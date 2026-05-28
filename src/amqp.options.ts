import type { ModuleMetadata, Type } from '@nestjs/common';
import type { AmqpBodyCodec } from './body-codec';

/**
 * Static configuration passed to `AmqpModule.forRoot(...)`.
 *
 * The module supports one OR several brokers — declared as an array of
 * {@link BrokerOptions}. Each broker is independent: its own connection,
 * its own reply stream, its own DLQ, its own body codec, its own retry
 * timings. Decorators reference brokers by their `name`.
 *
 * If you only have one broker, the `brokerName` argument on
 * `@AmqpQueue` / `@AmqpTopic` / `@Consume` / `@Subscribe` is
 * optional — the lone broker is resolved automatically.
 */
export interface AmqpModuleOptions {
  /** Brokers to connect to. Must contain at least one entry; names must be
   *  unique. */
  readonly brokers: BrokerOptions[];

  /** Global kill switch. `false` → the module loads but every broker is
   *  inactive (no connection, consumers not wired, `send()` errors,
   *  `emit()` is a silent no-op). Useful for local dev without a running
   *  broker. Default: `true`. */
  readonly enabled?: boolean;
}

/**
 * Per-broker connection settings + library behaviour. All fields except
 * `name` and `url` are optional. Conservative defaults: infinite reconnects,
 * 60s idle timeout, 30s send timeout, JSON body codec.
 */
export interface BrokerOptions {
  /** Unique logical identifier referenced by decorators and the DLQ admin
   *  path. Required, non-empty, must be unique across all brokers. */
  readonly name: string;

  /** Broker URL (`amqp://` or `amqps://`). Required. */
  readonly url: string;

  /** SASL PLAIN username. */
  readonly username?: string;

  /** SASL PLAIN password. */
  readonly password?: string;

  /** Reconnect attempts; `-1` = forever (rhea exponential backoff). Default `-1`. */
  readonly reconnectLimit?: number;

  /** First retry delay in ms; doubles up to max. Default `100`. */
  readonly initialReconnectDelayMs?: number;

  /** Ceiling for the exponential backoff in ms. Default `30000`. */
  readonly maxReconnectDelayMs?: number;

  /** Heartbeat / idle detection in ms. Default `60000`. */
  readonly idleTimeoutMs?: number;

  /** Default reply timeout for `send()` in ms. Default `30000`. */
  readonly defaultSendTimeoutMs?: number;

  /**
   * Address of the shared reply stream used by request/reply (`send()`) on
   * this broker. **Must be pre-declared broker-side as a stream queue.**
   * Optional — if absent, `send()` on this broker throws
   * `AmqpConnectionError` (only `emit()` and consumers remain available).
   */
  readonly replyStreamAddress?: string;

  /**
   * Default DLQ address — used by the optional `DlqBrowserService` to
   * pre-fill the admin UI and as a convention indicator at boot. The
   * consumer never publishes to this address itself: when a `@Consume`
   * with `{ dlq: true }` exhausts its retries the lib calls
   * `delivery.reject()` and the broker routes via its own DLX configuration.
   * Optional — declare it only if you've set up a DLQ broker-side.
   */
  readonly defaultDlqAddress?: string;

  /**
   * Custom wire codec for messages on this broker. Default: JSON with `Date`
   * round-trip and ObjectId duck-typing on encode. Provide your own
   * implementation for msgpack, protobuf, mongoose ObjectId rehydration, etc.
   * Per-broker so a primary broker can speak JSON while an analytics broker
   * speaks msgpack.
   */
  readonly bodyCodec?: AmqpBodyCodec;
}

/** Resolved broker options — every default has been filled. Internal use. */
export interface ResolvedBrokerOptions {
  readonly name: string;
  readonly url: string;
  readonly username?: string;
  readonly password?: string;
  readonly reconnectLimit: number;
  readonly initialReconnectDelayMs: number;
  readonly maxReconnectDelayMs: number;
  readonly idleTimeoutMs: number;
  readonly defaultSendTimeoutMs: number;
  readonly replyStreamAddress?: string;
  readonly defaultDlqAddress?: string;
  readonly bodyCodec?: AmqpBodyCodec;
}

/** Resolved root options — defaults applied, brokers indexed by name. */
export interface ResolvedAmqpModuleOptions {
  readonly enabled: boolean;
  readonly brokers: ReadonlyMap<string, ResolvedBrokerOptions>;
  /** Insertion order preserved — index 0 is the "first" broker, used as the
   *  default by single-broker decorators and by the DLQ admin URL fallback. */
  readonly brokerOrder: ReadonlyArray<string>;
}

/** Factory contract for `AmqpModule.forRootAsync({ useClass })`. */
export interface AmqpOptionsFactory {
  createAmqpOptions(): Promise<AmqpModuleOptions> | AmqpModuleOptions;
}

/** Options for `AmqpModule.forRootAsync(...)`. Mirrors the NestJS standard
 *  pattern (useFactory / useClass / useExisting). */
export interface AmqpModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  readonly useExisting?: Type<AmqpOptionsFactory>;
  readonly useClass?: Type<AmqpOptionsFactory>;
  readonly useFactory?: (...args: any[]) => Promise<AmqpModuleOptions> | AmqpModuleOptions;
  readonly inject?: any[];
}

/** Injection token for the resolved root options. */
export const AMQP_MODULE_OPTIONS = Symbol('AMQP_MODULE_OPTIONS');

/**
 * Apply defaults and validate. Throws if:
 *   - `brokers` is missing or empty
 *   - any broker has an empty `name` or `url`
 *   - two brokers share the same `name`
 */
export function resolveAmqpOptions(opts: AmqpModuleOptions): ResolvedAmqpModuleOptions {
  if (!opts.brokers || opts.brokers.length === 0) {
    throw new Error('AmqpModule: `brokers` is required and must contain at least one entry');
  }
  const byName = new Map<string, ResolvedBrokerOptions>();
  const order: string[] = [];
  for (const broker of opts.brokers) {
    if (!broker.name || broker.name.trim().length === 0) {
      throw new Error('AmqpModule: every broker requires a non-empty `name`');
    }
    if (!broker.url || broker.url.trim().length === 0) {
      throw new Error(`AmqpModule: broker '${broker.name}' requires a non-empty \`url\``);
    }
    if (byName.has(broker.name)) {
      throw new Error(`AmqpModule: duplicate broker name '${broker.name}' — names must be unique`);
    }
    const resolved: ResolvedBrokerOptions = {
      name: broker.name,
      url: broker.url,
      username: broker.username,
      password: broker.password,
      reconnectLimit: broker.reconnectLimit ?? -1,
      initialReconnectDelayMs: broker.initialReconnectDelayMs ?? 100,
      maxReconnectDelayMs: broker.maxReconnectDelayMs ?? 30000,
      idleTimeoutMs: broker.idleTimeoutMs ?? 60000,
      defaultSendTimeoutMs: broker.defaultSendTimeoutMs ?? 30000,
      replyStreamAddress: broker.replyStreamAddress,
      defaultDlqAddress: broker.defaultDlqAddress,
      bodyCodec: broker.bodyCodec,
    };
    byName.set(broker.name, resolved);
    order.push(broker.name);
  }
  return {
    enabled: opts.enabled ?? true,
    brokers: byName,
    brokerOrder: order,
  };
}
