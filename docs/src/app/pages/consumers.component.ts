import { Component } from '@angular/core';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-consumers',
  imports: [CodeComponent],
  template: `
    <h2>Consumers — &#64;Subscribe &amp; &#64;SubscribeTopic</h2>

    <p>
      Both decorators are walked by the consumer explorer at module-init: it inspects every provider via
      Nest's <code>DiscoveryService</code>, finds methods carrying the metadata, validates that every
      parameter is annotated with an <code>&#64;Amqp*()</code> decorator (throws at boot otherwise), and
      opens a receiver per handler.
    </p>

    <h3>&#64;Subscribe(address, options?) — work-queue consumer</h3>

    <p>
      Competing-consumer semantic — one message is processed by exactly one consumer. The broker-side
      queue should be <code>x-queue-type: classic</code> or <code>x-queue-type: quorum</code>.
    </p>

    <app-code lang="ts">&#64;Subscribe('orders.created')
onCreated(&#64;AmqpBody() order: OrderBody): void &#123;
  this.svc.handle(order);
&#125;</app-code>

    <p>With retries and DLQ:</p>

    <app-code lang="ts">&#64;Subscribe('payments.process', &#123; maxDelivery: 5, dlq: true &#125;)
onPayment(
  &#64;AmqpBody() body: Payment,
  &#64;AmqpDeliveryCount() count: number,
&#125;): Observable&lt;Result&gt; &#123;
  if (count &gt; 1) this.logger.warn(\`retry #\$&#123;count&#125; for payment \$&#123;body.id&#125;\`);
  return this.svc.process(body);
&#125;</app-code>

    <p>Options:</p>

    <table>
      <thead><tr><th>Option</th><th>Default</th><th>Meaning</th></tr></thead>
      <tbody>
        <tr>
          <td><code>maxDelivery</code></td>
          <td><code>1</code></td>
          <td>Total attempts before giving up. <code>1</code> = no retry. Higher: on error,
            <code>delivery.modified(&#123;delivery_failed:true&#125;)</code> until
            <code>deliveryCount &gt;= maxDelivery</code>, then apply <code>dlq</code>.</td>
        </tr>
        <tr>
          <td><code>dlq</code></td>
          <td><code>false</code></td>
          <td>On final failure: route to broker DLX (<code>true</code>) or <code>accept()</code> and drop
            silently (<code>false</code>).</td>
        </tr>
        <tr>
          <td><code>maxWindow</code></td>
          <td><code>100</code></td>
          <td>AMQP credit window — max in-flight unsettled messages.</td>
        </tr>
      </tbody>
    </table>

    <h3>&#64;SubscribeTopic(address, options?) — topic consumer</h3>

    <p>
      Broadcast / pub-sub semantic — every connected consumer receives every message. The broker-side
      queue MUST be <code>x-queue-type: stream</code>. The library attaches with
      <code>rabbitmq:stream-offset-spec: 'next'</code> (JMS topic-like: messages produced while
      disconnected are lost from the consumer's perspective).
    </p>

    <app-code lang="ts">&#64;SubscribeTopic('changes.bulletin')
onBulletinChanged(&#64;AmqpBody() change: BulletinChange): void &#123;
  this.realtimeBus.publish(change);
&#125;</app-code>

    <p>Options:</p>

    <table>
      <thead><tr><th>Option</th><th>Default</th><th>Meaning</th></tr></thead>
      <tbody>
        <tr>
          <td><code>maxWindow</code></td>
          <td><code>100</code></td>
          <td>AMQP credit window. Same meaning as for <code>&#64;Subscribe</code>.</td>
        </tr>
      </tbody>
    </table>

    <div class="callout">
      <strong>Why no <code>maxDelivery</code> / <code>dlq</code> for topics?</strong> Streams don't
      redeliver via the classic <code>modified(delivery_failed: true)</code> mechanism — they're
      append-only logs, the offset just advances past failed messages. And there's no DLX binding for
      streams. If a stream handler errors, the framework <code>accept()</code>s to advance the offset
      (drop the message). Handle retries in application code if needed.
    </div>

    <h3>Auto-reply on return value</h3>

    <p>
      If the handler returns a value (sync) or an <code>Observable</code> that <code>next</code>s, and the
      message has <code>reply_to</code>, the value is JSON-encoded and sent on <code>reply_to</code> with
      the original <code>correlation_id</code>. No code in the handler needed — the framework correlates
      automatically.
    </p>

    <app-code lang="ts">&#64;Subscribe('queries.balance')
onBalance(&#64;AmqpBody() q: BalanceQuery): Observable&lt;BalanceResponse&gt; &#123;
  return of(&#123; amount: 42 &#125;);   // -&gt; auto-shipped on q.reply_to
&#125;</app-code>

    <h3>Manual settle — &#64;AmqpSettler</h3>

    <p>
      Calling any method on the injected settler suppresses the framework's automatic policy:
    </p>

    <app-code lang="ts">&#64;Subscribe('payments.process', &#123; maxDelivery: 5, dlq: true &#125;)
onPayment(
  &#64;AmqpBody() body: Payment,
  &#64;AmqpSettler() settle: AmqpSettler,
): Observable&lt;Result&gt; &#123;
  if (body.amount &lt; 0) &#123;
    settle.reject(&#123;
      condition: 'amqp:precondition-failed',
      description: 'negative amount'
    &#125;);
    return EMPTY;
  &#125;
  return this.svc.process(body);
&#125;</app-code>

    <table>
      <thead><tr><th>Method</th><th>Broker action</th><th>When</th></tr></thead>
      <tbody>
        <tr>
          <td><code>settle.accept()</code></td>
          <td>Remove from queue (consumed)</td>
          <td>Idempotency check — you've already done this work, no point retrying or DLQ-ing</td>
        </tr>
        <tr>
          <td><code>settle.release()</code></td>
          <td>Return to queue, no <code>delivery_count++</code></td>
          <td>"Not for me, let someone else try" (rare, poison-loop risk)</td>
        </tr>
        <tr>
          <td><code>settle.reject(err)</code></td>
          <td>Route to DLX immediately</td>
          <td>Definitive business failure (validation, schema mismatch) — bypasses <code>maxDelivery</code></td>
        </tr>
      </tbody>
    </table>

    <p>
      <code>reject()</code> differs from <code>throw</code>: <code>throw</code> follows the configured
      <code>maxDelivery</code>/<code>dlq</code> policy; <code>reject()</code> is
      <strong>immediate DLQ regardless</strong> of remaining attempts.
    </p>

    <h3>Boot-time validation</h3>

    <p>
      Every parameter of every <code>&#64;Subscribe</code> handler must be annotated with one of the
      <code>&#64;Amqp*()</code> parameter decorators. Un-annotated parameters throw at boot:
    </p>

    <app-code lang="text">Error: &#64;Subscribe handler OrdersListener.onCreated has an un-annotated parameter
at index 0. Use &#64;AmqpBody() / &#64;AmqpContext() / &#64;AmqpSettler() /
&#64;AmqpDeliveryCount() / etc.</app-code>

    <p>This is intentional: handlers are explicit, no implicit positional binding.</p>
  `,
})
export class ConsumersComponent {}
