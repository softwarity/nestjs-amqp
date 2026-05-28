import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable, Subject, type Subscription, throwError } from 'rxjs';
import { finalize, switchMap, take, timeout } from 'rxjs/operators';
import { AmqpConnectionError, AmqpTimeoutError } from './amqp.errors';
import type { EmitOptions, IncomingMessage, SendOptions } from './amqp.types';
import type { BrokerConnection } from './broker-connection';

/**
 * Per-broker high-level publisher. `send()` is request/reply: it ships the
 * body with a generated `correlation_id` and the shared reply-to address,
 * then resolves the Observable when a matching reply lands on the broker's
 * reply queue. `emit()` is fire-and-forget — no correlation, no reply.
 *
 * Owned by {@link import('./broker-registry').BrokerRegistry} — one publisher
 * per broker. Not a NestJS provider on its own.
 */
export class BrokerPublisher {
  private readonly logger: Logger;

  // Each in-flight `send()` is keyed by its correlation_id. The subject is
  // resolved on reply arrival or completed by `timeout` via the `finalize`
  // operator (which removes the entry).
  private readonly pendingReplies = new Map<string, Subject<unknown>>();
  private repliesSub?: Subscription;

  constructor(private readonly broker: BrokerConnection) {
    this.logger = new Logger(`${BrokerPublisher.name}:${broker.options.name}`);
  }

  /** Called by `BrokerRegistry.onModuleInit` after `broker.start()`. Wires
   *  the broker's reply stream to the local correlation router. No-op if
   *  the broker has no reply stream configured. */
  start(): void {
    if (!this.broker.options.replyStreamAddress) return;
    this.repliesSub = this.broker.replies$.subscribe({
      next: (incoming) => this.routeReply(incoming),
      error: (err) => this.logger.error(`reply stream errored: ${describeUnknown(err)}`),
    });
  }

  stop(): void {
    this.repliesSub?.unsubscribe();
    this.pendingReplies.forEach((subject) => subject.complete());
    this.pendingReplies.clear();
  }

  /**
   * Send `payload` on `address` and wait for a reply on this broker's shared
   * reply queue. Times out after `opts.timeoutMs` (default: the broker's
   * `defaultSendTimeoutMs`).
   */
  send<TRes>(address: string, payload: unknown, opts: SendOptions = {}): Observable<TRes> {
    if (!this.broker.options.replyStreamAddress) {
      return throwError(
        () =>
          new AmqpConnectionError(
            `Broker '${this.broker.options.name}': send() requires a configured replyStreamAddress. Use emit() instead.`,
          ),
      );
    }
    const timeoutMs = opts.timeoutMs ?? this.broker.options.defaultSendTimeoutMs;
    return this.broker.replyToAddress$.pipe(
      take(1),
      switchMap((replyAddr) => {
        // Per-process prefix lets us filter our own replies out of the shared
        // reply stream — other instances see this id and ignore it.
        const correlationId = `${this.broker.replyPrefix}:${randomUUID()}`;
        const subject = new Subject<TRes>();
        this.pendingReplies.set(correlationId, subject as Subject<unknown>);
        this.broker.publish(address, {
          body: this.broker.encodeBody(payload),
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

  /** Fire-and-forget. No reply queue, no correlation. Returns synchronously.
   *  `true` if the message was handed off to rhea's sender (broker enabled +
   *  connected); `false` if the broker is disabled or not connected, in which
   *  case the message is dropped and the caller can fall back to another
   *  transport (e.g. NestJS EventEmitter2 for in-process delivery, a local
   *  outbox table, …). */
  emit(address: string, payload: unknown, opts: EmitOptions = {}): boolean {
    return this.broker.publish(address, {
      body: this.broker.encodeBody(payload),
      properties: opts.properties,
      application_properties: opts.applicationProperties,
    });
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
      const parsed = this.broker.decodeBody(incoming.message.body);
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
