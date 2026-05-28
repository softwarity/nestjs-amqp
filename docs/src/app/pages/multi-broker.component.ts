import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-multi-broker',
  imports: [CodeComponent, RouterLink],
  template: `
    <h2>Multi-broker</h2>

    <p>
      The module supports connecting to several brokers from one NestJS service. Common use cases:
      a primary broker for business events + a separate analytics broker; a write-through pattern across
      two clusters in different regions; an audit broker that mirrors everything. Each broker is
      independent — its own connection, its own reply stream, its own DLQ, its own body codec.
    </p>

    <p>
      <strong>For a single-broker service, none of this applies</strong> — the <code>brokerName</code>
      argument on every decorator and locator method is optional and the lone broker is resolved
      automatically. Read this page only when you actually need a second broker.
    </p>

    <h3>Declare several brokers</h3>

    <app-code lang="ts">AmqpModule.forRoot(&#123;
  brokers: [
    &#123;
      name: 'primary',
      url: 'amqp://broker-a:5672',
      username: 'svc', password: '...',
      replyStreamAddress: 'my-svc.replies',
      defaultDlqAddress: 'my-svc.dlq',
    &#125;,
    &#123;
      name: 'analytics',
      url: 'amqp://broker-b:5672',
      username: 'svc', password: '...',
      // No reply stream / DLQ — analytics is emit-only fire-and-forget.
    &#125;,
  ],
&#125;);</app-code>

    <p>Constraints:</p>
    <ul>
      <li><code>name</code> must be unique across all brokers.</li>
      <li>The order of <code>brokers[]</code> matters: the <strong>first</strong> entry is the
        "default broker" used by single-broker shortcuts and by the DLQ admin URL fallback.</li>
      <li>Each broker manages its own reply stream and DLQ. The names can collide
        (<code>my-svc.replies</code> on both brokers is fine) because they're physically different
        queues on different servers.</li>
    </ul>

    <h3>Pass the broker name on every decorator</h3>

    <app-code lang="ts">&#64;Injectable()
export class MixedService &#123;
  &#64;AmqpQueue('orders.create', 'primary')        private orders!: AmqpQueue&lt;OrderBody&gt;;
  &#64;AmqpTopic('metrics.collected', 'analytics')  private metrics!: AmqpTopic&lt;Metric&gt;;

  doStuff(): void &#123;
    this.orders.emit(&#123; id: 'o-1' &#125;);
    this.metrics.emit(&#123; name: 'order.created', count: 1 &#125;);
  &#125;
&#125;

&#64;Injectable()
export class MixedListener &#123;
  &#64;Consume('orders.create', 'primary', &#123; maxDelivery: 3, dlq: true &#125;)
  onOrder(order: OrderBody): void &#123; ... &#125;

  &#64;Subscribe('events.tick', 'analytics')
  onTick(event: TickEvent): void &#123; ... &#125;
&#125;</app-code>

    <p>
      The 2nd argument on <code>&#64;Consume</code> / <code>&#64;Subscribe</code> is detected at
      runtime: a string is a broker name, an object is an options bag. Both forms below are valid:
    </p>

    <app-code lang="ts">&#64;Consume('orders.create', &#123; dlq: true &#125;)                  // single-broker setup
&#64;Consume('orders.create', 'primary', &#123; dlq: true &#125;)      // multi-broker setup</app-code>

    <p>
      Forgetting the broker name in a multi-broker setup throws clearly at boot:
      <em>"Multiple brokers configured ([primary, analytics]) — a broker name is required. Pass it
      explicitly: e.g. &#64;AmqpQueue('addr', 'primary')."</em>
    </p>

    <h3>Runtime resolution — AmqpDestinations</h3>

    <p>
      For dynamic broker selection (e.g. choose based on payload, tenant, feature flag), inject
      <code>AmqpDestinations</code>:
    </p>

    <app-code lang="ts">import &#123; Injectable &#125; from '&#64;nestjs/common';
import &#123; AmqpDestinations &#125; from '&#64;softwarity/nestjs-amqp';

&#64;Injectable()
export class DualWritePublisher &#123;
  constructor(private readonly amqp: AmqpDestinations) &#123;&#125;

  publish(body: OrderBody): void &#123;
    this.amqp.queue&lt;OrderBody&gt;('orders.create', 'primary').emit(body);
    this.amqp.queue&lt;OrderBody&gt;('orders.create', 'analytics').emit(body);
  &#125;
&#125;</app-code>

    <h3>Boot log — see the wiring</h3>

    <p>At boot, the module logs one section per broker:</p>

    <app-code lang="text">[BrokerRegistry] bringing up 2 broker(s): [primary, analytics]
[BrokerConnection:primary]   connection_open to amqp://broker-a:5672 (peer: RabbitMQ 4.1.2)
[BrokerConnection:analytics] connection_open to amqp://broker-b:5672 (peer: RabbitMQ 4.1.2)
[BrokerConnection:primary]   reply receiver attached: /queues/my-svc.replies (prefix=abc-def-...)
[AmqpConsumerExplorer] broker 'primary': 2 consumer(s)
[AmqpConsumerExplorer]   - &#64;Consume orders.create -&gt; MixedListener.onOrder
[AmqpConsumerExplorer]   - &#64;Consume payments.process -&gt; PaymentListener.onPayment
[AmqpConsumerExplorer] broker 'analytics': 1 consumer(s)
[AmqpConsumerExplorer]   - &#64;Subscribe events.tick -&gt; MixedListener.onTick</app-code>

    <p>
      Use these lines to verify each handler is bound to the broker you expect. Brand detection
      (<code>RabbitMQ</code>, <code>Apache ActiveMQ Artemis</code>, etc.) reads the peer's AMQP Open
      frame <code>properties.product</code> field — used today for diagnostics and in 0.3.x for the
      brand-aware retry rescheduler.
    </p>

    <h3>Direct access to a broker — BrokerRegistry</h3>

    <p>
      Advanced users can inject the registry itself to do imperative work — e.g. inspect a broker's
      brand, drive low-level operations:
    </p>

    <app-code lang="ts">import &#123; Injectable &#125; from '&#64;nestjs/common';
import &#123; BrokerRegistry &#125; from '&#64;softwarity/nestjs-amqp';

&#64;Injectable()
export class HealthCheck &#123;
  constructor(private readonly registry: BrokerRegistry) &#123;&#125;

  describe(): &#123; broker: string; brand: string; product?: string &#125;[] &#123;
    return this.registry.names().map((name) =&gt; &#123;
      const conn = this.registry.getConnection(name);
      return &#123; broker: name, brand: conn.brand, product: conn.peerProduct &#125;;
    &#125;);
  &#125;
&#125;</app-code>

    <h3>What about a single shared destination across brokers?</h3>

    <p>
      An address like <code>orders.create</code> can be declared on multiple brokers, and that's fine
      — each broker has its own physical queue. But a <code>&#64;Consume('orders.create', '???')</code>
      can only bind to <strong>one</strong> broker per decorator. If you need to consume the same
      address from two brokers, declare two methods:
    </p>

    <app-code lang="ts">&#64;Consume('orders.create', 'primary')
onOrderPrimary(o: OrderBody): void &#123; this.svc.handle(o); &#125;

&#64;Consume('orders.create', 'dr-backup')
onOrderBackup(o: OrderBody): void &#123; this.svc.handle(o); &#125;</app-code>

    <p>
      Same for publishing — declare two <code>&#64;AmqpQueue</code> properties (one per broker) and emit
      to both at the call site. There is no "broadcast to all brokers" shortcut, by design — the
      "dual write" semantics is application-level concern.
    </p>

    <h3>DLQ admin in multi-broker mode</h3>

    <p>
      With multiple brokers, the DLQ admin URLs include the broker name in the path. See
      <a routerLink="/dlq-browser">DLQ browser</a>:
    </p>

    <app-code lang="text">POST /admin/dlq/primary/sessions      &#123; dlqAddress: 'my-svc.dlq', pageSize: 20 &#125;
POST /admin/dlq/analytics/sessions    &#123; dlqAddress: 'analytics.dlq', pageSize: 20 &#125;
POST /admin/dlq/sessions              &#123; dlqAddress: 'my-svc.dlq' &#125;   ← defaults to first broker</app-code>
  `,
})
export class MultiBrokerComponent {}
