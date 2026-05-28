/**
 * Wire format on the message body: plain UTF-8 JSON text — with round-trip
 * preservation of two BSON-flavoured types:
 *
 *   - `Date`              → `{ "$date": "<ISO>" }`        (always)
 *   - `ObjectId`          → `{ "$oid":  "<hex>" }`        (always on encode;
 *                                                          on decode, see
 *                                                          auto-detection
 *                                                          below)
 *
 * Marker names match MongoDB Extended JSON (EJSON), which keeps the wire
 * familiar to anyone who's debugged a BSON dump.
 *
 * On decode, `{$date}` is restored to a real `Date`. For `{$oid}`, the codec
 * auto-detects whether `mongoose` or `bson` is present in the host project
 * at module-load time:
 *
 *   - `mongoose` installed → `new mongoose.Types.ObjectId(hex)`
 *   - else `bson` installed → `new bson.ObjectId(hex)`
 *   - neither installed → returned as a marker object `{ $oid: hex }`
 *
 * This makes the lib mongoose-/bson-aware without taking a hard dependency
 * on either (both are declared as optional peer deps). If you need a
 * different ObjectId implementation, or a different rehydration strategy,
 * extend `JsonBodyCodec` and override the protected `restoreOid(hex)` hook:
 *
 * ```ts
 * export class CustomCodec extends JsonBodyCodec {
 *   protected restoreOid(hex: string): unknown { return … }
 * }
 * ```
 *
 * and wire it via `AmqpModule.forRoot({ bodyCodec: new CustomCodec() })`.
 *
 * Other rich JS types (`Map`, `Set`, `RegExp`, `BigInt`, …) are not
 * preserved by the default codec — provide a custom codec if needed.
 */

const DATE_MARKER = '$date';
const OID_MARKER = '$oid';

/** Try to resolve an `ObjectId` constructor from the host project at module-
 *  load time. Probed packages, in priority order:
 *
 *    1. `mongoose` — exposes `Types.ObjectId` (the dominant case in NestJS
 *       apps; the constructor is bson's under the hood)
 *    2. `bson`     — exposes `ObjectId` directly (NestJS apps using `bson`
 *       without mongoose, or schema-less services)
 *
 *  If neither is installed (or fails to load for any reason), the result
 *  is `undefined` and `JsonBodyCodec.restoreOid` falls back to emitting a
 *  plain `{ $oid: hex }` marker.
 *
 *  We use `require` (not dynamic `import`) so the lookup stays synchronous
 *  and runs once at module init. `try { require(pkg) } catch {}` is the
 *  standard pattern for soft optional peer deps in CommonJS NestJS libs. */
function resolveObjectIdCtor(): ((hex: string) => unknown) | undefined {
  for (const pkg of ['mongoose', 'bson'] as const) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(pkg) as {
        Types?: { ObjectId?: new (hex: string) => unknown };
        ObjectId?: new (hex: string) => unknown;
      };
      const Ctor = pkg === 'mongoose' ? mod.Types?.ObjectId : mod.ObjectId;
      if (typeof Ctor === 'function') return (hex: string): unknown => new Ctor(hex);
    } catch {
      // Package not installed — try next probe.
    }
  }
  return undefined;
}

const detectedObjectIdCtor = resolveObjectIdCtor();

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
 *  encoding via duck typing. By default `$oid` decodes to a marker object;
 *  override `restoreOid` in a subclass to return a real ObjectId instance
 *  (see the file-level doc for the mongoose subclass example). */
export class JsonBodyCodec implements AmqpBodyCodec {
  encode(value: unknown): string {
    return JSON.stringify(this.preserve(value));
  }

  decode(body: unknown): unknown {
    if (body === null || body === undefined) return body;
    if (typeof body === 'string') return this.restore(safeJsonParse(body));
    if (Buffer.isBuffer(body)) return this.restore(safeJsonParse(body.toString('utf-8')));
    return body;
  }

  /** Hook to instantiate a native ObjectId from a `$oid` marker on decode.
   *  The default uses the constructor auto-detected at module load (mongoose
   *  > bson > none), so most NestJS apps get real ObjectId instances out of
   *  the box without any configuration. If neither dep is installed, the
   *  default returns the marker object as-is. Subclasses can override for
   *  a custom rehydration strategy. */
  protected restoreOid(hex: string): unknown {
    return detectedObjectIdCtor ? detectedObjectIdCtor(hex) : { [OID_MARKER]: hex };
  }

  /** Recursively wrap supported rich types into their EJSON marker form.
   *  Non-matching values pass through unchanged. Arrays and plain objects
   *  are cloned shallowly so the original `value` is never mutated. */
  private preserve(value: unknown): unknown {
    if (value instanceof Date) return { [DATE_MARKER]: value.toISOString() };
    if (isObjectIdLike(value)) {
      return { [OID_MARKER]: (value as { toHexString(): string }).toHexString() };
    }
    if (Array.isArray(value)) return value.map((v) => this.preserve(v));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.preserve(v);
      return out;
    }
    return value;
  }

  /** Recursively unwrap single-key EJSON marker objects back to their
   *  native JS form. Anything that isn't a recognised single-key marker
   *  passes through unchanged — including user objects that happen to
   *  carry a `$date` or `$oid` key alongside other fields. The walk is
   *  done in a single pass; the `restoreOid` hook is called at each
   *  `$oid` site so a subclass override takes effect everywhere in the
   *  tree. */
  private restore(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => this.restore(v));
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1) {
      if (keys[0] === DATE_MARKER && typeof obj[DATE_MARKER] === 'string') {
        return new Date(obj[DATE_MARKER] as string);
      }
      if (keys[0] === OID_MARKER && typeof obj[OID_MARKER] === 'string') {
        return this.restoreOid(obj[OID_MARKER] as string);
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = this.restore(v);
    return out;
  }
}

/** Singleton instance of the default codec. The library uses this when a
 *  broker is declared without a `bodyCodec` override. Per-broker codecs are
 *  resolved by `BrokerConnection` from `BrokerOptions.bodyCodec`. */
export const defaultBodyCodec: AmqpBodyCodec = new JsonBodyCodec();

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
