import { Component } from '@angular/core';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-parameter-decorators',
  imports: [CodeComponent],
  template: `
    <h2>Parameter decorators</h2>

    <p>
      Order of parameters doesn't matter — resolution is by annotation, not by position. Type names of
      decorator-derived values live alongside the decorator function in the same module, so you
      <code>import &#123; AmqpSettler &#125;</code> for both the decorator and the interface.
    </p>

    <table>
      <thead>
        <tr><th>Decorator</th><th>Type injected</th><th>Source</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><code>&#64;AmqpBody()</code></td>
          <td><code>T</code> (cast at the call site)</td>
          <td><code>codec.decode(message.body)</code></td>
        </tr>
        <tr>
          <td><code>&#64;AmqpAddress()</code></td>
          <td><code>string</code></td>
          <td>The address the <code>&#64;Subscribe</code> was bound to</td>
        </tr>
        <tr>
          <td><code>&#64;AmqpDeliveryCount()</code></td>
          <td><code>number</code></td>
          <td>1-based attempt count (<code>header.delivery_count + 1</code>)</td>
        </tr>
        <tr>
          <td><code>&#64;AmqpHeader()</code></td>
          <td><code>MessageHeader</code></td>
          <td><code>message.header</code> (durable, priority, ttl, …)</td>
        </tr>
        <tr>
          <td><code>&#64;AmqpProperties()</code></td>
          <td><code>MessageProperties</code></td>
          <td>Full <code>message.properties</code></td>
        </tr>
        <tr>
          <td><code>&#64;AmqpProperty(name)</code></td>
          <td><code>string | number | undefined</code></td>
          <td>One field of <code>message.properties</code></td>
        </tr>
        <tr>
          <td><code>&#64;AmqpAppProperties()</code></td>
          <td><code>Record&lt;string, unknown&gt;</code></td>
          <td>Full <code>message.application_properties</code></td>
        </tr>
        <tr>
          <td><code>&#64;AmqpAppProperty(name)</code></td>
          <td><code>unknown</code></td>
          <td>One field of <code>application_properties</code></td>
        </tr>
        <tr>
          <td><code>&#64;AmqpSettler()</code></td>
          <td><code>AmqpSettler</code></td>
          <td><code>&#123; accept, release, reject &#125;</code> — manual settle</td>
        </tr>
        <tr>
          <td><code>&#64;AmqpContext()</code></td>
          <td><code>AmqpContext</code></td>
          <td>Full envelope + settle helpers — the escape hatch</td>
        </tr>
      </tbody>
    </table>

    <h3>Examples</h3>

    <p>Decode the body, log the retry count, look up a custom header:</p>

    <app-code lang="ts">&#64;Subscribe('orders.created', &#123; maxDelivery: 3 &#125;)
onCreated(
  &#64;AmqpBody() order: OrderBody,
  &#64;AmqpDeliveryCount() attempt: number,
  &#64;AmqpAppProperty('tenantId') tenantId: string,
): void &#123;
  this.logger.log(\`order \$&#123;order.id&#125; tenant=\$&#123;tenantId&#125; attempt=\$&#123;attempt&#125;\`);
  this.svc.handle(order);
&#125;</app-code>

    <p>Inspect the full envelope when the granular decorators don't fit:</p>

    <app-code lang="ts">&#64;Subscribe('debug.everything')
onDebug(&#64;AmqpContext() ctx: AmqpContext): void &#123;
  console.log('address', ctx.address);
  console.log('attempt', ctx.deliveryCount);
  console.log('header', ctx.header);
  console.log('properties', ctx.properties);
  console.log('applicationProperties', ctx.applicationProperties);
  // Manual settle helpers also live on ctx:
  ctx.accept();
&#125;</app-code>

    <h3>The AmqpContext interface</h3>

    <app-code lang="ts">interface AmqpContext &#123;
  readonly address: string;
  readonly properties: MessageProperties;
  readonly applicationProperties: Record&lt;string, unknown&gt;;
  readonly header: MessageHeader;
  readonly deliveryCount: number;
  readonly settled: boolean;

  accept(): void;
  release(): void;
  reject(error?: DeliveryRejectError): void;
&#125;</app-code>

    <h3>The AmqpSettler interface</h3>

    <app-code lang="ts">interface AmqpSettler &#123;
  accept(): void;
  release(): void;
  reject(error?: DeliveryRejectError): void;
&#125;</app-code>

    <p>
      A <code>DeliveryRejectError</code> is a <code>&#123; condition: string; description?: string &#125;</code>
      pair matching the AMQP 1.0 error frame. RabbitMQ stores the <em>category</em>
      (<code>'rejected'</code>) on the dead-letter trail but <strong>does not preserve the description</strong> —
      attach an <code>application_property</code> before rejecting if you need richer error context to
      survive to the DLQ.
    </p>
  `,
})
export class ParameterDecoratorsComponent {}
