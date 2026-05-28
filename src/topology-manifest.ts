import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { BrokerBrand } from './broker-connection';

/**
 * Topology manifest generator — emits a broker-side ready snippet listing the
 * resources this service expects to find on its broker.
 *
 * The library never declares topology at runtime; the manifest is a hint for
 * the operator: "to make this service work, declare these queues / exchanges
 * / bindings broker-side". One file per broker, per brand, with the format
 * that brand consumes natively (RabbitMQ JSON, Artemis XML, Qpid JSON,
 * generic text fallback).
 *
 * Opt-in via `BrokerOptions.emitTopologyManifest = true`. When disabled, the
 * library logs a one-line hint at boot so the feature stays discoverable.
 */

/** One destination this service consumes from. Drives the queue declaration
 *  and the DLX wiring (when the broker has a default DLQ address configured). */
export interface ExpectedDestination {
  /** `'queue'` = classic / quorum (work-queue, point-to-point);
   *  `'stream'` = stream-backed broadcast (broker-specific support). */
  readonly kind: 'queue' | 'stream';
  readonly address: string;
  /** Whether this destination's consumer enables `dlq: true` — only affects
   *  the **runtime** behaviour (reject vs accept on terminal failure). The
   *  topology manifest wires DLX on every queue when the broker has a
   *  `defaultDlqAddress` regardless of this flag, so enabling `dlq: true`
   *  later at the call site doesn't require recreating the broker queue
   *  (queue arguments are immutable on most brokers). */
  readonly dlq: boolean;
}

/** Everything a generator needs to emit a brand-specific manifest. */
export interface TopologyManifest {
  readonly brokerName: string;
  readonly brand: BrokerBrand;
  readonly destinations: ReadonlyArray<ExpectedDestination>;
  readonly replyStreamAddress?: string;
  readonly defaultDlqAddress?: string;
}

/** Per-brand manifest generator. Output is a string (file content). */
export interface TopologyManifestGenerator {
  /** File extension, no leading dot. */
  readonly extension: string;
  generate(manifest: TopologyManifest): string;
}

/** Metadata embedded in every generated file. Lives under the `_meta` JSON
 *  key for brokers that consume JSON, or as a comment for XML/text formats.
 *  Lets operators identify the file's origin and target without guessing. */
function metaBlock(brokerName: string, brand: string): Record<string, string> {
  return {
    generated_by: '@softwarity/nestjs-amqp',
    broker_name: brokerName,
    target_brand: brand,
    note: 'Topology snippet — merge with your existing broker config (add vhosts/users/permissions for standalone loading).',
  };
}

// ---------------------------------------------------------------------------
// RabbitMQ 4.x — definitions.json snippet
// ---------------------------------------------------------------------------

class RabbitMqGenerator implements TopologyManifestGenerator {
  readonly extension = 'json';

