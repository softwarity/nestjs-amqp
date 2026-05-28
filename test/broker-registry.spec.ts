import { BrokerRegistry } from '../src/broker-registry';
import { resolveAmqpOptions } from '../src/amqp.options';

function makeRegistry(brokerNames: string[]): BrokerRegistry {
  const opts = resolveAmqpOptions({
    enabled: false, // keep BrokerConnection.start() a no-op so we don't touch rhea
    brokers: brokerNames.map((name, idx) => ({ name, url: `amqp://broker-${idx}` })),
  });
  return new BrokerRegistry(opts);
}

describe('BrokerRegistry', () => {
  describe('lookup', () => {
    it('returns a connection by name', () => {
      const reg = makeRegistry(['primary', 'analytics']);
      expect(reg.getConnection('primary').options.name).toBe('primary');
      expect(reg.getConnection('analytics').options.name).toBe('analytics');
    });

    it('returns a publisher by name', () => {
      const reg = makeRegistry(['primary']);
      expect(reg.getPublisher('primary')).toBeDefined();
    });

    it('throws on unknown name with the list of known brokers', () => {
      const reg = makeRegistry(['primary', 'analytics']);
      expect(() => reg.getConnection('bogus')).toThrow(/Broker 'bogus' is not configured/);
      expect(() => reg.getConnection('bogus')).toThrow(/primary, analytics/);
    });
  });

  describe('default broker', () => {
    it('uses the first declared broker as default', () => {
      const reg = makeRegistry(['primary', 'analytics']);
      expect(reg.getDefaultName()).toBe('primary');
      expect(reg.getDefaultConnection().options.name).toBe('primary');
    });

    it('isSingle() reflects the broker count', () => {
      expect(makeRegistry(['only']).isSingle()).toBe(true);
      expect(makeRegistry(['a', 'b']).isSingle()).toBe(false);
    });
  });

  describe('resolveConnection', () => {
    it('returns the lone broker when name is omitted in single-broker mode', () => {
      const reg = makeRegistry(['only']);
      expect(reg.resolveConnection(undefined).options.name).toBe('only');
    });

    it('throws when name is omitted in multi-broker mode', () => {
      const reg = makeRegistry(['a', 'b']);
      expect(() => reg.resolveConnection(undefined)).toThrow(/broker name is required/);
    });

    it('resolves by explicit name in multi-broker mode', () => {
      const reg = makeRegistry(['a', 'b']);
      expect(reg.resolveConnection('b').options.name).toBe('b');
    });

    it('throws on unknown name', () => {
      const reg = makeRegistry(['a']);
      expect(() => reg.resolveConnection('bogus')).toThrow(/Broker 'bogus'/);
    });
  });

  describe('resolvePublisher', () => {
    it('mirrors resolveConnection semantics', () => {
      const single = makeRegistry(['only']);
      expect(single.resolvePublisher(undefined)).toBeDefined();
      const multi = makeRegistry(['a', 'b']);
      expect(() => multi.resolvePublisher(undefined)).toThrow(/broker name is required/);
      expect(multi.resolvePublisher('b')).toBeDefined();
    });
  });

  it('names() returns the declaration order', () => {
    const reg = makeRegistry(['x', 'y', 'z']);
    expect(reg.names()).toEqual(['x', 'y', 'z']);
  });
});
