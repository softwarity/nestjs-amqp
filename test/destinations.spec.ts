import { AmqpDestinations } from '../src/amqp.destinations';
import { BrokerRegistry } from '../src/broker-registry';
import { resolveAmqpOptions } from '../src/amqp.options';

function makeDestinations(brokerNames: string[]): { amqp: AmqpDestinations; registry: BrokerRegistry } {
  const opts = resolveAmqpOptions(
    brokerNames.map((name, idx) => ({ name, url: `amqp://broker-${idx}`, enabled: false })),
  );
  const registry = new BrokerRegistry(opts);
  const amqp = new AmqpDestinations(registry);
  return { amqp, registry };
}

describe('AmqpDestinations', () => {
  describe('single-broker mode', () => {
    it('queue() resolves with no brokerName', () => {
      const { amqp } = makeDestinations(['only']);
      const queue = amqp.queue<{ id: string }>('orders');
      expect(queue).toBeDefined();
      expect(typeof queue.emit).toBe('function');
      expect(typeof queue.send).toBe('function');
    });

    it('topic() resolves with no brokerName', () => {
      const { amqp } = makeDestinations(['only']);
      const topic = amqp.topic<{ id: string }>('events');
      expect(topic).toBeDefined();
      expect(typeof topic.emit).toBe('function');
    });
  });

  describe('multi-broker mode', () => {
    it('throws when queue() is called without brokerName', () => {
      const { amqp } = makeDestinations(['a', 'b']);
      expect(() => amqp.queue('orders')).toThrow(/broker name is required/);
    });

    it('resolves with explicit brokerName', () => {
      const { amqp } = makeDestinations(['a', 'b']);
      const q = amqp.queue('orders', 'b');
      expect(q).toBeDefined();
    });

    it('throws on unknown brokerName', () => {
      const { amqp } = makeDestinations(['a']);
      expect(() => amqp.queue('orders', 'bogus')).toThrow(/Broker 'bogus'/);
    });
  });
});
