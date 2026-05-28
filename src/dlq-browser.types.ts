import type { Delivery, Message, MessageProperties } from 'rhea';

/** One entry of the `x-opt-deaths` message annotation added by RabbitMQ
 *  4.x (AMQP 1.0) on each dead-letter hop. Field names match the wire
 *  verbatim — RabbitMQ uses hyphens (`routing-keys`, `first-time`,
 *  `last-time`) on the 1.0 path rather than the snake_case the AMQP 0.9.1
 *  `x-death` header used. Hyphenated keys are valid TS property names but
 *  require quoted access (`x['routing-keys']`). */
export interface XDeath {
  /** Origin queue — used by `replay()` to publish back. */
  readonly queue: string;
  /** Why the broker dead-lettered the message — RabbitMQ uses one of
   *  `'rejected' | 'expired' | 'maxlen' | 'delivery_limit'` but we type it as
   *  string so forward-compatibility with future reasons doesn't break us. */
  readonly reason: string;
  /** Number of times THIS exact dead-letter event has happened (resets to 1
   *  on first DLX hop, increments on every redelivery that re-fails). */
  readonly count: number;
  /** Origin exchange (empty string for the default exchange). */
  readonly exchange: string;
  /** Routing keys carried at dead-letter time. */
  readonly 'routing-keys': string[];
  /** ISO 8601 timestamp of the first dead-letter event for this entry. */
  readonly 'first-time'?: string;
  /** ISO 8601 timestamp of the most recent dead-letter event for this entry. */
  readonly 'last-time'?: string;
}

/** A DLQ message held un-settled in an open session. The `delivery` and
 *  `message` are the raw rhea handles, kept here so the session can later
 *  `accept()` or `release()` them. The decoded fields are convenience copies. */
export interface HeldMessage {
  /** Index inside the current page (0-based). Stable across one session page
   *  while the page is open; resets when `loadNextPage()` is called. */
  readonly idx: number;
  /** Raw rhea Message — full envelope. */
  readonly message: Message;
  /** Raw rhea Delivery — not yet settled. */
  readonly delivery: Delivery;
  /** JSON-decoded body (or raw if not JSON). */
  readonly body: unknown;
  /** AMQP standard properties (`message_id`, `subject`, `content_type`, …). */
  readonly properties: MessageProperties;
  /** Custom `application_properties` (tenant ID, trace ID, …). */
  readonly applicationProperties: Record<string, unknown>;
  /** `x-death` annotation array — origin queue, reason, count, time. */
  readonly xDeath: XDeath[];
}

/** A live DLQ browse session. Server-side state, kept in `DlqBrowserService`
 *  memory. Crash → AMQP drops connection → broker re-queues all un-settled
 *  deliveries (free rollback). */
export interface DlqSession {
  /** UUID v4 — opaque session identifier passed in URL paths. */
  readonly token: string;
  /** Name of the broker the DLQ lives on — needed for replay/drop routing. */
  readonly brokerName: string;
  /** Address of the DLQ being browsed. */
  readonly dlqAddress: string;
  /** Login of the admin who opened it (caller-provided). */
  readonly openedBy: string;
  /** Wall-clock open time. */
  readonly openedAt: Date;
  /** Mutated: each action (replay, drop, next-page) refreshes it. Used by
   *  the TTL sweep to detect idle sessions. */
  lastActivityAt: Date;
  /** How many messages were requested per page. */
  readonly pageSize: number;
  /** 0-based informative counter — `0` for the first page, +1 each `loadNextPage`. */
  pageIndex: number;
  /** Messages currently held un-settled. Keyed by their `idx`. */
  readonly messages: Map<number, HeldMessage>;
}
