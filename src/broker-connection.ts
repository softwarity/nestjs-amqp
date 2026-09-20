import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import rhea from 'rhea';
import type { Connection, EventContext, Message, Receiver, Sender } from 'rhea';
import { BehaviorSubject, EMPTY, Observable, ReplaySubject, Subject } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import { AmqpConnectionError, AmqpPublishError } from './amqp.errors';
import type { ResolvedBrokerOptions } from './amqp.options';
import type { IncomingMessage, StreamOffset } from './amqp.types';
import { type AmqpBodyCodec, defaultBodyCodec } from './body-codec';
import { normalizeIncoming, toRheaOutgoing } from './rhea-adapter';
import type { ExpectedDestination } from './topology-manifest';

/** Brand reported by the peer in its AMQP Open frame `properties.product`
 *  field. Used for diagnostics and to gate broker-specific features
 *  (delayed redelivery in 0.3.x). `'unknown'` means we couldn't recognise
 *  the product string — falls back to AMQP-standard behaviour everywhere. */
export type BrokerBrand = 'rabbitmq' | 'artemis' | 'qpid' | 'unknown';

/** The four AMQP 1.0 delivery outcomes a publisher can be told about.
 *  `'accepted'` is the only success: every target queue took the message
 *  (on a quorum queue, a majority of replicas wrote it to disk). */
type DeliveryOutcome = 'accepted' | 'released' | 'rejected' | 'modified';

/** One caller blocked on `publishConfirmed()`, waiting for the broker's
 *  verdict on a single delivery. */
interface PendingConfirm {
  /** User-facing address — what the error message quotes (not the
   *  broker-specific form `toBrokerAddress` produces). */
  readonly address: string;
  /** The link the delivery went out on, so a `sender_error` can fail exactly
   *  the callers that link was carrying. */
  readonly sender: Sender;
  /** Resolve the caller: no argument completes it, an error fails it. */
  readonly settle: (error?: AmqpPublishError) => void;
}

/**
 * Low-level rhea wrapper for **one** broker. Owns the single AMQP 1.0
 * Connection, the receiver on the shared reply stream (filtered by a
 * per-process correlation prefix), a per-address sender pool, and the
 * body codec used to (de)serialise message bodies on this broker.
 *
 * Topology is fully static — declared broker-side, no Management API call
 * at runtime. `start()` opens the connection; rhea handles reconnects
 * transparently. The instance is constructed by `BrokerRegistry` — not a
 * NestJS provider on its own.
 */
export class BrokerConnection {
  private readonly logger: Logger;

  private connection?: Connection;
  private replyReceiver?: Receiver;
  private readonly senders = new Map<string, Sender>();

  /** In-flight confirmed publishes, keyed by `<broker address>#<delivery id>`
   *  — the correlation the broker's disposition frames carry back. An entry
   *  exists only between `sender.send()` and the verdict (or the caller
   *  unsubscribing); `emit()` never registers one. */
  private readonly pendingConfirms = new Map<string, PendingConfirm>();
  /** Every in-flight confirmed publish, including those still waiting for
   *  credit on their link (no delivery id yet). Lets a `disconnected` or a
   *  shutdown fail them all rather than leave callers hanging. */
  private readonly inFlightConfirms = new Set<PendingConfirm>();

  private brandDetected: BrokerBrand = 'unknown';
  private brandProduct?: string;
  private brandVersion?: string;

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
   *  receiver's `message` handler). The publisher correlates each entry by
   *  `correlation_id` to route to the right pending Subject. */
  private readonly repliesSubject = new Subject<IncomingMessage>();

  readonly connected$ = this.connectedSubject.asObservable();
  readonly replyToAddress$ = this.replyAddressSubject.asObservable();
  readonly replies$ = this.repliesSubject.asObservable();

  private readonly codec: AmqpBodyCodec;

  /** Destinations this broker is expected to consume from — populated by
   *  `AmqpConsumerExplorer.wire` for each `@Consume` / `@Subscribe`. Drives
   *  the topology manifest output. */
  private readonly expectedDestinations: ExpectedDestination[] = [];

