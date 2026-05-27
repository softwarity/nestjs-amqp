import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable, Subject, type Subscription, throwError } from 'rxjs';
import { finalize, switchMap, take, timeout } from 'rxjs/operators';
import { AmqpClient } from './amqp.client';
import { AmqpConnectionError, AmqpTimeoutError } from './amqp.errors';
import { setAmqpPublisher } from './amqp.queue';
import { decodeBody, encodeBody } from './body-codec';
import type { EmitOptions, IncomingMessage, SendOptions } from './amqp.types';

/**
 * High-level publisher. `send()` is request/reply: it ships the body with a
 * generated `correlation_id` and the shared reply-to address, then resolves
 * the Observable when a matching reply lands on the reply queue. `emit()` is
 * fire-and-forget — no correlation, no reply. Bodies are JSON-encoded both
 * ways, so the contract on the wire is plain text JSON.
 */
@Injectable()
export class AmqpPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AmqpPublisher.name);

  // Each in-flight `send()` is keyed by its correlation_id. The subject is
  // resolved on reply arrival or completed by `timeout` via the `finalize`
  // operator (which removes the entry).
  private readonly pendingReplies = new Map<string, Subject<unknown>>();
  private repliesSub?: Subscription;

  constructor(private readonly client: AmqpClient) {}

  onModuleInit(): void {
    setAmqpPublisher(this);
    const options = this.client.getOptions();
    if (!options.enabled) return;
    if (!options.replyStreamAddress) return;
    this.repliesSub = this.client.replies$.subscribe({
      next: (incoming) => this.routeReply(incoming),
      error: (err) => this.logger.error(`reply stream errored: ${describeUnknown(err)}`),
    });
  }

  /**
   * Send `payload` on `address` and wait for a reply on the shared reply-to
   * queue. Times out after `opts.timeoutMs` (default: the configured
   * `defaultSendTimeoutMs`).
   */
  send<TRes>(address: string, payload: unknown, opts: SendOptions = {}): Observable<TRes> {
    const options = this.client.getOptions();
    if (!options.enabled) {
      return throwError(() => new AmqpConnectionError('AMQP is disabled (enabled=false) - send() unavailable'));
    }
    if (!options.replyStreamAddress) {
      return throwError(
        () =>
          new AmqpConnectionError(
            'AMQP send() requires a configured replyStreamAddress (or an appName from which to derive it). Use emit() instead.',
          ),
      );
    }
    const timeoutMs = opts.timeoutMs ?? options.defaultSendTimeoutMs;
    return this.client.replyToAddress$.pipe(
      take(1),
      switchMap((replyAddr) => {
        // Per-process prefix lets us filter our own replies out of the shared
        // reply stream — other instances see this id and ignore it.
        const correlationId = `${this.client.replyPrefix}:${randomUUID()}`;
        const subject = new Subject<TRes>();
        this.pendingReplies.set(correlationId, subject as Subject<unknown>);
        this.client.publish(address, {
          body: encodeBody(payload),
          properties: {
            ...opts.properties,
            reply_to: replyAddr,
            correlation_id: correlationId,
          },
          application_properties: opts.applicationProperties,
        });
        return subject.pipe(
          take(1),
          timeout({
            each: timeoutMs,
            with: () => throwError(() => new AmqpTimeoutError(address, correlationId, timeoutMs)),
          }),
          finalize(() => this.pendingReplies.delete(correlationId)),
        );
      }),
    );
  }

  /** Fire-and-forget. No reply queue, no correlation. Returns immediately. */
  emit(address: string, payload: unknown, opts: EmitOptions = {}): void {
    if (!this.client.getOptions().enabled) return;
    this.client.publish(address, {
      body: encodeBody(payload),
      properties: opts.properties,
      application_properties: opts.applicationProperties,
    });
  }

  onModuleDestroy(): void {
    this.repliesSub?.unsubscribe();
    this.pendingReplies.forEach((subject) => subject.complete());
    this.pendingReplies.clear();
  }

  private routeReply(incoming: IncomingMessage): void {
    const raw = incoming.message.properties?.correlation_id;
    const id = typeof raw === 'string' ? raw : raw === undefined ? undefined : String(raw);
    if (id === undefined) {
      this.logger.debug('reply without correlation_id - accepting and dropping');
      incoming.delivery.accept();
      return;
    }
    const subject = this.pendingReplies.get(id);
    if (!subject) {
      this.logger.debug(`reply with unknown correlation_id ${id} - accepting and dropping`);
      incoming.delivery.accept();
      return;
    }
    try {
      const parsed = decodeBody(incoming.message.body);
      subject.next(parsed);
      subject.complete();
    } catch (err) {
      subject.error(err);
    }
    incoming.delivery.accept();
  }
}

function describeUnknown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
