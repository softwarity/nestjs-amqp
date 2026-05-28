import { resolveAmqpOptions } from '../src/amqp.options';

describe('resolveAmqpOptions', () => {
  describe('validation', () => {
    it('throws when `brokers` is missing', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => resolveAmqpOptions({} as any)).toThrow(/brokers.*at least one/);
    });

    it('throws when `brokers` is empty', () => {
      expect(() => resolveAmqpOptions({ brokers: [] })).toThrow(/at least one/);
    });

    it('throws when a broker has an empty name', () => {
      expect(() => resolveAmqpOptions({ brokers: [{ name: '', url: 'amqp://x' }] })).toThrow(/non-empty `name`/);
      expect(() => resolveAmqpOptions({ brokers: [{ name: '   ', url: 'amqp://x' }] })).toThrow(/non-empty `name`/);
    });

    it('throws when a broker has an empty url', () => {
      expect(() => resolveAmqpOptions({ brokers: [{ name: 'a', url: '' }] })).toThrow(/non-empty `url`/);
    });

    it('throws when two brokers share the same name', () => {
      expect(() =>
        resolveAmqpOptions({
          brokers: [
            { name: 'a', url: 'amqp://x' },
            { name: 'a', url: 'amqp://y' },
          ],
        }),
      ).toThrow(/duplicate broker name/);
    });
  });

  describe('defaults', () => {
    it('applies all defaults on a minimal broker', () => {
      const r = resolveAmqpOptions({ brokers: [{ name: 'primary', url: 'amqp://localhost:5672' }] });
      expect(r.enabled).toBe(true);
      const b = r.brokers.get('primary')!;
      expect(b.url).toBe('amqp://localhost:5672');
      expect(b.reconnectLimit).toBe(-1);
      expect(b.initialReconnectDelayMs).toBe(100);
      expect(b.maxReconnectDelayMs).toBe(30000);
      expect(b.idleTimeoutMs).toBe(60000);
      expect(b.defaultSendTimeoutMs).toBe(30000);
      expect(b.replyStreamAddress).toBeUndefined();
      expect(b.defaultDlqAddress).toBeUndefined();
    });

    it('preserves enabled=false at the root', () => {
      const r = resolveAmqpOptions({
        enabled: false,
        brokers: [{ name: 'primary', url: 'amqp://localhost' }],
      });
      expect(r.enabled).toBe(false);
    });

    it('preserves explicit overrides', () => {
      const r = resolveAmqpOptions({
        brokers: [
          {
            name: 'primary',
            url: 'amqp://localhost',
            replyStreamAddress: 'my-svc.replies',
            defaultDlqAddress: 'my-svc.dlq',
            reconnectLimit: 10,
          },
        ],
      });
      const b = r.brokers.get('primary')!;
      expect(b.replyStreamAddress).toBe('my-svc.replies');
      expect(b.defaultDlqAddress).toBe('my-svc.dlq');
      expect(b.reconnectLimit).toBe(10);
    });
  });

  describe('multi-broker', () => {
    it('preserves declaration order in `brokerOrder`', () => {
      const r = resolveAmqpOptions({
        brokers: [
          { name: 'primary', url: 'amqp://a' },
          { name: 'analytics', url: 'amqp://b' },
          { name: 'audit', url: 'amqp://c' },
        ],
      });
      expect(r.brokerOrder).toEqual(['primary', 'analytics', 'audit']);
      expect(r.brokers.size).toBe(3);
    });

    it('indexes each broker by name', () => {
      const r = resolveAmqpOptions({
        brokers: [
          { name: 'primary', url: 'amqp://a' },
          { name: 'analytics', url: 'amqp://b' },
        ],
      });
      expect(r.brokers.get('primary')?.url).toBe('amqp://a');
      expect(r.brokers.get('analytics')?.url).toBe('amqp://b');
      expect(r.brokers.get('unknown')).toBeUndefined();
    });
  });
});
