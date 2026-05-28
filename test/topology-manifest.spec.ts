import { pickGenerator, type TopologyManifest } from '../src/topology-manifest';

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
  describe('RabbitMQ', () => {
    const gen = pickGenerator('rabbitmq');

    it('uses the .json extension', () => {
      expect(gen.extension).toBe('json');
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

    it('wires DLX + DLQ + binding when a consumer has dlq:true', () => {
      const out = gen.generate(baseManifest);
      expect(out).toContain('"name": "main.dlx"');
      expect(out).toContain('"x-dead-letter-exchange": "main.dlx"');
      expect(out).toContain('"x-dead-letter-routing-key": "payments.process"');
      expect(out).toContain('"name": "main.dlq"');
      // The binding section
      expect(out).toContain('"destination": "main.dlq"');
    });

    it('emits the reply stream when replyStreamAddress is set', () => {
      const out = gen.generate(baseManifest);
      expect(out).toContain('"name": "main.replies"');
    });

    it('skips DLX setup when no defaultDlqAddress', () => {
      const out = gen.generate({ ...baseManifest, defaultDlqAddress: undefined });
      expect(out).not.toContain('main.dlx');
      expect(out).not.toContain('x-dead-letter-exchange');
    });

    it('produces valid JSON after the comment header', () => {
      const out = gen.generate(baseManifest);
      const jsonStart = out.indexOf('{');
      const parsed = JSON.parse(out.slice(jsonStart));
      expect(parsed.queues).toBeInstanceOf(Array);
      expect(parsed.exchanges).toBeInstanceOf(Array);
      expect(parsed.bindings).toBeInstanceOf(Array);
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

    it('emits dead-letter-address on the queues with dlq:true', () => {
      const out = gen.generate(baseManifest);
      expect(out).toContain('<address-setting match="payments.process">');
      expect(out).toContain('<dead-letter-address>main.dlq</dead-letter-address>');
    });
  });

  describe('Azure Service Bus', () => {
    const gen = pickGenerator('azure-service-bus');

    it('uses the .sh extension', () => {
      expect(gen.extension).toBe('sh');
    });

    it('emits az servicebus queue create commands', () => {
      const out = gen.generate(baseManifest);
      expect(out).toContain('az servicebus queue create');
      expect(out).toContain("--name 'orders.create'");
    });

    it('adds --max-delivery-count for dlq:true queues', () => {
      const out = gen.generate(baseManifest);
      expect(out).toContain("--name 'payments.process'");
      expect(out).toContain('--max-delivery-count 5');
    });

    it('emits topic + subscription for stream destinations', () => {
      const out = gen.generate(baseManifest);
      expect(out).toContain("az servicebus topic create");
      expect(out).toContain("--topic-name 'changes.bulletin'");
      expect(out).toContain("--name 'main-default'");
    });

    it('notes that DLQ is built-in', () => {
      const out = gen.generate(baseManifest);
      expect(out).toContain('$DeadLetterQueue');
    });
  });

  describe('Qpid', () => {
    const gen = pickGenerator('qpid');

    it('uses the .json extension', () => {
      expect(gen.extension).toBe('json');
    });

    it('emits standard queues', () => {
      const out = gen.generate(baseManifest);
      expect(out).toContain('"name": "orders.create"');
      expect(out).toContain('"type": "standard"');
    });

    it('warns about streams not being natively supported', () => {
      const out = gen.generate(baseManifest);
      expect(out).toContain('Qpid Broker-J has no native stream queue type');
      expect(out).toContain("'changes.bulletin'");
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
