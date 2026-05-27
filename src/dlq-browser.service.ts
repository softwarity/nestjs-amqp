import { Injectable, Logger, NotFoundException, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Delivery, EventContext, Message, Receiver } from 'rhea';
import { Observable, throwError } from 'rxjs';
import { AmqpClient } from './amqp.client';
import { AmqpConnectionError } from './amqp.errors';
import { decodeBody, encodeBody } from './body-codec';
import type { DlqSession, HeldMessage, XDeath } from './dlq-browser.types';

// How long to wait for messages to arrive after adding credit. If the DLQ
// has fewer than `pageSize` messages, we return what we got after this
// timeout instead of blocking the caller forever.
const DRAIN_TIMEOUT_MS = 500;

// Session lifecycle: idle TTL is the gap between two actions; hard TTL is
// the absolute ceiling (kept under RabbitMQ's default `consumer_timeout`,
// 30 min, so the broker doesn't yank our session out from under us).
const SESSION_IDLE_TTL_MS = 5 * 60_000;
const SESSION_HARD_TTL_MS = 25 * 60_000;
const TTL_SWEEP_INTERVAL_MS = 30_000;

interface SessionRecord {
  readonly session: DlqSession;
  readonly receiver: Receiver;
}

/**
 * DLQ browser — open a session on a DLQ address, paginate through held
 * (un-settled) messages, then replay or drop them one by one. All state
 * lives in RAM; a backend crash drops the AMQP connection and the broker
 * re-queues every un-settled delivery (free rollback). Mono-instance by
 * design — for multi-instance deployments, route the admin session to a
 * single instance via sticky LB or expose only one replica.
 */
@Injectable()
export class DlqBrowserService implements OnModuleDestroy {
  private readonly logger = new Logger(DlqBrowserService.name);

  private readonly sessions = new Map<string, SessionRecord>();
  private readonly ttlTimer = setInterval(() => this.sweepIdleSessions(), TTL_SWEEP_INTERVAL_MS);

  constructor(private readonly client: AmqpClient) {}

  /**
   * Open a session on `dlqAddress`. Allocates `pageSize` credits to the
   * receiver, waits for at least that many messages or `DRAIN_TIMEOUT_MS`,
   * whichever comes first. Returns the populated session.
   */
  openSession(dlqAddress: string, pageSize: number, openedBy: string): Observable<DlqSession> {
    if (pageSize < 1 || pageSize > 200) {
      return throwError(() => new Error(`pageSize must be between 1 and 200 (got ${pageSize})`));
    }
    return new Observable<DlqSession>((subscriber) => {
      const receiver = this.client.openManualReceiver(dlqAddress);
      if (!receiver) {
        subscriber.error(new AmqpConnectionError('AMQP not ready - cannot open a DLQ session'));
        return;
      }
      const session: DlqSession = {
        token: randomUUID(),
        dlqAddress,
        openedBy,
        openedAt: new Date(),
        lastActivityAt: new Date(),
        pageSize,
        pageIndex: 0,
        messages: new Map<number, HeldMessage>(),
      };
      const onOpen = (): void => {
        receiver.removeAllListeners('receiver_open');
        receiver.removeAllListeners('receiver_error');
        this.drainInto(receiver, session, pageSize, 0).subscribe({
          next: () => {
            this.sessions.set(session.token, { session, receiver });
            this.logger.log(
              `dlq session opened: token=${session.token} addr=${dlqAddress} by=${openedBy} drained=${session.messages.size}`,
            );
            subscriber.next(session);
            subscriber.complete();
          },
          error: (err: unknown) => {
            if (receiver.is_open()) receiver.close();
            subscriber.error(err);
          },
        });
      };
      const onError = (ctx: EventContext): void => {
        receiver.removeAllListeners('receiver_open');
        receiver.removeAllListeners('receiver_error');
        if (receiver.is_open()) receiver.close();
        subscriber.error(new AmqpConnectionError(`receiver_error on '${dlqAddress}': ${describeCtxError(ctx)}`));
      };
      receiver.on('receiver_open', onOpen);
      receiver.on('receiver_error', onError);
    });
  }

  /** Read the current state of a session (messages still held). */
  get(token: string): DlqSession {
    const record = this.sessions.get(token);
    if (!record) throw new NotFoundException(`DLQ session not found: ${token}`);
    return record.session;
  }

  /**
   * Replay one held message — publish a copy to its original queue (taken
   * from `xDeath[0].queue`) then `accept()` the original to remove it from
   * the DLQ. Removes it from the session.
   */
  replay(token: string, idx: number): Observable<void> {
    return new Observable<void>((subscriber) => {
      const record = this.sessions.get(token);
      if (!record) {
        subscriber.error(new NotFoundException(`DLQ session not found: ${token}`));
        return;
      }
      const held = record.session.messages.get(idx);
      if (!held) {
        subscriber.error(new NotFoundException(`Message ${idx} not in session ${token}`));
        return;
      }
      const origin = held.xDeath[0]?.queue;
      if (!origin) {
        subscriber.error(new Error(`Cannot replay message ${idx}: missing x-death.queue annotation`));
        return;
      }
      const keepProps = { ...held.properties };
      delete keepProps.reply_to;
      delete keepProps.correlation_id;
      this.client.publish(origin, {
        body: encodeBody(held.body),
        properties: keepProps,
        application_properties: held.applicationProperties,
      });
      held.delivery.accept();
      record.session.messages.delete(idx);
      this.touch(record.session);
      this.logger.log(`dlq replay: token=${token} idx=${idx} origin=${origin} by=${record.session.openedBy}`);
      subscriber.next();
      subscriber.complete();
    });
  }

