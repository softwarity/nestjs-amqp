import { Logger } from '@nestjs/common';
import type { Delivery, EventContext, Message, Sender } from 'rhea';
import { firstValueFrom, type Observable } from 'rxjs';
import { AmqpPublishError } from '../src/amqp.errors';
import { resolveAmqpOptions, type BrokerOptions } from '../src/amqp.options';
import { BrokerConnection } from '../src/broker-connection';
import { BrokerPublisher } from '../src/broker-publisher';

// rhea is replaced wholesale: `broker.start()` then hands us a fake connection
// whose senders we drive by hand (credit, delivery outcomes, link errors).
jest.mock('rhea', () => ({ connect: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rhea = require('rhea') as { connect: jest.Mock };

// ---------------------------------------------------------------------------
// Fake rhea
// ---------------------------------------------------------------------------

type Handler = (ctx: EventContext) => void;

class FakeEmitter {
  private readonly handlers = new Map<string, { fn: Handler; original: Handler }[]>();

  on(event: string, fn: Handler): void {
    this.entries(event).push({ fn, original: fn });
  }

  once(event: string, fn: Handler): void {
    const wrapper: Handler = (ctx) => {
      this.removeListener(event, fn);
      fn(ctx);
    };
    this.entries(event).push({ fn: wrapper, original: fn });
  }

  removeListener(event: string, fn: Handler): void {
    const list = this.entries(event);
    const idx = list.findIndex((e) => e.original === fn);
    if (idx >= 0) list.splice(idx, 1);
  }

  removeAllListeners(event?: string): void {
    if (event) this.handlers.delete(event);
    else this.handlers.clear();
  }

  /** Number of listeners currently attached — used to assert teardown. */
  listenerCount(event: string): number {
    return this.entries(event).length;
  }

  /** Deliver an event to the listeners registered at this instant. */
  fire(event: string, ctx: EventContext = {}): void {
    for (const entry of [...this.entries(event)]) entry.fn(ctx);
  }

  private entries(event: string): { fn: Handler; original: Handler }[] {
    let list = this.handlers.get(event);
    if (!list) {
      list = [];
      this.handlers.set(event, list);
    }
    return list;
  }
}

class FakeSender extends FakeEmitter {
  readonly sent: Message[] = [];
  credit = true;
  opened = true;
  private nextId = 0;

  send(message: Message): Delivery {
    this.sent.push(message);
    return { id: this.nextId++ } as Delivery;
  }

  sendable(): boolean {
    return this.credit;
  }

  has_credit(): boolean {
    return this.credit;
  }

  close(): void {
    this.opened = false;
  }

  detach(): void {
    this.opened = false;
  }

  is_open(): boolean {
    return this.opened;
  }

  is_closed(): boolean {
    return !this.opened;
  }

  /** Deliver a disposition for the delivery at index `deliveryId`. */
  outcome(event: 'accepted' | 'released' | 'rejected' | 'modified', deliveryId = 0, error?: unknown): void {
    this.fire(event, { delivery: { id: deliveryId, remote_state: { error } } as unknown as Delivery });
  }
}

class FakeConnection extends FakeEmitter {
  readonly senders = new Map<string, FakeSender>();
  opened = true;

  open_sender(options: { target?: { address?: string } } | string): FakeSender {
    const address = typeof options === 'string' ? options : (options.target?.address ?? '');
    const existing = this.senders.get(address);
    if (existing?.is_open()) return existing;
    const sender = new FakeSender();
    this.senders.set(address, sender);
    return sender;
  }

  open_receiver(): never {
    throw new Error('not used in these tests');
  }

  close(): void {
    this.opened = false;
  }

  is_open(): boolean {
    return this.opened;
  }

  is_closed(): boolean {
    return !this.opened;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function startBroker(overrides: Partial<BrokerOptions> = {}): {
  broker: BrokerConnection;
  publisher: BrokerPublisher;
  conn: FakeConnection;
} {
  const resolved = resolveAmqpOptions({ url: 'amqp://localhost', confirmTimeoutMs: 40, ...overrides });
  const broker = new BrokerConnection(resolved.brokers.get('default')!);
  const conn = new FakeConnection();
  rhea.connect.mockReturnValue(conn);
  broker.start();
  return { broker, publisher: new BrokerPublisher(broker), conn };
}

/** The sender the library opened for `address` (bare name — the peer brand
 *  stays `'unknown'` here, so no address rewriting happens). */
function senderFor(conn: FakeConnection, address = 'orders.create'): FakeSender {
  const sender = conn.senders.get(address);
  if (!sender) throw new Error(`no sender opened for '${address}'`);
  return sender;
}

/** Subscribe and record the outcome synchronously — every fake event below is
 *  delivered in-band, so assertions can read this right after firing one. */
function watch(obs: Observable<void>): {
  completed: boolean;
  error?: unknown;
  unsubscribe: () => void;
} {
  const state: { completed: boolean; error?: unknown; unsubscribe: () => void } = {
    completed: false,
    unsubscribe: () => undefined,
  };
  const sub = obs.subscribe({
    complete: () => (state.completed = true),
    error: (err: unknown) => (state.error = err),
  });
  state.unsubscribe = () => sub.unsubscribe();
  return state;
}

function publishError(err: unknown): AmqpPublishError {
  expect(err).toBeInstanceOf(AmqpPublishError);
  return err as AmqpPublishError;
}

describe('emitConfirmed — broker delivery verdicts', () => {
  beforeAll(() => {
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => rhea.connect.mockReset());

  describe('the four AMQP outcomes', () => {
    it('completes when the broker accepts the delivery', () => {
      const { publisher, conn } = startBroker();
      const state = watch(publisher.emitConfirmed('orders.create', { id: '42' }));
      const sender = senderFor(conn);

      expect(sender.sent).toHaveLength(1);
      expect(state.completed).toBe(false); // nothing resolved before the verdict

      sender.outcome('accepted');
      expect(state.completed).toBe(true);
      expect(state.error).toBeUndefined();
    });

    it('errors on released — the broker matched no queue', () => {
      const { publisher, conn } = startBroker();
      const state = watch(publisher.emitConfirmed('orders.create', { id: '42' }));

      senderFor(conn).outcome('released');
      const err = publishError(state.error);
      expect(err.outcome).toBe('released');
      expect(err.address).toBe('orders.create');
      expect(err.message).toMatch(/routed the message to no queue/);
      expect(state.completed).toBe(false);
    });

    it('errors on rejected and carries the AMQP condition', () => {
      const { publisher, conn } = startBroker();
      const state = watch(publisher.emitConfirmed('orders.create', { id: '42' }));

      senderFor(conn).outcome('rejected', 0, {
        condition: 'amqp:resource-limit-exceeded',
        description: 'max length exceeded',
      });

      const err = publishError(state.error);
      expect(err.outcome).toBe('rejected');
      expect(err.condition).toBe('amqp:resource-limit-exceeded');
      expect(err.description).toBe('max length exceeded');
      expect(err.message).toContain('amqp:resource-limit-exceeded');
      expect(err.message).toContain('max length exceeded');
    });

    it('errors on modified and carries the AMQP condition', () => {
      const { publisher, conn } = startBroker();
      const state = watch(publisher.emitConfirmed('orders.create', { id: '42' }));

      senderFor(conn).outcome('modified', 0, { condition: 'amqp:precondition-failed' });

      const err = publishError(state.error);
      expect(err.outcome).toBe('modified');
      expect(err.condition).toBe('amqp:precondition-failed');
      expect(err.message).toContain('amqp:precondition-failed');
    });

    it('routes each verdict to its own caller', () => {
      const { publisher, conn } = startBroker();
      const first = watch(publisher.emitConfirmed('orders.create', { id: '1' }));
      const second = watch(publisher.emitConfirmed('orders.create', { id: '2' }));
      const sender = senderFor(conn);

      sender.outcome('released', 1);
      expect(first.completed).toBe(false);
      expect(first.error).toBeUndefined();
      expect(publishError(second.error).outcome).toBe('released');

      sender.outcome('accepted', 0);
      expect(first.completed).toBe(true);
    });
  });

  describe('nothing published, nothing pending', () => {
    it('errors immediately when the connection is not open', () => {
      const { publisher, conn } = startBroker();
      conn.close();

      const state = watch(publisher.emitConfirmed('orders.create', { id: '42' }));
      const err = publishError(state.error);
      expect(err.outcome).toBe('unsent');
      expect(err.message).toMatch(/not open/);
      expect(conn.senders.size).toBe(0);
    });

    it('errors immediately when the broker is disabled', () => {
      const { publisher } = startBroker({ enabled: false });

      const err = publishError(watch(publisher.emitConfirmed('orders.create', { id: '42' })).error);
      expect(err.outcome).toBe('unsent');
      expect(err.message).toMatch(/disabled/);
    });

    it('holds the message back while the link has no credit', () => {
      const { broker, conn } = startBroker();
      // Open the sender first so we can take its credit away before publishing.
      broker.publish('orders.create', { body: 'warm-up' });
      const sender = senderFor(conn);
      sender.credit = false;
      sender.sent.length = 0;

      const state = watch(broker.publishConfirmed('orders.create', { body: 'x' }));
      expect(sender.sent).toHaveLength(0);
      expect(state.error).toBeUndefined();

      sender.credit = true;
      sender.fire('sendable');
      expect(sender.sent).toHaveLength(1);

      // Delivery id 0 went to the warm-up emit; the confirmed one is next.
      sender.outcome('accepted', 1);
      expect(state.completed).toBe(true);
    });

    it('errors on the guard delay when credit never comes, having published nothing', async () => {
      const { broker, publisher, conn } = startBroker({ confirmTimeoutMs: 20 });
      broker.publish('orders.create', { body: 'warm-up' });
      const sender = senderFor(conn);
      sender.credit = false;
      sender.sent.length = 0;

      const err = publishError(
        await firstValueFrom(publisher.emitConfirmed('orders.create', { id: '42' })).catch((e: unknown) => e),
      );
      expect(err.outcome).toBe('timeout');
      // The point of waiting for credit rather than handing the message to
      // rhea: a failed confirm means the message was never published.
      expect(sender.sent).toHaveLength(0);
      expect(sender.listenerCount('sendable')).toBe(0);
    });

    it('errors on a link failure instead of waiting out the timeout', () => {
      const { publisher, conn } = startBroker();
      const state = watch(publisher.emitConfirmed('orders.create', { id: '42' }));

      senderFor(conn).fire('sender_error', {
        error: { condition: 'amqp:not-found', description: "no queue 'orders.create'" },
      } as EventContext);

      const err = publishError(state.error);
      expect(err.outcome).toBe('unsent');
      expect(err.condition).toBe('amqp:not-found');
      expect(err.message).toContain('amqp:not-found');
    });
  });

  describe('connection loss', () => {
    it('errors the caller waiting for a verdict', () => {
      const { publisher, conn } = startBroker();
      const state = watch(publisher.emitConfirmed('orders.create', { id: '42' }));

      conn.fire('disconnected');

      const err = publishError(state.error);
      expect(err.outcome).toBe('disconnected');
      expect(err.message).toMatch(/dropped before the broker confirmed/);
    });

    it('errors the caller still waiting for credit', () => {
      const { broker, conn } = startBroker();
      broker.publish('orders.create', { body: 'warm-up' });
      const sender = senderFor(conn);
      sender.credit = false;

      const state = watch(broker.publishConfirmed('orders.create', { body: 'x' }));
      conn.fire('disconnected');

      expect(publishError(state.error).outcome).toBe('disconnected');
    });

    it('errors in-flight callers on shutdown', () => {
      const { broker, conn } = startBroker();
      const state = watch(broker.publishConfirmed('orders.create', { body: 'x' }));
      expect(senderFor(conn).sent).toHaveLength(1);

      broker.stop();

      const err = publishError(state.error);
      expect(err.outcome).toBe('unsent');
      expect(err.message).toMatch(/shutting down/);
    });
  });

  describe('guard delay', () => {
    it('errors when no verdict comes back', async () => {
      const { publisher } = startBroker({ confirmTimeoutMs: 20 });

      const err = publishError(await firstValueFrom(publisher.emitConfirmed('orders.create', { id: '42' })).catch((e: unknown) => e));
      expect(err.outcome).toBe('timeout');
      expect(err.message).toContain('20ms');
    });

    it('is overridable per call', async () => {
      const { publisher } = startBroker({ confirmTimeoutMs: 60_000 });

      const err = publishError(await firstValueFrom(publisher.emitConfirmed('orders.create', { id: '42' }, { timeoutMs: 20 })).catch((e: unknown) => e));
      expect(err.outcome).toBe('timeout');
      expect(err.message).toContain('20ms');
    });

    it('defaults to the send timeout when confirmTimeoutMs is unset', () => {
      const resolved = resolveAmqpOptions({ url: 'amqp://localhost', defaultSendTimeoutMs: 1234 });
      expect(resolved.brokers.get('default')!.confirmTimeoutMs).toBe(1234);
    });

    it('drops the pending entry when the caller unsubscribes', () => {
      const { publisher, conn } = startBroker();
      const state = watch(publisher.emitConfirmed('orders.create', { id: '42' }));
      const sender = senderFor(conn);

      state.unsubscribe();
      // A late verdict for a caller that walked away must be a no-op.
      expect(() => sender.outcome('accepted')).not.toThrow();
      expect(state.completed).toBe(false);
      expect(sender.listenerCount('sendable')).toBe(0);
    });
  });

  describe('Observable semantics', () => {
    it('publishes nothing until something subscribes, once per subscription', () => {
      const { publisher, conn } = startBroker();
      const obs = publisher.emitConfirmed('orders.create', { id: '42' });

      expect(conn.senders.size).toBe(0);

      watch(obs);
      expect(senderFor(conn).sent).toHaveLength(1);
      watch(obs);
      expect(senderFor(conn).sent).toHaveLength(2);
    });

    it('emits one value before completing, so firstValueFrom resolves', async () => {
      const { publisher, conn } = startBroker();
      const pending = firstValueFrom(publisher.emitConfirmed('orders.create', { id: '42' }));

      senderFor(conn).outcome('accepted');
      await expect(pending).resolves.toBeUndefined();
    });

    it('encodes the payload with the broker codec', () => {
      const { publisher, conn } = startBroker();
      watch(publisher.emitConfirmed('orders.create', { id: '42' }, { applicationProperties: { tenant: 'acme' } }));

      const [message] = senderFor(conn).sent;
      expect(JSON.parse(String(message!.body))).toEqual({ id: '42' });
      expect(message!.application_properties).toEqual({ tenant: 'acme' });
    });
  });

  describe('emit() — unchanged', () => {
    it('stays synchronous and boolean', () => {
      const { broker, conn } = startBroker();

      expect(broker.publish('orders.create', { body: 'x' })).toBe(true);
      expect(senderFor(conn).sent).toHaveLength(1);
    });

    it('returns false without a connection, and false when disabled', () => {
      const { broker, conn } = startBroker();
      conn.close();
      expect(broker.publish('orders.create', { body: 'x' })).toBe(false);

      const disabled = startBroker({ enabled: false });
      expect(disabled.broker.publish('orders.create', { body: 'x' })).toBe(false);
    });

    it('registers no verdict watcher — a later outcome changes nothing', () => {
      const { broker, conn } = startBroker();
      broker.publish('orders.create', { body: 'x' });
      const sender = senderFor(conn);

      expect(() => sender.outcome('released')).not.toThrow();
      expect(() => sender.outcome('rejected', 0, { condition: 'amqp:not-found' })).not.toThrow();
      expect(broker.publish('orders.create', { body: 'y' })).toBe(true);
    });
  });

  it('opens senders with treat_modified_as_released disabled', () => {
    const { broker } = startBroker();
    const openSender = jest.spyOn(rhea.connect.mock.results[0]!.value as FakeConnection, 'open_sender') as unknown as jest.SpyInstance<Sender, [{ target?: { address?: string }; treat_modified_as_released?: boolean }]>;

    broker.publish('orders.create', { body: 'x' });

    expect(openSender).toHaveBeenCalledWith(expect.objectContaining({ treat_modified_as_released: false }));
  });
});
