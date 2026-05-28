import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-publishers',
  imports: [CodeComponent, RouterLink],
  template: `
    <h2>Publishers — &#64;AmqpQueue &amp; &#64;AmqpTopic</h2>

    <p>
      Two property decorators inject a publish handle bound to an address. They differ by the kind of
      destination they target — and consequently by the interface they expose.
    </p>

    <table>
      <thead><tr><th>Decorator</th><th>Interface</th><th>Destination</th><th>Methods</th></tr></thead>
      <tbody>
        <tr>
          <td><code>&#64;AmqpQueue(addr, brokerName?)</code></td>
          <td><code>AmqpQueue&lt;T&gt;</code></td>
          <td>Work-queue (classic / quorum)</td>
          <td><code>emit(payload: T): boolean</code> + <code>send&lt;TRes&gt;(payload: T)</code></td>
        </tr>
        <tr>
          <td><code>&#64;AmqpTopic(addr, brokerName?)</code></td>
          <td><code>AmqpTopic&lt;T&gt;</code></td>
          <td>Topic (stream-backed broadcast)</td>
          <td><code>emit(payload: T): boolean</code> only</td>
        </tr>
      </tbody>
    </table>

    <p>
      <code>brokerName</code> is optional when a single broker is configured. With several brokers,
      omitting it throws at first property access. See <a routerLink="/multi-broker">Multi-broker</a>.
    </p>

    <h3>&#64;AmqpQueue&lt;T&gt; — work-queue publisher</h3>

    <p>
      The interface is <strong>generic on the payload type</strong> <code>T</code>. Declare the queue
      with the event shape it carries and every <code>emit()</code> / <code>send()</code> call site is
      type-checked. <code>T</code> defaults to <code>unknown</code>, so omitting the generic stays
      valid for legacy code.
    </p>

    <h4>emit() — fire-and-forget (the 90% case)</h4>

    <app-code lang="ts">import &#123; Injectable &#125; from '&#64;nestjs/common';
import &#123; AmqpQueue &#125; from '&#64;softwarity/nestjs-amqp';

&#64;Injectable()
export class OrdersService &#123;
  &#64;AmqpQueue('orders.create')
  private readonly orders!: AmqpQueue&lt;OrderBody&gt;;

  notifyCreated(body: OrderBody): void &#123;
    this.orders.emit(body);                  // ✅ compiles
    // this.orders.emit(&#123; foo: 'bar' &#125;);  // ❌ TS error: not assignable to OrderBody
  &#125;
&#125;</app-code>

    <p>
      No correlation, no reply. Returns synchronously a <strong>boolean</strong>: <code>true</code> if
      the message was handed off to the sender (broker enabled and connected), <code>false</code> if
      the broker is disabled or not connected. The lib also logs a warning when it drops — the boolean
      is for the call site to react.
    </p>

    <h5>Fallback pattern — in-process bus when AMQP is unavailable</h5>

    <p>
      The boolean return makes it natural to fall back to NestJS's <code>EventEmitter2</code> (or any
      in-process bus, or a local outbox table) so the message isn't lost when the broker is down:
    </p>

    <app-code lang="ts">import &#123; Injectable &#125; from '&#64;nestjs/common';
import &#123; EventEmitter2 &#125; from '&#64;nestjs/event-emitter';
import &#123; AmqpQueue &#125; from '&#64;softwarity/nestjs-amqp';

&#64;Injectable()
export class OrdersService &#123;
  &#64;AmqpQueue('orders.create')
  private readonly orders!: AmqpQueue&lt;OrderBody&gt;;

  constructor(private readonly bus: EventEmitter2) &#123;&#125;

  notifyCreated(body: OrderBody): void &#123;
    if (!this.orders.emit(body)) &#123;
      // Broker disabled or not yet connected — keep going via the in-process bus
      // so local handlers still react. Useful for dev (broker off), boot lag
      // (first events emitted before connection_open), or degraded mode.
      this.bus.emit('orders.create', body);
    &#125;
  &#125;
&#125;</app-code>

    <p>
      Other fallback strategies the boolean enables: writing to a local outbox table (poll + retry
      later), pushing to a Redis dead-letter list, alerting on degraded mode, or simply incrementing
      a metric and dropping silently. The lib is unopinionated — it just tells you whether the message
      made it to the wire.
    </p>

    <div class="callout">
      <strong>Note: <code>true</code> is a local emit, not a broker-side ack.</strong> The boolean
      reflects whether the message reached rhea's sender pipeline; the broker may still reject it
      later (surfaces as a <code>rejected</code> event in the logs). For strong broker acknowledgement,
      use <code>send()</code> (request/reply) instead.
    </div>

    <h4>send() — request / reply (optional feature)</h4>

    <p>
      <code>send()</code> ships the message and returns an <code>Observable</code> that resolves with the
      peer's reply. <strong>It requires a reply stream declared broker-side and a
      <code>replyStreamAddress</code> on the broker options</strong> — see
      <a routerLink="/request-reply">Request / reply</a> for the full setup.
    </p>

    <app-code lang="ts">createOrder(body: OrderBody): Observable&lt;OrderConfirmation&gt; &#123;
  return this.orders.send&lt;OrderConfirmation&gt;(body, &#123;
    timeoutMs: 5000,
    properties: &#123; message_id: body.id, subject: 'order.create.v2' &#125;,
    applicationProperties: &#123; tenantId: body.tenantId &#125;,
  &#125;);
&#125;</app-code>

    <h3>&#64;AmqpTopic&lt;T&gt; — broadcast publisher</h3>

    <p>Same generic convention — defaults to <code>unknown</code>.</p>

    <app-code lang="ts">import &#123; Injectable &#125; from '&#64;nestjs/common';
import &#123; AmqpTopic &#125; from '&#64;softwarity/nestjs-amqp';

interface BulletinChangedEvent &#123;
  bulletinId: string;
  when: string;
&#125;

&#64;Injectable()
export class BulletinService &#123;
  &#64;AmqpTopic('changes.bulletin')
  private readonly changes!: AmqpTopic&lt;BulletinChangedEvent&gt;;

  notifyChange(bulletinId: string): void &#123;
    this.changes.emit(&#123; bulletinId, when: new Date().toISOString() &#125;);  // ✅
    // this.changes.send(...)   ❌ TS error: AmqpTopic has no send()
  &#125;
&#125;</app-code>

    <div class="callout">
      The generic is purely a <strong>compile-time</strong> contract. At runtime every payload goes
      through the same codec — <code>T</code> is erased. The cost is zero, the benefit is that typos and
      schema drifts on the publisher side fail at <code>tsc</code> time instead of in production logs.
    </div>

    <h3>Multi-broker — passing the broker name</h3>

    <app-code lang="ts">// Single broker — name optional, lone broker resolved automatically
&#64;AmqpQueue('orders.create')                  private orders!: AmqpQueue&lt;OrderBody&gt;;

// Multi-broker — name required; throws at first property access otherwise
&#64;AmqpQueue('orders.create', 'primary')       private orders!: AmqpQueue&lt;OrderBody&gt;;
&#64;AmqpTopic('events.metric', 'analytics')     private metrics!: AmqpTopic&lt;Metric&gt;;</app-code>

    <h3>Runtime resolution — AmqpDestinations</h3>

    <p>
      For addresses that aren't known at compile time (tenant-scoped queues, dynamic dispatchers), inject
      <code>AmqpDestinations</code> and resolve a handle at runtime. Same generic + same
      <code>brokerName?</code> semantics as the decorators.
    </p>

    <app-code lang="ts">import &#123; Injectable &#125; from '&#64;nestjs/common';
import &#123; AmqpDestinations &#125; from '&#64;softwarity/nestjs-amqp';

&#64;Injectable()
export class DynamicPublisher &#123;
  constructor(private readonly amqp: AmqpDestinations) &#123;&#125;

  publishToTenant(tenantId: string, body: OrderBody): void &#123;
    const queue = this.amqp.queue&lt;OrderBody&gt;(\`orders.\$&#123;tenantId&#125;\`);
    queue.emit(body);
  &#125;

  publishMetric(m: Metric): void &#123;
    this.amqp.topic&lt;Metric&gt;('events.metric', 'analytics').emit(m);
  &#125;
&#125;</app-code>

    <h3>Options reference — emit() &amp; send()</h3>

    <table>
      <thead><tr><th>Option</th><th>Used by</th><th>Meaning</th></tr></thead>
      <tbody>
        <tr>
          <td><code>timeoutMs</code></td>
          <td><code>send</code></td>
          <td>Override the configured default. Errors with <code>AmqpTimeoutError</code> after this elapses.</td>
        </tr>
        <tr>
          <td><code>properties</code></td>
          <td>both</td>
          <td>AMQP-standard message properties (<code>message_id</code>, <code>subject</code>,
            <code>content_type</code>, <code>creation_time</code>, <code>user_id</code>, …).
            <code>reply_to</code> and <code>correlation_id</code> are managed internally and ignored if
            set here. snake_case to match the wire format.</td>
        </tr>
        <tr>
          <td><code>applicationProperties</code></td>
          <td>both</td>
          <td>Custom <code>Record&lt;string, unknown&gt;</code> — business metadata (tenant ID, trace ID,
            schema version, source service, …).</td>
        </tr>
      </tbody>
    </table>

    <h3>Properties vs. Application Properties</h3>

    <p>AMQP 1.0 splits message metadata into two sections:</p>
    <ul>
      <li><strong>properties</strong> — AMQP-standard fields, a fixed list (<code>message_id</code>,
        <code>reply_to</code>, <code>correlation_id</code>, <code>subject</code>, <code>content_type</code>,
        <code>creation_time</code>, …). Think "HTTP standard headers".</li>
      <li><strong>application_properties</strong> — your custom key/value map. Think "HTTP X-* custom
        headers". Use for tenant IDs, trace IDs, source service names, schema versions, etc.</li>
    </ul>

    <div class="callout warn">
      <strong>First access timing.</strong> The decorated property resolves the broker publisher on its
      first access. If you call <code>this.orders</code> inside a service <em>constructor</em>, you'll get
      an exception because Nest's lifecycle hooks haven't run yet. Defer to a method body,
      <code>OnModuleInit</code>, or <code>OnApplicationBootstrap</code>.
    </div>

    <h3>Address resolution</h3>

    <p>
      User-facing addresses are bare names: <code>orders.create</code>, <code>changes.bulletin</code>.
      The library normalises them per-broker automatically:
    </p>
    <ul>
      <li><strong>RabbitMQ 4.x</strong>: rejects bare names
        (<code>amqp_address_v1_not_permitted</code>) and requires the v2 scheme — the library prepends
        <code>/queues/</code> automatically when the peer's brand is detected as RabbitMQ.</li>
      <li><strong>Artemis and Qpid</strong>: accept bare names, no prefix added.</li>
      <li><strong>Any address starting with <code>/</code></strong> passes through unchanged — escape
        hatch for custom routing (exchanges, sub-queues, …) on any broker.</li>
    </ul>
    <p>To target an exchange explicitly on RabbitMQ, pass the prefix yourself:</p>
    <app-code lang="ts">&#64;AmqpQueue('/exchanges/amq.topic/orders.created.high')
private readonly highPriority!: AmqpQueue;</app-code>
  `,
})
export class PublishersComponent {}
