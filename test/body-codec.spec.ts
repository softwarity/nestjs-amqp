import { JsonBodyCodec } from '../src/body-codec';

describe('JsonBodyCodec', () => {
  const codec = new JsonBodyCodec();

  describe('encode/decode round-trip', () => {
    it('preserves primitives', () => {
      expect(codec.decode(codec.encode('hello'))).toBe('hello');
      expect(codec.decode(codec.encode(42))).toBe(42);
      expect(codec.decode(codec.encode(true))).toBe(true);
      expect(codec.decode(codec.encode(null))).toBe(null);
    });

    it('preserves plain objects', () => {
      const payload = { id: 'abc', count: 3, tags: ['a', 'b'] };
      expect(codec.decode(codec.encode(payload))).toEqual(payload);
    });

    it('preserves Date instances via $date marker', () => {
      const d = new Date('2026-01-15T10:30:00.000Z');
      const encoded = codec.encode({ when: d }) as string;
      expect(encoded).toContain('"$date"');
      expect(encoded).toContain('"2026-01-15T10:30:00.000Z"');
      const decoded = codec.decode(encoded) as { when: Date };
      expect(decoded.when).toBeInstanceOf(Date);
      expect(decoded.when.getTime()).toBe(d.getTime());
    });

    it('preserves nested Date inside arrays', () => {
      const list = [new Date('2026-01-15T10:30:00.000Z'), new Date('2026-02-01T00:00:00.000Z')];
      const decoded = codec.decode(codec.encode(list)) as Date[];
      expect(decoded[0]).toBeInstanceOf(Date);
      expect(decoded[1]).toBeInstanceOf(Date);
    });

    it('encodes ObjectId-like values via $oid marker (duck typing)', () => {
      const fakeObjectId = {
        _bsontype: 'ObjectId',
        toHexString: () => '507f1f77bcf86cd799439011',
      };
      const encoded = codec.encode({ id: fakeObjectId }) as string;
      expect(encoded).toContain('"$oid"');
      expect(encoded).toContain('"507f1f77bcf86cd799439011"');
    });

    it('auto-rehydrates $oid via the bson/mongoose ObjectId detected at load', () => {
      // `bson` is installed as a devDep specifically for this test — the codec
      // probes `mongoose` first, then `bson`. The result is a native ObjectId
      // with `toHexString()`, not a plain marker. If neither dep is present
      // in the host project, the default falls back to the marker (covered
      // indirectly by the subclass-override tests below — overriding the
      // hook bypasses auto-detection entirely).
      const encoded = '{"id":{"$oid":"507f1f77bcf86cd799439011"}}';
      const decoded = codec.decode(encoded) as { id: { toHexString: () => string } };
      expect(typeof decoded.id.toHexString).toBe('function');
      expect(decoded.id.toHexString()).toBe('507f1f77bcf86cd799439011');
    });
  });

  describe('decode robustness', () => {
    it('returns raw string when body is not valid JSON', () => {
      expect(codec.decode('not-json')).toBe('not-json');
    });

    it('passes through already-decoded objects', () => {
      const obj = { decoded: true };
      expect(codec.decode(obj)).toBe(obj);
    });

    it('handles Buffer bodies', () => {
      const buf = Buffer.from('{"a":1}', 'utf-8');
      expect(codec.decode(buf)).toEqual({ a: 1 });
    });

    it('returns null/undefined unchanged', () => {
      expect(codec.decode(null)).toBeNull();
      expect(codec.decode(undefined)).toBeUndefined();
    });
  });

  describe('restoreOid extension hook', () => {
    // Subclass shape consumers will write when they want a different
    // rehydration strategy than the default auto-detection (mongoose / bson
    // probe at load time). Useful for projects that want a custom type, or
    // who explicitly want to keep the marker for downstream processing.
    class OidCodec extends JsonBodyCodec {
      protected restoreOid(hex: string): unknown {
        return `OID:${hex}`;
      }
    }
    const oidCodec = new OidCodec();

    it('subclass override is honoured at the top level (beats auto-detection)', () => {
      expect(oidCodec.decode('{"_id":{"$oid":"507f1f77bcf86cd799439011"}}')).toEqual({
        _id: 'OID:507f1f77bcf86cd799439011',
      });
    });

    it('subclass override applies at every depth of the tree (single-pass walk)', () => {
      const wire = JSON.stringify({
        items: [{ id: { $oid: 'a' } }, { id: { $oid: 'b' } }],
        meta: { owner: { $oid: 'c' } },
      });
      expect(oidCodec.decode(wire)).toEqual({
        items: [{ id: 'OID:a' }, { id: 'OID:b' }],
        meta: { owner: 'OID:c' },
      });
    });

    it('subclass override does NOT touch $date markers', () => {
      const wire = JSON.stringify({ id: { $oid: 'a' }, when: { $date: '2026-01-15T10:30:00.000Z' } });
      const decoded = oidCodec.decode(wire) as { id: unknown; when: unknown };
      expect(decoded.id).toBe('OID:a');
      expect(decoded.when).toBeInstanceOf(Date);
    });

    it('subclass override leaves multi-key objects alone (no false positive on $oid)', () => {
      // A user payload that happens to carry an `$oid` key alongside others
      // is NOT a marker — the rehydration must only trigger on single-key
      // objects. Otherwise we'd silently corrupt user data shaped like
      // `{ $oid: 'x', extra: 'y' }`.
      const wire = JSON.stringify({ shape: { $oid: 'a', extra: 'b' } });
      expect(oidCodec.decode(wire)).toEqual({ shape: { $oid: 'a', extra: 'b' } });
    });

    it('round-trip via subclass: ObjectId-like → $oid → custom restoration', () => {
      const fakeObjectId = {
        _bsontype: 'ObjectId',
        toHexString: () => '507f1f77bcf86cd799439011',
      };
      const wire = oidCodec.encode({ id: fakeObjectId }) as string;
      expect(oidCodec.decode(wire)).toEqual({ id: 'OID:507f1f77bcf86cd799439011' });
    });

    it('subclass returning the marker object disables auto-rehydration', () => {
      // Users that want the raw marker for downstream processing can opt out
      // of auto-detection by re-implementing the original default behaviour.
      class MarkerCodec extends JsonBodyCodec {
        protected restoreOid(hex: string): unknown {
          return { $oid: hex };
        }
      }
      const c = new MarkerCodec();
      expect(c.decode('{"id":{"$oid":"abc"}}')).toEqual({ id: { $oid: 'abc' } });
    });
  });
});