  generate(m: TopologyManifest): string {
    const queues: object[] = [];
    const exchanges: object[] = [];
    const bindings: object[] = [];

    // DLX wiring is defensive — set up on every consumer queue when the broker
    // declares a `defaultDlqAddress`, regardless of whether any consumer
    // currently uses `dlq: true`. Queue arguments are immutable on RabbitMQ;
    // wiring DLX up front avoids a broker-side recreate when the application
    // later flips a `dlq: true`.
    const dlxName = m.defaultDlqAddress ? `${m.brokerName}.dlx` : undefined;
    if (dlxName && m.defaultDlqAddress) {
      exchanges.push({
        name: dlxName,
        vhost: '/',
        type: 'direct',
        durable: true,
        auto_delete: false,
        internal: false,
        arguments: {},
      });
      queues.push({
        name: m.defaultDlqAddress,
        vhost: '/',
        durable: true,
        auto_delete: false,
        arguments: { 'x-queue-type': 'quorum' },
      });
    }

    for (const d of m.destinations) {
      if (d.kind === 'queue') {
        const args: Record<string, unknown> = { 'x-queue-type': 'quorum' };
        if (dlxName && m.defaultDlqAddress) {
          args['x-dead-letter-exchange'] = dlxName;
          args['x-dead-letter-routing-key'] = d.address;
          bindings.push({
            source: dlxName,
            vhost: '/',
            destination: m.defaultDlqAddress,
            destination_type: 'queue',
            routing_key: d.address,
            arguments: {},
          });
        }
        queues.push({
          name: d.address,
          vhost: '/',
          durable: true,
          auto_delete: false,
          arguments: args,
        });
      } else {
        queues.push({
          name: d.address,
          vhost: '/',
          durable: true,
          auto_delete: false,
          arguments: { 'x-queue-type': 'stream', 'x-max-age': '1h' },
        });
      }
    }

    if (m.replyStreamAddress) {
      queues.push({
        name: m.replyStreamAddress,
        vhost: '/',
        durable: true,
        auto_delete: false,
        arguments: { 'x-queue-type': 'stream', 'x-max-age': '5m' },
      });
    }

    return (
      JSON.stringify(
        {
          _meta: metaBlock(m.brokerName, 'rabbitmq'),
          exchanges,
          queues,
          bindings,
        },
        null,
        2,
      ) + '\n'
    );
  }
}

// ---------------------------------------------------------------------------
// ActiveMQ Artemis — broker.xml snippet
// ---------------------------------------------------------------------------

class ArtemisGenerator implements TopologyManifestGenerator {
  readonly extension = 'xml';

