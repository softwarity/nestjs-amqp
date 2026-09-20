import 'reflect-metadata';
import { Controller, Injectable } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { firstValueFrom } from 'rxjs';
import { AmqpModule } from '../src/amqp.module';
import { AmqpPublishError } from '../src/amqp.errors';
import { AmqpQueue, AmqpTopic } from '../src/amqp.queue';

// Plain `!` fields, exactly as the README declares them. This project compiles
// with `target: ES2022`, where TypeScript defaults `useDefineForClassFields` to
// true: each field becomes an own `undefined` property on the instance, in
// front of the accessor the decorator puts on the prototype.
@Injectable()
class OrdersService {
  @AmqpQueue('orders.create')
  readonly orders!: AmqpQueue<{ id: string }>;

  @AmqpTopic('orders.events')
  readonly events!: AmqpTopic<{ id: string }>;
}

@Controller()
class OrdersController {
  @AmqpQueue('orders.create')
  readonly orders!: AmqpQueue<{ id: string }>;
}

describe('@AmqpQueue / @AmqpTopic property decorators', () => {
  it('precondition: the class fields shadow the prototype accessor on a bare instance', () => {
    expect(Object.getOwnPropertyDescriptor(new OrdersService(), 'orders')).toMatchObject({ value: undefined });
  });

  describe('on instances created by Nest', () => {
    let mod: TestingModule;

    beforeAll(async () => {
      mod = await Test.createTestingModule({
        // enabled:false keeps BrokerConnection a no-op: emit() returns false.
        imports: [AmqpModule.forRoot({ url: 'amqp://localhost', enabled: false })],
        providers: [OrdersService],
        controllers: [OrdersController],
      }).compile();
    });

    afterAll(async () => {
      await mod.close();
    });

    it('binds @AmqpQueue on a provider', () => {
      const { orders } = mod.get(OrdersService);
      expect(typeof orders?.send).toBe('function');
      expect(orders.emit({ id: '1' })).toBe(false);
    });

    it('binds @AmqpTopic on a provider', () => {
      const { events } = mod.get(OrdersService);
      expect(events?.emit({ id: '1' })).toBe(false);
    });

    it('binds @AmqpQueue on a controller', () => {
      expect(mod.get(OrdersController).orders?.emit({ id: '1' })).toBe(false);
    });

    it('binds emitConfirmed on both handles', async () => {
      const { orders, events } = mod.get(OrdersService);
      // Disabled broker: the confirmed publish must say so rather than let
      // the caller believe in a delivery that never happened.
      for (const handle of [orders, events]) {
        const err: unknown = await firstValueFrom(handle.emitConfirmed({ id: '1' })).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AmqpPublishError);
        expect((err as AmqpPublishError).outcome).toBe('unsent');
      }
    });

    it('memoises the handle per instance', () => {
      const svc = mod.get(OrdersService);
      expect(svc.orders).toBeDefined();
      expect(svc.orders).toBe(svc.orders);
    });
  });

  it('removes the shadowing field even when AmqpModule is not imported', async () => {
    const mod = await Test.createTestingModule({ providers: [OrdersService] }).compile();
    expect(Object.getOwnPropertyDescriptor(mod.get(OrdersService), 'orders')).toBeUndefined();
    await mod.close();
  });
});
