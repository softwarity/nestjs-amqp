import { Component } from '@angular/core';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-errors-lifecycle',
  imports: [CodeComponent],
  template: `
    <h2>Errors &amp; lifecycle</h2>

    <h3>Error classes</h3>

    <p>All library errors extend <code>AmqpError</code> — useful as the single catch target:</p>

    <app-code lang="ts">try &#123;
  await firstValueFrom(this.orders.send(payload));
&#125; catch (err) &#123;
  if (err instanceof AmqpTimeoutError) &#123;
    this.logger.warn(\`no reply within \$&#123;err.timeoutMs&#125;ms for \$&#123;err.correlationId&#125;\`);
  &#125; else if (err instanceof AmqpError) &#123;
    this.logger.error(\`AMQP error: \$&#123;err.message&#125;\`);
  &#125; else &#123;
    throw err;
  &#125;
&#125;</app-code>

    <table>
      <thead><tr><th>Class</th><th>Where it surfaces</th></tr></thead>
      <tbody>
        <tr>
          <td><code>AmqpError</code></td>
          <td>Abstract base — use as the single <code>instanceof</code> target.</td>
        </tr>
        <tr>
          <td><code>AmqpConnectionError</code></td>
          <td>Connection-level issues; <code>send()</code> called when AMQP is disabled or no reply stream is configured.</td>
        </tr>
        <tr>
          <td><code>AmqpTimeoutError</code></td>
          <td><code>send()</code> Observable when no reply arrives in time. Carries <code>address</code>, <code>correlationId</code>, <code>timeoutMs</code>.</td>
        </tr>
        <tr>
          <td><code>AmqpHandlerError</code></td>
          <td>Reserved for future use; not currently thrown internally.</td>
        </tr>
      </tbody>
    </table>

    <h3>Consumer error policy</h3>

    <p>For <code>&#64;Subscribe</code> handlers (work-queue), when the handler throws or its Observable errors:</p>

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
                              broker DLX</app-code>

    <p>For <code>&#64;SubscribeTopic</code>, the tree collapses: error &rarr; <code>accept()</code> (advance the offset, drop).</p>

    <h3>Module lifecycle</h3>

    <p><code>AmqpClient</code> implements <code>OnModuleInit</code> + <code>OnModuleDestroy</code>:</p>

    <ol>
      <li><strong>Init</strong> — opens the rhea Connection. Wires events. On <code>connection_open</code>,
        opens the receiver on the configured reply stream with <code>streamOffset: 'next'</code>.</li>
      <li><strong>Steady state</strong> — <code>connected$</code> tracks connection health.
        <code>messages$()</code> gates on connected, then opens a receiver and emits incoming messages.
        rhea auto-reattaches across reconnects.</li>
      <li><strong>Destroy</strong> — closes senders, the reply receiver, the connection. No queue cleanup
        needed (streams are static, broker-managed).</li>
    </ol>

    <p><code>AmqpPublisher</code> registers itself in the global registry on <code>onModuleInit</code>,
       subscribes once to <code>client.replies$</code>, and routes each reply by
       <code>correlation_id</code>.</p>

    <p><code>AmqpConsumerExplorer</code> discovers handlers, validates their parameter annotations, opens
       receivers — all on <code>onModuleInit</code>.</p>

    <h3>Boot without broker</h3>

    <ul>
      <li>If <code>enabled: true</code> but the broker is unreachable: the app starts cleanly. rhea logs
        reconnect attempts; <code>&#64;Subscribe</code> consumers wait on <code>connected$</code>;
        <code>send()</code> calls time out per their <code>timeoutMs</code>. Reconnect is fully
        automatic.</li>
      <li>If <code>enabled: false</code>: module loads but is inactive.
        <code>&#64;AmqpQueue.send()</code> errors immediately with <code>AmqpConnectionError</code>;
        <code>&#64;AmqpQueue.emit()</code> is a silent no-op; <code>&#64;Subscribe</code> handlers are not
        wired.</li>
    </ul>

    <h3>Reconnect behaviour</h3>

    <p>
      rhea handles reconnects internally with exponential backoff
      (<code>initialReconnectDelayMs</code> &rarr; <code>maxReconnectDelayMs</code>). Receivers and senders
      re-attach automatically — there's nothing for application code to do. The library re-opens the
      reply receiver on each <code>connection_open</code>.
    </p>

    <h3>Known limitations</h3>

    <ul>
      <li>
        <strong>In-flight <code>send()</code> across reconnects</strong> — if a reconnect happens between
        sending and receiving the reply, the reply is lost (the reply stream is re-attached with
        <code>streamOffset: 'next'</code>, missing what arrived during the gap). The pending call times
        out.
      </li>
      <li>
        <strong><code>topic.send()</code> (scatter-gather RPC)</strong> — not supported.
        <code>AmqpTopic</code> only exposes <code>emit()</code> (compile-time enforcement). Build
        aggregation in user code on top of <code>emit()</code> if you need request/reply with multiple
        responders.
      </li>
      <li>
        <strong>Replay of stream messages</strong> — <code>&#64;SubscribeTopic</code> is hardcoded to
        <code>streamOffset: 'next'</code>. PR welcome for a dedicated <code>&#64;SubscribeStream</code>
        decorator exposing the option.
      </li>
    </ul>

    <h3>Logging</h3>

    <p>
      Every internal log line uses NestJS's <code>Logger</code> with a per-class context (<code>AmqpClient</code>,
      <code>AmqpPublisher</code>, <code>AmqpConsumerExplorer</code>, <code>DlqBrowserService</code>).
      Adjust the level globally via Nest's logger configuration. The library does not register a
      custom logger registry.
    </p>
  `,
})
export class ErrorsLifecycleComponent {}
