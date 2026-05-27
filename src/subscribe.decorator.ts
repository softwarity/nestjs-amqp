import type {
  ResolvedSubscribeOptions,
  SubscribeMetadata,
  SubscribeOptions,
  SubscribeTopicOptions,
} from './amqp.types';

/** Metadata key used by `AmqpConsumerExplorer` to locate handlers declared by
 *  `@Subscribe` and `@SubscribeTopic` (both produce the same metadata shape). */
export const AMQP_SUBSCRIBE_METADATA = Symbol('amqp:subscribe');

const QUEUE_DEFAULTS = {
  maxDelivery: 1,
  dlq: false,
  maxWindow: 100,
} as const;

const TOPIC_DEFAULTS = {
  maxWindow: 100,
} as const;

/**
 * Mark a method as a **work-queue consumer** on `address` — competing
 * consumers semantic, one message = one consumer processes it. The
 * broker-side queue should be `x-queue-type: classic` or `quorum`.
 *
 * Parameters MUST be annotated with `@Amqp*()` decorators
 * (`@AmqpBody`, `@AmqpDeliveryCount`, `@AmqpSettler`, …). Un-annotated
 * parameters throw at boot.
 *
 * Error policy:
 *   - On handler error (throw or `Observable.error`):
 *     - If `deliveryCount < maxDelivery`: `delivery.modified({delivery_failed:true})`
 *       → broker re-delivers, count++ at next attempt
 *     - Else (last attempt): if `dlq` → `delivery.reject()` to broker DLX,
 *       else `delivery.accept()` (drop silently)
 *   - Manual `@AmqpSettler()` calls suppress this automatic policy.
 *
 * For broadcast / pub-sub semantics, use `@SubscribeTopic` instead.
 */
export function Subscribe(address: string, options: SubscribeOptions = {}): MethodDecorator {
  const merged: ResolvedSubscribeOptions = { ...QUEUE_DEFAULTS, ...options };
  if (merged.maxDelivery < 1) {
    throw new Error(
      `@Subscribe('${address}'): maxDelivery must be >= 1 (got ${merged.maxDelivery}). 1 means no retry; higher means retry on error.`,
    );
  }
  if (merged.maxWindow < 1) {
    throw new Error(`@Subscribe('${address}'): maxWindow must be >= 1 (got ${merged.maxWindow}).`);
  }
  return defineMetadata({ address, options: merged });
}

/**
 * Mark a method as a **topic consumer** on `address` — broadcast / pub-sub
 * semantic, each connected consumer receives every message. The broker-side
 * queue MUST be `x-queue-type: stream`.
 *
 * The framework attaches with `rabbitmq:stream-offset-spec: 'next'`, so the
 * consumer only sees messages produced AFTER it connects (JMS topic-like
 * "ephemeral subscription"). Messages published while the consumer is
 * disconnected are lost from its perspective.
 *
 * `maxDelivery` and `dlq` are not exposed because streams don't redeliver
 * via the same mechanism as classic/quorum queues. If a stream handler
 * errors, the framework `accept()`s to advance the offset (drop the
 * message). Implement retry semantics in application code if needed.
 */
export function SubscribeTopic(address: string, options: SubscribeTopicOptions = {}): MethodDecorator {
  const merged: ResolvedSubscribeOptions = {
    maxDelivery: 1,
    dlq: false,
    maxWindow: options.maxWindow ?? TOPIC_DEFAULTS.maxWindow,
    streamOffset: 'next',
  };
  if (merged.maxWindow < 1) {
    throw new Error(`@SubscribeTopic('${address}'): maxWindow must be >= 1 (got ${merged.maxWindow}).`);
  }
  return defineMetadata({ address, options: merged });
}

function defineMetadata(meta: SubscribeMetadata): MethodDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata(AMQP_SUBSCRIBE_METADATA, meta, target, propertyKey);
  };
}
