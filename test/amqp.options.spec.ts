import { resolveAmqpOptions } from '../src/amqp.options';

describe('resolveAmqpOptions', () => {
  describe('validation', () => {
    it('throws when input is an empty array', () => {
      expect(() => resolveAmqpOptions([])).toThrow(/at least one broker/);
    });

    it('throws when a broker has an empty name', () => {
      expect(() => resolveAmqpOptions({ name: '', url: 'amqp://x' })).toThrow(/non-empty `name`/);
      expect(() => resolveAmqpOptions({ name: '   ', url: 'amqp://x' })).toThrow(/non-empty `name`/);
    });

    it('throws when a broker has an empty url', () => {
      expect(() => resolveAmqpOptions({ name: 'a', url: '' })).toThrow(/non-empty `url`/);
    });

    it('throws when two brokers share the same name', () => {
      expect(() =>
        resolveAmqpOptions([
          { name: 'a', url: 'amqp://x' },
          { name: 'a', url: 'amqp://y' },
        ]),
      ).toThrow(/duplicate broker name/);
    });
  });

  describe('input forms', () => {
    it('accepts a single BrokerOptions (90% case, no wrapping)', () => {
      const r = resolveAmqpOptions({ name: 'default', url: 'amqp://localhost:5672' });
      expect(r.brokers.size).toBe(1);
      expect(r.brokerOrder).toEqual(['default']);
      expect(r.brokers.get('default')?.url).toBe('amqp://localhost:5672');
    });

    it('accepts an array of BrokerOptions (multi-broker)', () => {
      const r = resolveAmqpOptions([
        { name: 'primary', url: 'amqp://a' },
        { name: 'analytics', url: 'amqp://b' },
      ]);
      expect(r.brokers.size).toBe(2);
      expect(r.brokerOrder).toEqual(['primary', 'analytics']);
    });
  });

  describe('defaults', () => {
    it('applies all defaults on a minimal broker', () => {
      const r = resolveAmqpOptions({ name: 'primary', url: 'amqp://localhost:5672' });
      const b = r.brokers.get('primary')!;
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

    it('preserves enabled=false per broker', () => {
      const r = resolveAmqpOptions({
        name: 'primary',
        url: 'amqp://localhost',
        enabled: false,
      });
      expect(r.brokers.get('primary')?.enabled).toBe(false);
    });

    it('lets one broker be disabled while another stays enabled', () => {
      const r = resolveAmqpOptions([
        { name: 'primary', url: 'amqp://a' },
        { name: 'analytics', url: 'amqp://b', enabled: false },
      ]);
      expect(r.brokers.get('primary')?.enabled).toBe(true);
      expect(r.brokers.get('analytics')?.enabled).toBe(false);
    });

    it('preserves explicit overrides', () => {
      const r = resolveAmqpOptions({
        name: 'primary',
        url: 'amqp://localhost',
        replyStreamAddress: 'my-svc.replies',
        defaultDlqAddress: 'my-svc.dlq',
        reconnectLimit: 10,
      });
      const b = r.brokers.get('primary')!;
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
