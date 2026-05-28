import 'reflect-metadata';
import { AmqpConsumerExplorer } from '../src/amqp.consumer-explorer';
import { AmqpAddress, AmqpBody, AmqpDeliveryCount, AmqpSettler } from '../src/amqp.param-decorators';
import { Consume } from '../src/consumers.decorator';
import type { ConsumerMetadata } from '../src/amqp.types';

// `readAndValidateParams` is private — we access it via a thin test harness
// that picks the prototype + arity directly from a class. This keeps the
// public surface untouched. We pass a synthetic ConsumerMetadata since the
// method uses it only to format error messages.
function validate(target: object, method: string, arity: number): unknown[] {
  const explorer = new AmqpConsumerExplorer(undefined as never, undefined as never, undefined as never);
  const meta: ConsumerMetadata = {
    address: 'test',
    kind: 'consume',
    options: { maxDelivery: 1, retryPolicy: 'immediate', dlq: false, maxWindow: 100 },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (explorer as any).readAndValidateParams(meta, target, method, target.constructor.name, arity);
}

describe('readAndValidateParams — implicit-body rule', () => {
  it('passes through when every parameter is annotated', () => {
    class Handler {
      @Consume('addr')
      onMsg(@AmqpBody() _b: unknown, @AmqpDeliveryCount() _c: number): void {}
    }
    const result = validate(Handler.prototype, 'onMsg', 2);
    expect(result).toEqual([
      { kind: 'BODY', key: undefined },
      { kind: 'DELIVERY_COUNT', key: undefined },
    ]);
  });

  it('binds a single un-annotated parameter as BODY implicitly', () => {
    class Handler {
      @Consume('addr')
      onMsg(_body: unknown): void {}
    }
    const result = validate(Handler.prototype, 'onMsg', 1);
    expect(result).toEqual([{ kind: 'BODY' }]);
  });

  it('binds the un-annotated slot among annotated others', () => {
    class Handler {
      @Consume('addr')
      onMsg(_body: unknown, @AmqpDeliveryCount() _c: number, @AmqpAddress() _a: string): void {}
    }
    const result = validate(Handler.prototype, 'onMsg', 3);
    expect(result[0]).toEqual({ kind: 'BODY' });
    expect(result[1]).toEqual({ kind: 'DELIVERY_COUNT', key: undefined });
    expect(result[2]).toEqual({ kind: 'ADDRESS', key: undefined });
  });

  it('throws when 2+ parameters are un-annotated (ambiguous)', () => {
    class Handler {
      @Consume('addr')
      onMsg(_a: unknown, _b: unknown): void {}
    }
    expect(() => validate(Handler.prototype, 'onMsg', 2)).toThrow(/2 un-annotated parameters/);
  });

  it('throws when an explicit @AmqpBody coexists with an un-annotated parameter (mixed styles)', () => {
    class Handler {
      @Consume('addr')
      onMsg(_extra: string, @AmqpBody() _body: unknown): void {}
    }
    expect(() => validate(Handler.prototype, 'onMsg', 2)).toThrow(/mixes an explicit @AmqpBody/);
  });

  it('does not mutate the cached reflect metadata', () => {
    class Handler {
      @Consume('addr')
      onMsg(_body: unknown, @AmqpSettler() _s: never): void {}
    }
    validate(Handler.prototype, 'onMsg', 2);
    const fresh = validate(Handler.prototype, 'onMsg', 2);
    // Second call still works (reflect-metadata array unchanged at index 0)
    expect(fresh[0]).toEqual({ kind: 'BODY' });
  });
});
