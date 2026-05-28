import type {
  ConsumeOptions,
  ConsumerMetadata,
  ResolvedConsumerOptions,
  RetryPolicy,
  SubscribeOptions,
} from './amqp.types';

/** Metadata key used by `AmqpConsumerExplorer` to locate handlers declared by
 *  `@Consume` and `@Subscribe` (both produce the same metadata shape — the
 *  flavour is carried by `kind`). */
export const AMQP_CONSUMER_METADATA = Symbol('amqp:consumer');

const CONSUME_DEFAULTS = {
  maxDelivery: 1,
  retryPolicy: 'immediate' as RetryPolicy,
  dlq: false,
  maxWindow: 100,
} as const;

const SUBSCRIBE_DEFAULTS = {
  maxWindow: 100,
} as const;

/**
 * Mark a method as a **work-queue consumer** on `address` — competing-consumer
 * semantics, one message processed by exactly one consumer. The broker-side
 * queue should be `x-queue-type: classic` or `quorum`.
 *
 * Parameters MUST be annotated with `@Amqp*()` decorators
 * (`@AmqpBody`, `@AmqpDeliveryCount`, `@AmqpSettler`, …) — with one
 * exception: a single un-annotated parameter is implicitly bound to the
 * decoded message body. Un-annotated parameters when more than one exist
 * throw at boot.
 *
 * `brokerName` is optional when a single broker is configured — the lone
 * broker is resolved automatically. With several brokers, omitting it
 * throws at boot. Two ergonomic forms are accepted:
 *
 * ```ts
 * @Consume('orders.create')                          // single-broker, no options
 * @Consume('orders.create', { dlq: true })           // single-broker, options only
 * @Consume('orders.create', 'primary')               // multi-broker, no options
 * @Consume('orders.create', 'primary', { dlq: true })// multi-broker, with options
 * ```
 *
 * Error policy:
 *   - On handler error (throw or `Observable.error`):
 *     - If `deliveryCount < maxDelivery`: `delivery.modified({delivery_failed:true})`
 *       → broker re-delivers, count++ at next attempt
 *     - Else (last attempt): if `dlq` → `delivery.reject()` (broker routes
 *       via its own DLX configuration), else `delivery.accept()` (drop silently)
 *   - Manual `@AmqpSettler()` calls suppress this automatic policy.
 *
 * For broadcast / pub-sub semantics, use {@link Subscribe} instead.
 */
export function Consume(address: string, brokerName?: string, options?: ConsumeOptions): MethodDecorator;
export function Consume(address: string, options?: ConsumeOptions): MethodDecorator;
export function Consume(address: string, arg2?: string | ConsumeOptions, arg3?: ConsumeOptions): MethodDecorator {
  const { brokerName, options } = splitArgs(arg2, arg3);
  const merged: ResolvedConsumerOptions = { ...CONSUME_DEFAULTS, ...options };
  if (merged.maxDelivery < 1) {
    throw new Error(
      `@Consume('${address}'): maxDelivery must be >= 1 (got ${merged.maxDelivery}). 1 means no retry; higher means retry on error.`,
    );
  }
  if (merged.maxWindow < 1) {
    throw new Error(`@Consume('${address}'): maxWindow must be >= 1 (got ${merged.maxWindow}).`);
  }
  validateRetryPolicy(address, merged.retryPolicy);
  return defineMetadata({ address, brokerName, kind: 'consume', options: merged });
}

/**
 * Mark a method as a **topic subscriber** on `address` — broadcast / pub-sub
 * semantics, each connected subscriber receives every message. The broker-side
 * queue MUST be `x-queue-type: stream`.
 *
 * The framework attaches with `rabbitmq:stream-offset-spec: 'next'`, so the
 * subscriber only sees messages produced AFTER it connects (JMS topic-like
 * "ephemeral subscription"). Messages published while the subscriber is
 * disconnected are lost from its perspective.
 *
 * `maxDelivery`, `retryPolicy` and `dlq` are not exposed because streams
 * don't redeliver via the same mechanism as classic/quorum queues. If a
 * stream handler errors, the framework `accept()`s to advance the offset
 * (drop the message). Implement retry semantics in application code if
 * needed.
 *
 * `brokerName` semantics: same as {@link Consume} — optional when a single
 * broker is configured, required otherwise.
 *
 * For work-queue (one-message-one-consumer) semantics, use {@link Consume}.
 */
export function Subscribe(address: string, brokerName?: string, options?: SubscribeOptions): MethodDecorator;
export function Subscribe(address: string, options?: SubscribeOptions): MethodDecorator;
export function Subscribe(
  address: string,
  arg2?: string | SubscribeOptions,
  arg3?: SubscribeOptions,
): MethodDecorator {
  const { brokerName, options } = splitArgs(arg2, arg3);
  const merged: ResolvedConsumerOptions = {
    maxDelivery: 1,
    retryPolicy: 'immediate',
    dlq: false,
    maxWindow: options?.maxWindow ?? SUBSCRIBE_DEFAULTS.maxWindow,
    streamOffset: 'next',
  };
  if (merged.maxWindow < 1) {
    throw new Error(`@Subscribe('${address}'): maxWindow must be >= 1 (got ${merged.maxWindow}).`);
  }
  return defineMetadata({ address, brokerName, kind: 'subscribe', options: merged });
}

function defineMetadata(meta: ConsumerMetadata): MethodDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata(AMQP_CONSUMER_METADATA, meta, target, propertyKey);
  };
}

function splitArgs<O>(
  arg2: string | O | undefined,
  arg3: O | undefined,
): { brokerName: string | undefined; options: O | undefined } {
  if (typeof arg2 === 'string') return { brokerName: arg2, options: arg3 };
  return { brokerName: undefined, options: arg2 };
}

function validateRetryPolicy(address: string, policy: RetryPolicy): void {
  if (policy === 'immediate') return;
  if (typeof policy !== 'object' || policy === null) {
    throw new Error(
      `@Consume('${address}'): invalid retryPolicy. Expected 'immediate' | { kind: 'fixed' | 'exponential', ... }`,
    );
  }
  if (policy.kind === 'fixed') {
    if (!(policy.delayMs > 0)) {
      throw new Error(`@Consume('${address}'): retryPolicy.delayMs must be > 0`);
    }
  } else if (policy.kind === 'exponential') {
    if (!(policy.initialMs > 0)) {
      throw new Error(`@Consume('${address}'): retryPolicy.initialMs must be > 0`);
    }
    if (!(policy.multiplier > 1)) {
      throw new Error(`@Consume('${address}'): retryPolicy.multiplier must be > 1`);
    }
    if (!(policy.maxMs >= policy.initialMs)) {
      throw new Error(`@Consume('${address}'): retryPolicy.maxMs must be >= initialMs`);
    }
  } else {
    throw new Error(`@Consume('${address}'): unknown retryPolicy.kind '${(policy as { kind: string }).kind}'`);
  }
}
