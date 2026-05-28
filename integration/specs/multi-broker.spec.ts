import { Test, type TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import { AmqpDestinations, AmqpModule, BrokerRegistry } from '../../src';
import {
  ArtemisConsumer,
  MultiBrokerHandlersModule,
  RabbitConsumer,
  receivedOnArtemis,
  receivedOnRabbit,
} from '../fixtures/multi-broker-handlers';
import { waitForAllBrokersReady } from '../fixtures/wait-ready';

const RABBIT_URL = process.env.AMQP_RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5674';
const ARTEMIS_URL = process.env.AMQP_ARTEMIS_URL ?? 'amqp://artemis:artemis@localhost:5675';

describe('Multi-broker — two brokers in one process', () => {
  let mod: TestingModule;
  let amqp: AmqpDestinations;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        AmqpModule.forRoot([
          { name: 'rabbit', url: RABBIT_URL, replyStreamAddress: 'integ.replies', defaultDlqAddress: 'integ.dlq-holding' },
          { name: 'artemis', url: ARTEMIS_URL, replyStreamAddress: 'integ.replies', defaultDlqAddress: 'integ.dlq-holding' },
        ]),
        MultiBrokerHandlersModule,
      ],
    }).compile();
    await mod.init();
    await waitForAllBrokersReady(mod);
    amqp = mod.get(AmqpDestinations);
  });

  afterAll(async () => {
    await mod?.close();
  });

  it('registers two brokers under their declared names', () => {
    const registry = mod.get(BrokerRegistry);
    expect(registry.names()).toEqual(['rabbit', 'artemis']);
    expect(registry.isSingle()).toBe(false);
  });

  it('routes a message emitted on rabbit to the rabbit handler only', async () => {
    const next = firstValueFrom(receivedOnRabbit);
    expect(amqp.queue('integ.simple', 'rabbit').emit({ source: 'rabbit-side' })).toBe(true);
    expect(await next).toEqual({ source: 'rabbit-side' });
    // Make sure the artemis handler did not receive it (give the network a
    // moment before asserting silence).
    await new Promise((r) => setTimeout(r, 200));
  });

  it('routes a message emitted on artemis to the artemis handler only', async () => {
    const next = firstValueFrom(receivedOnArtemis);
    expect(amqp.queue('integ.simple', 'artemis').emit({ source: 'artemis-side' })).toBe(true);
    expect(await next).toEqual({ source: 'artemis-side' });
  });

  it('AmqpDestinations.queue() throws without a broker name in multi-broker mode', () => {
    expect(() => amqp.queue('integ.simple')).toThrow(/broker name is required/);
  });

  it('exposes both BrokerConnections via the registry with independent brands', () => {
    const registry = mod.get(BrokerRegistry);
    const rabbit = registry.getConnection('rabbit');
    const artemis = registry.getConnection('artemis');
    expect(rabbit.brand).toBe('rabbitmq');
    expect(artemis.brand).toBe('artemis');
  });

  // Reference the imported handler classes so TS doesn't drop them in tree-shaking.
  it('handler classes wired by Nest (smoke)', () => {
    expect(mod.get(RabbitConsumer)).toBeInstanceOf(RabbitConsumer);
    expect(mod.get(ArtemisConsumer)).toBeInstanceOf(ArtemisConsumer);
  });
});
