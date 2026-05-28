import { Injectable, Module } from '@nestjs/common';
import { Consume, Subscribe } from '../../src';
import { config, counters, received } from './test-state';

/**
 * Handler set used by the single-broker integration specs. The `@Consume` /
 * `@Subscribe` decorators omit the broker name — they resolve to the lone
 * broker automatically. Each handler delegates to the shared `received`
 * Subjects so the spec can await on them.
 */

@Injectable()
export class SimpleConsumer {
  @Consume('integ.simple')
  onSimple(body: unknown): void {
    received.simple.next(body);
  }
}

@Injectable()
export class RequestReplyConsumer {
  @Consume('integ.request-reply')
  onRequest(body: { value: number }): { doubled: number } {
    return { doubled: body.value * 2 };
  }
}

@Injectable()
export class BroadcastConsumer {
  @Subscribe('integ.broadcast')
  onBroadcast(body: unknown): void {
    received.topic.next(body);
  }
}

@Injectable()
export class RetryConsumer {
  // maxDelivery generous (10) to give the broker plenty of room — the test
  // owns its own counter so we don't depend on `delivery_count` tracking,
  // which isn't uniformly honoured (RabbitMQ 4.x quorum queues, notably).
  @Consume('integ.retry', { maxDelivery: 10 })
  onRetry(body: unknown): void {
    counters.retry += 1;
    received.retry.next({ body, attempt: counters.retry });
    if (counters.retry < config.retrySucceedsAt) {
      throw new Error(`force-fail invocation ${counters.retry}`);
    }
    // returns undefined → framework accepts
  }
}

@Injectable()
export class DlqConsumer {
  @Consume('integ.dlq-test', { maxDelivery: 3, dlq: true })
  onDlq(body: unknown): void {
    counters.dlq += 1;
    received.dlq.next({ body, attempt: counters.dlq });
    if (config.dlqAlwaysFails) throw new Error(`permanent fail invocation ${counters.dlq}`);
  }
}

@Injectable()
export class CodecConsumer {
  @Consume('integ.codec')
  onCodec(body: unknown): void {
    received.codec.next(body);
  }
}

@Injectable()
export class LocatorConsumer {
  @Consume('integ.simple-locator')
  onLocator(body: unknown): void {
    received.locator.next(body);
  }
}

@Injectable()
export class DlqHoldingObserver {
  /** Observes messages routed to the broker DLQ. Used by the DLQ scenario to
   *  confirm the failed payload actually landed at the catch-all DLQ. */
  @Consume('integ.dlq-holding')
  onDlqHolding(body: unknown): void {
    received.dlqHolding.next(body);
  }
}

@Module({
  providers: [
    SimpleConsumer,
    RequestReplyConsumer,
    BroadcastConsumer,
    RetryConsumer,
    DlqConsumer,
    CodecConsumer,
    LocatorConsumer,
    DlqHoldingObserver,
  ],
})
export class TestHandlersModule {}
