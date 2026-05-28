import type { Observable } from 'rxjs';
import type { BrokerPublisher } from './broker-publisher';
import type { BrokerRegistry } from './broker-registry';
import type { EmitOptions, SendOptions } from './amqp.types';

// ---------------------------------------------------------------------------
// Public types — co-located with their decorators so the barrel can re-export
// both (decorator value + interface type) under the same name.
// ---------------------------------------------------------------------------

/** Publish handle for a **work-queue** (classic/quorum). Supports both
 *  `send()` (request/reply, waits for the reply on the broker's shared reply
 *  stream) and `emit()` (fire-and-forget). Use for point-to-point messaging
 *  where one message is processed by exactly one consumer.
 *
 *  Generic on the payload type `T` — declare the queue with the event shape
 *  it carries (`AmqpQueue<MyEvent>`) and `emit()` / `send()` are type-checked
 *  at every call site. Defaults to `unknown` so legacy declarations without
 *  a generic argument keep compiling. */
export interface AmqpQueue<T = unknown> {
  /** Request/reply. Returns an Observable that emits the peer's reply and
   *  completes. Errors with `AmqpTimeoutError` after `timeoutMs` (default
   *  configured via `defaultSendTimeoutMs`). `TRes` is supplied at the call
   *  site — the queue's static `T` only constrains the request payload. */
  send<TRes>(payload: T, options?: SendOptions): Observable<TRes>;
  /** Fire-and-forget. Returns `true` if the message was handed off to the
   *  sender (broker enabled and connected), `false` if it was dropped
   *  (broker disabled or not connected) — caller can then fall back to an
   *  in-process bus, a local outbox, etc. */
  emit(payload: T, options?: EmitOptions): boolean;
}

/** Publish handle for a **topic** (stream-backed broadcast). Only exposes
 *  `emit()` — request/reply (`send()`) is intentionally excluded because
 *  broadcast semantics don't fit a single-reply correlation model.
 *
 *  Generic on the payload type `T` — same convention as {@link AmqpQueue},
 *  default `unknown` to preserve legacy declarations. */
export interface AmqpTopic<T = unknown> {
  /** Fire-and-forget broadcast. All connected `@Subscribe` consumers
   *  on this address receive the message. Returns `true` if the message was
   *  handed off to the sender (broker enabled and connected), `false` if it
   *  was dropped (broker disabled or not connected) — caller can then fall
   *  back to an in-process bus, a local outbox, etc. */
  emit(payload: T, options?: EmitOptions): boolean;
}

// ---------------------------------------------------------------------------
// Internal: registry handoff. `BrokerRegistry` constructor calls
// `setAmqpBrokerRegistry(this)` so property decorators can resolve the
// publisher at first property access without going through Nest DI on the
// property itself.
// ---------------------------------------------------------------------------

let registryRef: BrokerRegistry | undefined;

/** Internal — called by `BrokerRegistry` during construction. Not exported
 *  via the module barrel. */
export function setAmqpBrokerRegistry(registry: BrokerRegistry): void {
  registryRef = registry;
}

// The bound impls stay non-parametric — the generic `T` is purely a
// compile-time contract carried by the public interface. At runtime every
// payload reaches the codec the same way regardless of its declared shape,
// so erasing `T` here costs nothing and keeps the impl small.
class BoundAmqpQueue implements AmqpQueue<unknown> {
  constructor(
    private readonly publisher: BrokerPublisher,
    private readonly address: string,
  ) {}

  send<TRes>(payload: unknown, options?: SendOptions): Observable<TRes> {
    return this.publisher.send<TRes>(this.address, payload, options);
  }

  emit(payload: unknown, options?: EmitOptions): boolean {
    return this.publisher.emit(this.address, payload, options);
  }
}

class BoundAmqpTopic implements AmqpTopic<unknown> {
  constructor(
    private readonly publisher: BrokerPublisher,
    private readonly address: string,
  ) {}

  emit(payload: unknown, options?: EmitOptions): boolean {
    return this.publisher.emit(this.address, payload, options);
  }
}

function resolvePublisher(decoratorName: string, address: string, brokerName: string | undefined): BrokerPublisher {
  if (registryRef === undefined) {
    throw new Error(
      `@${decoratorName}('${address}'${brokerName ? `, '${brokerName}'` : ''}): the AMQP module has not initialised yet - ` +
        `the broker registry is unavailable. This usually means the ` +
        `decorated property was accessed from a constructor or another ` +
        `path that runs before NestJS lifecycle hooks. Defer the call to ` +
        `OnModuleInit / OnApplicationBootstrap or to a normal method invocation.`,
    );
  }
  return registryRef.resolvePublisher(brokerName);
}

// ---------------------------------------------------------------------------
// Property decorators
// ---------------------------------------------------------------------------

/**
 * Inject an {@link AmqpQueue} handle bound to a **work-queue** address on
 * the named broker. Property decorator. First access reads the broker
 * publisher from the registry; subsequent accesses reuse a memoised handle.
 *
 * `brokerName` is optional when a single broker is configured — the lone
 * broker is resolved automatically. With several brokers, omitting
 * `brokerName` throws at first access.
 *
 * Usage:
 * ```ts
 * @AmqpQueue('orders.create')                  // single-broker setup
 * private readonly orders!: AmqpQueue<OrderBody>;
 *
 * @AmqpQueue('orders.create', 'primary')       // multi-broker setup
 * private readonly orders!: AmqpQueue<OrderBody>;
 * ```
 *
 * For broadcast / pub-sub semantics, use {@link AmqpTopic} instead.
 */
export function AmqpQueue(address: string, brokerName?: string): PropertyDecorator {
  return (target, propertyKey) => {
    Object.defineProperty(target, propertyKey, {
      configurable: true,
      enumerable: true,
      get(this: object): AmqpQueue<unknown> {
        const handle = new BoundAmqpQueue(resolvePublisher('AmqpQueue', address, brokerName), address);
        Object.defineProperty(this, propertyKey, {
          value: handle,
          configurable: true,
          writable: false,
          enumerable: true,
        });
        return handle;
      },
    });
  };
}

/**
 * Inject an {@link AmqpTopic} handle bound to a **broadcast** address
 * (stream-backed) on the named broker. Only exposes `emit()` — request/reply
 * doesn't apply to broadcast. Same `brokerName` semantics as
 * {@link AmqpQueue}.
 *
 * Usage:
 * ```ts
 * @AmqpTopic('changes.bulletin')                  // single-broker setup
 * private readonly changes!: AmqpTopic<BulletinChangedEvent>;
 *
 * @AmqpTopic('changes.bulletin', 'primary')       // multi-broker setup
 * private readonly changes!: AmqpTopic<BulletinChangedEvent>;
 * ```
 *
 * For work-queue semantics, use {@link AmqpQueue} instead.
 */
export function AmqpTopic(address: string, brokerName?: string): PropertyDecorator {
  return (target, propertyKey) => {
    Object.defineProperty(target, propertyKey, {
      configurable: true,
      enumerable: true,
      get(this: object): AmqpTopic<unknown> {
        const handle = new BoundAmqpTopic(resolvePublisher('AmqpTopic', address, brokerName), address);
        Object.defineProperty(this, propertyKey, {
          value: handle,
          configurable: true,
          writable: false,
          enumerable: true,
        });
        return handle;
      },
    });
  };
}
