import { Component } from '@angular/core';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-broker-topology',
  imports: [CodeComponent],
  template: `
    <h2>Broker topology</h2>

    <div class="callout danger">
      <strong>⚠ Critical — this library never declares topology at runtime.</strong>
      It opens senders and receivers on destinations that <em>must already exist</em> on the broker.
      If a queue, stream, exchange, or binding is missing, the AMQP link is rejected with
      <code>amqp:not-found</code> and the consumer silently does nothing (the connection itself stays
      open). <strong>You must pre-declare every destination broker-side</strong> — typically via a
      mounted definition file or an IaC / CLI script run at deployment time.
    </div>

    <p>
      This is a deliberate design choice. Topology drift is the #1 source of subtle bugs in messaging
      systems; treating the topology as code that lives next to the broker (and not in the application)
      makes it reviewable, versionable, and reproducible across environments.
    </p>

    <h3>What you need to declare</h3>

    <table>
      <thead>
        <tr><th>For…</th><th>You need</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>Each <code>&#64;Consume(addr)</code></td>
          <td>A <strong>classic or quorum queue</strong> at <code>addr</code>. Add <code>x-dead-letter-exchange</code> + <code>x-dead-letter-routing-key</code> if you set <code>dlq: true</code>.</td>
        </tr>
        <tr>
          <td>Each <code>&#64;Subscribe(addr)</code> (RabbitMQ)</td>
          <td>A <strong>stream queue</strong> at <code>addr</code> with an appropriate <code>x-max-age</code>.</td>
        </tr>
        <tr>
          <td>Any use of <code>send()</code> (request/reply)</td>
          <td>A <strong>stream queue</strong> at <code>replyStreamAddress</code> (default <code>&lt;appName&gt;.replies</code>). Short <code>x-max-age</code> (e.g. <code>5m</code>) is fine — replies are consumed almost immediately.</td>
        </tr>
        <tr>
          <td>Any consumer with <code>dlq: true</code></td>
          <td>A <strong>DLX</strong> (typically direct) + one or more <strong>DLQs</strong> (typically quorum) bound to it.</td>
        </tr>
      </tbody>
    </table>

    <h2>RabbitMQ 4.x (recommended)</h2>

    <p>
      RabbitMQ 4.x is the recommended broker: native AMQP 1.0 (no plugin needed since 4.0), streams
      (required for <code>&#64;Subscribe</code> and the reply queue), quorum queues, and v2
      addressing on by default.
    </p>

    <h3>definitions.json — the single source of truth</h3>

    <p>
      Mount a JSON definitions file at boot. RabbitMQ loads it once and creates the entities. Subsequent
      runs are idempotent. Below is a complete topology for a service named <code>my-service</code>
      with three work-queues (<code>orders.created</code>, <code>orders.shipped</code>,
      <code>payments.process</code>), one broadcast topic (<code>changes.bulletin</code>), the shared
      reply stream, and a catch-all DLQ.
    </p>

    <app-code lang="json">&#123;
  "rabbit_version": "4.0.0",
  "users": [
    &#123;
      "name": "my-service",
      "password": "change-me",
      "tags": ""
    &#125;
  ],
  "vhosts": [&#123; "name": "/" &#125;],
  "permissions": [
    &#123;
      "user": "my-service",
      "vhost": "/",
      "configure": ".*",
      "write": ".*",
      "read": ".*"
    &#125;
  ],

  "exchanges": [
    &#123;
      "name": "my-service.dlx",
      "vhost": "/",
      "type": "direct",
      "durable": true,
      "auto_delete": false,
      "internal": false,
      "arguments": &#123;&#125;
    &#125;
  ],

  "queues": [
    &#123;
      "name": "orders.created",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": &#123;
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": "my-service.dlx",
        "x-dead-letter-routing-key": "orders.created"
      &#125;
    &#125;,
    &#123;
      "name": "orders.shipped",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": &#123;
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": "my-service.dlx",
        "x-dead-letter-routing-key": "orders.shipped"
      &#125;
    &#125;,
    &#123;
      "name": "payments.process",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": &#123;
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": "my-service.dlx",
        "x-dead-letter-routing-key": "payments.process"
      &#125;
    &#125;,

    &#123;
      "name": "my-service.dlq",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": &#123;
        "x-queue-type": "quorum"
      &#125;
    &#125;,

    &#123;
      "name": "my-service.replies",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": &#123;
        "x-queue-type": "stream",
        "x-max-age": "5m"
      &#125;
    &#125;,

    &#123;
      "name": "changes.bulletin",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": &#123;
        "x-queue-type": "stream",
        "x-max-age": "1h"
      &#125;
    &#125;
  ],

  "bindings": [
    &#123;
      "source": "my-service.dlx",
      "vhost": "/",
      "destination": "my-service.dlq",
      "destination_type": "queue",
      "routing_key": "orders.created",
      "arguments": &#123;&#125;
    &#125;,
    &#123;
      "source": "my-service.dlx",
      "vhost": "/",
      "destination": "my-service.dlq",
      "destination_type": "queue",
      "routing_key": "orders.shipped",
      "arguments": &#123;&#125;
    &#125;,
    &#123;
      "source": "my-service.dlx",
      "vhost": "/",
      "destination": "my-service.dlq",
      "destination_type": "queue",
      "routing_key": "payments.process",
      "arguments": &#123;&#125;
    &#125;
  ]
&#125;</app-code>

    <h3>rabbitmq.conf</h3>

    <p>Tell RabbitMQ to load the definitions on boot:</p>

    <app-code lang="text">management.load_definitions = /etc/rabbitmq/definitions.json

# AMQP 1.0 is enabled by default in 4.x. v2 addressing (/queues/&lt;name&gt;) is also
# default. The library detects RabbitMQ at the AMQP handshake and prepends
# /queues/ to bare addresses automatically — no config needed.
#
# Optional: tune consumer_timeout to be safely above the DLQ-browser hard TTL.
consumer_timeout = 1800000   # 30 min (default)</app-code>

    <h3>docker-compose snippet</h3>

    <app-code lang="text">services:
  rabbitmq:
    image: rabbitmq:4-management
    container_name: rabbitmq
    ports:
      - "5672:5672"       # AMQP 1.0 (and 0.9.1)
      - "15672:15672"     # Management UI
    volumes:
      - ./rabbitmq/definitions.json:/etc/rabbitmq/definitions.json:ro
      - ./rabbitmq/rabbitmq.conf:/etc/rabbitmq/rabbitmq.conf:ro
      - rabbitmq-data:/var/lib/rabbitmq

volumes:
  rabbitmq-data:</app-code>

    <h3>Where to put each piece in your repo</h3>

    <app-code lang="text">my-service/
├─ docker/
│  └─ rabbitmq/
│     ├─ rabbitmq.conf
│     └─ definitions.json   &lt;-- single source of truth
├─ docker-compose.yml
└─ src/
   └─ ...your NestJS app</app-code>

    <p>
      Commit <code>definitions.json</code> alongside your application code. Any change to the topology
      becomes a normal pull request — reviewable, replayable in CI, traceable in <code>git blame</code>.
    </p>

    <div class="callout warn">
      <strong>Don't forget to re-import after a destructive change.</strong> If you change a queue type
      (e.g. classic → quorum, or quorum → stream), RabbitMQ won't let you simply re-declare — the entity
      type is immutable. You need <code>docker compose down -v &amp;&amp; docker compose up -d</code> in
      dev, or in prod: delete the queue first via the Management UI / API, then re-import the
      definitions.
    </div>

    <h2>Apache ActiveMQ Artemis</h2>

    <p>
      Artemis speaks AMQP 1.0 natively on port 5672. Topology is declared in <code>broker.xml</code>.
      The library detects Artemis at the AMQP handshake and uses bare names — no config needed.
    </p>

    <h3>broker.xml — addresses, queues, dead-letter</h3>

    <app-code lang="text">&lt;configuration&gt;
  &lt;core&gt;
    &lt;!-- Work queues (point-to-point = anycast) --&gt;
    &lt;addresses&gt;
      &lt;address name="orders.created"&gt;
        &lt;anycast&gt;
          &lt;queue name="orders.created"&gt;
            &lt;durable&gt;true&lt;/durable&gt;
          &lt;/queue&gt;
        &lt;/anycast&gt;
      &lt;/address&gt;

      &lt;address name="orders.shipped"&gt;
        &lt;anycast&gt;
          &lt;queue name="orders.shipped"&gt;&lt;durable&gt;true&lt;/durable&gt;&lt;/queue&gt;
        &lt;/anycast&gt;
      &lt;/address&gt;

      &lt;address name="payments.process"&gt;
        &lt;anycast&gt;
          &lt;queue name="payments.process"&gt;&lt;durable&gt;true&lt;/durable&gt;&lt;/queue&gt;
        &lt;/anycast&gt;
      &lt;/address&gt;

      &lt;!-- DLQ --&gt;
      &lt;address name="my-service.dlq"&gt;
        &lt;anycast&gt;
          &lt;queue name="my-service.dlq"&gt;&lt;durable&gt;true&lt;/durable&gt;&lt;/queue&gt;
        &lt;/anycast&gt;
      &lt;/address&gt;

      &lt;!-- Broadcast topic (multicast = pub/sub) --&gt;
      &lt;address name="changes.bulletin"&gt;
        &lt;multicast/&gt;
      &lt;/address&gt;
    &lt;/addresses&gt;

    &lt;!-- Dead-letter routing --&gt;
    &lt;address-settings&gt;
      &lt;address-setting match="orders.#"&gt;
        &lt;dead-letter-address&gt;my-service.dlq&lt;/dead-letter-address&gt;
        &lt;max-delivery-attempts&gt;5&lt;/max-delivery-attempts&gt;
      &lt;/address-setting&gt;
      &lt;address-setting match="payments.#"&gt;
        &lt;dead-letter-address&gt;my-service.dlq&lt;/dead-letter-address&gt;
        &lt;max-delivery-attempts&gt;5&lt;/max-delivery-attempts&gt;
      &lt;/address-setting&gt;
    &lt;/address-settings&gt;
  &lt;/core&gt;
&lt;/configuration&gt;</app-code>

    <h3>Key differences from RabbitMQ</h3>

    <ul>
      <li><strong>No streams.</strong> Artemis broadcast is achieved via <code>multicast</code>
        addresses. Each receiver creates its own auto-deleted subscription queue on attach (handled
        transparently by the broker — the library opens the receiver as usual).</li>
      <li><strong>Reply queue.</strong> Use a regular (anycast) durable queue rather than a stream.
        Filter by <code>correlation_id</code> on the consumer side works the same way — but only one
        instance will receive each reply (no broadcast). For multi-instance services, declare one reply
        queue per instance and pass the right <code>replyStreamAddress</code> per process, OR use a
        multicast address with one subscription per instance.</li>
      <li><strong>Bare addresses.</strong> No prefix needed — the library detects Artemis and skips
        the <code>/queues/</code> prefix automatically.</li>
      <li><strong>DLQ semantics.</strong> Artemis tracks delivery attempts itself
        (<code>max-delivery-attempts</code> on the address-setting). Coordinate this with
        <code>maxDelivery</code> in the consumer options — typically set Artemis to a higher value so
        the library's retry policy wins.</li>
    </ul>

    <h2>Azure Service Bus</h2>

    <p>
      Azure SB is fully AMQP 1.0 native — the library connects with no transport changes. Entities
      (queues, topics, subscriptions, sub-queues) are declared via ARM/Bicep, Azure CLI, or the Portal.
    </p>

    <p>The connection URL looks like:</p>

    <app-code lang="text">amqps://&lt;namespace&gt;.servicebus.windows.net:5671</app-code>

    <p>
      Auth is SASL (use a SAS token or AAD token as <code>password</code> with
      <code>username = "$@$@"</code> for SAS, or AAD bearer for OAuth).
    </p>

    <h3>Azure CLI — declare the topology</h3>

    <app-code lang="bash">RG=my-rg
NS=my-namespace
LOC=westeurope

az group create --name $RG --location $LOC

az servicebus namespace create \\
  --name $NS \\
  --resource-group $RG \\
  --location $LOC \\
  --sku Standard       # Standard required for topics

# Work queues (each gets an automatic $DeadLetterQueue sub-queue)
az servicebus queue create --resource-group $RG --namespace-name $NS \\
  --name orders.created --max-delivery-count 5
az servicebus queue create --resource-group $RG --namespace-name $NS \\
  --name orders.shipped --max-delivery-count 5
az servicebus queue create --resource-group $RG --namespace-name $NS \\
  --name payments.process --max-delivery-count 5

# Reply queue (anycast, one per consumer instance — see note below)
az servicebus queue create --resource-group $RG --namespace-name $NS \\
  --name my-service.replies --default-message-time-to-live PT5M

# Broadcast topic + one subscription per consumer instance
az servicebus topic create --resource-group $RG --namespace-name $NS \\
  --name changes.bulletin
az servicebus topic subscription create --resource-group $RG \\
  --namespace-name $NS --topic-name changes.bulletin \\
  --name my-service-instance-1</app-code>

    <h3>Key differences</h3>

    <ul>
      <li><strong>Dead-letter is built-in.</strong> Every queue and subscription has an automatic
        <code>$DeadLetterQueue</code> sub-queue at <code>&lt;queue&gt;/$DeadLetterQueue</code>. No
        DLX/binding declaration needed. Browse it the same way as a regular queue.</li>
      <li><strong>No streams.</strong> Use a regular queue for the reply destination. For broadcast,
        use topics + per-instance subscriptions.</li>
      <li><strong>Topic subscriptions are addressable.</strong> The address to subscribe is
        <code>&lt;topic&gt;/Subscriptions/&lt;sub-name&gt;</code>.</li>
      <li><strong>SKU matters.</strong> Topics require the Standard tier (or Premium).</li>
    </ul>

    <h2>Apache Qpid Broker-J</h2>

    <p>
      Qpid Broker-J speaks AMQP 1.0 natively. Topology lives in
      <code>config.json</code> (or the web console at port 8080 for browse/declare).
      It supports queues and exchanges very similar to RabbitMQ classic queues but lacks streams.
      The library detects Qpid and uses bare names automatically.
    </p>

    <p>
      For <code>&#64;Subscribe</code>-style broadcast and the reply destination, fall back to
      either a per-instance queue + topic exchange binding pattern, or use Apache Pulsar / RabbitMQ if
      stream semantics matter. Qpid is a good fit for pure work-queue workloads.
    </p>

    <h2>Topology verification at boot — optional pattern</h2>

    <p>
      Some teams want a sanity check that the broker is in the expected state. Since this library
      doesn't call the Management API, you can implement it yourself:
    </p>

    <ul>
      <li><strong>RabbitMQ</strong> — hit <code>GET /api/queues/%2F/&lt;queue&gt;</code> on the
        Management API and assert HTTP 200 in a healthcheck.</li>
      <li><strong>Azure SB</strong> — use the <code>@azure/service-bus-management</code> SDK
        <code>queueExists()</code> / <code>topicExists()</code> in an <code>OnApplicationBootstrap</code>
        hook.</li>
      <li><strong>Artemis</strong> — JMX or the Jolokia REST endpoint.</li>
    </ul>

    <p>
      This is opt-in: nothing in this library does it for you. The reasoning is that production
      deployments should fail loudly at infra provisioning time (Terraform plan, Helm upgrade,
      definitions import) — not silently at app startup.
    </p>

    <h2>Auto-generated topology manifest — opt-in</h2>

    <p>
      The library can write <strong>broker-side ready snippets</strong> of the topology your service
      expects — <strong>one file per supported brand</strong>, all at boot, <strong>without ever
      connecting to a broker</strong>. Useful when bootstrapping a new service offline, when onboarding
      an operator, or as a living source of truth in a PR description ("here's what I need declared
      broker-side").
    </p>

    <p>Opt in per broker:</p>

    <app-code lang="ts">AmqpModule.forRoot(&#123;
  url: 'amqp://localhost:5672',
  username: 'guest', password: 'guest',
  emitTopologyManifest: true,   // ← enables the manifest
&#125;);</app-code>

    <p>
      At <code>onModuleInit</code> (right after the consumer-explorer has wired every
      <code>&#64;Consume</code> / <code>&#64;Subscribe</code>), the library writes one file per known
      brand to <code>os.tmpdir() / amqp-topology / &lt;brokerName&gt;.&lt;brand&gt;.&lt;ext&gt;</code>.
      Each file is a ready-to-merge snippet for its target broker — pick the one matching your stack.
      Works <strong>even when <code>enabled: false</code> or the broker is unreachable</strong>: the
      generation is purely static, derived from your decorators and options.
    </p>

    <app-code lang="text">[AmqpConsumerExplorer] broker 'default': 4 consumer(s)
[AmqpConsumerExplorer]   - &#64;Consume orders.create -&gt; OrdersListener.onCreate
[AmqpConsumerExplorer]   - &#64;Consume payments.process -&gt; PaymentListener.onPayment
[AmqpConsumerExplorer]   - &#64;Consume orders.ship -&gt; OrdersListener.onShip
[AmqpConsumerExplorer]   - &#64;Subscribe changes.bulletin -&gt; BulletinPublisher.onChanged
[AmqpConsumerExplorer] broker 'default': topology manifests written:
[AmqpConsumerExplorer]   - /tmp/amqp-topology/default.rabbitmq.json
[AmqpConsumerExplorer]   - /tmp/amqp-topology/default.artemis.xml
[AmqpConsumerExplorer]   - /tmp/amqp-topology/default.azure-service-bus.sh
[AmqpConsumerExplorer]   - /tmp/amqp-topology/default.qpid.json</app-code>

    <p>What goes into each manifest:</p>
    <ul>
      <li>One queue per <code>&#64;Consume(addr)</code> (quorum on RabbitMQ, anycast on Artemis, …)</li>
      <li>One stream / topic per <code>&#64;Subscribe(addr)</code> (stream on RabbitMQ, multicast on Artemis, topic + sub on Azure SB, …)</li>
      <li>The <code>replyStreamAddress</code> if declared (used by <code>send()</code>)</li>
      <li>The <code>defaultDlqAddress</code> and the DLX wiring if any consumer uses <code>dlq: true</code></li>
    </ul>

    <table>
      <thead><tr><th>Brand</th><th>Format</th><th>Example file</th></tr></thead>
      <tbody>
        <tr><td>RabbitMQ</td><td><code>definitions.json</code> snippet (queues + exchanges + bindings)</td><td><code>default.rabbitmq.json</code></td></tr>
        <tr><td>Artemis</td><td><code>broker.xml</code> snippet (<code>&lt;addresses&gt;</code> + <code>&lt;address-settings&gt;</code>)</td><td><code>default.artemis.xml</code></td></tr>
        <tr><td>Azure Service Bus</td><td>bash script with <code>az servicebus</code> commands</td><td><code>default.azure-service-bus.sh</code></td></tr>
        <tr><td>Qpid Broker-J</td><td><code>config.json</code> snippet</td><td><code>default.qpid.json</code></td></tr>
      </tbody>
    </table>

    <p>
      When the option is <code>false</code> or omitted (the default), the library logs a one-line hint
      at boot so the feature stays discoverable:
    </p>

    <app-code lang="text">[AmqpConsumerExplorer] broker 'default': set \`emitTopologyManifest: true\` to get
       ready-to-merge topology snippets written to os.tmpdir() at boot</app-code>

    <div class="callout">
      <strong>Side effect.</strong> When enabled, four files are written at every boot. Pick the option
      per broker — useful to enable in dev only, switch off in prod.
    </div>

    <div class="callout warn">
      <strong>Not a runtime declarator.</strong> The manifest is a <em>hint</em> the library writes for
      you — declaring topology broker-side is still your job (or your IaC's). The manifest is meant to
      be merged into your existing <code>definitions.json</code> / <code>broker.xml</code> / IaC
      scripts, not run as-is in prod.
    </div>
  `,
})
export class BrokerTopologyComponent {}
