import { Component } from '@angular/core';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-getting-started',
  imports: [CodeComponent],
  template: `
    <h2>Getting started</h2>

    <p>
      <strong>&#64;softwarity/nestjs-amqp</strong> wraps the canonical
      <a href="https://github.com/amqp/rhea" target="_blank" rel="noopener">rhea</a> AMQP 1.0 client behind a
      decorator-based NestJS API. You declare queues and topics, annotate methods with
      <code>&#64;Subscribe</code> / <code>&#64;SubscribeTopic</code>, and the library handles connection,
      reconnect, settle policy, retries, DLQ routing, and reply correlation for you.
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
      <li>Brokers: RabbitMQ 4.x, ActiveMQ Artemis, Apache Qpid, Azure Service Bus</li>
    </ul>

    <h3>Installation</h3>
    <app-code lang="bash">npm install &#64;softwarity/nestjs-amqp rhea</app-code>

    <p>Peer deps you most likely already have:</p>
    <app-code lang="bash">npm install &#64;nestjs/common &#64;nestjs/core rxjs reflect-metadata</app-code>

    <h3>Register the module</h3>

    <app-code lang="ts">import &#123; Module &#125; from '&#64;nestjs/common';
import &#123; AmqpModule &#125; from '&#64;softwarity/nestjs-amqp';

&#64;Module(&#123;
  imports: [
    AmqpModule.forRoot(&#123;
      appName: 'my-service',
      url: 'amqp://localhost:5672',
      username: 'guest',
      password: 'guest',
    &#125;),
  ],
&#125;)
export class AppModule &#123;&#125;</app-code>

    <p>
      <code>appName</code> drives sensible defaults: the shared reply stream becomes
      <code>my-service.replies</code>, the default DLQ address becomes <code>my-service.dlq</code>, and the
      AMQP container ID identifies your service on the broker. All three can be overridden in the options.
    </p>

    <h3>Publish</h3>

    <app-code lang="ts">import &#123; Injectable &#125; from '&#64;nestjs/common';
import &#123; AmqpQueue &#125; from '&#64;softwarity/nestjs-amqp';

&#64;Injectable()
export class OrdersService &#123;
  &#64;AmqpQueue('orders.create')
  private readonly orders!: AmqpQueue;

  create(body: OrderBody): void &#123;
    this.orders.emit(body);                       // fire-and-forget
  &#125;

  confirm(body: OrderBody): Observable&lt;Confirmation&gt; &#123;
    return this.orders.send&lt;Confirmation&gt;(body); // request/reply
  &#125;
&#125;</app-code>

    <h3>Consume</h3>

    <app-code lang="ts">import &#123; Injectable &#125; from '&#64;nestjs/common';
import &#123; Subscribe, AmqpBody &#125; from '&#64;softwarity/nestjs-amqp';

&#64;Injectable()
export class OrdersListener &#123;
  &#64;Subscribe('orders.create')
  onCreate(&#64;AmqpBody() order: OrderBody): void &#123;
    this.svc.handle(order);
  &#125;
&#125;</app-code>

    <div class="callout">
      Use the sidebar to navigate to <strong>Configuration</strong>, <strong>Publishers</strong>,
      <strong>Consumers</strong>, <strong>Parameter decorators</strong>, <strong>Wire codec</strong>,
      <strong>DLQ browser</strong>, and <strong>Errors &amp; lifecycle</strong>.
    </div>

    <h3>RabbitMQ topology — pre-declared, not created at runtime</h3>
    <p>
      This library never calls the broker Management API. Queues, streams, exchanges, and DLX bindings live
      in your broker definitions (typically a mounted <code>definitions.json</code> for RabbitMQ). The app
      boots, connects, opens senders and receivers — nothing else.
    </p>
    <p>
      Minimum recommended topology for full feature use:
    </p>
    <ul>
      <li>Quorum or classic queues for each <code>&#64;Subscribe</code> address, with a DLX if you set
        <code>dlq: true</code>.</li>
      <li>A <strong>stream queue</strong> for the shared reply destination (<code>&#64;Subscribe</code> /
        <code>&#64;SubscribeTopic</code> defaults: <code>&lt;appName&gt;.replies</code>).</li>
      <li>One or more stream queues for <code>&#64;SubscribeTopic</code> broadcast addresses.</li>
      <li>One catch-all DLQ (typically quorum) referenced by the DLX.</li>
    </ul>
  `,
})
export class GettingStartedComponent {}
