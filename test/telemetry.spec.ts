import { Logger } from '@nestjs/common';
import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { Delivery, Message } from 'rhea';
import { Subject } from 'rxjs';
import { AmqpConsumerExplorer } from '../src/amqp.consumer-explorer';
import { resolveAmqpOptions, type BrokerOptions } from '../src/amqp.options';
import type { AmqpParamMeta, ConsumerMetadata, IncomingMessage } from '../src/amqp.types';
import { BrokerConnection } from '../src/broker-connection';
import { BrokerPublisher } from '../src/broker-publisher';
import { FakeConnection, FakeSender } from './fake-rhea';

jest.mock('rhea', () => ({ connect: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rhea = require('rhea') as { connect: jest.Mock };

const exporter = new InMemorySpanExporter();

type RecordedSpan = ReturnType<InMemorySpanExporter['getFinishedSpans']>[number];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function startBroker(overrides: Partial<BrokerOptions> = {}): { broker: BrokerConnection; conn: FakeConnection } {
  const resolved = resolveAmqpOptions({ url: 'amqp://localhost', confirmTimeoutMs: 40, ...overrides });
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

function finished(name?: string): RecordedSpan[] {
  const spans = exporter.getFinishedSpans();
  return name ? spans.filter((s) => s.name === name) : spans;
}

function only(name: string): RecordedSpan {
  const spans = finished(name);
  expect(spans).toHaveLength(1);
  return spans[0]!;
}

/** Run `fn` inside a recorded span, so publishes have a parent to inherit. */
function inSpan<T>(name: string, fn: (span: Span) => T): T {
  const span = trace.getTracer('test').startSpan(name);
  try {
    return context.with(trace.setSpan(context.active(), span), () => fn(span));
  } finally {
    span.end();
  }
}

/** A carrier holding the trace context of a span that is not ours — what an
 *  incoming message, or a message being replayed, looks like. */
function carrierFromForeignSpan(): { carrier: Record<string, unknown>; traceId: string; spanId: string } {
  const span = trace.getTracer('test').startSpan('foreign publisher');
  const carrier: Record<string, unknown> = {};
  context.with(trace.setSpan(ROOT_CONTEXT, span), () => propagation.inject(context.active(), carrier));
  span.end();
  const { traceId, spanId } = span.spanContext();
  return { carrier, traceId, spanId };
}

describe('OpenTelemetry instrumentation', () => {
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ sampler: new AlwaysOnSampler(), spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterAll(() => {
    // Leave the globals as we found them: jest shares a worker between files.
    trace.disable();
    propagation.disable();
    context.disable();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    exporter.reset();
    rhea.connect.mockReset();
  });

  // -------------------------------------------------------------------------
  // Publisher
  // -------------------------------------------------------------------------

  describe('emit() — producer span and propagation', () => {
    it('emits a PRODUCER span named after the operation and destination', () => {
      const { broker, conn } = startBroker();
      inSpan('POST /orders', () => broker.publish('orders.create', { body: '{}' }));

      const span = only('send orders.create');
      expect(span.kind).toBe(SpanKind.PRODUCER);
      expect(span.attributes).toMatchObject({
        'messaging.system': 'amqp',
        'messaging.destination.name': 'orders.create',
        'messaging.operation.name': 'send',
        'messaging.operation.type': 'send',
      });
      expect(senderFor(conn).sent).toHaveLength(1);
    });

    it('makes the publish a child of whatever is active — nothing to pass explicitly', () => {
      const { broker } = startBroker();
      const caller = inSpan('POST /orders', (span) => {
        broker.publish('orders.create', { body: '{}' });
        return span.spanContext();
      });

      const span = only('send orders.create');
      expect(span.spanContext().traceId).toBe(caller.traceId);
      expect(span.parentSpanContext?.spanId).toBe(caller.spanId);
    });

    it('injects the traceparent into application_properties, pointing at the producer span', () => {
      const { broker, conn } = startBroker();
      inSpan('POST /orders', () => broker.publish('orders.create', { body: '{}' }));

      const [sent] = senderFor(conn).sent;
      const traceparent = String((sent!.application_properties as Record<string, unknown>).traceparent);
      const span = only('send orders.create');
      expect(traceparent).toContain(span.spanContext().traceId);
      expect(traceparent).toContain(span.spanContext().spanId);
    });

    it('does not mutate the application properties the caller handed over', () => {
      const { broker } = startBroker();
      const userProps: Record<string, unknown> = { tenant: 'acme' };
      inSpan('POST /orders', () => broker.publish('orders.create', { body: '{}', application_properties: userProps }));

      // A leaked traceparent here would pin every later publish reusing this
      // object to the first trace that touched it.
      expect(userProps).toEqual({ tenant: 'acme' });
    });

    it('keeps a traceparent the message already carries, and links to it instead', () => {
      const { broker, conn } = startBroker();
      const foreign = carrierFromForeignSpan();

      inSpan('POST /admin/replay', () =>
        broker.publish('orders.create', { body: '{}', application_properties: { ...foreign.carrier } }),
      );

      const [sent] = senderFor(conn).sent;
      expect((sent!.application_properties as Record<string, unknown>).traceparent).toBe(foreign.carrier.traceparent);
      const span = only('send orders.create');
      expect(span.links).toHaveLength(1);
      expect(span.links[0]!.context.traceId).toBe(foreign.traceId);
      expect(span.links[0]!.context.spanId).toBe(foreign.spanId);
    });

    it('records a publish dropped because the connection is closed', () => {
      const { broker, conn } = startBroker();
      conn.close();

      expect(inSpan('POST /orders', () => broker.publish('orders.create', { body: '{}' }))).toBe(false);
      const span = only('send orders.create');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes['error.type']).toBe('unsent');
    });

    it('emits nothing at all when the broker is disabled', () => {
      const { broker } = startBroker({ enabled: false });
      inSpan('POST /orders', () => broker.publish('orders.create', { body: '{}' }));

      expect(finished('send orders.create')).toHaveLength(0);
    });

    it('reports the peer brand as messaging.system', () => {
      const { broker, conn } = startBroker();
      // Brand detection reads the peer's Open frame on connection_open.
      Object.assign(conn, { remote: { open: { properties: { product: 'RabbitMQ', version: '4.3.6' } } } });
      conn.fire('connection_open');

      inSpan('POST /orders', () => broker.publish('orders.create', { body: '{}' }));

      const span = only('send orders.create');
      expect(span.attributes['messaging.system']).toBe('rabbitmq');
      // The span reports the address the caller used, not the broker-specific
      // rewrite ('/queues/orders.create'): lower cardinality, and it matches
      // what the developer wrote.
      expect(span.attributes['messaging.destination.name']).toBe('orders.create');
      expect(conn.senders.has('/queues/orders.create')).toBe(true);
    });
  });

  it('reports the address as written, even when publishing to the broker-rewritten form', () => {
    // The reply path publishes to the `reply_to` the requester put on the
    // wire, which on RabbitMQ is '/queues/x' — it has to be, so that a
    // responder written against another library can use it verbatim. The span
    // must still say 'x', or one span in a request/reply trace disagrees with
    // its siblings and grouping by destination breaks.
    const { broker, conn } = startBroker();
    Object.assign(conn, { remote: { open: { properties: { product: 'RabbitMQ' } } } });
    conn.fire('connection_open');

    inSpan('reply', () => broker.publish('/queues/svc.replies', { body: '{}' }));

    const span = only('send svc.replies');
    expect(span.attributes['messaging.destination.name']).toBe('svc.replies');
  });

  describe('emitConfirmed() — the span carries the broker verdict', () => {
    it('stays open until the verdict, then ends clean on accepted', () => {
      const { broker, conn } = startBroker();
      const publisher = new BrokerPublisher(broker);
      inSpan('POST /orders', () => publisher.emitConfirmed('orders.create', { id: '1' }).subscribe({ error: () => {} }));

      // Handed to rhea, but no verdict yet: nothing has ended.
      expect(finished('send orders.create')).toHaveLength(0);

      senderFor(conn).outcome('accepted');
      const span = only('send orders.create');
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      expect(span.attributes['error.type']).toBeUndefined();
    });

    it('carries the outcome as error.type when the broker refuses the message', () => {
      const { broker, conn } = startBroker();
      const publisher = new BrokerPublisher(broker);
      inSpan('POST /orders', () => publisher.emitConfirmed('orders.create', { id: '1' }).subscribe({ error: () => {} }));

      senderFor(conn).outcome('released');
      const span = only('send orders.create');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes['error.type']).toBe('released');
    });

    it('marks a publish that never got a verdict as timeout', async () => {
      const { broker } = startBroker({ confirmTimeoutMs: 20 });
      const publisher = new BrokerPublisher(broker);
      await new Promise<void>((resolve) => {
        inSpan('POST /orders', () =>
          publisher.emitConfirmed('orders.create', { id: '1' }).subscribe({ error: () => resolve() }),
        );
      });

      expect(only('send orders.create').attributes['error.type']).toBe('timeout');
    });
  });

  // -------------------------------------------------------------------------
  // Consumer
  // -------------------------------------------------------------------------

  describe('@Consume — the process span anchors the handler', () => {
    function dispatch(handler: (...args: unknown[]) => unknown, incoming: IncomingMessage, params: AmqpParamMeta[] = [{ kind: 'BODY' }]): void {
      const explorer = new AmqpConsumerExplorer(undefined as never, undefined as never, undefined as never);
      const meta: ConsumerMetadata = {
        address: 'orders.create',
        kind: 'consume',
        options: { maxDelivery: 1, retryPolicy: 'immediate', dlq: false, maxWindow: 100 },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (explorer as any).dispatch(brokerStub, {}, handler, params, meta, incoming);
    }

    const published: { address: string; parent?: string }[] = [];
    const brokerStub = {
      brand: 'rabbitmq' as const,
      decodeBody: (b: unknown) => JSON.parse(String(b)),
      encodeBody: (v: unknown) => JSON.stringify(v),
      publish: (address: string, _message: Message) => {
        published.push({ address, parent: trace.getSpan(context.active())?.spanContext().spanId });
        return true;
      },
    } as never;

    function incomingMessage(carrier: Record<string, unknown>, replyTo?: string): {
      incoming: IncomingMessage;
      settled: string[];
    } {
      const settled: string[] = [];
      const delivery = {
        accept: () => settled.push('accept'),
        release: () => settled.push('release'),
        reject: () => settled.push('reject'),
        modified: () => settled.push('modified'),
      } as unknown as Delivery;
      return {
        settled,
        incoming: {
          address: 'orders.create',
          message: {
            body: '{"id":"1"}',
            properties: { message_id: 'msg-1', ...(replyTo ? { reply_to: replyTo, correlation_id: 'corr-1' } : {}) },
            application_properties: carrier,
          },
          delivery,
        },
      };
    }

    beforeEach(() => (published.length = 0));

    it('is a CONSUMER span, child of the publishing context the message carries', () => {
      const foreign = carrierFromForeignSpan();
      const { incoming, settled } = incomingMessage({ ...foreign.carrier });

      dispatch(() => undefined, incoming);

      const span = only('process orders.create');
      expect(span.kind).toBe(SpanKind.CONSUMER);
      expect(span.spanContext().traceId).toBe(foreign.traceId);
      expect(span.parentSpanContext?.spanId).toBe(foreign.spanId);
      expect(span.attributes).toMatchObject({
        'messaging.system': 'rabbitmq',
        'messaging.destination.name': 'orders.create',
        'messaging.operation.name': 'process',
        'messaging.operation.type': 'process',
        'messaging.message.id': 'msg-1',
      });
      expect(settled).toEqual(['accept']);
    });

    it('starts a root span when the message carries no context', () => {
      const { incoming } = incomingMessage({});
      dispatch(() => undefined, incoming);

      const span = only('process orders.create');
      expect(span.parentSpanContext).toBeUndefined();
    });

    it('records a handler that throws', () => {
      const { incoming } = incomingMessage({});
      dispatch(() => {
        throw new TypeError('boom');
      }, incoming);

      const span = only('process orders.create');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes['error.type']).toBe('TypeError');
      expect(span.events.map((e) => e.name)).toContain('exception');
    });

    it('waits for an Observable handler to complete before ending the span', () => {
      const { incoming, settled } = incomingMessage({});
      const subject = new Subject<void>();
      dispatch(() => subject.asObservable(), incoming);

      expect(finished('process orders.create')).toHaveLength(0);
      expect(settled).toEqual([]);

      subject.complete();
      expect(finished('process orders.create')).toHaveLength(1);
      expect(settled).toEqual(['accept']);
    });

    it('records an Observable handler that errors', () => {
      const { incoming } = incomingMessage({});
      const subject = new Subject<void>();
      dispatch(() => subject.asObservable(), incoming);
      subject.error(new Error('async boom'));

      const span = only('process orders.create');
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes['error.type']).toBe('Error');
    });

    it('publishes the auto-reply inside the process span', () => {
      const { incoming } = incomingMessage({}, 'replies.stream');
      dispatch(() => ({ ok: true }), incoming);

      const span = only('process orders.create');
      expect(published).toEqual([{ address: 'replies.stream', parent: span.spanContext().spanId }]);
    });
  });

  // -------------------------------------------------------------------------
  // Request / reply
  // -------------------------------------------------------------------------

  describe('send() — round trip as a CLIENT span, reply as a link', () => {
    function publisherWithReplyStream(): { publisher: BrokerPublisher; sent: Message[] } {
      const sent: Message[] = [];
      const replyAddress = new Subject<string>();
      const broker = {
        brand: 'rabbitmq' as const,
        replyPrefix: 'prefix',
        options: { name: 'default', replyStreamAddress: 'replies.stream', defaultSendTimeoutMs: 50 },
        replyToAddress$: replyAddress.asObservable(),
        replies$: new Subject<IncomingMessage>().asObservable(),
        encodeBody: (v: unknown) => JSON.stringify(v),
        decodeBody: (b: unknown) => JSON.parse(String(b)),
        publish: (_address: string, message: Message) => {
          sent.push(message);
          return true;
        },
      } as never;
      const publisher = new BrokerPublisher(broker);
      setImmediate(() => replyAddress.next('replies.stream'));
      return { publisher, sent };
    }

    it('opens a CLIENT span carrying the correlation id, with the publish nested inside', async () => {
      const { publisher, sent } = publisherWithReplyStream();
      const reply = new Promise<void>((resolve) => {
        inSpan('POST /orders', () => publisher.send('orders.create', { id: '1' }).subscribe({ error: () => resolve() }));
      });
      await reply; // times out — we only care about the spans

      const client = only('send orders.create');
      expect(client.kind).toBe(SpanKind.CLIENT);
      expect(client.attributes['messaging.message.conversation_id']).toBe(
        String(sent[0]!.properties!.correlation_id),
      );
      expect(client.status.code).toBe(SpanStatusCode.ERROR);
      expect(client.attributes['error.type']).toBe('AmqpTimeoutError');
    });

    it('links the round trip to the reply message rather than adopting it', async () => {
      const { publisher, sent } = publisherWithReplyStream();
      const received = new Promise<unknown>((resolve) => {
        inSpan('POST /orders', () => publisher.send('orders.create', { id: '1' }).subscribe({ next: resolve }));
      });
      await new Promise((r) => setImmediate(r));

      const foreign = carrierFromForeignSpan();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (publisher as any).routeReply({
        address: 'replies.stream',
        message: {
          body: '{"ok":true}',
          properties: { correlation_id: sent[0]!.properties!.correlation_id },
          application_properties: foreign.carrier,
        },
        delivery: { accept: () => undefined } as unknown as Delivery,
      });
      await expect(received).resolves.toEqual({ ok: true });

      const client = only('send orders.create');
      expect(client.status.code).toBe(SpanStatusCode.UNSET);
      expect(client.links).toHaveLength(1);
      expect(client.links[0]!.context.spanId).toBe(foreign.spanId);
    });
  });
});