  generate(m: TopologyManifest): string {
    const addresses: string[] = [];
    const settings: string[] = [];

    for (const d of m.destinations) {
      if (d.kind === 'queue') {
        addresses.push(
          `    <address name="${d.address}">\n      <anycast><queue name="${d.address}"><durable>true</durable></queue></anycast>\n    </address>`,
        );
        // Defensive DLA wiring — same rationale as the RabbitMQ generator:
        // applies to every consumer queue when defaultDlqAddress is set, so
        // flipping `dlq: true` later doesn't require a broker-side change.
        if (m.defaultDlqAddress) {
          settings.push(
            `    <address-setting match="${d.address}">\n      <dead-letter-address>${m.defaultDlqAddress}</dead-letter-address>\n      <max-delivery-attempts>5</max-delivery-attempts>\n    </address-setting>`,
          );
        }
      } else {
        addresses.push(`    <address name="${d.address}">\n      <multicast/>\n    </address>`);
      }
    }

    if (m.defaultDlqAddress) {
      addresses.push(
        `    <address name="${m.defaultDlqAddress}">\n      <anycast><queue name="${m.defaultDlqAddress}"><durable>true</durable></queue></anycast>\n    </address>`,
      );
    }
    if (m.replyStreamAddress) {
      addresses.push(
        `    <address name="${m.replyStreamAddress}">\n      <anycast><queue name="${m.replyStreamAddress}"><durable>true</durable></queue></anycast>\n    </address>`,
      );
    }

    const header =
      `<!-- Generated by @softwarity/nestjs-amqp for broker '${m.brokerName}' (target: artemis). -->\n` +
      `<!-- Merge the <addresses> + <address-settings> into the <core> section of your broker.xml. -->\n`;
    return (
      header +
      `<configuration>\n  <core>\n    <addresses>\n${addresses.join('\n')}\n    </addresses>\n` +
      (settings.length > 0 ? `    <address-settings>\n${settings.join('\n')}\n    </address-settings>\n` : '') +
      `  </core>\n</configuration>\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Apache Qpid Broker-J — config.json snippet
// ---------------------------------------------------------------------------

class QpidGenerator implements TopologyManifestGenerator {
  readonly extension = 'json';

  generate(m: TopologyManifest): string {
    const queues = m.destinations
      .filter((d) => d.kind === 'queue')
      .map((d) => ({ name: d.address, type: 'standard', durable: true }));
    const streams = m.destinations.filter((d) => d.kind === 'stream');
    if (m.defaultDlqAddress) {
      queues.push({ name: m.defaultDlqAddress, type: 'standard', durable: true });
    }
    if (m.replyStreamAddress) {
      queues.push({ name: m.replyStreamAddress, type: 'standard', durable: true });
    }
    const meta: Record<string, string> = metaBlock(m.brokerName, 'qpid');
    if (streams.length > 0) {
      meta.streams_warning =
        `Qpid Broker-J has no native stream queue type — addresses (${streams.map((s) => s.address).join(', ')}) ` +
        `need a per-instance pattern (queue per subscriber bound to a topic exchange).`;
    }
    return JSON.stringify({ _meta: meta, queues }, null, 2) + '\n';
  }
}

// ---------------------------------------------------------------------------
// Generic / unknown brand — plain text checklist
// ---------------------------------------------------------------------------

class GenericGenerator implements TopologyManifestGenerator {
  readonly extension = 'txt';

  generate(m: TopologyManifest): string {
    const lines: string[] = [
      `Expected topology for broker '${m.brokerName}' (brand: ${m.brand})`,
      `Generated by @softwarity/nestjs-amqp.`,
      ``,
      `The library does not declare topology at runtime. Make sure the following`,
      `resources exist on your broker before this service starts:`,
      ``,
      `Queues (work-queue / point-to-point):`,
    ];
    const queues = m.destinations.filter((d) => d.kind === 'queue');
    if (queues.length === 0) lines.push(`  (none)`);
    else for (const d of queues) lines.push(`  - ${d.address}${d.dlq ? '  [DLX required for dlq:true]' : ''}`);
    lines.push(``, `Streams / topics (broadcast):`);
    const streams = m.destinations.filter((d) => d.kind === 'stream');
    if (streams.length === 0) lines.push(`  (none)`);
    else for (const d of streams) lines.push(`  - ${d.address}`);
    lines.push(``, `Infrastructure:`);
    if (m.replyStreamAddress) lines.push(`  - reply stream: ${m.replyStreamAddress}`);
    if (m.defaultDlqAddress) lines.push(`  - default DLQ: ${m.defaultDlqAddress}`);
    return lines.join('\n') + '\n';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** All brands the manifest emitter generates for. Order is stable so the boot
 *  log is consistent. */
export const ALL_KNOWN_BRANDS: ReadonlyArray<BrokerBrand> = ['rabbitmq', 'artemis', 'qpid'];

/** Pick the generator for the detected brand. Falls back to `GenericGenerator`
 *  for unknown peers. */
export function pickGenerator(brand: BrokerBrand): TopologyManifestGenerator {
  switch (brand) {
    case 'rabbitmq':
      return new RabbitMqGenerator();
    case 'artemis':
      return new ArtemisGenerator();
    case 'qpid':
      return new QpidGenerator();
    default:
      return new GenericGenerator();
  }
}

/** Build the manifest content and write it to disk. Returns the absolute
 *  path written. Throws if `mkdir` or `writeFile` fails — caller logs the
 *  error. */
export function writeTopologyManifest(manifest: TopologyManifest): string {
  const generator = pickGenerator(manifest.brand);
  const content = generator.generate(manifest);
  const dir = path.join(os.tmpdir(), 'amqp-topology');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${manifest.brokerName}.${manifest.brand}.${generator.extension}`);
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

/**
 * Write one manifest file per known brand for the given broker. Useful at
 * boot time when the peer isn't connected yet (or `enabled: false`): the
 * operator gets ready-to-merge snippets for every supported broker and
 * picks the one matching their target. Returns the list of absolute paths
 * written (in `ALL_KNOWN_BRANDS` order). Throws on the first I/O failure;
 * caller logs the error.
 */
export function writeTopologyManifestForAllBrands(manifest: Omit<TopologyManifest, 'brand'>): string[] {
  return ALL_KNOWN_BRANDS.map((brand) => writeTopologyManifest({ ...manifest, brand }));
}