  /** Drop one held message — `accept()` only, no republish. */
  drop(token: string, idx: number): Observable<void> {
    return new Observable<void>((subscriber) => {
      const record = this.sessions.get(token);
      if (!record) {
        subscriber.error(new NotFoundException(`DLQ session not found: ${token}`));
        return;
      }
      const held = record.session.messages.get(idx);
      if (!held) {
        subscriber.error(new NotFoundException(`Message ${idx} not in session ${token}`));
        return;
      }
      held.delivery.accept();
      record.session.messages.delete(idx);
      this.touch(record.session);
      this.logger.log(`dlq drop: token=${token} idx=${idx} by=${record.session.openedBy}`);
      subscriber.next();
      subscriber.complete();
    });
  }

  /**
   * Release all currently held messages back to the DLQ (no settlement
   * change — `delivery_count` stays as it was), then drain the next page
   * worth of messages. Reuses the same open receiver.
   */
  loadNextPage(token: string): Observable<DlqSession> {
    return new Observable<DlqSession>((subscriber) => {
      const record = this.sessions.get(token);
      if (!record) {
        subscriber.error(new NotFoundException(`DLQ session not found: ${token}`));
        return;
      }
      this.releaseAll(record.session);
      record.session.pageIndex += 1;
      this.drainInto(record.receiver, record.session, record.session.pageSize, 0).subscribe({
        next: () => {
          this.touch(record.session);
          this.logger.log(
            `dlq next page: token=${token} pageIndex=${record.session.pageIndex} drained=${record.session.messages.size}`,
          );
          subscriber.next(record.session);
          subscriber.complete();
        },
        error: (err: unknown) => subscriber.error(err),
      });
    });
  }

  /** Explicit close — release any remaining messages and close the receiver. */
  close(token: string): Observable<void> {
    return new Observable<void>((subscriber) => {
      const record = this.sessions.get(token);
      if (!record) {
        subscriber.error(new NotFoundException(`DLQ session not found: ${token}`));
        return;
      }
      this.closeRecord(record, 'explicit');
      subscriber.next();
      subscriber.complete();
    });
  }

  onModuleDestroy(): void {
    clearInterval(this.ttlTimer);
    for (const record of this.sessions.values()) {
      this.closeRecord(record, 'module-destroy');
    }
  }

  private touch(session: DlqSession): void {
    session.lastActivityAt = new Date();
  }

  private releaseAll(session: DlqSession): void {
    for (const held of session.messages.values()) {
      held.delivery.release();
    }
    session.messages.clear();
  }

  private closeRecord(record: SessionRecord, reason: string): void {
    this.releaseAll(record.session);
    if (record.receiver.is_open()) record.receiver.close();
    this.sessions.delete(record.session.token);
    this.logger.log(`dlq session closed: token=${record.session.token} reason=${reason}`);
  }

  private sweepIdleSessions(): void {
    const now = Date.now();
    for (const record of this.sessions.values()) {
      const idleMs = now - record.session.lastActivityAt.getTime();
      const totalMs = now - record.session.openedAt.getTime();
      if (idleMs > SESSION_IDLE_TTL_MS) {
        this.logger.warn(`dlq session idle TTL: token=${record.session.token} idleMs=${idleMs}`);
        this.closeRecord(record, 'idle-ttl');
        continue;
      }
      if (totalMs > SESSION_HARD_TTL_MS) {
        this.logger.warn(`dlq session hard TTL: token=${record.session.token} totalMs=${totalMs}`);
        this.closeRecord(record, 'hard-ttl');
      }
    }
  }

  private drainInto(receiver: Receiver, session: DlqSession, pageSize: number, startIdx: number): Observable<void> {
    return new Observable<void>((subscriber) => {
      let nextIdx = startIdx;
      let finished = false;

      const finish = (): void => {
        if (finished) return;
        finished = true;
        receiver.removeListener('message', onMessage);
        clearTimeout(timer);
        subscriber.next();
        subscriber.complete();
      };

      const onMessage = (ctx: EventContext): void => {
        if (!ctx.message || !ctx.delivery) return;
        const held = buildHeldMessage(ctx.message, ctx.delivery, nextIdx);
        session.messages.set(nextIdx, held);
        nextIdx += 1;
        if (session.messages.size >= pageSize) finish();
      };

      receiver.on('message', onMessage);
      receiver.add_credit(pageSize);
      const timer = setTimeout(finish, DRAIN_TIMEOUT_MS);
    });
  }
}

function buildHeldMessage(message: Message, delivery: Delivery, idx: number): HeldMessage {
  return {
    idx,
    message,
    delivery,
    body: decodeBody(message.body),
    properties: message.properties ?? {},
    applicationProperties: message.application_properties ?? {},
    xDeath: extractXDeath(message),
  };
}

/** Read the dead-letter trail. RabbitMQ 4.x (AMQP 1.0) exposes it under the
 *  `x-opt-deaths` message annotation — the `x-opt-` prefix is RabbitMQ's
 *  convention for system-emitted AMQP 1.0 annotations. The classic
 *  AMQP 0.9.1 `x-death` header is NOT present on the 1.0 path. */
function extractXDeath(message: Message): XDeath[] {
  const annotations = message.message_annotations;
  const raw = annotations?.['x-opt-deaths'];
  if (!Array.isArray(raw)) return [];
  return raw as XDeath[];
}

function describeCtxError(ctx: EventContext): string {
  const err =
    (ctx as { error?: unknown; receiver?: { error?: unknown } }).error ??
    (ctx.receiver as { error?: unknown } | undefined)?.error;
  if (err === null || err === undefined) return 'unknown';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const e = err as { condition?: string; description?: string };
    if (e.condition && e.description) return `${e.condition} - ${e.description}`;
    return e.description ?? e.condition ?? JSON.stringify(err);
  }
  return JSON.stringify(err);
}
