import { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider as SdkMeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import type { Delivery } from 'rhea';
import { firstValueFrom, Subject } from 'rxjs';
import { AmqpConsumerExplorer } from '../src/amqp.consumer-explorer';
import { resolveAmqpOptions, type BrokerOptions } from '../src/amqp.options';
import type { AmqpParamMeta, ConsumerMetadata, IncomingMessage } from '../src/amqp.types';
import { BrokerConnection } from '../src/broker-connection';
import { BrokerPublisher } from '../src/broker-publisher';
import { FakeConnection, FakeSender } from './fake-rhea';

jest.mock('rhea', () => ({ connect: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rhea = require('rhea') as { connect: jest.Mock };

/** One exported data point, flattened to what the assertions care about. */
interface Point {
  metric: string;
  attributes: Record<string, unknown>;
  count: number;
  sum?: number;
}

describe('Metrics', () => {
  let exporter: InMemoryMetricExporter;
  let reader: PeriodicExportingMetricReader;
  let provider: SdkMeterProvider;

  beforeAll(() => {
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => {
    rhea.connect.mockReset();
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    provider = new SdkMeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
  });

  afterEach(async () => {
    metrics.disable();
    await provider.shutdown();
  });

  /** Force a collection and flatten every point the library produced. */
  async function collect(): Promise<Point[]> {
    await reader.forceFlush();
    const points: Point[] = [];
    for (const resource of exporter.getMetrics()) {
      for (const scope of resource.scopeMetrics) {
        for (const metric of scope.metrics) {
          for (const dp of metric.dataPoints) {
            const value = dp.value as number | { count: number; sum?: number };
            points.push({
              metric: metric.descriptor.name,
              attributes: dp.attributes as Record<string, unknown>,
              count: typeof value === 'number' ? value : value.count,
              sum: typeof value === 'number' ? undefined : value.sum,
            });
          }
        }
      }
    }
    return points;
  }

  function pointsFor(points: Point[], metric: string): Point[] {
    return points.filter((p) => p.metric === metric);
  }

  function startBroker(overrides: Partial<BrokerOptions> = {}): { broker: BrokerConnection; conn: FakeConnection } {
    const resolved = resolveAmqpOptions({ url: 'amqp://localhost', confirmTimeoutMs: 30, ...overrides });
    const broker = new BrokerConnection(resolved.brokers.get('default')!);
    const conn = new FakeConnection();
    rhea.connect.mockReturnValue(conn);
    broker.start();
    return { broker, conn };
  }

  function senderFor(conn: FakeConnection, address = 'orders.create'): FakeSender {
    const sender = conn.senders.get(address);
    if (!sender) throw new Error(`no sender opened for '${address}'`);
    return sender;
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  describe('publishing', () => {
    it('counts a message and times the publish, with the conventional names', async () => {
      const { broker } = startBroker();
      broker.publish('orders.create', { body: '{}' });

      const points = await collect();
      const sent = pointsFor(points, 'messaging.client.sent.messages');
      expect(sent).toHaveLength(1);
      expect(sent[0]!.count).toBe(1);
      expect(sent[0]!.attributes).toEqual({
        'messaging.system': 'amqp',
        'messaging.destination.name': 'orders.create',
        'messaging.operation.name': 'send',
      });

      const duration = pointsFor(points, 'messaging.client.operation.duration');
      expect(duration).toHaveLength(1);
      expect(duration[0]!.count).toBe(1);
    });

    it('marks a publish the connection refused, without losing the count', async () => {
      const { broker, conn } = startBroker();
      conn.close();
      expect(broker.publish('orders.create', { body: '{}' })).toBe(false);

      const [sent] = pointsFor(await collect(), 'messaging.client.sent.messages');
      expect(sent!.count).toBe(1);
      expect(sent!.attributes['error.type']).toBe('unsent');
    });

    it('carries the broker verdict of a confirmed publish as error.type', async () => {
      const { broker, conn } = startBroker();
      const publisher = new BrokerPublisher(broker);
      publisher.emitConfirmed('orders.create', { id: '1' }).subscribe({ error: () => undefined });
      senderFor(conn).outcome('released');

      const [sent] = pointsFor(await collect(), 'messaging.client.sent.messages');
      expect(sent!.attributes['error.type']).toBe('released');
    });

    it('times a confirmed publish up to the verdict, not the handoff', async () => {
      const { broker, conn } = startBroker();
      const publisher = new BrokerPublisher(broker);
      const done = firstValueFrom(publisher.emitConfirmed('orders.create', { id: '1' }));

      // Nothing recorded while the broker has not answered.
      expect(pointsFor(await collect(), 'messaging.client.sent.messages')).toHaveLength(0);

      await new Promise((r) => setTimeout(r, 25));
      senderFor(conn).outcome('accepted');
      await done;

      const [duration] = pointsFor(await collect(), 'messaging.client.operation.duration');
      expect(duration!.count).toBe(1);
      // The wait is in the histogram: this is confirm latency, in seconds.
      expect(duration!.sum).toBeGreaterThan(0.02);
    });

    it('reports the address as written, not the broker-rewritten form', async () => {
      // The span path had this test since 1.2.1; the metric path did not, and
      // shipped 1.3.0 with the raw address. Aggregation makes it worse than on
      // a span: one queue would carry two labels depending on the instrument.
      const { broker, conn } = startBroker();
      Object.assign(conn, { remote: { open: { properties: { product: 'RabbitMQ' } } } });
      conn.fire('connection_open');

      broker.publish('/queues/svc.replies', { body: '{}' });

      for (const metric of ['messaging.client.sent.messages', 'messaging.client.operation.duration']) {
        const [point] = pointsFor(await collect(), metric);
        expect(point!.attributes['messaging.destination.name']).toBe('svc.replies');
      }
    });

    it('picks up a MeterProvider registered after the first publish', async () => {
      // The metrics API has no equivalent of the tracer's proxy: a meter taken
      // before the SDK registers would stay a no-op for the life of the
      // process. The library compares the provider's identity on every record,
      // so a late bootstrap is not a silent dead end.
      metrics.disable();
      const { broker } = startBroker();
      broker.publish('orders.create', { body: '{}' }); // into the void

      metrics.setGlobalMeterProvider(provider);
      broker.publish('orders.create', { body: '{}' }); // recorded

      const [sent] = pointsFor(await collect(), 'messaging.client.sent.messages');
      expect(sent!.count).toBe(1);
    });

    it('stays silent when the broker is disabled', async () => {
      const { broker } = startBroker({ enabled: false });
      broker.publish('orders.create', { body: '{}' });

      expect(await collect()).toHaveLength(0);
    });

    it('reports the peer brand as messaging.system', async () => {
      const { broker, conn } = startBroker();
      Object.assign(conn, { remote: { open: { properties: { product: 'RabbitMQ' } } } });
      conn.fire('connection_open');
      broker.publish('orders.create', { body: '{}' });

      const [sent] = pointsFor(await collect(), 'messaging.client.sent.messages');
      expect(sent!.attributes['messaging.system']).toBe('rabbitmq');
    });
  });

  // -------------------------------------------------------------------------
  // Consuming
  // -------------------------------------------------------------------------

  describe('consuming', () => {
    const brokerStub = {
      brand: 'rabbitmq' as const,
      decodeBody: (b: unknown) => JSON.parse(String(b)),
      publish: () => true,
    } as never;

    function incoming(): { message: IncomingMessage; settled: string[] } {
      const settled: string[] = [];
      return {
        settled,
        message: {
          address: 'orders.create',
          message: { body: '{"id":"1"}', properties: {}, application_properties: {} },
          delivery: {
            accept: () => settled.push('accept'),
            release: () => settled.push('release'),
            reject: () => settled.push('reject'),
            modified: () => settled.push('modified'),
          } as unknown as Delivery,
        },
      };
    }

    function dispatch(
      handler: (...args: unknown[]) => unknown,
      message: IncomingMessage,
      options: Partial<ConsumerMetadata['options']> = {},
      params: AmqpParamMeta[] = [{ kind: 'BODY' }],
    ): void {
      const explorer = new AmqpConsumerExplorer(undefined as never, undefined as never, undefined as never);
      const meta: ConsumerMetadata = {
        address: 'orders.create',
        kind: 'consume',
        options: { maxDelivery: 1, retryPolicy: 'immediate', dlq: false, maxWindow: 100, ...options },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (explorer as any).dispatch(brokerStub, {}, handler, params, meta, message);
    }

    it('counts a consumed message and times the handler', async () => {
      const { message } = incoming();
      dispatch(() => undefined, message);

      const points = await collect();
      const consumed = pointsFor(points, 'messaging.client.consumed.messages');
      expect(consumed).toHaveLength(1);
      expect(consumed[0]!.attributes).toEqual({
        'messaging.system': 'rabbitmq',
        'messaging.destination.name': 'orders.create',
        'messaging.operation.name': 'process',
      });
      expect(pointsFor(points, 'messaging.process.duration')[0]!.count).toBe(1);
    });

    it('carries a failing handler as error.type', async () => {
      const { message } = incoming();
      dispatch(() => {
        throw new TypeError('boom');
      }, message);

      const [consumed] = pointsFor(await collect(), 'messaging.client.consumed.messages');
      expect(consumed!.attributes['error.type']).toBe('TypeError');
    });

    it('waits for an Observable handler before recording its duration', async () => {
      const { message } = incoming();
      const subject = new Subject<void>();
      dispatch(() => subject.asObservable(), message);

      expect(pointsFor(await collect(), 'messaging.process.duration')).toHaveLength(0);
      subject.complete();
      expect(pointsFor(await collect(), 'messaging.process.duration')).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // The signal people alert on
  // -------------------------------------------------------------------------

  describe('settlements — work failing quietly', () => {
    const brokerStub = {
      brand: 'rabbitmq' as const,
      decodeBody: (b: unknown) => JSON.parse(String(b)),
      publish: () => true,
    } as never;

    function failingDispatch(options: Partial<ConsumerMetadata['options']>, deliveryCount = 1): string[] {
      const settled: string[] = [];
      const message: IncomingMessage = {
        address: 'orders.create',
        message: {
          body: '{"id":"1"}',
          properties: {},
          application_properties: {},
          header: { delivery_count: deliveryCount - 1 },
        },
        delivery: {
          accept: () => settled.push('accept'),
          release: () => settled.push('release'),
          reject: () => settled.push('reject'),
          modified: () => settled.push('modified'),
        } as unknown as Delivery,
      };
      const explorer = new AmqpConsumerExplorer(undefined as never, undefined as never, undefined as never);
      const meta: ConsumerMetadata = {
        address: 'orders.create',
        kind: 'consume',
        options: { maxDelivery: 1, retryPolicy: 'immediate', dlq: false, maxWindow: 100, ...options },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (explorer as any).dispatch(
        brokerStub,
        {},
        () => {
          throw new Error('permanent');
        },
        [{ kind: 'BODY' }],
        meta,
        message,
      );
      return settled;
    }

    it('counts a message routed to the dead-letter queue', async () => {
      expect(failingDispatch({ maxDelivery: 1, dlq: true })).toEqual(['reject']);

      const settles = pointsFor(await collect(), 'messaging.client.operation.duration');
      expect(settles).toHaveLength(1);
      expect(settles[0]!.attributes).toMatchObject({
        'messaging.operation.name': 'reject',
        'error.type': 'Error',
      });
    });

    it('counts a message dropped because no DLQ is configured — the quiet one', async () => {
      expect(failingDispatch({ maxDelivery: 1, dlq: false })).toEqual(['accept']);

      const [settle] = pointsFor(await collect(), 'messaging.client.operation.duration');
      // An acceptance carrying an error is a give-up, not a success: plain
      // acceptances are never recorded here at all.
      expect(settle!.attributes).toMatchObject({ 'messaging.operation.name': 'accept', 'error.type': 'Error' });
    });

    it('counts a retry as a modify', async () => {
      expect(failingDispatch({ maxDelivery: 3 })).toEqual(['modified']);

      const [settle] = pointsFor(await collect(), 'messaging.client.operation.duration');
      expect(settle!.attributes).toMatchObject({ 'messaging.operation.name': 'modify' });
    });

    it('records nothing for a handler that simply succeeds', async () => {
      const { message } = incomingSuccess();
      const explorer = new AmqpConsumerExplorer(undefined as never, undefined as never, undefined as never);
      const meta: ConsumerMetadata = {
        address: 'orders.create',
        kind: 'consume',
        options: { maxDelivery: 1, retryPolicy: 'immediate', dlq: false, maxWindow: 100 },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (explorer as any).dispatch(brokerStub, {}, () => undefined, [{ kind: 'BODY' }], meta, message);

      expect(pointsFor(await collect(), 'messaging.client.operation.duration')).toHaveLength(0);
    });

    function incomingSuccess(): { message: IncomingMessage } {
      return {
        message: {
          address: 'orders.create',
          message: { body: '{"id":"1"}', properties: {}, application_properties: {} },
          delivery: { accept: () => undefined } as unknown as Delivery,
        },
      };
    }
  });
});
