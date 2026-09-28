import { Logger } from '@nestjs/common';
import type { EventContext } from 'rhea';
import { firstValueFrom } from 'rxjs';
import { AmqpPublishError } from '../src/amqp.errors';
import { resolveAmqpOptions, type BrokerOptions } from '../src/amqp.options';
import { BrokerConnection } from '../src/broker-connection';
import { BrokerPublisher } from '../src/broker-publisher';
import { FakeConnection, FakeSender } from './fake-rhea';

jest.mock('rhea', () => ({ connect: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rhea = require('rhea') as { connect: jest.Mock };

/**
 * A link the broker refuses for good — a queue that isn't declared, a
 * permission that isn't granted — used to cost a session on every attempt.
 *
 * Observed on RabbitMQ 4.3.6 with a reply stream missing broker-side: the
 * failed attach takes the session down, rhea reconnects, the library
 * re-attaches, and around the 64th turn the broker answers `channel number
 * (64) exceeds maximum channel number (63)` and closes the connection. The
 * service then stays connected to nothing, for good, behind a wall of
 * warnings that never names the cause.
 *
 * These specs hold the two halves of the fix: stop re-attaching what will
 * never attach, and say why, once.
 */
describe('Links the broker refuses for good', () => {
  beforeAll(() => {
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => rhea.connect.mockReset());

  function startBroker(overrides: Partial<BrokerOptions> = {}): { broker: BrokerConnection; conn: FakeConnection } {
    const resolved = resolveAmqpOptions({ url: 'amqp://localhost', confirmTimeoutMs: 30, ...overrides });
    const broker = new BrokerConnection(resolved.brokers.get('default')!);
    const conn = new FakeConnection();
    rhea.connect.mockReturnValue(conn);
    broker.start();
    return { broker, conn };
  }

  function notFound(entity: string): EventContext {
    return { error: { condition: 'amqp:not-found', description: `no queue '${entity}' in vhost '/'` } } as EventContext;
  }

  // -------------------------------------------------------------------------
  // The reply stream — the shape that was killing services
  // -------------------------------------------------------------------------

  describe('reply stream missing broker-side', () => {
    function connectWithReplyStream(): { broker: BrokerConnection; conn: FakeConnection; receivers: number } {
      const { broker, conn } = startBroker({ replyStreamAddress: 'svc.replies' });
      conn.fire('connection_open');
      return { broker, conn, receivers: conn.receivers.length };
    }

    it('stops re-attaching the reply receiver once the broker says not-found', () => {
      const { broker, conn } = connectWithReplyStream();
      expect(conn.receivers).toHaveLength(1);

      conn.receivers[0]!.fire('receiver_error', notFound('svc.replies'));

      // Reconnect, five times over. Before the fix each of these opened a
      // fresh session and burned a channel number.
      for (let i = 0; i < 5; i++) {
        conn.fire('disconnected');
        conn.fire('connection_open');
      }

      expect(conn.receivers).toHaveLength(1);
      expect(broker.replyStreamUnavailable).toMatch(/amqp:not-found/);
    });

    it('reports the cause once, as an error, instead of a wall of warnings', () => {
      const errors = jest.spyOn(Logger.prototype, 'error');
      errors.mockClear();
      const { conn } = connectWithReplyStream();

      conn.receivers[0]!.fire('receiver_error', notFound('svc.replies'));
      conn.receivers[0]!.fire('receiver_close', notFound('svc.replies'));
      conn.fire('disconnected');
      conn.fire('connection_open');

      const said = errors.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('svc.replies'));
      expect(said).toHaveLength(1);
      expect(said[0]).toMatch(/topology problem, not a network one/);
    });

    it('fails send() immediately, with the reason, rather than on its timeout', async () => {
      const { broker, conn } = connectWithReplyStream();
      conn.receivers[0]!.fire('receiver_error', notFound('svc.replies'));

      const publisher = new BrokerPublisher(broker);
      const started = Date.now();
      await expect(firstValueFrom(publisher.send('orders.create', { id: '1' }))).rejects.toThrow(
        /reply stream 'svc.replies' is unusable.*amqp:not-found/s,
      );
      // The point of failing fast: no 30 second wait for a reply that cannot come.
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('leaves emit(), emitConfirmed() and consumers alone', async () => {
      const { broker, conn } = connectWithReplyStream();
      conn.receivers[0]!.fire('receiver_error', notFound('svc.replies'));

      expect(broker.publish('orders.create', { body: '{}' })).toBe(true);
      const publisher = new BrokerPublisher(broker);
      const confirmed = firstValueFrom(publisher.emitConfirmed('orders.create', { id: '1' }));
      (conn.senders.get('orders.create') as FakeSender).outcome('accepted', 1);
      await expect(confirmed).resolves.toBeUndefined();
    });

    it('keeps retrying a reply stream that failed for a transient reason', () => {
      const { conn } = connectWithReplyStream();
      conn.receivers[0]!.fire('receiver_error', {
        error: { condition: 'amqp:internal-error', description: 'try again' },
      } as EventContext);
      conn.receivers[0]!.close(); // the peer detaches the link, as a broker does

      conn.fire('disconnected');
      conn.fire('connection_open');

      // Not a topology problem: the library must not give up on it.
      expect(conn.receivers.length).toBeGreaterThan(1);
    });
  });

  // -------------------------------------------------------------------------
  // Publishing to an address that does not exist
  // -------------------------------------------------------------------------

  describe('publishing to an address the broker refuses', () => {
    it('stops opening a new sender — and a new session — on every publish', () => {
      const { broker, conn } = startBroker();
      conn.fire('connection_open');

      expect(broker.publish('nowhere', { body: '{}' })).toBe(true);
      const sender = conn.senders.get('nowhere')!;
      sender.fire('sender_error', notFound('nowhere'));

      for (let i = 0; i < 10; i++) {
        expect(broker.publish('nowhere', { body: '{}' })).toBe(false);
      }
      expect(conn.openedSenders).toBe(1);
    });

    it('tells a confirmed publish why, without waiting for the guard delay', async () => {
      const { broker, conn } = startBroker();
      conn.fire('connection_open');
      broker.publish('nowhere', { body: '{}' });
      conn.senders.get('nowhere')!.fire('sender_error', notFound('nowhere'));

      const publisher = new BrokerPublisher(broker);
      const err: unknown = await firstValueFrom(publisher.emitConfirmed('nowhere', { id: '1' })).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AmqpPublishError);
      expect((err as AmqpPublishError).outcome).toBe('unsent');
      expect((err as AmqpPublishError).message).toMatch(/amqp:not-found/);
    });

    it('tries again on the next connection — the topology may have been declared', () => {
      const { broker, conn } = startBroker();
      conn.fire('connection_open');
      broker.publish('nowhere', { body: '{}' });
      conn.senders.get('nowhere')!.fire('sender_error', notFound('nowhere'));
      expect(broker.publish('nowhere', { body: '{}' })).toBe(false);

      conn.fire('disconnected');
      conn.fire('connection_open');

      expect(broker.publish('nowhere', { body: '{}' })).toBe(true);
      expect(conn.openedSenders).toBe(2);
    });

    it('keeps publishing after a transient link error', () => {
      const { broker, conn } = startBroker();
      conn.fire('connection_open');
      broker.publish('orders.create', { body: '{}' });
      conn.senders.get('orders.create')!.fire('sender_error', {
        error: { condition: 'amqp:internal-error', description: 'hiccup' },
      } as EventContext);

      expect(broker.publish('orders.create', { body: '{}' })).toBe(true);
    });
  });
});
