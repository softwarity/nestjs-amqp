/** Base class for every AMQP-related error this module emits. */
export abstract class AmqpError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Connection-level failure (broker unreachable after all retries, etc.). */
export class AmqpConnectionError extends AmqpError {
  constructor(message: string) {
    super(message);
  }
}

/** A publisher's `send()` waited longer than `timeoutMs` for a reply. */
export class AmqpTimeoutError extends AmqpError {
  constructor(
    readonly address: string,
    readonly correlationId: string,
    readonly timeoutMs: number,
  ) {
    super(`AMQP reply timeout after ${timeoutMs}ms on '${address}' (correlation_id=${correlationId})`);
  }
}

/** A `@Consume` handler threw or its Observable errored. Wraps the original. */
export class AmqpHandlerError extends AmqpError {
  constructor(
    readonly address: string,
    readonly cause: unknown,
  ) {
    super(`AMQP handler on '${address}' failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/**
 * Why a confirmed publish (`emitConfirmed()`) did not end with the broker
 * taking responsibility for the message.
 *
 *   - `'released'` — the broker routed the message to **no queue** (unknown
 *     routing key, missing binding). The most common topology mistake.
 *   - `'rejected'` — at least one target queue refused the message (length
 *     limit reached, queue unavailable). Carries an AMQP error condition.
 *   - `'modified'` — the broker asked for the message to be changed before
 *     any redelivery. RabbitMQ does not use it publisher-side today.
 *   - `'unsent'` — never handed to the broker at all: broker disabled,
 *     connection not open, or the link failed while waiting for credit.
 *   - `'disconnected'` — the connection dropped before a verdict came back.
 *   - `'timeout'` — no verdict within the confirm timeout.
 */
export type AmqpPublishFailure = 'released' | 'rejected' | 'modified' | 'unsent' | 'disconnected' | 'timeout';

/**
 * A confirmed publish (`emitConfirmed()`) failed. Never thrown by `emit()`,
 * which stays fire-and-forget.
 *
 * `outcome` discriminates the failure (see {@link AmqpPublishFailure});
 * `condition` / `description` carry the AMQP error fields when the broker
 * reported one (typically on `'rejected'`).
 */
export class AmqpPublishError extends AmqpError {
  constructor(
    readonly address: string,
    readonly outcome: AmqpPublishFailure,
    readonly reason: string,
    readonly condition?: string,
    readonly description?: string,
  ) {
    super(`AMQP publish on '${address}' failed [${outcome}]: ${reason}`);
  }
}
