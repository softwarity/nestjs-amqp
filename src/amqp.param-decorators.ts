import type { DeliveryRejectError, MessageHeader, MessageProperties } from 'rhea';
import type { AmqpParamKind, AmqpParamMeta } from './amqp.types';

/** Metadata key holding the per-parameter array of `AmqpParamMeta` on a
 *  `@Subscribe` method. Indexed by parameter position. */
export const AMQP_PARAMS_METADATA = Symbol('amqp:params');

/** Manual settle control injected via `@AmqpSettler()`. Calling any method
 *  flips the framework's `settled` flag, suppressing automatic settle. */
export interface AmqpSettler {
  /** Mark the delivery as accepted (consumed). Broker removes the message. */
  accept(): void;
  /** Return the delivery to the broker without ack. Re-delivered to anyone
   *  (including us) with delivery_count unchanged. Poison-loop risk: use
   *  with a back-off / dedup policy. */
  release(): void;
  /** Mark the delivery as rejected. Routes to the broker DLX immediately,
   *  bypassing the `maxDelivery` counter. */
  reject(error?: DeliveryRejectError): void;
}

/** What `@AmqpContext()` injects — the full envelope plus the settler. Use
 *  for cases the granular decorators don't cover. */
export interface AmqpContext {
  readonly address: string;
  readonly properties: MessageProperties;
  readonly applicationProperties: Record<string, unknown>;
  readonly header: MessageHeader;
  /** 1-based attempt number — 1 on first delivery, +1 each time the framework
   *  retries via `modified(delivery_failed: true)`. Driven by the AMQP
   *  `header.delivery_count` field, which the broker increments. */
  readonly deliveryCount: number;
  /** True after any of accept/release/reject has been called manually. */
  readonly settled: boolean;
  accept(): void;
  release(): void;
  reject(error?: DeliveryRejectError): void;
}

function paramDecorator(kind: AmqpParamKind, key?: string): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    if (propertyKey === undefined) return;
    const existing = (Reflect.getMetadata(AMQP_PARAMS_METADATA, target, propertyKey) ?? []) as AmqpParamMeta[];
    existing[parameterIndex] = { kind, key };
    Reflect.defineMetadata(AMQP_PARAMS_METADATA, existing, target, propertyKey);
  };
}

/** Inject the JSON-decoded message body. */
export const AmqpBody = (): ParameterDecorator => paramDecorator('BODY');

/** Inject the address the `@Subscribe` was bound to (useful for multi-route
 *  handlers or logging). */
export const AmqpAddress = (): ParameterDecorator => paramDecorator('ADDRESS');

/** Inject the 1-based attempt number. 1 on first delivery, +1 each retry. */
export const AmqpDeliveryCount = (): ParameterDecorator => paramDecorator('DELIVERY_COUNT');

/** Inject the AMQP message header (durable, priority, ttl, delivery_count,
 *  first_acquirer). */
export const AmqpHeader = (): ParameterDecorator => paramDecorator('HEADER');

/** Inject the full AMQP message properties (message_id, reply_to,
 *  correlation_id, subject, content_type, creation_time, …). */
export const AmqpProperties = (): ParameterDecorator => paramDecorator('PROPERTIES');

/** Inject a single field from `message.properties`. */
export const AmqpProperty = (name: string): ParameterDecorator => paramDecorator('PROPERTY', name);

/** Inject the full `application_properties` map (custom key/value pairs the
 *  publisher attached alongside the body). */
export const AmqpAppProperties = (): ParameterDecorator => paramDecorator('APP_PROPERTIES');

/** Inject a single field from `application_properties` by name. */
export const AmqpAppProperty = (name: string): ParameterDecorator => paramDecorator('APP_PROPERTY', name);

/** Inject the manual settle helper — `{ accept, release, reject }`. Calling
 *  any of these suppresses the framework's automatic `maxDelivery`/`dlq`
 *  policy for this delivery. */
export const AmqpSettler = (): ParameterDecorator => paramDecorator('SETTLER');

/** Inject the full envelope. The injected value matches the `AmqpContext`
 *  interface above. */
export const AmqpContext = (): ParameterDecorator => paramDecorator('CONTEXT');
