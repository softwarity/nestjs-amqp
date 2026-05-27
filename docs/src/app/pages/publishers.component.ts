import { Component } from '@angular/core';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-publishers',
  imports: [CodeComponent],
  template: `
    <h2>Publishers — &#64;AmqpQueue &amp; &#64;AmqpTopic</h2>

    <p>
      Two property decorators inject a publish handle bound to an address. They differ by the kind of
      destination they target — and consequently by the interface they expose.
    </p>

    <table>
      <thead><tr><th>Decorator</th><th>Destination</th><th>Methods</th></tr></thead>
      <tbody>
        <tr>
          <td><code>&#64;AmqpQueue(addr)</code></td>
          <td>Work-queue (classic / quorum)</td>
          <td><code>send&lt;T&gt;()</code> + <code>emit()</code></td>
        </tr>
        <tr>
          <td><code>&#64;AmqpTopic(addr)</code></td>
          <td>Topic (stream-backed broadcast)</td>
          <td><code>emit()</code> only</td>
        </tr>
      </tbody>
    </table>

    <p>
      Both addresses resolve to <code>/queues/&lt;name&gt;</code> internally (RabbitMQ 4.x v2 addressing).
      The decorator you pick declares the <em>semantic intent</em>. Choosing <code>&#64;AmqpTopic</code>
      gives you a compile-time error if someone tries to call <code>send()</code> on a broadcast
      destination.
    </p>

    <h3>&#64;AmqpQueue — work-queue publisher</h3>

    <app-code lang="ts">import &#123; Injectable &#125; from '&#64;nestjs/common';
import &#123; Observable &#125; from 'rxjs';
import &#123; AmqpQueue &#125; from '&#64;softwarity/nestjs-amqp';

&#64;Injectable()
export class OrdersService &#123;
  &#64;AmqpQueue('orders.create')
  private readonly orders!: AmqpQueue;

  createOrder(body: OrderBody): Observable&lt;OrderConfirmation&gt; &#123;
    return this.orders.send&lt;OrderConfirmation&gt;(body, &#123;
      timeoutMs: 5000,
      properties: &#123; message_id: body.id, subject: 'order.create.v2' &#125;,
      applicationProperties: &#123; tenantId: body.tenantId &#125;,
    &#125;);
  &#125;

  notifyCreated(body: OrderBody): void &#123;
    this.orders.emit(body);   // fire-and-forget
  &#125;
&#125;</app-code>

    <h3>&#64;AmqpTopic — broadcast publisher</h3>

    <app-code lang="ts">import &#123; Injectable &#125; from '&#64;nestjs/common';
import &#123; AmqpTopic &#125; from '&#64;softwarity/nestjs-amqp';

&#64;Injectable()
export class BulletinService &#123;
  &#64;AmqpTopic('changes.bulletin')
  private readonly changes!: AmqpTopic;

  notifyChange(bulletinId: string): void &#123;
    this.changes.emit(&#123; bulletinId, when: new Date().toISOString() &#125;);
    // this.changes.send(...)  &lt;-- TypeScript error: AmqpTopic has no send()
  &#125;
&#125;</app-code>

    <h3>send() — request / reply</h3>

    <ol>
      <li>The library generates <code>correlationId = $&#123;client.replyPrefix&#125;:$&#123;randomUUID()&#125;</code></li>
      <li>It publishes the body with <code>reply_to</code> set to the shared reply stream and the correlation ID</li>
      <li>It returns an Observable that resolves when a reply with the matching correlation ID arrives</li>
      <li>It times out after <code>opts.timeoutMs</code> (or <code>defaultSendTimeoutMs</code>), erroring with <code>AmqpTimeoutError</code></li>
    </ol>

    <h3>emit() — fire-and-forget</h3>

    <p>
      No correlation, no reply. Returns <code>void</code> synchronously. If the broker is not connected,
      the message is dropped with a warning log — same semantic as a UDP send.
    </p>

    <h3>Options reference</h3>

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
      <strong>First access timing.</strong> The decorated property resolves the publisher singleton on its
      first access. If you call <code>this.orders</code> inside a service <em>constructor</em>, you'll get
      an exception because Nest's lifecycle hooks haven't run yet. Defer to a method body,
      <code>OnModuleInit</code>, or <code>OnApplicationBootstrap</code>.
    </div>

    <h3>Address resolution</h3>

    <p>
      User-facing addresses are bare names: <code>orders.create</code>, <code>changes.bulletin</code>.
      Internally, the client prepends <code>/queues/</code> (RabbitMQ 4.x v2 addressing —
      <code>amqp_address_v1_not_permitted</code> rejects the bare form). This works identically for
      classic, quorum, and stream queues — all "queues" at the addressing layer.
    </p>
    <p>To target an exchange explicitly, pass the prefix yourself:</p>
    <app-code lang="ts">&#64;AmqpQueue('/exchanges/amq.topic/orders.created.high')
private readonly highPriority!: AmqpQueue;</app-code>

    <p>
      Already-prefixed addresses (<code>/queues/…</code>, <code>/exchanges/…</code>) pass through unchanged.
      If your broker accepts bare names (Artemis, Qpid, Azure SB), set
      <code>autoPrefixQueues: false</code> in the module options.
    </p>

    <h3>The reply queue — per-process prefix on a shared stream</h3>
    <p>
      The library generates a <code>replyPrefix = randomUUID()</code> per process. At boot it subscribes
      to the configured reply stream with <code>streamOffset: 'next'</code>. Every instance of the service
      sees every reply, but only routes those whose <code>correlation_id</code> starts with
      <code>$&#123;replyPrefix&#125;:</code> to its local pending-replies map. Others are accept-and-dropped
      (advancing the stream cursor).
    </p>
    <p>
      Trade-off: N&times; bandwidth per reply (each instance reads everyone's replies). For low-volume
      request/reply on a LAN, invisible.
    </p>
  `,
})
export class PublishersComponent {}
