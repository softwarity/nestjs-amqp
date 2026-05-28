import { Injectable, Module } from '@nestjs/common';
import { Subject } from 'rxjs';
import { Consume } from '../../src';

/**
 * Handlers used by the multi-broker spec. Each broker has its own handler
 * with an explicit broker name so the same address can be observed
 * independently per broker. Tests await on the per-broker Subjects to assert
 * cross-broker isolation (a message sent to broker A never reaches the
 * handler bound to broker B).
 */

export const receivedOnRabbit = new Subject<unknown>();
export const receivedOnArtemis = new Subject<unknown>();

@Injectable()
export class RabbitConsumer {
  @Consume('integ.simple', 'rabbit')
  onRabbit(body: unknown): void {
    receivedOnRabbit.next(body);
  }
}

@Injectable()
export class ArtemisConsumer {
  @Consume('integ.simple', 'artemis')
  onArtemis(body: unknown): void {
    receivedOnArtemis.next(body);
  }
}

@Module({
  providers: [RabbitConsumer, ArtemisConsumer],
})
export class MultiBrokerHandlersModule {}
