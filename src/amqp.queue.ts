import type { Observable } from 'rxjs';
import type { AmqpPublisher } from './amqp.publisher';
import type { EmitOptions, SendOptions } from './amqp.types';

// ---------------------------------------------------------------------------
// Public types — co-located with their decorators so the barrel can re-export
// both (decorator value + interface type) under the same name.
// ---------------------------------------------------------------------------

/** Publish handle for a **work-queue** (classic/quorum). Supports both
 *  `send()` (request/reply, waits for the reply on the shared reply stream)
 *  and `emit()` (fire-and-forget). Use for point-to-point messaging where
 *  one message is processed by exactly one consumer. */
export interface AmqpQueue {
  /** Request/reply. Returns an Observable that emits the peer's reply and
   *  completes. Errors with `AmqpTimeoutError` after `timeoutMs` (default
   *  configured via `defaultSendTimeoutMs`). */
  send<TRes>(payload: unknown, options?: SendOptions): Observable<TRes>;
  /** Fire-and-forget. Returns `void` synchronously. */
  emit(payload: unknown, options?: EmitOptions): void;
}

/** Publish handle for a **topic** (stream-backed broadcast). Only exposes
 *  `emit()` — request/reply (`send()`) is intentionally excluded because
 *  broadcast semantics don't fit a single-reply correlation model. */
export interface AmqpTopic {
  /** Fire-and-forget broadcast. All connected `@SubscribeTopic` consumers
   *  on this address receive the message. Returns `void` synchronously. */
  emit(payload: unknown, options?: EmitOptions): void;
}

// ---------------------------------------------------------------------------
// Internal: registry pattern. `AmqpPublisher.onModuleInit` calls
// `setAmqpPublisher(this)` so the decorators can resolve the publisher at
// first property access without going through Nest DI on the property.
// ---------------------------------------------------------------------------

let publisherRef: AmqpPublisher | undefined;

/** Internal — called by `AmqpPublisher` during module init. Not exported via
 *  the module barrel. */
export function setAmqpPublisher(publisher: AmqpPublisher): void {
  publisherRef = publisher;
}

class BoundAmqpQueue implements AmqpQueue {
  constructor(
    private readonly publisher: AmqpPublisher,
    private readonly address: string,
  ) {}

  send<TRes>(payload: unknown, options?: SendOptions): Observable<TRes> {
    return this.publisher.send<TRes>(this.address, payload, options);
  }

  emit(payload: unknown, options?: EmitOptions): void {
    this.publisher.emit(this.address, payload, options);
  }
}

class BoundAmqpTopic implements AmqpTopic {
  constructor(
    private readonly publisher: AmqpPublisher,
    private readonly address: string,
  ) {}

  emit(payload: unknown, options?: EmitOptions): void {
    this.publisher.emit(this.address, payload, options);
  }
}

function resolvePublisher(decoratorName: string, address: string): AmqpPublisher {
  if (publisherRef === undefined) {
    throw new Error(
      `@${decoratorName}('${address}'): the AMQP module has not initialised yet - ` +
        `the publisher singleton is unavailable. This usually means the ` +
        `decorated property was accessed from a constructor or another ` +
        `path that runs before NestJS lifecycle hooks. Defer the call to ` +
        `OnModuleInit / OnApplicationBootstrap or to a normal method invocation.`,
    );
  }
  return publisherRef;
}

// ---------------------------------------------------------------------------
// Property decorators
// ---------------------------------------------------------------------------

/**
 * Inject an {@link AmqpQueue} handle bound to a **work-queue** address.
 * Property decorator. First access reads the publisher singleton from the
 * module registry; subsequent accesses reuse a memoised handle.
 *
 * Usage:
 * ```ts
 * @AmqpQueue('orders.create')
 * private readonly orders!: AmqpQueue;
 *
 * createOrder(body: OrderBody): Observable<OrderConfirmation> {
 *   return this.orders.send<OrderConfirmation>(body, { timeoutMs: 5000 });
 * }
 * ```
 *
 * For broadcast / pub-sub semantics, use {@link AmqpTopic} instead.
 */
export function AmqpQueue(address: string): PropertyDecorator {
  return (target, propertyKey) => {
    Object.defineProperty(target, propertyKey, {
      configurable: true,
      enumerable: true,
      get(this: object): AmqpQueue {
        const handle = new BoundAmqpQueue(resolvePublisher('AmqpQueue', address), address);
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
 * (stream-backed). Only exposes `emit()` — request/reply doesn't apply to
 * broadcast.
 *
 * Usage:
 * ```ts
 * @AmqpTopic('changes.bulletin')
 * private readonly changes!: AmqpTopic;
 *
 * notifyChange(id: string): void {
 *   this.changes.emit({ id, when: new Date().toISOString() });
 * }
 * ```
 *
 * For work-queue semantics, use {@link AmqpQueue} instead.
 */
export function AmqpTopic(address: string): PropertyDecorator {
  return (target, propertyKey) => {
    Object.defineProperty(target, propertyKey, {
      configurable: true,
      enumerable: true,
      get(this: object): AmqpTopic {
        const handle = new BoundAmqpTopic(resolvePublisher('AmqpTopic', address), address);
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
