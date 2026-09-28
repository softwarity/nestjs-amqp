import { Logger } from '@nestjs/common';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import type { Delivery } from 'rhea';
import { firstValueFrom } from 'rxjs';
import { AmqpConsumerExplorer } from '../src/amqp.consumer-explorer';
import { resolveAmqpOptions } from '../src/amqp.options';
import type { ConsumerMetadata, IncomingMessage } from '../src/amqp.types';
import { BrokerConnection } from '../src/broker-connection';
import { BrokerPublisher } from '../src/broker-publisher';
import { FakeConnection, FakeSender } from './fake-rhea';

jest.mock('rhea', () => ({ connect: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rhea = require('rhea') as { connect: jest.Mock };

/**
 * The claim that makes the instrumentation "optional" with no option: with no
 * SDK registered by the host application, the OpenTelemetry API is inert. This
 * spec holds that claim to the wire — **nothing** may be added to a published
 * message, and every code path must behave exactly as it did before.
 */
describe('No SDK registered — the instrumentation is inert', () => {
  beforeAll(() => {
    // Jest shares a worker between files, and the API's global provider lives
    // on globalThis: reset it so this spec really runs without an SDK whatever
    // ran before it.
    trace.disable();
    propagation.disable();
    context.disable();
    metrics.disable();
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(() => rhea.connect.mockReset());

  function startBroker(): { broker: BrokerConnection; conn: FakeConnection } {
    const resolved = resolveAmqpOptions({ url: 'amqp://localhost', confirmTimeoutMs: 20 });
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

  it('adds no application_properties to a message that had none', () => {
    const { broker, conn } = startBroker();
    expect(broker.publish('orders.create', { body: '{}' })).toBe(true);

    const [sent] = senderFor(conn).sent;
    // Not an empty map — absent. Nothing new reaches the wire.
    expect(sent!.application_properties).toBeUndefined();
    expect(Object.keys(sent!)).toEqual(['body']);
  });

  it('leaves the caller application properties untouched', () => {
    const { broker, conn } = startBroker();
    broker.publish('orders.create', { body: '{}', application_properties: { tenant: 'acme' } });

    expect(senderFor(conn).sent[0]!.application_properties).toEqual({ tenant: 'acme' });
  });

  it('keeps emit() synchronous and boolean', () => {
    const { broker, conn } = startBroker();
    expect(broker.publish('orders.create', { body: '{}' })).toBe(true);
    conn.close();
    expect(broker.publish('orders.create', { body: '{}' })).toBe(false);
  });

  it('keeps emitConfirmed() completing on the broker verdict', async () => {
    const { broker, conn } = startBroker();
    const publisher = new BrokerPublisher(broker);
    const pending = firstValueFrom(publisher.emitConfirmed('orders.create', { id: '1' }));

    senderFor(conn).outcome('accepted');
    await expect(pending).resolves.toBeUndefined();
  });

  it('keeps emitConfirmed() erroring on a refused publish', async () => {
    const { broker, conn } = startBroker();
    const publisher = new BrokerPublisher(broker);
    const pending = firstValueFrom(publisher.emitConfirmed('orders.create', { id: '1' }));

    senderFor(conn).outcome('rejected', 0, { condition: 'amqp:not-found' });
    await expect(pending).rejects.toThrow(/amqp:not-found/);
  });

  it('dispatches a consumer handler and settles the delivery as before', () => {
    const settled: string[] = [];
    const incoming: IncomingMessage = {
      address: 'orders.create',
      message: { body: '{"id":"1"}', properties: {}, application_properties: {} },
      delivery: {
        accept: () => settled.push('accept'),
        reject: () => settled.push('reject'),
        release: () => settled.push('release'),
        modified: () => settled.push('modified'),
      } as unknown as Delivery,
    };
    const brokerStub = {
      brand: 'unknown' as const,
      decodeBody: (b: unknown) => JSON.parse(String(b)),
      publish: () => true,
    } as never;
    const meta: ConsumerMetadata = {
      address: 'orders.create',
      kind: 'consume',
      options: { maxDelivery: 1, retryPolicy: 'immediate', dlq: false, maxWindow: 100 },
    };
    const explorer = new AmqpConsumerExplorer(undefined as never, undefined as never, undefined as never);
    const seen: unknown[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (explorer as any).dispatch(brokerStub, {}, (body: unknown) => seen.push(body), [{ kind: 'BODY' }], meta, incoming);

    expect(seen).toEqual([{ id: '1' }]);
    expect(settled).toEqual(['accept']);
  });

  it('publishes and consumes with no MeterProvider registered', () => {
    // Metrics are more often absent than traces: `NodeSDK` defaults
    // OTEL_METRICS_EXPORTER to otlp, which fails every minute when nothing
    // listens, so plenty of services pin it to `none`. The library must be
    // silent and free in exactly that setup.
    const { broker, conn } = startBroker();
    expect(broker.publish('orders.create', { body: '{}' })).toBe(true);
    expect(senderFor(conn).sent).toHaveLength(1);

    const settled: string[] = [];
    const explorer = new AmqpConsumerExplorer(undefined as never, undefined as never, undefined as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (explorer as any).dispatch(
      { brand: 'unknown', decodeBody: (b: unknown) => JSON.parse(String(b)), publish: () => true } as never,
      {},
      () => {
        throw new Error('fails, so the settlement path runs too');
      },
      [{ kind: 'BODY' }],
      {
        address: 'orders.create',
        kind: 'consume',
        options: { maxDelivery: 1, retryPolicy: 'immediate', dlq: true, maxWindow: 100 },
      },
      {
        address: 'orders.create',
        message: { body: '{"id":"1"}', properties: {}, application_properties: {} },
        delivery: {
          accept: () => settled.push('accept'),
          reject: () => settled.push('reject'),
          release: () => settled.push('release'),
          modified: () => settled.push('modified'),
        } as unknown as Delivery,
      },
    );
    expect(settled).toEqual(['reject']);
  });

  it('survives a message that carries a traceparent from a traced system', () => {
    const { broker, conn } = startBroker();
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    broker.publish('orders.create', { body: '{}', application_properties: { traceparent } });

    // No SDK here, so nothing can be extracted or linked — the context simply
    // rides along untouched for whoever downstream does have one.
    expect(senderFor(conn).sent[0]!.application_properties).toEqual({ traceparent });
  });
});
