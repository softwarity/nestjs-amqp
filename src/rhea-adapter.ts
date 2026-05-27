import type { Message, MessageProperties } from 'rhea';

/**
 * Thin compatibility layer between the rhea Message layout and the package's
 * public message layout.
 *
 * Rhea decodes the AMQP 1.0 `properties` composite section into TOP-LEVEL
 * fields on the message object (`msg.reply_to`, `msg.correlation_id`,
 * `msg.message_id`, …). It does NOT populate a nested `msg.properties`. The
 * same goes for sending: rhea's encoder reads `properties` fields from the
 * top level of the outgoing object — anything passed under a nested
 * `properties` key is ignored.
 *
 * The package's public API exposes the nested layout because that's what the
 * `MessageProperties` type from rhea's typings looks like (a logical grouping
 * of the standard properties), and because mixing AMQP standard properties
 * with arbitrary top-level fields would clutter the API. So we bridge the
 * two layouts here:
 *
 *   - `normalizeIncoming` reconstructs `properties` from rhea's flat layout
 *   - `toRheaOutgoing`    flattens our nested layout into what rhea expects
 *
 * Map sections (`application_properties`, `message_annotations`) are already
 * nested by rhea — they pass through unchanged.
 */

/** Standard AMQP 1.0 properties section fields, in declaration order. Mirror
 *  of rhea's `properties` composite definition (see `rhea/lib/message.js`
 *  `define_composite_section`). Keep in sync if rhea ever extends the list. */
export const AMQP_PROPERTIES_KEYS = [
  'message_id',
  'user_id',
  'to',
  'subject',
  'reply_to',
  'correlation_id',
  'content_type',
  'content_encoding',
  'absolute_expiry_time',
  'creation_time',
  'group_id',
  'group_sequence',
  'reply_to_group_id',
] as const satisfies ReadonlyArray<keyof MessageProperties>;

/** Return a shallow clone of `message` with `properties` reconstructed from
 *  the top-level fields rhea posts there. Original top-level fields are
 *  preserved (some user code or tests may read them directly — we don't want
 *  to break that). Fields that are `undefined` or `null` are omitted from
 *  `properties` so callers can use a simple truthy check. */
export function normalizeIncoming(message: Message): Message {
  const m = message as Message & Record<string, unknown>;
  const properties: MessageProperties = {};
  for (const key of AMQP_PROPERTIES_KEYS) {
    const v = m[key];
    if (v !== undefined && v !== null) (properties as Record<string, unknown>)[key] = v;
  }
  return { ...message, properties };
}

/** Return a shallow clone of `message` with `properties` flattened to the
 *  top level — the layout rhea actually consumes when sending. A missing or
 *  empty `properties` is a no-op; if present, its fields override any
 *  conflicting top-level fields (treat `properties` as authoritative). */
export function toRheaOutgoing(message: Message): Message {
  const { properties, ...rest } = message;
  if (!properties) return rest as Message;
  return { ...rest, ...properties } as Message;
}
