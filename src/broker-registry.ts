import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AMQP_MODULE_OPTIONS, type ResolvedAmqpModuleOptions } from './amqp.options';
import { setAmqpBrokerRegistry } from './amqp.queue';
import { BrokerConnection } from './broker-connection';
import { BrokerPublisher } from './broker-publisher';

/**
 * Central registry for all broker connections + publishers in the running
 * process. Built from the resolved broker list at module init time —
 * instantiates one {@link BrokerConnection} and one {@link BrokerPublisher}
 * per broker, opens every connection, and exposes a lookup API for the
 * rest of the library (decorators, locator, consumer-explorer, DLQ admin).
 *
 * Single-broker friendliness: when only one broker is configured, callers
 * can omit the `brokerName` argument and `getDefault()` resolves to it.
 * With several brokers, `getDefault()` returns the **first** entry in the
 * declared `brokers[]` array (also used as the URL fallback for the DLQ
 * admin routes).
 */
@Injectable()
export class BrokerRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrokerRegistry.name);

  private readonly connections = new Map<string, BrokerConnection>();
  private readonly publishers = new Map<string, BrokerPublisher>();

  constructor(@Inject(AMQP_MODULE_OPTIONS) private readonly options: ResolvedAmqpModuleOptions) {
    for (const [name, brokerOpts] of options.brokers) {
      const connection = new BrokerConnection(brokerOpts);
      this.connections.set(name, connection);
      this.publishers.set(name, new BrokerPublisher(connection));
    }
    // Hand the registry to the property-decorator singleton so `@AmqpQueue` /
    // `@AmqpTopic` can resolve a publisher on first property access. Done in
    // the constructor (not onModuleInit) so the registry is ready before any
    // other provider's onModuleInit could trigger a property access.
    setAmqpBrokerRegistry(this);
  }

  onModuleInit(): void {
    if (this.options.brokers.size === 0) {
      this.logger.warn('no brokers configured — AmqpModule is a no-op');
      return;
    }
    const enabled: string[] = [];
    const disabled: string[] = [];
    for (const name of this.options.brokerOrder) {
      (this.options.brokers.get(name)!.enabled ? enabled : disabled).push(name);
    }
    const summary = [
      enabled.length > 0 ? `enabled: [${enabled.join(', ')}]` : null,
      disabled.length > 0 ? `disabled: [${disabled.join(', ')}]` : null,
    ]
      .filter(Boolean)
      .join(', ');
    this.logger.log(`bringing up ${this.options.brokers.size} broker(s) — ${summary}`);
    for (const connection of this.connections.values()) {
      connection.start();
    }
    for (const publisher of this.publishers.values()) {
      publisher.start();
    }
  }

  onModuleDestroy(): void {
    for (const publisher of this.publishers.values()) publisher.stop();
    for (const connection of this.connections.values()) connection.stop();
    this.publishers.clear();
    this.connections.clear();
  }

  /** Return the broker connection registered under `name`. Throws if unknown. */
  getConnection(name: string): BrokerConnection {
    const conn = this.connections.get(name);
    if (!conn) {
      throw new Error(
        `Broker '${name}' is not configured. Known brokers: [${[...this.connections.keys()].join(', ')}]`,
      );
    }
    return conn;
  }

  /** Return the broker publisher registered under `name`. Throws if unknown. */
  getPublisher(name: string): BrokerPublisher {
    const pub = this.publishers.get(name);
    if (!pub) {
      throw new Error(`Broker '${name}' is not configured. Known brokers: [${[...this.publishers.keys()].join(', ')}]`);
    }
    return pub;
  }

  /**
   * Return the broker connection a decorator with no explicit `brokerName`
   * should bind to. When only one broker is configured this is unambiguous;
   * when several are, the **first** broker (insertion order in the original
   * `brokers[]` array) wins. Throws if no brokers are configured.
   */
  getDefaultConnection(): BrokerConnection {
    return this.getConnection(this.getDefaultName());
  }

  /** Same as {@link getDefaultConnection} for the publisher. */
  getDefaultPublisher(): BrokerPublisher {
    return this.getPublisher(this.getDefaultName());
  }

  /** Name of the broker returned by `getDefault*()`. */
  getDefaultName(): string {
    const first = this.options.brokerOrder[0];
    if (!first) throw new Error('AmqpModule has no brokers configured');
    return first;
  }

  /** Whether the registry holds a single broker — when true, decorators may
   *  omit the broker argument and resolve via `getDefault*()`. */
  isSingle(): boolean {
    return this.connections.size === 1;
  }

  /** All broker names in declaration order. */
  names(): string[] {
    return [...this.options.brokerOrder];
  }

  /**
   * Resolve a broker name to a connection. If `name` is undefined and a
   * single broker is configured, the lone broker is returned. With several
   * brokers and no explicit name, throws — callers must disambiguate.
   */
  resolveConnection(name: string | undefined): BrokerConnection {
    if (name !== undefined) return this.getConnection(name);
    if (this.isSingle()) return this.getDefaultConnection();
    throw new Error(
      `Multiple brokers configured ([${this.names().join(', ')}]) — a broker name is required. ` +
        `Pass it explicitly: e.g. @AmqpQueue('addr', 'primary').`,
    );
  }

  /**
   * Resolve a broker name to a publisher. Same semantics as
   * {@link resolveConnection} but returns the publisher.
   */
  resolvePublisher(name: string | undefined): BrokerPublisher {
    if (name !== undefined) return this.getPublisher(name);
    if (this.isSingle()) return this.getDefaultPublisher();
    throw new Error(
      `Multiple brokers configured ([${this.names().join(', ')}]) — a broker name is required. ` +
        `Pass it explicitly: e.g. @AmqpQueue('addr', 'primary').`,
    );
  }
}
