import type { ModuleMetadata, Type } from '@nestjs/common';
import type { AmqpBodyCodec } from './body-codec';

/**
 * Static configuration passed to `AmqpModule.forRoot(...)`.
 *
 * Broker connection settings + library behaviour. Defaults are conservative:
 * if you don't set anything, the module assumes `amqp://localhost:5672` with
 * no auth, infinite reconnects, and `<appName>.replies` as the shared reply
 * stream.
 *
 * `appName` is mandatory unless you pass `replyStreamAddress` explicitly: it
 * drives both the AMQP container ID (so the broker sees a stable identity)
 * and the default reply-stream / dlq names.
 */
export interface AmqpModuleOptions {
  /**
   * Logical name of the host application — used as the default for
   * `replyStreamAddress` (`${appName}.replies`) and
   * `defaultDlqAddress` (`${appName}.dlq`), and as the AMQP container ID.
   *
   * Required unless every default that depends on it is overridden.
   */
  readonly appName?: string;

  /** Master switch. `false` → the module loads but is inactive (no
   *  connection, `@Subscribe` not wired, `send()` errors, `emit()` is a
   *  silent no-op). Useful for local dev without a running broker.
   *  Default: `true`. */
  readonly enabled?: boolean;

  /** Broker URL (`amqp://` or `amqps://`). Default `amqp://localhost:5672`. */
  readonly url?: string;

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
   * Address of the shared reply stream used by request/reply (`send()`).
   * Default: `${appName}.replies`. **Must be pre-declared broker-side as a
   * stream queue.** If neither this nor `appName` is provided, `send()` is
   * unavailable and throws `AmqpConnectionError`.
   */
  readonly replyStreamAddress?: string;

  /**
   * Default DLQ address used by the optional `DlqBrowserService` when no
   * address is given at the call site. Default: `${appName}.dlq`.
   */
  readonly defaultDlqAddress?: string;

  /**
   * Whether to auto-prefix bare addresses with `/queues/` (RabbitMQ 4.x v2
   * addressing). Already-prefixed addresses (`/queues/...`, `/exchanges/...`,
   * `/topic/...`) always pass through unchanged. Set to `false` for brokers
   * that accept bare names (Artemis, Qpid, Azure SB). Default `true`.
   */
  readonly autoPrefixQueues?: boolean;

  /**
   * Custom wire codec. Default: JSON with `Date` round-trip and ObjectId
   * duck-typing on encode. Provide your own implementation for msgpack,
   * protobuf, mongoose ObjectId rehydration, etc.
   */
  readonly bodyCodec?: AmqpBodyCodec;
}

/** Resolved options — every default has been filled. Internal use. */
export interface ResolvedAmqpModuleOptions {
  readonly appName: string;
  readonly enabled: boolean;
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
  readonly autoPrefixQueues: boolean;
  readonly bodyCodec?: AmqpBodyCodec;
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

/** Injection token for the resolved options. */
export const AMQP_MODULE_OPTIONS = Symbol('AMQP_MODULE_OPTIONS');

/**
 * Apply defaults. Validates the minimum required: if neither `appName` nor
 * `replyStreamAddress` is given, request/reply is disabled (caller can still
 * use `emit()` and `@Subscribe`).
 */
export function resolveAmqpOptions(opts: AmqpModuleOptions): ResolvedAmqpModuleOptions {
  const appName = opts.appName ?? '';
  const replyStreamAddress = opts.replyStreamAddress ?? (appName ? `${appName}.replies` : undefined);
  const defaultDlqAddress = opts.defaultDlqAddress ?? (appName ? `${appName}.dlq` : undefined);
  return {
    appName,
    enabled: opts.enabled ?? true,
    url: opts.url ?? 'amqp://localhost:5672',
    username: opts.username,
    password: opts.password,
    reconnectLimit: opts.reconnectLimit ?? -1,
    initialReconnectDelayMs: opts.initialReconnectDelayMs ?? 100,
    maxReconnectDelayMs: opts.maxReconnectDelayMs ?? 30000,
    idleTimeoutMs: opts.idleTimeoutMs ?? 60000,
    defaultSendTimeoutMs: opts.defaultSendTimeoutMs ?? 30000,
    replyStreamAddress,
    defaultDlqAddress,
    autoPrefixQueues: opts.autoPrefixQueues ?? true,
    bodyCodec: opts.bodyCodec,
  };
}
