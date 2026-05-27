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

    it('leaves $oid as a marker object on decode (no mongoose dep)', () => {
      const encoded = '{"id":{"$oid":"507f1f77bcf86cd799439011"}}';
      const decoded = codec.decode(encoded) as { id: { $oid: string } };
      expect(decoded.id.$oid).toBe('507f1f77bcf86cd799439011');
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
});
