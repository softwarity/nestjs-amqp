import { ALL_KNOWN_BRANDS, pickGenerator, type TopologyManifest } from '../src/topology-manifest';

const baseManifest: TopologyManifest = {
  brokerName: 'main',
  brand: 'rabbitmq',
  destinations: [
    { kind: 'queue', address: 'orders.create', dlq: false },
    { kind: 'queue', address: 'payments.process', dlq: true },
    { kind: 'stream', address: 'changes.bulletin', dlq: false },
  ],
  replyStreamAddress: 'main.replies',
  defaultDlqAddress: 'main.dlq',
};

describe('topology manifest generators', () => {
  describe('ALL_KNOWN_BRANDS', () => {
    it('lists the three supported brands (no Azure)', () => {
      expect([...ALL_KNOWN_BRANDS].sort()).toEqual(['artemis', 'qpid', 'rabbitmq']);
    });
  });

  describe('RabbitMQ', () => {
    const gen = pickGenerator('rabbitmq');

    it('uses the .json extension', () => {
      expect(gen.extension).toBe('json');
    });

    it('outputs valid JSON (no `//` header)', () => {
      const out = gen.generate(baseManifest);
      expect(() => JSON.parse(out)).not.toThrow();
    });

    it('embeds a _meta block identifying generator + target', () => {
      const parsed = JSON.parse(gen.generate(baseManifest));
      expect(parsed._meta).toMatchObject({
        generated_by: '@softwarity/nestjs-amqp',
        broker_name: 'main',
        target_brand: 'rabbitmq',
      });
    });

    it('emits quorum queues for @Consume destinations', () => {
      const out = gen.generate(baseManifest);
      expect(out).toContain('"name": "orders.create"');
      expect(out).toContain('"x-queue-type": "quorum"');
    });

    it('emits stream queues for @Subscribe destinations', () => {
      const out = gen.generate(baseManifest);
      expect(out).toContain('"name": "changes.bulletin"');
      expect(out).toContain('"x-queue-type": "stream"');
    });

    it('wires DLX + bindings on EVERY consumer queue when defaultDlqAddress is set', () => {
      const parsed = JSON.parse(gen.generate(baseManifest));
      const consumers: Array<{ name: string; arguments: Record<string, unknown> }> = parsed.queues.filter(
        (q: { arguments: Record<string, unknown> }) =>
          q.arguments['x-queue-type'] === 'quorum' && q.arguments['x-dead-letter-exchange'],
      );
      // Both consumer queues (orders.create + payments.process) carry DLX
      // wiring, regardless of dlq:true on the @Consume.
      expect(consumers.map((q) => q.name).sort()).toEqual(['orders.create', 'payments.process']);
      for (const q of consumers) {
        expect(q.arguments['x-dead-letter-exchange']).toBe('main.dlx');
        expect(q.arguments['x-dead-letter-routing-key']).toBe(q.name);
      }
      // One binding per consumer queue
      expect(parsed.bindings).toHaveLength(2);
      expect(parsed.bindings.map((b: { routing_key: string }) => b.routing_key).sort()).toEqual([
        'orders.create',
        'payments.process',
      ]);
    });

    it('declares the DLX exchange and the holding DLQ', () => {
      const parsed = JSON.parse(gen.generate(baseManifest));
      expect(parsed.exchanges.map((e: { name: string }) => e.name)).toContain('main.dlx');
      expect(parsed.queues.map((q: { name: string }) => q.name)).toContain('main.dlq');
    });

    it('emits the reply stream when replyStreamAddress is set', () => {
      const out = gen.generate(baseManifest);
      expect(out).toContain('"name": "main.replies"');
    });

    it('skips DLX setup when no defaultDlqAddress', () => {
      const parsed = JSON.parse(gen.generate({ ...baseManifest, defaultDlqAddress: undefined }));
      expect(parsed.exchanges).toEqual([]);
      expect(parsed.bindings).toEqual([]);
      // No queue carries DLX wiring either
      for (const q of parsed.queues as Array<{ arguments: Record<string, unknown> }>) {
        expect(q.arguments['x-dead-letter-exchange']).toBeUndefined();
      }
    });
  });

  describe('Artemis', () => {
    const gen = pickGenerator('artemis');

    it('uses the .xml extension', () => {
      expect(gen.extension).toBe('xml');
    });

    it('emits anycast addresses for queues', () => {
      const out = gen.generate(baseManifest);
      expect(out).toContain('<address name="orders.create">');
      expect(out).toContain('<anycast>');
    });

    it('emits multicast addresses for streams', () => {
      const out = gen.generate(baseManifest);
      expect(out).toContain('<address name="changes.bulletin">');
      expect(out).toContain('<multicast/>');
    });

    it('emits dead-letter-address on EVERY consumer queue when defaultDlqAddress is set', () => {
      const out = gen.generate(baseManifest);
      expect(out).toContain('<address-setting match="orders.create">');
      expect(out).toContain('<address-setting match="payments.process">');
      // Both reference the same DLA
      const occurrences = out.match(/<dead-letter-address>main\.dlq<\/dead-letter-address>/g) ?? [];
      expect(occurrences.length).toBe(2);
    });
  });

  describe('Qpid', () => {
    const gen = pickGenerator('qpid');

    it('uses the .json extension', () => {
      expect(gen.extension).toBe('json');
    });

    it('outputs valid JSON with a _meta block', () => {
      const parsed = JSON.parse(gen.generate(baseManifest));
      expect(parsed._meta).toMatchObject({ generated_by: '@softwarity/nestjs-amqp', target_brand: 'qpid' });
    });

    it('emits standard queues', () => {
      const parsed = JSON.parse(gen.generate(baseManifest));
      const names = parsed.queues.map((q: { name: string; type: string }) => ({ name: q.name, type: q.type }));
      expect(names).toContainEqual({ name: 'orders.create', type: 'standard' });
    });

    it('warns about streams in the _meta block when present', () => {
      const parsed = JSON.parse(gen.generate(baseManifest));
      expect(parsed._meta.streams_warning).toMatch(/no native stream queue type/);
      expect(parsed._meta.streams_warning).toContain('changes.bulletin');
    });
  });

  describe('Generic / unknown', () => {
    const gen = pickGenerator('unknown');

    it('uses the .txt extension', () => {
      expect(gen.extension).toBe('txt');
    });

    it('lists queues, streams, and infrastructure', () => {
      const out = gen.generate({ ...baseManifest, brand: 'unknown' });
      expect(out).toContain('Queues (work-queue / point-to-point):');
      expect(out).toContain('orders.create');
      expect(out).toContain('payments.process  [DLX required');
      expect(out).toContain('Streams / topics (broadcast):');
      expect(out).toContain('changes.bulletin');
      expect(out).toContain('reply stream: main.replies');
      expect(out).toContain('default DLQ: main.dlq');
    });

    it('handles empty destinations gracefully', () => {
      const out = gen.generate({ brokerName: 'x', brand: 'unknown', destinations: [] });
      expect(out).toContain('(none)');
    });
  });
});
