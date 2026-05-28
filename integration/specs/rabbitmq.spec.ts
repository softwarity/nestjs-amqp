import { Test, type TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import { AmqpDestinations, AmqpModule } from '../../src';
import { TestHandlersModule } from '../fixtures/test-handlers';
import { received, resetTestState } from '../fixtures/test-state';
import { waitForAllBrokersReady } from '../fixtures/wait-ready';
import { collectNext } from '../fixtures/collect';

const RABBIT_URL = process.env.AMQP_RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5674';

describe('RabbitMQ — single broker scenarios', () => {
  let mod: TestingModule;
  let amqp: AmqpDestinations;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        AmqpModule.forRoot({
          url: RABBIT_URL,
          replyStreamAddress: 'integ.replies',
          defaultDlqAddress: 'integ.dlq-holding',
        }),
        TestHandlersModule,
      ],
    }).compile();
    await mod.init();
    await waitForAllBrokersReady(mod);
    amqp = mod.get(AmqpDestinations);
  });

  afterAll(async () => {
    await mod?.close();
  });

  beforeEach(() => {
    resetTestState();
  });

  it('1. emit + @Consume round-trip', async () => {
    const next = firstValueFrom(received.simple);
    expect(amqp.queue('integ.simple').emit({ hello: 'world' })).toBe(true);
    expect(await next).toEqual({ hello: 'world' });
  });

  it('2. send + return value (request/reply)', async () => {
    const queue = amqp.queue<{ value: number }>('integ.request-reply');
    const reply = await firstValueFrom(queue.send<{ doubled: number }>({ value: 21 }));
    expect(reply).toEqual({ doubled: 42 });
  });

  it('3. @Subscribe topic broadcast', async () => {
    const next = firstValueFrom(received.topic);
    expect(amqp.topic('integ.broadcast').emit({ tick: 1 })).toBe(true);
    expect(await next).toEqual({ tick: 1 });
  });

  it('4. retry on throw — handler is invoked again until it succeeds', async () => {
    // The handler throws on its first 2 invocations and accepts on the 3rd.
    // We assert on the BEHAVIOUR (3 invocations carrying the right body) rather
    // than on the broker's `delivery_count` field, which isn't uniformly
    // incremented on `modified(delivery_failed:true)` across brokers.
    const attempts = collectNext(received.retry, 3, 20_000);
    amqp.queue('integ.retry').emit({ flow: 'retry' });
    const seen = await attempts;
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => (s.body as { flow: string }).flow === 'retry')).toBe(true);
    // The invocation counter we own (vs the broker-tracked delivery_count)
    // gives us a stable, monotonic [1, 2, 3] across all brokers.
    expect(seen.map((s) => s.attempt)).toEqual([1, 2, 3]);
  });

  it('5. DLQ on permanent failure — message lands in the broker DLQ', async () => {
    // Handler throws on every invocation; the lib's retry policy eventually
    // calls reject() and RabbitMQ routes via integ.dlx → integ.dlq-holding,
    // which the DlqHoldingObserver consumes. We assert the BODY identifies
    // this scenario's message so a leaked message from a previous test
    // wouldn't pass silently.
    const seen = collectNext(received.dlqHolding, 1, 30_000);
    amqp.queue('integ.dlq-test').emit({ doomed: true });
    const [body] = await seen;
    expect(body).toEqual({ doomed: true });
  });

  it('6. body codec — Date round-trip', async () => {
    const sent = { when: new Date('2026-05-28T12:34:56.000Z'), label: 'now' };
    const next = firstValueFrom(received.codec);
    amqp.queue('integ.codec').emit(sent);
    const got = (await next) as typeof sent;
    expect(got.when).toBeInstanceOf(Date);
    expect(got.when.toISOString()).toBe(sent.when.toISOString());
    expect(got.label).toBe('now');
  });

  it('7. AmqpDestinations runtime lookup', async () => {
    const next = firstValueFrom(received.locator);
    expect(amqp.queue('integ.simple-locator').emit({ via: 'locator' })).toBe(true);
    expect(await next).toEqual({ via: 'locator' });
  });
});
