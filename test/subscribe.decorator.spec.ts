import 'reflect-metadata';
import { Subscribe, SubscribeTopic, AMQP_SUBSCRIBE_METADATA } from '../src/subscribe.decorator';
import type { SubscribeMetadata } from '../src/amqp.types';

describe('@Subscribe', () => {
  it('records metadata with defaults', () => {
    class Handler {
      @Subscribe('orders.created')
      onCreated(): void {}
    }
    const meta = Reflect.getMetadata(AMQP_SUBSCRIBE_METADATA, Handler.prototype, 'onCreated') as SubscribeMetadata;
    expect(meta).toBeDefined();
    expect(meta.address).toBe('orders.created');
    expect(meta.options.maxDelivery).toBe(1);
    expect(meta.options.dlq).toBe(false);
    expect(meta.options.maxWindow).toBe(100);
    expect(meta.options.streamOffset).toBeUndefined();
  });

  it('merges custom options', () => {
    class Handler {
      @Subscribe('orders.created', { maxDelivery: 5, dlq: true, maxWindow: 50 })
      onCreated(): void {}
    }
    const meta = Reflect.getMetadata(AMQP_SUBSCRIBE_METADATA, Handler.prototype, 'onCreated') as SubscribeMetadata;
    expect(meta.options.maxDelivery).toBe(5);
    expect(meta.options.dlq).toBe(true);
    expect(meta.options.maxWindow).toBe(50);
  });

  it('throws when maxDelivery < 1', () => {
    expect(() => {
      class Handler {
        @Subscribe('orders.created', { maxDelivery: 0 })
        onCreated(): void {}
      }
      // Force evaluation
      new Handler();
    }).toThrow(/maxDelivery must be >= 1/);
  });

  it('throws when maxWindow < 1', () => {
    expect(() => {
      class Handler {
        @Subscribe('orders.created', { maxWindow: 0 })
        onCreated(): void {}
      }
      new Handler();
    }).toThrow(/maxWindow must be >= 1/);
  });
});

describe('@SubscribeTopic', () => {
  it('records metadata with streamOffset=next and no DLQ/retry', () => {
    class Handler {
      @SubscribeTopic('changes.bulletin')
      onChange(): void {}
    }
    const meta = Reflect.getMetadata(AMQP_SUBSCRIBE_METADATA, Handler.prototype, 'onChange') as SubscribeMetadata;
    expect(meta.address).toBe('changes.bulletin');
    expect(meta.options.streamOffset).toBe('next');
    expect(meta.options.maxDelivery).toBe(1);
    expect(meta.options.dlq).toBe(false);
  });

  it('allows custom maxWindow', () => {
    class Handler {
      @SubscribeTopic('changes.bulletin', { maxWindow: 25 })
      onChange(): void {}
    }
    const meta = Reflect.getMetadata(AMQP_SUBSCRIBE_METADATA, Handler.prototype, 'onChange') as SubscribeMetadata;
    expect(meta.options.maxWindow).toBe(25);
  });
});
