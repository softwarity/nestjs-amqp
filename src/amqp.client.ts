import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import rhea from 'rhea';
import type { Connection, Message, Receiver, Sender } from 'rhea';
import { BehaviorSubject, EMPTY, Observable, ReplaySubject, Subject } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import { AmqpConnectionError } from './amqp.errors';
import { AMQP_MODULE_OPTIONS, type ResolvedAmqpModuleOptions } from './amqp.options';
import type { IncomingMessage, StreamOffset } from './amqp.types';
import { normalizeIncoming, toRheaOutgoing } from './rhea-adapter';

/**
 * Low-level rhea wrapper. Owns the single AMQP 1.0 Connection, the receiver
 * on the shared reply stream (filtered by a per-process correlation prefix)
 * and a per-address sender pool. Higher-level services (`AmqpPublisher`,
 * `AmqpConsumerExplorer`) compose Observables on top of this.
 *
 * Topology is fully static — declared broker-side (e.g. RabbitMQ
 * `definitions.json`), no Management API call at runtime. `OnModuleInit`
 * opens the connection; rhea handles reconnects transparently — receivers
 * and senders re-attach on the same JS objects.
 */
@Injectable()
export class AmqpClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AmqpClient.name);

  private connection?: Connection;
  private replyReceiver?: Receiver;
  private readonly senders = new Map<string, Sender>();

  /** Per-process correlation prefix. Reply messages whose `correlation_id`
   *  does not start with `${replyPrefix}:` belong to another instance and are
   *  accept-and-dropped (the stream offset advances). Generated once at
   *  construction; stable across reconnects. */
  readonly replyPrefix = randomUUID();

  /** Emits true on `connection_open`, false on `disconnected`. Seeded false. */
  private readonly connectedSubject = new BehaviorSubject<boolean>(false);
  /** The reply-to address (the static stream). Emitted once on first
   *  `connection_open`. Never emits if no reply stream is configured. */
  private readonly replyAddressSubject = new ReplaySubject<string>(1);
  /** Reply messages addressed to *this* process (filtered by prefix in the
   *  receiver's `message` handler). `AmqpPublisher` correlates each entry by
   *  `correlation_id` to route to the right pending Subject. */
  private readonly repliesSubject = new Subject<IncomingMessage>();

  readonly connected$ = this.connectedSubject.asObservable();
  readonly replyToAddress$ = this.replyAddressSubject.asObservable();
  readonly replies$ = this.repliesSubject.asObservable();

  constructor(@Inject(AMQP_MODULE_OPTIONS) private readonly options: ResolvedAmqpModuleOptions) {}

  /** Expose the resolved options to other internal providers. */
  getOptions(): ResolvedAmqpModuleOptions {
    return this.options;
  }

  onModuleInit(): void {
    if (!this.options.enabled) {
      this.logger.log('AMQP disabled (enabled=false) — module loaded but inactive; send/emit/@Subscribe are no-ops');
      return;
    }
    const url = new URL(this.options.url);
    const conn = rhea.connect({
      host: url.hostname || 'localhost',
      port: url.port ? Number(url.port) : 5672,
      transport: url.protocol === 'amqps:' ? 'tls' : 'tcp',
      username: this.options.username,
      password: this.options.password,
      container_id: this.options.appName || undefined,
      idle_time_out: this.options.idleTimeoutMs,
      reconnect: true,
      reconnect_limit: this.options.reconnectLimit,
      initial_reconnect_delay: this.options.initialReconnectDelayMs,
      max_reconnect_delay: this.options.maxReconnectDelayMs,
    });
    this.connection = conn;

    conn.on('connection_open', () => {
      this.logger.log(`connection_open to ${this.options.url}`);
      this.connectedSubject.next(true);
      if (this.options.replyStreamAddress) this.openReplyReceiver(conn);
    });
    conn.on('disconnected', () => {
      this.logger.warn(`disconnected — rhea will retry (limit=${this.options.reconnectLimit})`);
      this.connectedSubject.next(false);
    });
    conn.on('connection_close', () => this.logger.log('connection_close'));
    conn.on('connection_error', (ctx) => {
      this.logger.error(`connection_error: ${describeAmqpError(extractAmqpError(ctx))}`);
    });
    conn.on('error', (ctx) => {
      this.logger.warn(`error event: ${describeAmqpError(extractAmqpError(ctx))}`);
    });
  }

  /**
   * Observable of incoming messages on `address`. Subscribing opens a receiver,
   * unsubscribing closes it. Waits for connection-open before opening — so safe
   * to subscribe immediately at module init even if the broker is still down.
   *
   * `opts.streamOffset` positions the consumer on a stream queue via the
   * `rabbitmq:stream-offset-spec` filter. No effect on classic/quorum queues.
   */
  messages$(address: string, opts: { creditWindow: number; streamOffset?: StreamOffset }): Observable<IncomingMessage> {
    if (!this.options.enabled) return EMPTY;
    return new Observable<IncomingMessage>((subscriber) => {
      let receiver: Receiver | undefined;
      const ready = this.connected$.pipe(
        filter((c) => c),
        take(1),
      );
      const sub = ready.subscribe(() => {
        const conn = this.connection;
        if (!conn) {
          subscriber.error(new AmqpConnectionError('AMQP connection vanished'));
          return;
        }
        const source: Parameters<Connection['open_receiver']>[0] = {
          source: {
            address: this.toBrokerAddress(address),
            ...(opts.streamOffset !== undefined && { filter: streamOffsetFilter(opts.streamOffset) }),
          },
          autoaccept: false,
          credit_window: opts.creditWindow,
        };
        receiver = conn.open_receiver(source);
        receiver.on('receiver_open', () => this.logger.debug(`receiver_open '${address}'`));
        receiver.on('message', (ctx) => {
          if (!ctx.message || !ctx.delivery) return;
          subscriber.next({ address, message: normalizeIncoming(ctx.message), delivery: ctx.delivery });
        });
        receiver.on('receiver_error', (ctx) => {
          this.logger.warn(`receiver_error '${address}': ${describeAmqpError(extractAmqpError(ctx))}`);
        });
      });
      return () => {
        sub.unsubscribe();
        if (receiver?.is_open()) receiver.close();
      };
    });
  }

  /**
   * Open a receiver with manual credit control (`credit_window: 0`) on
   * `address`. Used by `DlqBrowserService` to drain N messages at a time.
   * Caller is responsible for `add_credit`, settling each delivery, and
   * closing the receiver. Returns `undefined` if AMQP is disabled or the
   * connection isn't open yet (caller should retry on `connected$`).
   */
  openManualReceiver(address: string): Receiver | undefined {
    if (!this.options.enabled) return undefined;
    const conn = this.connection;
    if (!conn?.is_open()) return undefined;
    return conn.open_receiver({
      source: { address: this.toBrokerAddress(address) },
      autoaccept: false,
      credit_window: 0,
    });
  }

  /**
   * Publish `message` on `address`. Sender pooled per-address. Fire-and-forget
   * at this layer: if the broker is not connected, the call is logged and
   * dropped. Reply correlation is the publisher's concern, not this method's.
   *
   * `message.properties` (the AMQP 1.0 standard properties — `reply_to`,
   * `correlation_id`, `message_id`, `subject`, …) is shaped as a nested object
   * by the public API; `toRheaOutgoing` flattens it before reaching rhea, see
   * the function for why.
   */
  publish(address: string, message: Message): void {
    if (!this.options.enabled) return;
    const conn = this.connection;
    if (!conn?.is_open()) {
      this.logger.warn(`publish to '${address}' dropped — connection not open`);
      return;
    }
    const sender = this.getOrCreateSender(conn, this.toBrokerAddress(address));
    sender.send(toRheaOutgoing(message));
  }

  private openReplyReceiver(conn: Connection): void {
    if (this.replyReceiver?.is_open()) return;
    const replyStream = this.options.replyStreamAddress;
    if (!replyStream) return;
    const address = this.toBrokerAddress(replyStream);
    // Subscribe to the broadcast reply stream starting at the most recent
    // offset (`next` = only messages produced AFTER our attach). A reconnect
    // re-opens with `next` again — replies that arrived during the gap are
    // lost; the calling `send()` times out (acceptable).
    const receiver = conn.open_receiver({
      source: { address, filter: streamOffsetFilter('next') },
      autoaccept: false,
      credit_window: 100,
    });
    this.replyReceiver = receiver;
    const prefixMatch = `${this.replyPrefix}:`;
    receiver.on('receiver_open', () => {
      this.logger.log(`reply receiver attached: ${address} (prefix=${this.replyPrefix})`);
      this.replyAddressSubject.next(address);
    });
    receiver.on('message', (ctx) => {
      if (!ctx.message || !ctx.delivery) return;
      const message = normalizeIncoming(ctx.message);
      const corrId = message.properties?.correlation_id;
      if (typeof corrId !== 'string' || !corrId.startsWith(prefixMatch)) {
        ctx.delivery.accept();
        return;
      }
      this.repliesSubject.next({ address, message, delivery: ctx.delivery });
    });
    receiver.on('receiver_error', (ctx) => {
      this.logger.warn(`reply receiver_error: ${describeAmqpError(extractAmqpError(ctx))}`);
    });
    receiver.on('receiver_close', (ctx) => {
      const err = extractAmqpError(ctx);
      if (err) this.logger.warn(`reply receiver closed by peer: ${describeAmqpError(err)}`);
    });
  }

  private getOrCreateSender(conn: Connection, address: string): Sender {
    const existing = this.senders.get(address);
    if (existing?.is_open()) return existing;
    const sender = conn.open_sender({ target: { address } });
    sender.on('sender_open', () => this.logger.debug(`sender_open '${address}'`));
    sender.on('sender_error', (ctx) => {
      this.logger.warn(`sender_error '${address}': ${describeAmqpError(extractAmqpError(ctx))}`);
    });
    sender.on('rejected', (ctx) => {
      const err = extractAmqpError(ctx);
      this.logger.warn(`message rejected on '${address}': ${describeAmqpError(err)}`);
    });
    this.senders.set(address, sender);
    return sender;
  }

  onModuleDestroy(): void {
    if (!this.options.enabled) return;
    this.logger.log('shutting down');
    this.senders.forEach((sender) => {
      if (sender.is_open()) sender.close();
    });
    this.senders.clear();
    if (this.replyReceiver?.is_open()) this.replyReceiver.close();
    if (this.connection?.is_open()) this.connection.close();
    this.connectedSubject.complete();
    this.replyAddressSubject.complete();
    this.repliesSubject.complete();
  }

  /**
   * Normalise a user-facing address (a bare name) to the broker-specific
   * scheme. With `autoPrefixQueues: true` (default), bare names become
   * `/queues/<name>` (RabbitMQ 4.x v2 addressing). Already-prefixed
   * addresses (`/queues/...`, `/exchanges/...`, `/topic/...`) always pass
   * through unchanged.
   */
  private toBrokerAddress(address: string): string {
    if (!this.options.autoPrefixQueues) return address;
    if (address.startsWith('/')) return address;
    return `/queues/${address}`;
  }
}

