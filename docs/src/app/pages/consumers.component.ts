import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-consumers',
  imports: [CodeComponent, RouterLink],
  template: `
    <h2>Consumers — &#64;Consume &amp; &#64;Subscribe</h2>

    <p>
      Both decorators are walked by the consumer explorer at module-init: it inspects every provider via
      Nest's <code>DiscoveryService</code>, finds methods carrying the metadata, resolves the target
      broker, validates that every parameter is annotated with an <code>&#64;Amqp*()</code> decorator
      (with one exception — see the implicit-body rule below), and opens a receiver per handler.
    </p>

    <h3>&#64;Consume(address, brokerName?, options?) — work-queue consumer</h3>

    <p>
      Competing-consumer semantic — one message is processed by exactly one consumer. The broker-side
      queue should be <code>x-queue-type: classic</code> or <code>x-queue-type: quorum</code>.
    </p>

    <h4>The 90% case — no retry, no DLQ</h4>

    <app-code lang="ts">&#64;Consume('orders.created')
onCreated(order: OrderBody): void &#123;       // single un-annotated arg = body
  this.svc.handle(order);
&#125;</app-code>

    <p>
      On handler error (throw or <code>Observable.error</code>), the message is
      <code>accept()</code>-ed silently — dropped. That's the safe default: failures don't pile up in the
      queue. If you need retries or DLQ routing, see <a routerLink="/retry-and-dlq">Retry &amp; DLQ</a>.
    </p>

    <h4>Argument forms</h4>

    <app-code lang="ts">&#64;Consume('orders.created')                              // single-broker, defaults
&#64;Consume('orders.created', &#123; maxDelivery: 3 &#125;)         // single-broker, options
&#64;Consume('orders.created', 'primary')                   // multi-broker, defaults
&#64;Consume('orders.created', 'primary', &#123; dlq: true &#125;)  // multi-broker, options</app-code>

    <p>
      The 2nd argument is detected at runtime: a string is a broker name, an object is an options bag.
      <code>brokerName</code> is optional when a single broker is configured.
    </p>

    <h4>Options</h4>

    <table>
      <thead><tr><th>Option</th><th>Default</th><th>Meaning</th></tr></thead>
      <tbody>
        <tr>
          <td><code>maxDelivery</code></td>
          <td><code>1</code></td>
          <td>Total attempts before giving up. <code>1</code> = no retry. Higher: on error,
            <code>delivery.modified(&#123;delivery_failed:true&#125;)</code> until
            <code>deliveryCount &gt;= maxDelivery</code>, then apply <code>dlq</code>. See
            <a routerLink="/retry-and-dlq">Retry &amp; DLQ</a>.</td>
        </tr>
        <tr>
          <td><code>retryPolicy</code></td>
          <td><code>'immediate'</code></td>
          <td>Delay between retries. Currently only <code>'immediate'</code> is functional in 0.2.x;
            <code>fixed</code> / <code>exponential</code> shapes are accepted by the type system for
            forward-compatibility (boot warning + fallback to immediate). See
            <a routerLink="/retry-and-dlq">Retry &amp; DLQ</a>.</td>
        </tr>
        <tr>
          <td><code>dlq</code></td>
          <td><code>false</code></td>
          <td>On final failure: call <code>delivery.reject()</code> so the broker routes via its own DLX
            configuration (<code>true</code>), or <code>accept()</code> and drop silently
            (<code>false</code>). The lib never publishes to a DLQ itself — broker-side DLX setup is
            mandatory if you want the message to land somewhere. See
            <a routerLink="/retry-and-dlq">Retry &amp; DLQ</a>.</td>
        </tr>
        <tr>
          <td><code>maxWindow</code></td>
          <td><code>100</code></td>
          <td>AMQP credit window — max in-flight unsettled messages.</td>
        </tr>
      </tbody>
    </table>

    <h3>&#64;Subscribe(address, brokerName?, options?) — topic consumer</h3>

    <p>
      Broadcast / pub-sub semantic — every connected consumer receives every message. The broker-side
      queue MUST be <code>x-queue-type: stream</code>. The library attaches with
      <code>rabbitmq:stream-offset-spec: 'next'</code> (JMS topic-like: messages produced while
      disconnected are lost from the consumer's perspective).
    </p>

    <app-code lang="ts">&#64;Subscribe('changes.bulletin')
onBulletinChanged(change: BulletinChange): void &#123;
  this.realtimeBus.publish(change);
&#125;</app-code>

    <p>Options:</p>

    <table>
      <thead><tr><th>Option</th><th>Default</th><th>Meaning</th></tr></thead>
      <tbody>
        <tr>
          <td><code>maxWindow</code></td>
          <td><code>100</code></td>
          <td>AMQP credit window. Same meaning as for <code>&#64;Consume</code>.</td>
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
      If the handler returns a value (sync) or an <code>Observable</code> that <code>next</code>s, and
      the message has <code>reply_to</code>, the value is encoded and sent on <code>reply_to</code> with
      the original <code>correlation_id</code>. No code in the handler needed — the framework correlates
      automatically. This is the consume-side of <a routerLink="/request-reply">Request / reply</a>.
    </p>

    <app-code lang="ts">&#64;Consume('queries.balance')
onBalance(q: BalanceQuery): Observable&lt;BalanceResponse&gt; &#123;
  return of(&#123; amount: 42 &#125;);   // -&gt; auto-shipped on q.reply_to
&#125;</app-code>

    <h3>Manual settle — &#64;AmqpSettler</h3>

    <p>Calling any method on the injected settler suppresses the framework's automatic policy:</p>

    <app-code lang="ts">&#64;Consume('payments.process', &#123; maxDelivery: 5, dlq: true &#125;)
onPayment(
  body: Payment,
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
          <td><code>delivery.reject()</code> — broker routes via DLX if configured</td>
          <td>Definitive business failure (validation, schema mismatch) — bypasses <code>maxDelivery</code></td>
        </tr>
      </tbody>
    </table>

    <p>
      <code>reject()</code> differs from <code>throw</code>: <code>throw</code> follows the configured
      <code>maxDelivery</code>/<code>dlq</code> policy; <code>reject()</code> is
      <strong>immediate</strong> regardless of remaining attempts.
    </p>

    <h3>Boot-time validation — the implicit-body rule</h3>

    <p>
      To keep the dominant case (one body argument) ergonomic, exactly <strong>one un-annotated
      parameter is allowed</strong> per handler and is bound as if you had written
      <code>&#64;AmqpBody()</code>. Anything else throws at boot — never silently at runtime.
      The rule:
    </p>

    <table>
      <thead><tr><th>Situation</th><th>Behaviour</th></tr></thead>
      <tbody>
        <tr>
          <td>All parameters annotated</td>
          <td>Pass through — used as declared.</td>
        </tr>
        <tr>
          <td>Exactly 1 un-annotated parameter</td>
          <td>Treated as <code>&#64;AmqpBody()</code> implicitly.</td>
        </tr>
        <tr>
          <td>2+ un-annotated parameters</td>
          <td><strong>Throws</strong> — ambiguous (which one is the body?).</td>
        </tr>
        <tr>
          <td>1 un-annotated + an explicit <code>&#64;AmqpBody()</code> elsewhere</td>
          <td><strong>Throws</strong> — mixed styles refused. Pick one.</td>
        </tr>
      </tbody>
    </table>

    <p>Both forms below are valid and equivalent:</p>

    <app-code lang="ts">// Implicit — the single argument is bound as the body
&#64;Consume('orders.created')
onCreated(order: OrderBody): void &#123;
  this.svc.handle(order);
&#125;

// Explicit — same effect, more verbose
&#64;Consume('orders.created')
onCreated(&#64;AmqpBody() order: OrderBody): void &#123;
  this.svc.handle(order);
&#125;</app-code>

    <h3>Boot log — see what wired up where</h3>

    <p>At boot, the consumer explorer prints one line per broker listing the bound handlers:</p>

    <app-code lang="text">[AmqpConsumerExplorer] broker 'primary': 2 consumer(s)
[AmqpConsumerExplorer]   - &#64;Consume orders.create -&gt; OrdersListener.onCreate
[AmqpConsumerExplorer]   - &#64;Consume payments.process -&gt; PaymentListener.onPayment
[AmqpConsumerExplorer] broker 'analytics': 1 consumer(s)
[AmqpConsumerExplorer]   - &#64;Subscribe events.tick -&gt; TickListener.onTick</app-code>

    <p>
      Each line is tagged with the decorator flavour (<code>&#64;Consume</code> = work-queue,
      <code>&#64;Subscribe</code> = topic). Verify that the topology your code expects matches the
      brokers you connected to. If a broker reports "no consumers" but you wrote some, double-check
      the broker name on your decorators.
    </p>
  `,
})
export class ConsumersComponent {}
