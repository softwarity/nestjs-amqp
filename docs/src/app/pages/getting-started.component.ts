import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-getting-started',
  imports: [CodeComponent, RouterLink],
  template: `
    <h2>Getting started — the 90% case</h2>

    <p>
      <strong>&#64;softwarity/nestjs-amqp</strong> wraps the canonical
      <a href="https://github.com/amqp/rhea" target="_blank" rel="noopener">rhea</a> AMQP 1.0 client behind a
      decorator-based NestJS API. This page shows the simplest, most common setup: <strong>one broker,
      fire-and-forget publish, basic consume — no DLQ, no request/reply</strong>. Declare as many queues
      and topics as you need; the simplicity here is about the feature surface, not the quantity.
      Reply/DLQ are opt-in features documented on their own pages.
    </p>

    <div class="callout">
      <strong>Why not <code>&#64;nestjs/microservices</code>?</strong> Because it ships only the AMQP 0.9.1
      transport (via <code>amqplib</code>). This library targets AMQP 1.0 — long-lived sessions, link credit,
      source filters, message annotations, stream consumers. None of these have an equivalent in 0.9.1.
    </div>

    <h3>Compatibility</h3>
    <ul>
      <li>Node.js &ge; 20</li>
      <li>NestJS &ge; 10 (tested with 10 and 11)</li>
      <li>Brokers: RabbitMQ 4.x, ActiveMQ Artemis, Apache Qpid</li>
    </ul>

    <h3>1. Install</h3>
    <app-code lang="bash">npm install &#64;softwarity/nestjs-amqp rhea</app-code>
    <p>Peer deps you most likely already have:</p>
    <app-code lang="bash">npm install &#64;nestjs/common &#64;nestjs/core rxjs reflect-metadata</app-code>

    <h3>2. Declare your queues and topics broker-side</h3>
    <p>
      The library never declares topology at runtime — it only opens senders and receivers on destinations
      that <strong>already exist</strong>. Declare whatever your service needs (one queue, ten queues,
      mixed work-queues and broadcast streams — same exercise). With RabbitMQ 4.x via
      <code>definitions.json</code>:
    </p>
    <app-code lang="json">&#123;
  "queues": [
    &#123;
      "name": "orders.create",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": &#123; "x-queue-type": "quorum" &#125;
    &#125;,
    &#123;
      "name": "orders.ship",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": &#123; "x-queue-type": "quorum" &#125;
    &#125;,
    &#123;
      "name": "changes.bulletin",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": &#123; "x-queue-type": "stream", "x-max-age": "1h" &#125;
    &#125;
  ]
&#125;</app-code>
    <p>
      Quorum queues for work-queue semantics (one consumer per message), stream queues for broadcast
      semantics (every consumer sees every message). The library makes no assumption about how many you
      declare. Full topology examples for every supported broker on the
      <a routerLink="/broker-topology">Broker topology</a> page.
    </p>

    <h3>3. Register the module</h3>
    <app-code lang="ts">import &#123; Module &#125; from '&#64;nestjs/common';
import &#123; AmqpModule &#125; from '&#64;softwarity/nestjs-amqp';

&#64;Module(&#123;
  imports: [
    AmqpModule.forRoot(&#123;
      url: 'amqp://localhost:5672',
      username: 'guest',
      password: 'guest',
    &#125;),
  ],
&#125;)
export class AppModule &#123;&#125;</app-code>

    <p>
      A single broker (the name is implicit — internally <code>'default'</code>). Because only one
      broker is configured, the <code>brokerName</code> argument is optional on every decorator and on
      the locator — the library resolves the lone broker automatically. If you want a custom name
      (visible as the AMQP container ID on the broker management UI), wrap in an array even with a
      single entry: <code>AmqpModule.forRoot([&#123; name: 'my-svc', url, ... &#125;])</code>. For
      multi-broker setups, see <a routerLink="/multi-broker">Multi-broker</a>.
    </p>

    <h3>4. Publish — fire and forget</h3>

    <app-code lang="ts">import &#123; Injectable &#125; from '&#64;nestjs/common';
import &#123; AmqpQueue, AmqpTopic &#125; from '&#64;softwarity/nestjs-amqp';

&#64;Injectable()
export class OrdersService &#123;
  &#64;AmqpQueue('orders.create')
  private readonly create!: AmqpQueue&lt;OrderBody&gt;;

  &#64;AmqpQueue('orders.ship')
  private readonly ship!: AmqpQueue&lt;OrderShipped&gt;;

  &#64;AmqpTopic('changes.bulletin')
  private readonly changes!: AmqpTopic&lt;BulletinChange&gt;;

  newOrder(body: OrderBody): void &#123;
    this.create.emit(body);                       // fire-and-forget
  &#125;

  notifyShipped(body: OrderShipped): void &#123;
    this.ship.emit(body);
    this.changes.emit(&#123; type: 'shipped', orderId: body.id, when: new Date().toISOString() &#125;);
  &#125;
&#125;</app-code>

    <p>
      <code>&#64;AmqpQueue</code> for work-queues (point-to-point) and <code>&#64;AmqpTopic</code> for
      broadcast. <code>emit()</code> returns synchronously a <code>boolean</code> — <code>true</code> if
      the message was handed off to the sender, <code>false</code> if the broker is disabled or not
      connected (caller can then fall back to an in-process bus, a local outbox, etc. — see the
      <a routerLink="/publishers">Publishers</a> page for the pattern). Each handle is generic on the
      payload type — every call site is type-checked at compile time.
    </p>

    <h3>5. Consume</h3>

    <app-code lang="ts">import &#123; Injectable &#125; from '&#64;nestjs/common';
import &#123; Consume, Subscribe &#125; from '&#64;softwarity/nestjs-amqp';

&#64;Injectable()
export class OrdersListener &#123;
  // The single un-annotated argument is bound to the JSON-decoded body.
  // Equivalent to writing &#64;AmqpBody() explicitly.
  &#64;Consume('orders.create')
  onCreate(order: OrderBody): void &#123;
    this.svc.handle(order);
  &#125;

  &#64;Consume('orders.ship')
  onShip(shipped: OrderShipped): void &#123;
    this.svc.markShipped(shipped);
  &#125;

  &#64;Subscribe('changes.bulletin')
  onChange(change: BulletinChange): void &#123;
    this.realtime.publish(change);
  &#125;
&#125;</app-code>

    <p>
      Start the app — you'll see a boot log section like
      <code>broker 'default': 3 consumer(s)</code> followed by one line per binding (each tagged
      <code>&#64;Consume</code> or <code>&#64;Subscribe</code>). You're
      done.
    </p>

    <h3>What's NOT in the 90% case</h3>
    <p>The bootstrap above intentionally skips three optional features. Add them à la carte as needed:</p>
    <table>
      <thead><tr><th>Feature</th><th>What you gain</th><th>What you have to do</th></tr></thead>
      <tbody>
        <tr>
          <td><a routerLink="/request-reply">Request / reply (<code>send()</code>)</a></td>
          <td>Wait for a reply Observable on a published message — RPC-style.</td>
          <td>Declare a stream queue broker-side, add <code>replyStreamAddress</code> to the broker config.</td>
        </tr>
        <tr>
          <td><a routerLink="/retry-and-dlq">Retry &amp; DLQ</a></td>
          <td>Auto-retry on handler error, then route the failed message to a DLQ for human inspection.</td>
          <td>Declare a DLX + DLQ broker-side, set <code>&#123; maxDelivery, dlq: true &#125;</code> on the decorator.</td>
        </tr>
        <tr>
          <td><a routerLink="/multi-broker">Multiple brokers</a></td>
          <td>Speak to several brokers from one service (e.g. primary + analytics).</td>
          <td>Pass an array to <code>forRoot</code>, pass <code>brokerName</code> on each decorator.</td>
        </tr>
      </tbody>
    </table>

    <h3>What's next</h3>
    <p>
      Read <a routerLink="/configuration">Configuration</a> for the full option reference,
      <a routerLink="/publishers">Publishers</a> and <a routerLink="/consumers">Consumers</a> for the
      decorator details, or <a routerLink="/broker-topology">Broker topology</a> for full IaC examples on
      RabbitMQ 4.x, Artemis, and Qpid.
    </p>
  `,
})
export class GettingStartedComponent {}
