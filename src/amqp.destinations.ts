import { Injectable } from '@nestjs/common';
import type { AmqpQueue, AmqpTopic } from './amqp.queue';
import type { EmitOptions, SendOptions } from './amqp.types';
import type { BrokerPublisher } from './broker-publisher';
import { BrokerRegistry } from './broker-registry';
import type { Observable } from 'rxjs';

/**
 * Runtime equivalent of the `@AmqpQueue` / `@AmqpTopic` property decorators.
 * Inject this service when you need a publish handle for an address that
 * isn't known at compile time — e.g. tenant-scoped queues, multi-route
 * dispatchers, dynamic broker selection.
 *
 * `brokerName` is optional when a single broker is configured. With several
 * brokers, omitting it throws.
 *
 * ```ts
 * @Injectable()
 * export class DynamicPublisher {
 *   constructor(private readonly amqp: AmqpDestinations) {}
 *
 *   publish(tenantId: string, body: OrderBody): void {
 *     this.amqp.queue<OrderBody>(`orders.${tenantId}`, 'primary').emit(body);
 *   }
 * }
 * ```
 */
@Injectable()
export class AmqpDestinations {
  constructor(private readonly registry: BrokerRegistry) {}

  /** Return an {@link AmqpQueue} handle for `address` on the given broker. */
  queue<T = unknown>(address: string, brokerName?: string): AmqpQueue<T> {
    const publisher = this.registry.resolvePublisher(brokerName);
    return new LocatedAmqpQueue<T>(publisher, address);
  }

  /** Return an {@link AmqpTopic} handle for `address` on the given broker. */
  topic<T = unknown>(address: string, brokerName?: string): AmqpTopic<T> {
    const publisher = this.registry.resolvePublisher(brokerName);
    return new LocatedAmqpTopic<T>(publisher, address);
  }
}

class LocatedAmqpQueue<T> implements AmqpQueue<T> {
  constructor(
    private readonly publisher: BrokerPublisher,
    private readonly address: string,
  ) {}

  send<TRes>(payload: T, options?: SendOptions): Observable<TRes> {
    return this.publisher.send<TRes>(this.address, payload, options);
  }

  emit(payload: T, options?: EmitOptions): boolean {
    return this.publisher.emit(this.address, payload, options);
  }
}

class LocatedAmqpTopic<T> implements AmqpTopic<T> {
  constructor(
    private readonly publisher: BrokerPublisher,
    private readonly address: string,
  ) {}

  emit(payload: T, options?: EmitOptions): boolean {
    return this.publisher.emit(this.address, payload, options);
  }
}
