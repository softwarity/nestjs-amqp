import { resolveAmqpOptions } from '../src/amqp.options';

describe('resolveAmqpOptions', () => {
  describe('validation', () => {
    it('throws when input is an empty array', () => {
      expect(() => resolveAmqpOptions([])).toThrow(/at least one broker/);
    });

    it('throws when a broker in the array has an empty name', () => {
      expect(() => resolveAmqpOptions([{ name: '', url: 'amqp://x' }])).toThrow(/non-empty `name`/);
      expect(() => resolveAmqpOptions([{ name: '   ', url: 'amqp://x' }])).toThrow(/non-empty `name`/);
    });

    it('throws when a broker has an empty url (single form)', () => {
      expect(() => resolveAmqpOptions({ url: '' })).toThrow(/non-empty `url`/);
    });

    it('throws when a broker has an empty url (array form)', () => {
      expect(() => resolveAmqpOptions([{ name: 'a', url: '' }])).toThrow(/non-empty `url`/);
    });

    it('throws when two brokers in the array share the same name', () => {
      expect(() =>
        resolveAmqpOptions([
          { name: 'a', url: 'amqp://x' },
          { name: 'a', url: 'amqp://y' },
        ]),
      ).toThrow(/duplicate broker name/);
    });
  });

  describe('input forms', () => {
    it('accepts a single SingleBrokerOptions (90% case, no name, no wrapping)', () => {
      const r = resolveAmqpOptions({ url: 'amqp://localhost:5672' });
      expect(r.brokers.size).toBe(1);
      expect(r.brokerOrder).toEqual(['default']);
      expect(r.brokers.get('default')?.url).toBe('amqp://localhost:5672');
    });

    it('accepts an array of BrokerOptions (multi-broker, names required)', () => {
      const r = resolveAmqpOptions([
        { name: 'primary', url: 'amqp://a' },
        { name: 'analytics', url: 'amqp://b' },
      ]);
      expect(r.brokers.size).toBe(2);
      expect(r.brokerOrder).toEqual(['primary', 'analytics']);
    });

    it('accepts a single-entry array when the user wants a custom name', () => {
      const r = resolveAmqpOptions([{ name: 'my-svc', url: 'amqp://localhost' }]);
      expect(r.brokers.size).toBe(1);
      expect(r.brokerOrder).toEqual(['my-svc']);
    });
  });

  describe('defaults', () => {
    it('applies all defaults on a minimal single broker', () => {
      const r = resolveAmqpOptions({ url: 'amqp://localhost:5672' });
      const b = r.brokers.get('default')!;
      expect(b.name).toBe('default');
      expect(b.url).toBe('amqp://localhost:5672');
      expect(b.enabled).toBe(true);
      expect(b.reconnectLimit).toBe(-1);
      expect(b.initialReconnectDelayMs).toBe(100);
      expect(b.maxReconnectDelayMs).toBe(30000);
      expect(b.idleTimeoutMs).toBe(60000);
      expect(b.defaultSendTimeoutMs).toBe(30000);
      expect(b.replyStreamAddress).toBeUndefined();
      expect(b.defaultDlqAddress).toBeUndefined();
    });

    it('preserves enabled=false per broker (single form)', () => {
      const r = resolveAmqpOptions({ url: 'amqp://localhost', enabled: false });
      expect(r.brokers.get('default')?.enabled).toBe(false);
    });

    it('lets one broker be disabled while another stays enabled (array form)', () => {
      const r = resolveAmqpOptions([
        { name: 'primary', url: 'amqp://a' },
        { name: 'analytics', url: 'amqp://b', enabled: false },
      ]);
      expect(r.brokers.get('primary')?.enabled).toBe(true);
      expect(r.brokers.get('analytics')?.enabled).toBe(false);
    });

    it('preserves explicit overrides on a single broker', () => {
      const r = resolveAmqpOptions({
        url: 'amqp://localhost',
        replyStreamAddress: 'my-svc.replies',
        defaultDlqAddress: 'my-svc.dlq',
        reconnectLimit: 10,
      });
      const b = r.brokers.get('default')!;
      expect(b.replyStreamAddress).toBe('my-svc.replies');
      expect(b.defaultDlqAddress).toBe('my-svc.dlq');
      expect(b.reconnectLimit).toBe(10);
    });
  });

  describe('multi-broker', () => {
    it('preserves declaration order in `brokerOrder`', () => {
      const r = resolveAmqpOptions([
        { name: 'primary', url: 'amqp://a' },
        { name: 'analytics', url: 'amqp://b' },
        { name: 'audit', url: 'amqp://c' },
      ]);
      expect(r.brokerOrder).toEqual(['primary', 'analytics', 'audit']);
      expect(r.brokers.size).toBe(3);
    });

    it('indexes each broker by name', () => {
      const r = resolveAmqpOptions([
        { name: 'primary', url: 'amqp://a' },
        { name: 'analytics', url: 'amqp://b' },
      ]);
      expect(r.brokers.get('primary')?.url).toBe('amqp://a');
      expect(r.brokers.get('analytics')?.url).toBe('amqp://b');
      expect(r.brokers.get('unknown')).toBeUndefined();
    });
  });
});