  constructor(readonly options: ResolvedBrokerOptions) {
    this.logger = new Logger(`${BrokerConnection.name}:${options.name}`);
    this.codec = options.bodyCodec ?? defaultBodyCodec;
  }

  /** Register an address the consumer-explorer wired to this broker. Called
   *  once per `@Consume` / `@Subscribe` at module init, before any connection
   *  attempt. */
  registerExpectedDestination(d: ExpectedDestination): void {
    this.expectedDestinations.push(d);
  }

  /** Snapshot of the destinations registered so far. Used by the topology
   *  manifest emitter. */
  getExpectedDestinations(): ReadonlyArray<ExpectedDestination> {
    return this.expectedDestinations;
  }

  /** Brand detected on the peer's Open frame. `'unknown'` until the first
   *  `connection_open` fires (or if the peer doesn't advertise `product`). */
  get brand(): BrokerBrand {
    return this.brandDetected;
  }

  /** Raw product string from the peer's Open frame, if any. */
  get peerProduct(): string | undefined {
    return this.brandProduct;
  }

  /** Raw version string from the peer's Open frame, if any. */
  get peerVersion(): string | undefined {
    return this.brandVersion;
  }

  /** Encode a JS value using the broker's configured body codec. */
  encodeBody(value: unknown): unknown {
    return this.codec.encode(value);
  }

  /** Decode an incoming body using the broker's configured body codec. */
  decodeBody(body: unknown): unknown {
    return this.codec.decode(body);
  }

