import type { Delivery, Message, MessageProperties } from 'rhea';

/** Internal: where on a stream queue a consumer should start reading.
 *  Currently always `'next'` (set by `@Subscribe`); kept as a type for
 *  possible future expansion via a dedicated `@SubscribeStream` decorator. */
export type StreamOffset = 'first' | 'last' | 'next' | number | Date;

/**
 * Retry timing policy applied on handler error before `maxDelivery` is
 * reached. **In 0.2.x only `'immediate'` is functional** — the other
 * variants are accepted by the type system but throw at boot with a clear
 * "not yet implemented" message. They are exposed now so consumer call
 * sites can be written against the final API today and start working
 * automatically in 0.3.x when client-side scheduled republish lands.
 *
 *   - `'immediate'` — the framework calls
 *     `delivery.modified({ delivery_failed: true })`. Re-delivery timing
 *     depends entirely on the broker: Artemis honours its `redelivery-delay`
 *     setting, RabbitMQ / Qpid redeliver as soon as they can.
 *   - `{ kind: 'fixed', delayMs }` — fixed delay between attempts. Will be
 *     implemented in 0.3.x via broker-specific scheduled republish.
 *   - `{ kind: 'exponential', initialMs, multiplier, maxMs }` — exponential
 *     backoff. Will be implemented in 0.3.x.
 */
export type RetryPolicy =
  | 'immediate'
  | { readonly kind: 'fixed'; readonly delayMs: number }
  | { readonly kind: 'exponential'; readonly initialMs: number; readonly multiplier: number; readonly maxMs: number };

/** Options for `@Consume(address, brokerName?, opts?)` — work-queue semantics
 *  (competing consumers, one message processed by exactly one consumer). */
export interface ConsumeOptions {
  /** Total delivery attempts before giving up. Must be ≥ 1. Default 1 (no
   *  retry). On error, the framework `delivery.modified({delivery_failed:true})`
   *  the message until `deliveryCount >= maxDelivery`, then applies `dlq`. */
  readonly maxDelivery?: number;
  /** Timing between retries. Default `'immediate'`. See {@link RetryPolicy}. */
  readonly retryPolicy?: RetryPolicy;
  /** On final failure (deliveryCount === maxDelivery), call `delivery.reject()`
   *  so the broker routes the message via its own DLX configuration (`true`),
   *  or `delivery.accept()` to drop silently (`false`). Default `false`.
   *  When `true`, ensure the queue's DLX is configured broker-side; otherwise
   *  the message is still dropped — the lib never publishes to a DLQ itself. */
  readonly dlq?: boolean;
  /** Per-receiver credit window — max in-flight unsettled messages.
   *  Default 100. */
  readonly maxWindow?: number;
}

/** Options for `@Subscribe(address, brokerName?, opts?)` — topic / broadcast
 *  semantics via stream queues. `maxDelivery`, `retryPolicy` and `dlq` are
 *  omitted intentionally: streams don't redeliver via
 *  `modified(delivery_failed: true)` the way classic/quorum queues do, and
 *  they're append-only logs (no DLX semantics). Stream offset is hardcoded
 *  to `'next'` — only messages produced AFTER the subscriber connects are
 *  delivered, JMS-topic-like. */
export interface SubscribeOptions {
  /** Per-receiver credit window — max in-flight unsettled messages.
   *  Default 100. */
  readonly maxWindow?: number;
}

/** Resolved options after defaults are applied by `@Consume` / `@Subscribe`.
 *  For topic subscriptions (`@Subscribe`), `maxDelivery` is `1` and `dlq` is
 *  `false` (retry/DLQ are no-ops on streams). `streamOffset` is set when the
 *  consumer is on a stream queue. */
export interface ResolvedConsumerOptions {
  readonly maxDelivery: number;
  readonly retryPolicy: RetryPolicy;
  readonly dlq: boolean;
  readonly maxWindow: number;
  readonly streamOffset?: StreamOffset;
}

/** What `@Consume` / `@Subscribe` records on the method via
 *  `Reflect.defineMetadata`. `brokerName` is undefined when the decorator
 *  omits it — the explorer resolves to the lone broker (or throws if several
 *  are configured). `kind` lets the explorer distinguish the two flavours
 *  for clean logs and per-flavour validation. */
export interface ConsumerMetadata {
  readonly address: string;
  readonly brokerName?: string;
  readonly kind: 'consume' | 'subscribe';
  readonly options: ResolvedConsumerOptions;
}

/** Options accepted by publishers' `send()`. */
export interface SendOptions {
  /** Override the configured default for this call. */
  readonly timeoutMs?: number;
  /** Extra AMQP message properties (subject, content_type, …). `reply_to` and
   *  `correlation_id` are managed by the publisher and ignored if set here. */
  readonly properties?: Omit<MessageProperties, 'reply_to' | 'correlation_id'>;
  /** `application_properties` carried alongside the body. */
  readonly applicationProperties?: Record<string, unknown>;
}

/** Options accepted by publishers' `emit()`. */
export interface EmitOptions {
  readonly properties?: MessageProperties;
  readonly applicationProperties?: Record<string, unknown>;
}

/** Internal: what the consumer-explorer hands to the per-message router. */
export interface IncomingMessage {
  readonly address: string;
  readonly message: Message;
  readonly delivery: Delivery;
}

/** Parameter decorator kinds — each value identifies one `@Amqp*()` decorator
 *  and tells the dispatcher how to resolve the parameter at call time. */
export type AmqpParamKind =
  | 'BODY'
  | 'ADDRESS'
  | 'DELIVERY_COUNT'
  | 'HEADER'
  | 'PROPERTIES'
  | 'PROPERTY'
  | 'APP_PROPERTIES'
  | 'APP_PROPERTY'
  | 'SETTLER'
  | 'CONTEXT';

/** Per-parameter metadata stored on a `@Consume` / `@Subscribe` method by
 *  `@Amqp*()`. */
export interface AmqpParamMeta {
  readonly kind: AmqpParamKind;
  /** Optional key for `@AmqpProperty(name)` / `@AmqpAppProperty(name)`. */
  readonly key?: string;
}
