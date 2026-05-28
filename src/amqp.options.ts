import type { ModuleMetadata, Type } from '@nestjs/common';
import type { AmqpBodyCodec } from './body-codec';

/**
 * Per-broker connection settings + library behaviour. All fields except
 * `name` and `url` are optional. Conservative defaults: infinite reconnects,
 * 60s idle timeout, 30s send timeout, JSON body codec, broker enabled.
 *
 * `AmqpModule.forRoot(...)` accepts either a single `BrokerOptions` (the 90%
 * single-broker case) or an array of them (multi-broker). Each broker is
 * independent: its own connection, its own reply stream, its own DLQ, its
 * own body codec, its own retry timings. Decorators reference brokers by
 * their `name`.
 *
 * If you only have one broker, the `brokerName` argument on
 * `@AmqpQueue` / `@AmqpTopic` / `@Consume` / `@Subscribe` is
 * optional — the lone broker is resolved automatically.
 */
export interface BrokerOptions {
  /** Unique logical identifier referenced by decorators and the DLQ admin
   *  path. Required, non-empty, must be unique across all brokers. */
  readonly name: string;

  /** Broker URL (`amqp://` or `amqps://`). Required. */
  readonly url: string;

  /** Kill switch for this broker. `false` → loaded but inactive (no
   *  connection, consumers not wired, `send()` errors, `emit()` returns
   *  `false`). Useful for local dev without a running broker, or to disable
   *  one broker in a multi-broker setup. Default: `true`. */
  readonly enabled?: boolean;

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

  /**
   * Emit a broker-side topology manifest at boot. On the first
   * `connection_open`, the library detects the peer's brand and writes a
   * ready-to-merge snippet to `os.tmpdir()/amqp-topology/<name>.<brand>.<ext>`
   * listing every queue / stream / DLX / DLQ this service expects to find
   * broker-side. Format depends on the brand: RabbitMQ JSON, Artemis XML,
   * Azure SB bash, Qpid JSON, generic text fallback for unknown peers.
   *
   * Default `false`. When disabled, the broker logs a one-line hint at boot
   * so the feature stays discoverable.
   */
  readonly emitTopologyManifest?: boolean;
}

/** Resolved broker options — every default has been filled. Internal use. */
export interface ResolvedBrokerOptions {
  readonly name: string;
  readonly url: string;
  readonly enabled: boolean;
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
  readonly emitTopologyManifest: boolean;
}

/** Resolved root options — defaults applied, brokers indexed by name. */
export interface ResolvedAmqpModuleOptions {
  readonly brokers: ReadonlyMap<string, ResolvedBrokerOptions>;
  /** Insertion order preserved — index 0 is the "first" broker, used as the
   *  default by single-broker decorators and by the DLQ admin URL fallback. */
  readonly brokerOrder: ReadonlyArray<string>;
}

/**
 * Single-broker form of {@link BrokerOptions} — the `name` field is omitted
 * because it isn't referenced by anything in the single-broker case (the
 * lone broker is resolved automatically by decorators and the locator). The
 * library internally uses the name `'default'`.
 *
 * If you want a custom broker name (visible as the AMQP container ID on the
 * broker's management UI, and used in the DLQ admin URL), switch to the
 * multi-broker form by wrapping in an array — even with a single entry:
 * `AmqpModule.forRoot([{ name: 'my-svc', url, ... }])`.
 */
export type SingleBrokerOptions = Omit<BrokerOptions, 'name'>;

/** Factory contract for `AmqpModule.forRootAsync({ useClass })`. Returns one
 *  or several broker configurations (same shape as the static `forRoot` arg). */
export interface AmqpOptionsFactory {
  createAmqpOptions():
    | Promise<SingleBrokerOptions | BrokerOptions[]>
    | SingleBrokerOptions
    | BrokerOptions[];
}

/** Options for `AmqpModule.forRootAsync(...)`. Mirrors the NestJS standard
 *  pattern (useFactory / useClass / useExisting). The factory returns one or
 *  several broker configurations — same shape as the static `forRoot` arg. */
export interface AmqpModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  readonly useExisting?: Type<AmqpOptionsFactory>;
  readonly useClass?: Type<AmqpOptionsFactory>;
  readonly useFactory?: (
    ...args: any[]
  ) =>
    | Promise<SingleBrokerOptions | BrokerOptions[]>
    | SingleBrokerOptions
    | BrokerOptions[];
  readonly inject?: any[];
}

/** Injection token for the resolved root options. */
export const AMQP_MODULE_OPTIONS = Symbol('AMQP_MODULE_OPTIONS');

/** Internal default broker name used when `forRoot` receives a single broker
 *  config (the `name` field is omitted in that form). */
const DEFAULT_BROKER_NAME = 'default';

/**
 * Normalise + apply defaults. Accepts a single broker (`name`-less, the 90%
 * case → internally renamed to `'default'`) or an array of `BrokerOptions`
 * (multi-broker, names required). Throws if:
 *   - input is an empty array
 *   - any broker (in the array form) has an empty `name` or `url`
 *   - two brokers share the same `name`
 *   - the single broker has an empty `url`
 */
export function resolveAmqpOptions(opts: SingleBrokerOptions | BrokerOptions[]): ResolvedAmqpModuleOptions {
  const list: BrokerOptions[] = Array.isArray(opts) ? opts : [{ name: DEFAULT_BROKER_NAME, ...opts }];
  if (list.length === 0) {
    throw new Error('AmqpModule: at least one broker must be configured');
  }
  const byName = new Map<string, ResolvedBrokerOptions>();
  const order: string[] = [];
  for (const broker of list) {
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
      enabled: broker.enabled ?? true,
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
      emitTopologyManifest: broker.emitTopologyManifest ?? false,
    };
    byName.set(broker.name, resolved);
    order.push(broker.name);
  }
  return {
    brokers: byName,
    brokerOrder: order,
  };
}
