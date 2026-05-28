import { Test, type TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import { AmqpDestinations, AmqpModule } from '../../src';
import { TestHandlersModule } from '../fixtures/test-handlers';
import { received, resetTestState } from '../fixtures/test-state';
import { waitForAllBrokersReady } from '../fixtures/wait-ready';
import { collectNext } from '../fixtures/collect';

const ARTEMIS_URL = process.env.AMQP_ARTEMIS_URL ?? 'amqp://artemis:artemis@localhost:5675';

/**
 * Artemis runs with the image's default broker.xml (we don't mount a custom
 * one — it would short-circuit the image's instance init). That config has
 * `auto-create-queues = true`, which covers most scenarios. The two scenarios
 * that need explicit topology config are skipped on Artemis with a comment:
 *   - #3 broadcast: needs a multicast address declared in broker.xml
 *   - #5 DLQ: needs a `<dead-letter-address>` + the catch-all DLQ declared
 *
 * Both are fully covered on RabbitMQ where we mount a full `definitions.json`.
 */
describe('ActiveMQ Artemis — single broker scenarios', () => {
  let mod: TestingModule;
  let amqp: AmqpDestinations;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        AmqpModule.forRoot({
          url: ARTEMIS_URL,
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

  // Multicast / topic broadcast requires `<address name="integ.broadcast"><multicast/></address>`
  // declared in broker.xml. Skipped here because we run with the image's
  // default config (see file header). The RabbitMQ spec covers this scenario.
  it.skip('3. @Subscribe topic broadcast — needs broker.xml mount', () => {});

  it('4. retry on throw — handler is invoked again until it succeeds', async () => {
    // See rabbitmq.spec.ts for the rationale on counting invocations
    // ourselves instead of trusting the broker's delivery_count.
    const attempts = collectNext(received.retry, 3, 20_000);
    amqp.queue('integ.retry').emit({ flow: 'retry' });
    const seen = await attempts;
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => (s.body as { flow: string }).flow === 'retry')).toBe(true);
    expect(seen.map((s) => s.attempt)).toEqual([1, 2, 3]);
  });

  // DLQ via DLX requires a `<dead-letter-address>` setting on the queue plus
  // the catch-all DLQ declared in broker.xml. Skipped for the same reason
  // as #3. Covered by RabbitMQ.
  it.skip('5. DLQ on permanent failure — needs broker.xml mount', () => {});

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