  /** Open the connection. Called by `BrokerRegistry.onModuleInit`. */
  start(): void {
    if (!this.options.enabled) {
      this.logger.log('AMQP disabled (enabled=false) — broker inactive; send/emit/consumers are no-ops');
      return;
    }
    const url = new URL(this.options.url);
    // Credentials embedded in the URL (`amqp://user:pass@host`) take effect
    // only when explicit `username` / `password` options are unset. Lets
    // callers pass a single connection string without splitting credentials
    // out into separate config keys — a common 12-factor pattern.
    const urlUser = url.username ? decodeURIComponent(url.username) : undefined;
    const urlPass = url.password ? decodeURIComponent(url.password) : undefined;
    const conn = rhea.connect({
      host: url.hostname || 'localhost',
      port: url.port ? Number(url.port) : 5672,
      transport: url.protocol === 'amqps:' ? 'tls' : 'tcp',
      username: this.options.username ?? urlUser,
      password: this.options.password ?? urlPass,
      container_id: this.options.name,
      idle_time_out: this.options.idleTimeoutMs,
      reconnect: true,
      reconnect_limit: this.options.reconnectLimit,
      initial_reconnect_delay: this.options.initialReconnectDelayMs,
      max_reconnect_delay: this.options.maxReconnectDelayMs,
    });
    this.connection = conn;

    conn.on('connection_open', () => {
      this.detectBrand(conn);
      this.logger.log(
        `connection_open to ${this.options.url}${this.brandProduct ? ` (peer: ${this.brandProduct}${this.brandVersion ? ` ${this.brandVersion}` : ''})` : ''}`,
      );
      this.connectedSubject.next(true);
      if (this.options.replyStreamAddress) this.openReplyReceiver(conn);
    });
    conn.on('disconnected', () => {
      this.logger.warn(`disconnected — rhea will retry (limit=${this.options.reconnectLimit})`);
      this.connectedSubject.next(false);
      // Verdicts for deliveries that were in flight will never come back:
      // the session is gone with its delivery ids. Fail those callers now.
      this.failAllConfirms(
        'disconnected',
        `the connection to broker '${this.options.name}' dropped before the broker confirmed the delivery`,
      );
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
          subscriber.error(new AmqpConnectionError(`AMQP connection '${this.options.name}' vanished`));
          return;
        }
        const source: Parameters<Connection['open_receiver']>[0] = {
          source: {
            address: this.toBrokerAddress(address),
            ...(opts.streamOffset !== undefined && this.streamOffsetFilterFor(opts.streamOffset, address)),
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
   * at this layer: if the broker is disabled or not connected, the call is
   * logged and dropped, and we return `false` so the caller can fall back to
   * another transport (in-process bus, local store-and-forward, retry queue,
   * …). Returns `true` once the message has been handed off to rhea's sender
   * — this is a "local emit", not a broker-side ack (the broker may still
   * reject the message later; that surfaces as a sender `rejected` event in
   * the logs). Reply correlation is the publisher's concern, not this
   * method's.
   */
  publish(address: string, message: Message): boolean {
    if (!this.options.enabled) return false;
    const conn = this.connection;
    if (!conn?.is_open()) {
      this.logger.warn(`publish to '${address}' dropped — connection not open`);
      return false;
    }
    const sender = this.getOrCreateSender(conn, this.toBrokerAddress(address));
    sender.send(toRheaOutgoing(message));
    return true;
  }

  /**
   * Publish `message` on `address` and report what the broker did with it.
   * Same sender pool as {@link publish} — the difference is that the
   * `Delivery` is kept and correlated with the broker's disposition frame.
   *
   * The returned Observable is cold (each subscription publishes once, like
   * `send()`), emits a single `void` and completes on `accepted`, and errors
   * with an {@link AmqpPublishError} on anything else: `released` (no queue
   * matched), `rejected`, `modified`, a link failure, a disconnect, or a
   * broker that is disabled / not connected. It never errors on time by
   * itself — the guard delay belongs to the caller (`BrokerPublisher`
   * applies the broker's `confirmTimeoutMs`).
   *
   * When the link has no credit yet the message is **not** handed to rhea:
   * it would go out later, after the caller was already told the publish
   * failed. We wait for the link's `sendable` event instead, so a failed
   * confirm always means nothing was published.
   */
  publishConfirmed(address: string, message: Message): Observable<void> {
    return new Observable<void>((subscriber) => {
      if (!this.options.enabled) {
        subscriber.error(
          new AmqpPublishError(address, 'unsent', `broker '${this.options.name}' is disabled (enabled=false)`),
        );
        return;
      }
      const conn = this.connection;
      if (!conn?.is_open()) {
        subscriber.error(
          new AmqpPublishError(address, 'unsent', `the connection to broker '${this.options.name}' is not open`),
        );
        return;
      }
      const brokerAddress = this.toBrokerAddress(address);
      const sender = this.getOrCreateSender(conn, brokerAddress);
      const pending: PendingConfirm = {
        address,
        sender,
        settle: (error?: AmqpPublishError) => {
          if (subscriber.closed) return;
          if (error) {
            subscriber.error(error);
            return;
          }
          subscriber.next();
          subscriber.complete();
        },
      };
      this.inFlightConfirms.add(pending);

      let key: string | undefined;
      const send = (): void => {
        const delivery = sender.send(toRheaOutgoing(message));
        if (delivery?.id === undefined) {
          // rhea always allocates one; without it there is nothing to
          // correlate the verdict with, so say so rather than hang.
          pending.settle(
            new AmqpPublishError(
              address,
              'unsent',
              'rhea returned a delivery without an id — the broker verdict cannot be correlated',
            ),
          );
          return;
        }
        key = confirmKey(brokerAddress, delivery.id);
        this.pendingConfirms.set(key, pending);
      };

      let onSendable: ((ctx: EventContext) => void) | undefined;
      if (sender.sendable()) {
        send();
      } else {
        // Normal right after attach: the broker's first flow frame is a
        // round-trip away. Also covers broker-side flow control.
        this.logger.debug(`publishConfirmed '${address}' — waiting for credit on the link`);
        onSendable = () => {
          onSendable = undefined;
          send();
        };
        sender.once('sendable', onSendable);
      }

      return () => {
        if (onSendable) sender.removeListener('sendable', onSendable);
        if (key !== undefined) this.pendingConfirms.delete(key);
        this.inFlightConfirms.delete(pending);
      };
    });
  }

  stop(): void {
    if (!this.options.enabled) return;
    this.logger.log('shutting down');
    this.failAllConfirms('unsent', `broker '${this.options.name}' is shutting down`);
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
      source: { address, ...this.streamOffsetFilterFor('next', replyStream) },
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
    // `treat_modified_as_released: false` stops rhea from re-dispatching a
    // `modified` outcome as `released` (its default), so the four AMQP
    // outcomes map one-to-one onto the events below.
    const sender = conn.open_sender({ target: { address }, treat_modified_as_released: false });
    sender.on('sender_open', () => this.logger.debug(`sender_open '${address}'`));
    sender.on('sender_error', (ctx) => {
      const err = extractAmqpError(ctx);
      this.logger.warn(`sender_error '${address}': ${describeAmqpError(err)}`);
      // A link that fails (unknown address, revoked permission, …) will never
      // produce a verdict for what it was carrying — fail those callers now
      // rather than make them sit out the confirm timeout.
      this.failConfirmsOnSender(sender, `the link to '${address}' failed: ${describeAmqpError(err)}`, err);
    });
    // The four delivery outcomes. Only `accepted` means the broker took
    // responsibility for the message; `released` (nothing matched the routing
    // key) is the quiet failure that used to go unnoticed, hence the warn.
    sender.on('accepted', (ctx) => this.settleConfirm(address, ctx, 'accepted'));
    sender.on('released', (ctx) => {
      this.logger.warn(`message released on '${address}' — the broker routed it to no queue`);
      this.settleConfirm(address, ctx, 'released');
    });
    sender.on('rejected', (ctx) => {
      this.logger.warn(`message rejected on '${address}': ${describeAmqpError(extractAmqpError(ctx))}`);
      this.settleConfirm(address, ctx, 'rejected');
    });
    sender.on('modified', (ctx) => {
      this.logger.warn(`message modified on '${address}': ${describeAmqpError(extractAmqpError(ctx))}`);
      this.settleConfirm(address, ctx, 'modified');
    });
    this.senders.set(address, sender);
    return sender;
  }

  /** Route one delivery outcome to the caller waiting on it, if any. A
   *  delivery nobody awaits (every `emit()`) simply has no entry. */
  private settleConfirm(brokerAddress: string, ctx: EventContext, outcome: DeliveryOutcome): void {
    const id = ctx.delivery?.id;
    if (id === undefined) return;
    const pending = this.pendingConfirms.get(confirmKey(brokerAddress, id));
    if (!pending) return;
    if (outcome === 'accepted') {
      pending.settle();
      return;
    }
    const err = extractAmqpError(ctx);
    const { condition, description } = amqpErrorFields(err);
    pending.settle(new AmqpPublishError(pending.address, outcome, outcomeReason(outcome, err), condition, description));
  }

  /** Fail every confirmed publish riding on `sender` — used when the link
   *  itself breaks. */
  private failConfirmsOnSender(sender: Sender, reason: string, err: unknown): void {
    const { condition, description } = amqpErrorFields(err);
    for (const pending of [...this.inFlightConfirms]) {
      if (pending.sender !== sender) continue;
      pending.settle(new AmqpPublishError(pending.address, 'unsent', reason, condition, description));
    }
  }

  /** Fail every confirmed publish still in flight — disconnect, shutdown. */
  private failAllConfirms(outcome: 'disconnected' | 'unsent', reason: string): void {
    for (const pending of [...this.inFlightConfirms]) {
      pending.settle(new AmqpPublishError(pending.address, outcome, reason));
    }
  }

  /**
   * The source filter set positioning a consumer on a stream queue — or
   * nothing at all when the peer isn't RabbitMQ.
   *
   * `rabbitmq:stream-offset-spec` is, as its name says, a RabbitMQ extension.
   * We used to send it to every peer on the assumption that a broker ignores
   * filters it doesn't know. Qpid Broker-J does not: it validates the filter
   * set and closes the **connection** with `Expected value type is 'Filter'
   * but got 'LinkedHashMap'`, which took down `@Subscribe` and the reply
   * stream on that broker. Artemis and Qpid have no stream queues anyway, so
   * there is no offset to position — skipping the filter costs nothing and
   * keeps the connection alive.
   */
  private streamOffsetFilterFor(offset: StreamOffset, address: string): { filter?: Record<string, unknown> } {
    if (this.brandDetected === 'rabbitmq') return { filter: streamOffsetFilter(offset) };
    this.logger.debug(
      `stream offset '${String(offset)}' not applied on '${address}' — peer is ${this.brandDetected}, not RabbitMQ`,
    );
    return {};
  }

  /**
   * Normalise a user-facing address (a bare name) to the broker-specific
   * scheme. RabbitMQ 4.x rejects bare names (`amqp_address_v1_not_permitted`)
   * and requires the v2 scheme `/queues/<name>`, `/exchanges/...`, `/topic/...`.
   * Artemis and Qpid accept bare names directly.
   *
   * We auto-detect via the peer's `product` (see {@link brand}) — the brand
   * is known by the time we reach this point (see lifecycle notes on
   * {@link messages$} and {@link publish}). Already-prefixed addresses
   * (starting with `/`) always pass through unchanged, which is the escape
   * hatch for any setup where the heuristic doesn't fit (custom proxy,
   * Pulsar via the AMQP proxy, etc.).
   */
  private toBrokerAddress(address: string): string {
    if (address.startsWith('/')) return address;
    if (this.brandDetected === 'rabbitmq') return `/queues/${address}`;
    return address;
  }

  private detectBrand(conn: Connection): void {
    const properties = readPeerProperties(conn);
    if (!properties) {
      this.brandDetected = 'unknown';
      return;
    }
    const product = typeof properties.product === 'string' ? properties.product : undefined;
    const version = typeof properties.version === 'string' ? properties.version : undefined;
    this.brandProduct = product;
    this.brandVersion = version;
    if (!product) {
      this.brandDetected = 'unknown';
      return;
    }
    const lower = product.toLowerCase();
    if (lower.includes('rabbitmq')) this.brandDetected = 'rabbitmq';
    else if (lower.includes('artemis')) this.brandDetected = 'artemis';
    else if (lower.includes('qpid')) this.brandDetected = 'qpid';
    else this.brandDetected = 'unknown';
  }
}

/** Try a few possible locations rhea may expose the peer's Open frame
 *  properties under. Best effort — returns undefined if none match. */
function readPeerProperties(conn: Connection): Record<string, unknown> | undefined {
  const c = conn as unknown as Record<string, unknown>;
  const remote = c.remote as { open?: { properties?: Record<string, unknown> } } | undefined;
  if (remote?.open?.properties && typeof remote.open.properties === 'object') return remote.open.properties;
  const remoteProperties = c.remote_properties as Record<string, unknown> | undefined;
  if (remoteProperties && typeof remoteProperties === 'object') return remoteProperties;
  const properties = c.properties as Record<string, unknown> | undefined;
  if (properties && typeof properties === 'object') return properties;
  return undefined;
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

/** Correlation key for one in-flight confirmed publish. Delivery ids are
 *  allocated per session; scoping by address keeps the key unique even if a
 *  future rhea session policy puts senders on separate sessions. */
function confirmKey(brokerAddress: string, deliveryId: number): string {
  return `${brokerAddress}#${deliveryId}`;
}

/** The AMQP error fields worth handing to the caller, when the broker sent one. */
function amqpErrorFields(err: unknown): { condition?: string; description?: string } {
  if (!err || typeof err !== 'object') return {};
  const e = err as { condition?: unknown; description?: unknown };
  return {
    condition: typeof e.condition === 'string' ? e.condition : undefined,
    description: typeof e.description === 'string' ? e.description : undefined,
  };
}

/** Human-readable reason for a non-`accepted` delivery outcome, with the AMQP
 *  condition appended whenever the broker reported one. */
function outcomeReason(outcome: Exclude<DeliveryOutcome, 'accepted'>, err: unknown): string {
  const detail = err === undefined ? undefined : describeAmqpError(err);
  switch (outcome) {
    case 'released':
      return `the broker routed the message to no queue${detail ? ` (${detail})` : ''} — check the address, the routing key and the bindings`;
    case 'rejected':
      return `the broker refused the message: ${detail ?? 'no error condition reported'}`;
    case 'modified':
      return `the broker asked for the message to be modified before redelivery${detail ? `: ${detail}` : ''}`;
  }
}