/** Build the AMQP 1.0 filter set positioning a stream consumer at the given
 *  offset. The RabbitMQ-specific `rabbitmq:stream-offset-spec` descriptor
 *  accepts the named values `'first' | 'last' | 'next'`, a numeric offset,
 *  or a `Date` (interpreted as absolute timestamp). */
function streamOffsetFilter(offset: StreamOffset): Record<string, unknown> {
  const value = offset instanceof Date ? offset.getTime() : offset;
  return {
    'rabbitmq:stream-offset-spec': {
      descriptor: 'rabbitmq:stream-offset-spec',
      value,
    },
  };
}

/** AMQP errors hide on different paths of the rhea EventContext depending on
 *  which link/peer triggered them. */
function extractAmqpError(ctx: unknown): unknown {
  if (!ctx || typeof ctx !== 'object') return undefined;
  const c = ctx as Record<string, unknown>;
  if (looksLikeAmqpError(c.error)) return c.error;
  for (const key of ['receiver', 'sender', 'connection', 'session', 'delivery'] as const) {
    const node = c[key] as Record<string, unknown> | undefined;
    if (!node) continue;
    if (looksLikeAmqpError(node.error)) return node.error;
    const remote = (node as { remote_state?: { error?: unknown } }).remote_state;
    if (remote && looksLikeAmqpError(remote.error)) return remote.error;
  }
  return undefined;
}

function looksLikeAmqpError(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return typeof e.condition === 'string' || typeof e.description === 'string';
}

function describeAmqpError(err: unknown): string {
  if (err === null || err === undefined) return 'unknown';
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const e = err as { condition?: string; description?: string };
    if (e.condition && e.description) return `${e.condition} - ${e.description}`;
    return e.description ?? e.condition ?? JSON.stringify(err);
  }
  return JSON.stringify(err);
}
