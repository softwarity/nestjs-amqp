import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-confirmed-publish',
  imports: [CodeComponent, RouterLink],
  template: `
    <h2>Confirmed publish — <code>emitConfirmed()</code></h2>

    <p>
      <strong><code>emit()</code> — I don't want to know. <code>emitConfirmed()</code> — tell me what
      the broker did with it.</strong>
    </p>

    <p>
      <code>emit()</code> returns as soon as the message is handed to the sender, so a message no queue
      is bound to leaves without a trace — the most common topology mistake there is.
      <code>emitConfirmed()</code> publishes the same way but returns an <code>Observable</code> that
      completes only once the broker <strong>accepted</strong> the delivery, and errors with an
      <code>AmqpPublishError</code> otherwise.
    </p>

    <p>
      Nothing broker-side to declare, no consumer needed: the verdict is an AMQP 1.0
      <em>disposition</em> the broker sends back on the link.
    </p>

    <app-code lang="ts">import &#123; Injectable &#125; from '&#64;nestjs/common';
import &#123; Observable &#125; from 'rxjs';
import &#123; AmqpQueue, AmqpPublishError &#125; from '&#64;softwarity/nestjs-amqp';

&#64;Injectable()
export class TriggerPublisher &#123;
  &#64;AmqpQueue('tasks.trigger')
  private readonly triggers!: AmqpQueue&lt;TriggerBody&gt;;

  // Completes = the broker has the message. Only then do we move the
  // schedule forward — no trigger is ever silently lost.
  fire(trigger: TriggerBody): Observable&lt;void&gt; &#123;
    return this.triggers.emitConfirmed(trigger);
  &#125;
&#125;</app-code>

    <app-code lang="ts">this.triggers.emitConfirmed(trigger).subscribe(&#123;
  next: () =&gt; this.schedule.advanceDueDate(trigger.id),   // safe: the broker took it
  error: (err: AmqpPublishError) =&gt; this.logger.error(\`\$&#123;err.outcome&#125;: \$&#123;err.message&#125;\`),
&#125;);</app-code>

    <h3>Not the same thing as send()</h3>

    <p>
      The confusion to defuse: <code>emitConfirmed()</code> waits for a <strong>delivery verdict</strong>
      from the <em>broker</em>; <a routerLink="/request-reply"><code>send()</code></a> waits for an
      <strong>application reply</strong> from <em>your consumer</em>.
    </p>

    <table>
      <thead><tr><th>Method</th><th>Waits for</th><th>Resolves when</th><th>Needs</th></tr></thead>
      <tbody>
        <tr>
          <td><code>emit()</code></td>
          <td>nothing — returns a <code>boolean</code> synchronously</td>
          <td>the message was handed to the sender</td>
          <td>—</td>
        </tr>
        <tr>
          <td><code>emitConfirmed()</code></td>
          <td>a <strong>delivery verdict</strong> from the broker</td>
          <td>the broker took responsibility for the message</td>
          <td>—</td>
        </tr>
        <tr>
          <td><code>send()</code></td>
          <td>an <strong>application reply</strong> from a consumer</td>
          <td>your handler returned a value</td>
          <td><code>replyStreamAddress</code> + a consumer</td>
        </tr>
      </tbody>
    </table>

    <div class="callout">
      <strong>Accepted is not processed.</strong> <code>accepted</code> means the broker durably owns
      the message — on a quorum queue, a majority of replicas wrote it to disk. It says nothing about a
      consumer having handled it. If you need the business outcome, that's <code>send()</code>.
    </div>

    <h3>What the broker's verdicts mean</h3>

    <table>
      <thead><tr><th>Outcome</th><th>Meaning (RabbitMQ)</th><th>Result</th></tr></thead>
      <tbody>
        <tr>
          <td><code>accepted</code></td>
          <td>every target queue took the message — on a quorum queue, a majority of replicas wrote it
            to disk</td>
          <td><strong>completes</strong></td>
        </tr>
        <tr>
          <td><code>released</code></td>
          <td>the message was routed to <strong>no</strong> queue: the address resolved but nothing
            downstream took it, typically an exchange with no matching binding</td>
          <td>errors, <code>outcome: 'released'</code></td>
        </tr>
        <tr>
          <td><code>rejected</code></td>
          <td>a target queue refused it: length limit reached, classic queue unavailable</td>
          <td>errors, <code>outcome: 'rejected'</code>, AMQP <code>condition</code> carried</td>
        </tr>
        <tr>
          <td><code>modified</code></td>
          <td>the broker asked for the message to be changed before redelivery — RabbitMQ doesn't use
            it publisher-side today</td>
          <td>errors, <code>outcome: 'modified'</code></td>
        </tr>
      </tbody>
    </table>

    <p>
      <code>released</code> and <code>rejected</code> are also logged at <code>warn</code> level by the
      library, whichever method published the message — so a wrong routing key shows up in the logs
      even when the publisher used <code>emit()</code>.
    </p>

    <h3>Three failures that never reach the broker</h3>

    <p>
      Reported through the same error, so a caller can never mistake them for a success:
    </p>

    <table>
      <thead><tr><th>Outcome</th><th>When</th></tr></thead>
      <tbody>
        <tr>
          <td><code>unsent</code></td>
          <td>broker disabled (<code>enabled: false</code>), connection not open, or the link itself
            failed (unknown address, revoked permission)</td>
        </tr>
        <tr>
          <td><code>disconnected</code></td>
          <td>the connection dropped while the verdict was pending — nothing is left hanging</td>
        </tr>
        <tr>
          <td><code>timeout</code></td>
          <td>no verdict within the guard delay</td>
        </tr>
      </tbody>
    </table>

    <div class="callout warn">
      <strong>A missing queue on RabbitMQ 4.x is <code>unsent</code>, not <code>released</code>.</strong>
      Addresses resolve to <code>/queues/&lt;name&gt;</code>, and a queue that doesn't exist makes the
      <em>link attach</em> fail: you get <code>outcome: 'unsent'</code> with
      <code>condition: 'amqp:not-found'</code> immediately, not after the guard delay. Verified against
      RabbitMQ 4.x in the integration suite. So don't branch on <code>'released'</code> alone when what
      you mean is "my topology is wrong".
    </div>

    <h3>Broker support</h3>

    <p>
      Delivery outcomes are <strong>core AMQP 1.0</strong> (§3.4, delivery state), not a RabbitMQ
      extension — <code>emitConfirmed()</code> carries no broker-specific handling. What a broker
      <em>reports</em> for a destination that doesn't exist, however, follows its own routing policy —
      see <a routerLink="/broker-support">Broker support</a> for the full matrix:
    </p>

    <table>
      <thead><tr><th>Broker</th><th>Verified</th><th>Destination that doesn't exist</th></tr></thead>
      <tbody>
        <tr>
          <td>RabbitMQ 4.x</td>
          <td>integration suite</td>
          <td>the link attach fails &rarr; <code>unsent</code> with <code>amqp:not-found</code>,
            immediately</td>
        </tr>
        <tr>
          <td>ActiveMQ Artemis</td>
          <td>integration suite</td>
          <td>with the default <code>auto-create-queues = true</code> the address is
            <strong>created</strong>, so the publish is <code>accepted</code>. Turn auto-creation off
            to have a typo caught (<code>released</code>, or a failed attach)</td>
        </tr>
        <tr>
          <td>Qpid Broker-J</td>
          <td>integration suite</td>
          <td>nothing is auto-created either &rarr; <code>unsent</code> with
            <code>amqp:not-found</code>, like RabbitMQ</td>
        </tr>
        <tr>
          <td>Other AMQP 1.0 peers</td>
          <td>not covered by the suite</td>
          <td>standard dispositions apply; the routing policy is the broker's own</td>
        </tr>
      </tbody>
    </table>

    <h3>Handling the error</h3>

    <app-code lang="ts">import &#123; AmqpPublishError &#125; from '&#64;softwarity/nestjs-amqp';

this.triggers.emitConfirmed(trigger).subscribe(&#123;
  next: () =&gt; this.schedule.advanceDueDate(trigger.id),
  error: (err: unknown) =&gt; &#123;
    if (!(err instanceof AmqpPublishError)) throw err;
    switch (err.outcome) &#123;
      case 'released':
      case 'unsent':
        // Topology problem — the message will never get through on its own.
        this.logger.error(\`unroutable: \$&#123;err.address&#125; (\$&#123;err.condition ?? 'no condition'&#125;)\`);
        break;
      case 'timeout':
      case 'disconnected':
        this.retryLater(trigger);   // transient — try again
        break;
      default:
        this.logger.error(err.message);
    &#125;
  &#125;,
&#125;);</app-code>

    <table>
      <thead><tr><th>Field</th><th>Type</th><th>Meaning</th></tr></thead>
      <tbody>
        <tr><td><code>address</code></td><td><code>string</code></td><td>The user-facing address you published to.</td></tr>
        <tr><td><code>outcome</code></td><td><code>AmqpPublishFailure</code></td><td><code>'released' | 'rejected' | 'modified' | 'unsent' | 'disconnected' | 'timeout'</code></td></tr>
        <tr><td><code>reason</code></td><td><code>string</code></td><td>Plain-language explanation, already included in <code>message</code>.</td></tr>
        <tr><td><code>condition</code></td><td><code>string?</code></td><td>AMQP error condition when the broker reported one (<code>amqp:not-found</code>, <code>amqp:resource-limit-exceeded</code>, …).</td></tr>
        <tr><td><code>description</code></td><td><code>string?</code></td><td>The broker's own description of that condition.</td></tr>
      </tbody>
    </table>

    <p>
      <code>AmqpPublishError</code> extends <code>AmqpError</code>, so it is caught by the single
      <code>instanceof AmqpError</code> target described on
      <a routerLink="/errors-lifecycle">Errors &amp; lifecycle</a>.
    </p>

    <h3>The guard delay</h3>

    <p><code>emitConfirmed()</code> never waits forever:</p>

    <app-code lang="ts">AmqpModule.forRoot(&#123;
  url: 'amqp://localhost',
  confirmTimeoutMs: 5_000,     // default: defaultSendTimeoutMs (30s)
&#125;)

// ... or per call:
this.triggers.emitConfirmed(trigger, &#123; timeoutMs: 2_000 &#125;);</app-code>

    <p>
      A delivery verdict is a broker round-trip, not an application round-trip: set
      <code>confirmTimeoutMs</code> well below the reply timeout when a publisher should give up
      quickly. See <a routerLink="/configuration">Configuration</a> for the full option reference.
    </p>

    <div class="callout">
      <strong>No credit yet? The message waits, it isn't handed over.</strong> A link has no credit for
      a moment right after it attaches — and possibly for longer under broker flow control. Rather than
      pushing the message into rhea's buffer (where it would go out <em>after</em> the caller was told
      the publish failed), the library waits for the link to become sendable, within the same guard
      delay. That's what makes the guarantee hold: <strong>if <code>emitConfirmed()</code> errors,
      nothing was published</strong>.
    </div>

    <h3>Observable semantics</h3>

    <ul>
      <li><strong>Cold</strong>, like <code>send()</code>: nothing is published until something
        subscribes, and each subscription publishes once. Don't subscribe twice unless you mean to
        publish twice.</li>
      <li>Emits a single <code>void</code> <em>then</em> completes, so
        <code>firstValueFrom(...)</code> resolves instead of throwing <code>EmptyError</code>.</li>
      <li>Unsubscribing before the verdict drops the pending correlation — a late verdict is a no-op.</li>
    </ul>

    <app-code lang="ts">// Promise-style, when the surrounding code is async
await firstValueFrom(this.triggers.emitConfirmed(trigger));
this.schedule.advanceDueDate(trigger.id);</app-code>

    <h3>Availability</h3>

    <p>
      <code>emitConfirmed()</code> is on <code>AmqpQueue&lt;T&gt;</code> <strong>and</strong>
      <code>AmqpTopic&lt;T&gt;</code>, from the property decorators as well as from
      <code>AmqpDestinations</code> — see <a routerLink="/publishers">Publishers</a>.
    </p>

    <app-code lang="ts">// Decorator
&#64;AmqpTopic('changes.bulletin')
private readonly changes!: AmqpTopic&lt;BulletinChange&gt;;

this.changes.emitConfirmed(change);

// Runtime resolution
this.amqp.queue&lt;OrderBody&gt;(\`orders.\$&#123;tenantId&#125;\`).emitConfirmed(body);</app-code>

    <div class="callout">
      <strong><code>emit()</code> is untouched.</strong> Still synchronous, still a boolean, still
      fire-and-forget — it remains the right default for the 90% case. This is an added method, not a
      changed one.
    </div>
  `,
})
export class ConfirmedPublishComponent {}
