import 'reflect-metadata';
import { Consume, Subscribe, AMQP_CONSUMER_METADATA } from '../src/consumers.decorator';
import type { ConsumerMetadata } from '../src/amqp.types';

function readMeta(target: object, method: string): ConsumerMetadata {
  return Reflect.getMetadata(AMQP_CONSUMER_METADATA, target, method) as ConsumerMetadata;
}

describe('@Consume', () => {
  it('records metadata with defaults (no broker, no options)', () => {
    class Handler {
      @Consume('orders.created')
      onCreated(): void {}
    }
    const meta = readMeta(Handler.prototype, 'onCreated');
    expect(meta).toBeDefined();
    expect(meta.kind).toBe('consume');
    expect(meta.address).toBe('orders.created');
    expect(meta.brokerName).toBeUndefined();
    expect(meta.options.maxDelivery).toBe(1);
    expect(meta.options.retryPolicy).toBe('immediate');
    expect(meta.options.dlq).toBe(false);
    expect(meta.options.maxWindow).toBe(100);
    expect(meta.options.streamOffset).toBeUndefined();
  });

  describe('argument forms', () => {
    it('accepts (address, brokerName) — string in 2nd slot', () => {
      class Handler {
        @Consume('orders.created', 'primary')
        onCreated(): void {}
      }
      const meta = readMeta(Handler.prototype, 'onCreated');
      expect(meta.brokerName).toBe('primary');
      expect(meta.options.maxDelivery).toBe(1);
    });

    it('accepts (address, options) — object in 2nd slot (single-broker form)', () => {
      class Handler {
        @Consume('orders.created', { maxDelivery: 5, dlq: true })
        onCreated(): void {}
      }
      const meta = readMeta(Handler.prototype, 'onCreated');
      expect(meta.brokerName).toBeUndefined();
      expect(meta.options.maxDelivery).toBe(5);
      expect(meta.options.dlq).toBe(true);
    });

    it('accepts (address, brokerName, options) — full form', () => {
      class Handler {
        @Consume('orders.created', 'primary', { maxDelivery: 5, dlq: true, maxWindow: 50 })
        onCreated(): void {}
      }
      const meta = readMeta(Handler.prototype, 'onCreated');
      expect(meta.brokerName).toBe('primary');
      expect(meta.options.maxDelivery).toBe(5);
      expect(meta.options.dlq).toBe(true);
      expect(meta.options.maxWindow).toBe(50);
    });
  });

  describe('retryPolicy', () => {
    it("defaults to 'immediate'", () => {
      class Handler {
        @Consume('addr')
        onMsg(): void {}
      }
      expect(readMeta(Handler.prototype, 'onMsg').options.retryPolicy).toBe('immediate');
    });

    it('accepts fixed policy', () => {
      class Handler {
        @Consume('addr', { retryPolicy: { kind: 'fixed', delayMs: 1000 } })
        onMsg(): void {}
      }
      expect(readMeta(Handler.prototype, 'onMsg').options.retryPolicy).toEqual({ kind: 'fixed', delayMs: 1000 });
    });

    it('accepts exponential policy', () => {
      class Handler {
        @Consume('addr', { retryPolicy: { kind: 'exponential', initialMs: 1000, multiplier: 2, maxMs: 60000 } })
        onMsg(): void {}
      }
      expect(readMeta(Handler.prototype, 'onMsg').options.retryPolicy).toEqual({
        kind: 'exponential',
        initialMs: 1000,
        multiplier: 2,
        maxMs: 60000,
      });
    });

    it('throws on fixed.delayMs <= 0', () => {
      expect(() => {
        class Handler {
          @Consume('addr', { retryPolicy: { kind: 'fixed', delayMs: 0 } })
          onMsg(): void {}
        }
        new Handler();
      }).toThrow(/delayMs must be > 0/);
    });

    it('throws on exponential.multiplier <= 1', () => {
      expect(() => {
        class Handler {
          @Consume('addr', { retryPolicy: { kind: 'exponential', initialMs: 1000, multiplier: 1, maxMs: 60000 } })
          onMsg(): void {}
        }
        new Handler();
      }).toThrow(/multiplier must be > 1/);
    });

    it('throws on exponential.maxMs < initialMs', () => {
      expect(() => {
        class Handler {
          @Consume('addr', { retryPolicy: { kind: 'exponential', initialMs: 1000, multiplier: 2, maxMs: 500 } })
          onMsg(): void {}
        }
        new Handler();
      }).toThrow(/maxMs must be >= initialMs/);
    });

    it('throws on unknown retryPolicy.kind', () => {
      expect(() => {
        class Handler {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          @Consume('addr', { retryPolicy: { kind: 'bogus', delayMs: 1 } as any })
          onMsg(): void {}
        }
        new Handler();
      }).toThrow(/unknown retryPolicy.kind/);
    });
  });

  describe('validation', () => {
    it('throws when maxDelivery < 1', () => {
      expect(() => {
        class Handler {
          @Consume('orders.created', { maxDelivery: 0 })
          onCreated(): void {}
        }
        new Handler();
      }).toThrow(/maxDelivery must be >= 1/);
    });

    it('throws when maxWindow < 1', () => {
      expect(() => {
        class Handler {
          @Consume('orders.created', { maxWindow: 0 })
          onCreated(): void {}
        }
        new Handler();
      }).toThrow(/maxWindow must be >= 1/);
    });
  });
});

describe('@Subscribe (topic)', () => {
  it('records metadata with kind=subscribe, streamOffset=next, no retry/DLQ', () => {
    class Handler {
      @Subscribe('changes.bulletin')
      onChange(): void {}
    }
    const meta = readMeta(Handler.prototype, 'onChange');
    expect(meta.kind).toBe('subscribe');
    expect(meta.address).toBe('changes.bulletin');
    expect(meta.brokerName).toBeUndefined();
    expect(meta.options.streamOffset).toBe('next');
    expect(meta.options.maxDelivery).toBe(1);
    expect(meta.options.dlq).toBe(false);
    expect(meta.options.retryPolicy).toBe('immediate');
  });

  it('accepts (address, brokerName)', () => {
    class Handler {
      @Subscribe('changes.bulletin', 'analytics')
      onChange(): void {}
    }
    expect(readMeta(Handler.prototype, 'onChange').brokerName).toBe('analytics');
  });

  it('accepts (address, brokerName, options)', () => {
    class Handler {
      @Subscribe('changes.bulletin', 'analytics', { maxWindow: 25 })
      onChange(): void {}
    }
    const meta = readMeta(Handler.prototype, 'onChange');
    expect(meta.brokerName).toBe('analytics');
    expect(meta.options.maxWindow).toBe(25);
  });

  it('accepts (address, options) — object in 2nd slot', () => {
    class Handler {
      @Subscribe('changes.bulletin', { maxWindow: 25 })
      onChange(): void {}
    }
    const meta = readMeta(Handler.prototype, 'onChange');
    expect(meta.brokerName).toBeUndefined();
    expect(meta.options.maxWindow).toBe(25);
  });
});
