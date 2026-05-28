import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-retry-and-dlq',
  imports: [CodeComponent, RouterLink],
  template: `
    <h2>Retry &amp; DLQ</h2>

    <p>
      An opt-in feature for <code>&#64;Consume</code> handlers. Retry and DLQ are off by default
      (<code>maxDelivery: 1</code>, <code>dlq: false</code>) — handler errors silently drop the message.
      Enable them when you want failed messages to be retried and, after exhausting retries, routed to a
      DLQ for human inspection.
    </p>

    <div class="callout">
      <strong>The lib never publishes to a DLQ itself.</strong> On terminal failure with
      <code>dlq: true</code>, the lib calls <code>delivery.reject()</code> with an AMQP error and the
      <strong>broker</strong> routes the message via its own DLX configuration. If you forget to declare
      a DLX broker-side, <code>dlq: true</code> is silently ignored (the broker discards rejected
      messages with no DLX). The boot log will warn if you set <code>dlq: true</code> on a broker that
      has no <code>defaultDlqAddress</code>.
    </div>

    <h3>What the policy does</h3>

    <p>For each delivery, the framework reads the AMQP <code>header.delivery_count</code> field (the
       broker increments it on each redelivery) and applies:</p>

    <app-code lang="text">handler throws or Observable.error fires
                  |
                  v
   ctx.settled === true (manual settle via &#64;AmqpSettler) ?
        |              |
       yes             no
        |              |
        v              v
    do nothing   deliveryCount &lt; maxDelivery ?
                       |            |
                      yes           no
                       |            |
                       v            v
              modified(failed)  dlq === true ?
                                   |       |
                                  yes      no
                                   |       |
                                   v       v
                                reject() accept()
                                  |
                                  v
                         broker routes via its DLX
                         (if declared broker-side)</app-code>

    <h3>Setup — full example with RabbitMQ 4.x</h3>

    <h4>1. Declare DLX + DLQ broker-side</h4>

    <app-code lang="json">&#123;
  "exchanges": [
    &#123;
      "name": "my-service.dlx",
      "vhost": "/",
      "type": "direct",
      "durable": true,
      "auto_delete": false,
      "internal": false
    &#125;
  ],

  "queues": [
    &#123;
      "name": "payments.process",
      "vhost": "/",
      "durable": true,
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
      "arguments": &#123; "x-queue-type": "quorum" &#125;
    &#125;
  ],

  "bindings": [
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

    <p>
      The recipe: each consumed queue carries <code>x-dead-letter-exchange</code> +
      <code>x-dead-letter-routing-key</code>. A direct exchange routes rejected messages to a single
      catch-all DLQ via per-origin routing keys.
    </p>

    <h4>2. Set <code>defaultDlqAddress</code> on the broker options</h4>

    <p>Optional but recommended — the DLQ admin UI uses it as the pre-fill value.</p>

    <app-code lang="ts">AmqpModule.forRoot(&#123;
  url: 'amqp://localhost:5672',
  username: '...', password: '...',
  defaultDlqAddress: 'my-service.dlq',   // ← shown in DLQ admin UI
&#125;)</app-code>

    <h4>3. Enable the policy on the decorator</h4>

    <app-code lang="ts">&#64;Consume('payments.process', &#123; maxDelivery: 5, dlq: true &#125;)
onPayment(
  body: Payment,
  &#64;AmqpDeliveryCount() count: number,
): Observable&lt;Result&gt; &#123;
  if (count &gt; 1) this.logger.warn(\`retry #\$&#123;count&#125; for payment \$&#123;body.id&#125;\`);
  return this.svc.process(body);
&#125;</app-code>

    <p>Run-time behaviour:</p>
    <ul>
      <li><code>count = 1</code> (first delivery), handler throws → <code>modified()</code>, broker
        redelivers with <code>delivery_count: 2</code></li>
      <li><code>count = 2..4</code>, handler throws → <code>modified()</code> again</li>
      <li><code>count = 5</code>, handler throws → <code>reject()</code> → broker routes to
        <code>my-service.dlx</code> with routing key <code>payments.process</code> →
        <code>my-service.dlq</code></li>
    </ul>

    <h3>Without DLX broker-side</h3>

    <p>If you set <code>dlq: true</code> but the queue has no <code>x-dead-letter-exchange</code>:</p>
    <ul>
      <li>The lib still <code>reject()</code>s on the final attempt</li>
      <li>The broker has no DLX → it <strong>silently discards</strong> the rejected message</li>
      <li>Identical visible effect to <code>dlq: false</code> — both lose the message</li>
    </ul>
    <p>
      The boot log warns you when you enable <code>dlq: true</code> on a broker with no
      <code>defaultDlqAddress</code> configured — that's a strong indicator the broker-side topology may
      be missing.
    </p>

    <h3>retryPolicy — delayed retries (in 0.3.x)</h3>

    <p>
      The decorator accepts a <code>retryPolicy</code> option that defines the timing between retries.
      <strong>In 0.2.x only <code>'immediate'</code> is functional</strong> — the other shapes
      (<code>fixed</code> / <code>exponential</code>) are accepted by the type system but the runtime
      falls back to immediate with a boot warning. Client-side scheduled republish is planned for the
      0.3.x release.
    </p>

    <app-code lang="ts">type RetryPolicy =
  | 'immediate'
  | &#123; kind: 'fixed';       delayMs: number &#125;
  | &#123; kind: 'exponential'; initialMs: number; multiplier: number; maxMs: number &#125;;

// Today (0.2.x): functional
&#64;Consume('payments.process', &#123; maxDelivery: 5, retryPolicy: 'immediate', dlq: true &#125;)

// Tomorrow (0.3.x): also functional. Declare it now — it'll start working
// automatically when the runtime support lands. 0.2.x logs a warning at boot
// and falls back to 'immediate'.
&#64;Consume('payments.process', &#123;
  maxDelivery: 5,
  retryPolicy: &#123; kind: 'exponential', initialMs: 1000, multiplier: 2, maxMs: 60_000 &#125;,
  dlq: true,
&#125;)</app-code>

    <h4>What 'immediate' really means today</h4>

    <p>
      <code>retryPolicy: 'immediate'</code> calls
      <code>delivery.modified(&#123;delivery_failed:true&#125;)</code> and the broker redelivers as soon
      as it can. The actual timing of the redelivery is then a <strong>broker-side concern</strong>:
    </p>

    <table>
      <thead><tr><th>Broker</th><th>Built-in redelivery delay?</th><th>How to configure</th></tr></thead>
      <tbody>
        <tr>
          <td>ActiveMQ Artemis</td>
          <td>✅ Native</td>
          <td><code>&lt;redelivery-delay&gt;</code> + <code>&lt;redelivery-delay-multiplier&gt;</code> on the address-setting</td>
        </tr>
        <tr>
          <td>RabbitMQ</td>
          <td>❌ Immediate</td>
          <td>Topology workaround: TTL retry queue or <code>rabbitmq_delayed_message_exchange</code> plugin</td>
        </tr>
        <tr>
          <td>Azure Service Bus</td>
          <td>❌ Immediate (on abandon)</td>
          <td>Custom scheduled-send pattern</td>
        </tr>
        <tr>
          <td>Qpid</td>
          <td>❌ Immediate</td>
          <td>—</td>
        </tr>
      </tbody>
    </table>

    <p>
      <strong>If you're on Artemis</strong>, configure <code>redelivery-delay</code> broker-side and the
      retry timing you want is achieved with no client code.
      <strong>If you're on RabbitMQ / Azure SB / Qpid</strong>, retries with
      <code>retryPolicy: 'immediate'</code> hammer your handler in a tight loop — which is exactly when
      <code>retryPolicy: 'exponential'</code> (coming in 0.3.x) will become useful.
    </p>

    <h3>Manual settle bypasses the policy</h3>

    <p>
      If your handler decides the failure is definitive (validation error, schema mismatch, business
      precondition unmet), use <code>&#64;AmqpSettler</code> to <code>reject()</code> immediately —
      bypasses the retry counter and goes straight to DLX:
    </p>

    <app-code lang="ts">&#64;Consume('payments.process', &#123; maxDelivery: 5, dlq: true &#125;)
onPayment(body: Payment, &#64;AmqpSettler() settle: AmqpSettler): Observable&lt;Result&gt; &#123;
  if (body.amount &lt; 0) &#123;
    settle.reject(&#123; condition: 'amqp:precondition-failed', description: 'negative amount' &#125;);
    return EMPTY;
  &#125;
  return this.svc.process(body);
&#125;</app-code>

    <h3>Once messages land in the DLQ — browsing &amp; replaying</h3>

    <p>
      See the <a routerLink="/dlq-browser">DLQ browser</a> page for the programmatic API and the optional
      HTTP module that lets an operator inspect, replay or drop dead-lettered messages from an admin UI.
    </p>
  `,
})
export class RetryAndDlqComponent {}
