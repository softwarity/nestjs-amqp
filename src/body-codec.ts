/**
 * Wire format on the message body: plain UTF-8 JSON text — with round-trip
 * preservation of two BSON-flavoured types:
 *
 *   - `Date`              → `{ "$date": "<ISO>" }`
 *   - `ObjectId`          → `{ "$oid":  "<hex>" }`   (encode-side only, via
 *                                                     duck typing on
 *                                                     `_bsontype === 'ObjectId'`)
 *
 * Marker names match MongoDB Extended JSON (EJSON), which keeps the wire
 * familiar to anyone who's debugged a BSON dump.
 *
 * On decode, `{$date}` is restored to a real `Date`. `{$oid}` is left as a
 * plain marker object — the library can't depend on mongoose/bson to
 * reconstruct the native type. If you need real `ObjectId` instances on
 * receive, supply a custom `AmqpBodyCodec` via `AmqpModule.forRoot({ bodyCodec })`.
 *
 * Other rich JS types (`Map`, `Set`, `RegExp`, `BigInt`, …) are not
 * preserved by the default codec — provide a custom codec if needed.
 */

const DATE_MARKER = '$date';
const OID_MARKER = '$oid';

/**
 * Contract for swapping the wire codec. Provide a custom implementation
 * through `AmqpModule.forRoot({ bodyCodec })` if the default JSON codec is
 * not what you need (msgpack, protobuf, mongoose ObjectId rehydration, …).
 */
export interface AmqpBodyCodec {
  /** Encode a JS value to whatever the rhea sender will ship as `message.body`
   *  (typically a UTF-8 string). */
  encode(value: unknown): unknown;
  /** Decode an incoming `message.body` (rhea passes string | Buffer | already-
   *  decoded object). Should be a pure function — no side effects. */
  decode(body: unknown): unknown;
}

/** Default JSON-based codec — handles `Date` round-trip and `ObjectId`
 *  encoding via duck typing (decoding leaves `$oid` as a marker object). */
export class JsonBodyCodec implements AmqpBodyCodec {
  encode(value: unknown): string {
    return JSON.stringify(preserve(value));
  }

  decode(body: unknown): unknown {
    if (body === null || body === undefined) return body;
    if (typeof body === 'string') return restore(safeJsonParse(body));
    if (Buffer.isBuffer(body)) return restore(safeJsonParse(body.toString('utf-8')));
    return body;
  }
}

/** Singleton instance of the default codec. The library uses this when no
 *  custom codec is supplied via options. */
export const defaultBodyCodec: AmqpBodyCodec = new JsonBodyCodec();

/** Recursively wrap supported rich types into their EJSON marker form. Non-
 *  matching values pass through unchanged. Arrays and plain objects are
 *  cloned shallowly so the original `value` is never mutated. */
function preserve(value: unknown): unknown {
  if (value instanceof Date) return { [DATE_MARKER]: value.toISOString() };
  if (isObjectIdLike(value)) {
    return { [OID_MARKER]: (value as { toHexString(): string }).toHexString() };
  }
  if (Array.isArray(value)) return value.map(preserve);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = preserve(v);
    return out;
  }
  return value;
}

/** Recursively unwrap single-key EJSON marker objects back to their native
 *  JS form. Anything that isn't a recognised single-key marker passes through
 *  unchanged — including user objects that happen to carry a `$date` or
 *  `$oid` key alongside other fields (those keep their shape).
 *
 *  `$oid` is left as a marker object because the library can't depend on
 *  mongoose / bson to instantiate the real type. Consumers wanting real
 *  ObjectIds should provide a custom `AmqpBodyCodec`. */
function restore(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(restore);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    if (keys[0] === DATE_MARKER && typeof obj[DATE_MARKER] === 'string') {
      return new Date(obj[DATE_MARKER] as string);
    }
    // `$oid` left as-is; see function doc.
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = restore(v);
  return out;
}

/** Duck-type check for ObjectId instances from mongoose / bson without
 *  importing either library. Catches both the standard `_bsontype` marker
 *  and the presence of a `toHexString` method. */
function isObjectIdLike(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as { _bsontype?: string; toHexString?: unknown };
  if (o._bsontype !== 'ObjectId' && o._bsontype !== 'ObjectID') return false;
  return typeof o.toHexString === 'function';
}

function safeJsonParse(text: string): unknown {
  if (text.length === 0) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Convenience free functions — used internally so call sites don't have to
// inject a codec themselves. They delegate to the codec resolved at module
// init time (set via `setActiveBodyCodec`). The injection token approach is
// avoided here to keep `body-codec.ts` zero-dependency.
// ---------------------------------------------------------------------------

let activeCodec: AmqpBodyCodec = defaultBodyCodec;

/** Internal — called by `AmqpModule.forRoot/forRootAsync` after options
 *  resolution. Not exported via the public barrel. */
export function setActiveBodyCodec(codec: AmqpBodyCodec | undefined): void {
  activeCodec = codec ?? defaultBodyCodec;
}

export function encodeBody(value: unknown): unknown {
  return activeCodec.encode(value);
}

export function decodeBody(body: unknown): unknown {
  return activeCodec.decode(body);
}
