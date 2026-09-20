import { Test, type TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import { AmqpDestinations, AmqpModule, AmqpPublishError } from '../../src';
import { TestHandlersModule } from '../fixtures/test-handlers';
import { received, resetTestState } from '../fixtures/test-state';
import { waitForAllBrokersReady } from '../fixtures/wait-ready';
import { collectNext } from '../fixtures/collect';

const QPID_URL = process.env.AMQP_QPID_URL ?? 'amqp://admin:admin@localhost:5676';

/**
 * Qpid Broker-J runs with the topology declared up front in
 * `integration/qpid/default.json` — it auto-creates nothing, unlike Artemis.
 *
 * One scenario is skipped, for a broker behaviour worth knowing about:
 *   - #5 DLQ: Qpid does not increment the AMQP `delivery-count` on
 *     `modified(delivery_failed: true)`, so the library's `maxDelivery` never
 *     trips and `dlq: true` never fires. Measured: a handler that always
 *     throws was re-invoked ~24 000 times in 5 seconds. See the broker
 *     support table in the README.
 */

describe('Qpid Broker-J — single broker scenarios', () => {
  let mod: TestingModule;
  let amqp: AmqpDestinations;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        AmqpModule.forRoot({
          url: QPID_URL,
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

  // Passes against a plain queue with ONE subscriber. Qpid has no stream
  // queue, so real fan-out to N instances needs a topic exchange declared
  // broker-side — this proves the wiring, not the broadcast semantics.
  it('3. @Subscribe on a plain queue — single subscriber', async () => {
    const next = firstValueFrom(received.topic);
    expect(amqp.topic('integ.broadcast').emit({ tick: 1 })).toBe(true);
    expect(await next).toEqual({ tick: 1 });
  });

  it('4. retry on throw — handler is invoked again until it succeeds', async () => {
    const attempts = collectNext(received.retry, 3, 20_000);
    amqp.queue('integ.retry').emit({ flow: 'retry' });
    const seen = await attempts;
    expect(seen).toHaveLength(3);
    expect(seen.map((s) => s.attempt)).toEqual([1, 2, 3]);
  });

  // The queue carries an `alternateBinding` to integ.dlq-holding (Qpid's
  // equivalent of a DLX), so the broker side is ready — but the library never
  // gets to reject the message, because `delivery-count` stays at 0 here.
  // Skipped rather than silently green. Covered on RabbitMQ.
  it.skip('5. DLQ on permanent failure — Qpid does not track delivery-count', () => {});

  it('6. body codec — Date round-trip', async () => {
    const sent = { when: new Date('2026-05-28T12:34:56.000Z'), label: 'now' };
    const next = firstValueFrom(received.codec);
    amqp.queue('integ.codec').emit(sent);
    const got = (await next) as typeof sent;
    expect(got.when).toBeInstanceOf(Date);
    expect(got.when.toISOString()).toBe(sent.when.toISOString());
  });

  it('7. AmqpDestinations runtime lookup', async () => {
    const next = firstValueFrom(received.locator);
    expect(amqp.queue('integ.simple-locator').emit({ via: 'locator' })).toBe(true);
    expect(await next).toEqual({ via: 'locator' });
  });

  it('8. emitConfirmed — the broker accepts and the consumer gets the message', async () => {
    const next = firstValueFrom(received.simple);
    await expect(firstValueFrom(amqp.queue('integ.simple').emitConfirmed({ confirmed: true }))).resolves.toBeUndefined();
    expect(await next).toEqual({ confirmed: true });
  });

  it('9. emitConfirmed — an address that does not exist surfaces an error', async () => {
    const err: unknown = await firstValueFrom(
      amqp.queue('integ.nowhere-at-all').emitConfirmed({ lost: true }, { timeoutMs: 10_000 }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AmqpPublishError);
    // Qpid declares nothing on its own, so the link attach fails — same
    // answer as RabbitMQ 4.x, and the opposite of Artemis with auto-create on.
    expect((err as AmqpPublishError).outcome).toBe('unsent');
    expect((err as AmqpPublishError).condition).toBe('amqp:not-found');
  });
});
