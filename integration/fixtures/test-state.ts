import { Subject } from 'rxjs';

/**
 * Shared mutable state for the integration fixtures. Tests subscribe to these
 * Subjects to await message delivery, and tweak the `config` flags to drive
 * handler behaviour (retry / DLQ scenarios). Reset between tests via
 * {@link resetTestState}.
 */
export const received = {
  simple: new Subject<unknown>(),
  topic: new Subject<unknown>(),
  retry: new Subject<{ body: unknown; attempt: number }>(),
  dlq: new Subject<{ body: unknown; attempt: number }>(),
  dlqHolding: new Subject<unknown>(),
  codec: new Subject<unknown>(),
  locator: new Subject<unknown>(),
};

export const config = {
  /** Retry scenario: handler throws while its **own invocation count** is
   *  less than this; succeeds on/after. We count invocations ourselves rather
   *  than reading the broker's `header.delivery_count` because that field is
   *  not reliably incremented on `modified(delivery_failed:true)` across all
   *  brokers (notably RabbitMQ 4.x with quorum queues), so a test that asserts
   *  specific values would flake on broker semantics rather than on the
   *  library's actual behaviour. */
  retrySucceedsAt: 3,
  /** DLQ scenario: when true, handler always throws (forces routing to DLQ). */
  dlqAlwaysFails: true,
};

/** Per-handler invocation counters — reset between tests via `resetTestState`.
 *  Used by the retry and DLQ handlers to drive their throw/succeed decision
 *  without depending on broker-side `delivery_count` tracking. */
export const counters = {
  retry: 0,
  dlq: 0,
};

export function resetTestState(): void {
  config.retrySucceedsAt = 3;
  config.dlqAlwaysFails = true;
  counters.retry = 0;
  counters.dlq = 0;
}
