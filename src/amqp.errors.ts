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

/** `AmqpPublisher.send()` waited longer than `timeoutMs` for a reply. */
export class AmqpTimeoutError extends AmqpError {
  constructor(
    readonly address: string,
    readonly correlationId: string,
    readonly timeoutMs: number,
  ) {
    super(`AMQP reply timeout after ${timeoutMs}ms on '${address}' (correlation_id=${correlationId})`);
  }
}

/** A `@Subscribe` handler threw or its Observable errored. Wraps the original. */
export class AmqpHandlerError extends AmqpError {
  constructor(
    readonly address: string,
    readonly cause: unknown,
  ) {
    super(`AMQP handler on '${address}' failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
