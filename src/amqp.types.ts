import type { Delivery, Message, MessageProperties } from 'rhea';

/** Internal: where on a stream queue a consumer should start reading.
 *  Currently always `'next'` (set by `@SubscribeTopic`); kept as a type for
 *  possible future expansion via `@SubscribeStream`. */
export type StreamOffset = 'first' | 'last' | 'next' | number | Date;

/** Options for `@Subscribe(address, opts?)` — work-queue semantics. */
export interface SubscribeOptions {
  /** Total delivery attempts before giving up. Must be ≥ 1. Default 1 (no
   *  retry). On error, the framework `delivery.modified({delivery_failed:true})`
   *  the message until `deliveryCount >= maxDelivery`, then applies `dlq`. */
  readonly maxDelivery?: number;
  /** On final failure (deliveryCount === maxDelivery), route the message to
   *  the broker-configured DLX (`true`) or accept-and-drop silently (`false`).
   *  Default `false`. */
  readonly dlq?: boolean;
  /** Per-receiver credit window — max in-flight unsettled messages.
   *  Default 100. */
  readonly maxWindow?: number;
}

/** Options for `@SubscribeTopic(address, opts?)` — topic / broadcast semantics
 *  via RabbitMQ streams. `maxDelivery` and `dlq` are omitted intentionally:
 *  streams don't redeliver via `modified(delivery_failed: true)` the way
 *  classic/quorum queues do, and they're append-only logs (no DLX semantics).
 *  Stream offset is hardcoded to `'next'` — only the messages produced AFTER
 *  the subscriber connects are delivered, JMS-topic-like. */
export interface SubscribeTopicOptions {
  /** Per-receiver credit window — max in-flight unsettled messages.
   *  Default 100. */
  readonly maxWindow?: number;
}

/** Resolved options after defaults are applied by `@Subscribe` /
 *  `@SubscribeTopic`. For topic subscriptions, `maxDelivery` is `1` and `dlq`
 *  is `false` (retry/DLQ are no-ops on streams). `streamOffset` is set when
 *  the consumer is on a stream queue. */
export interface ResolvedSubscribeOptions {
  readonly maxDelivery: number;
  readonly dlq: boolean;
  readonly maxWindow: number;
  readonly streamOffset?: StreamOffset;
}

/** What `@Subscribe` / `@SubscribeTopic` records on the method via
 *  `Reflect.defineMetadata`. */
export interface SubscribeMetadata {
  readonly address: string;
  readonly options: ResolvedSubscribeOptions;
}

/** Options accepted by `AmqpPublisher.send()`. */
export interface SendOptions {
  /** Override the configured default for this call. */
  readonly timeoutMs?: number;
  /** Extra AMQP message properties (subject, content_type, …). `reply_to` and
   *  `correlation_id` are managed by the publisher and ignored if set here. */
  readonly properties?: Omit<MessageProperties, 'reply_to' | 'correlation_id'>;
  /** `application_properties` carried alongside the body. */
  readonly applicationProperties?: Record<string, unknown>;
}

/** Options accepted by `AmqpPublisher.emit()`. */
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

/** Per-parameter metadata stored on a `@Subscribe` method by `@Amqp*()`. */
export interface AmqpParamMeta {
  readonly kind: AmqpParamKind;
  /** Optional key for `@AmqpProperty(name)` / `@AmqpAppProperty(name)`. */
  readonly key?: string;
}
