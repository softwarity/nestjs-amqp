import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-errors-lifecycle',
  imports: [CodeComponent, RouterLink],
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
          <td>Connection-level issues; <code>send()</code> called when AMQP is disabled or no reply
            stream is configured on the broker.</td>
        </tr>
        <tr>
          <td><code>AmqpTimeoutError</code></td>
          <td><code>send()</code> Observable when no reply arrives in time. Carries <code>address</code>,
            <code>correlationId</code>, <code>timeoutMs</code>.</td>
        </tr>
        <tr>
          <td><code>AmqpHandlerError</code></td>
          <td>Reserved for future use; not currently thrown internally.</td>
        </tr>
      </tbody>
    </table>

    <h3>Consumer error policy</h3>

    <p>
      For <code>&#64;Consume</code> handlers (work-queue), when the handler throws or its Observable
      errors, see the full decision tree on the <a routerLink="/retry-and-dlq">Retry &amp; DLQ</a> page.
      Default behaviour with no options:
      <code>delivery.accept()</code> — message dropped silently. Set <code>maxDelivery</code> /
      <code>dlq</code> to enable retries / DLQ routing.
    </p>

    <p>
      For <code>&#64;Subscribe</code>, the policy collapses: error &rarr; <code>accept()</code>
      (advance the offset, drop). Streams don't redeliver.
    </p>

    <h3>Module lifecycle</h3>

    <p>
      The module is built from a list of brokers. <code>BrokerRegistry</code> is the central provider
      that owns one <code>BrokerConnection</code> + one <code>BrokerPublisher</code> per declared broker.
      <code>AmqpConsumerExplorer</code> walks providers, resolves each handler's broker via the
      registry, and opens receivers.
    </p>

    <ol>
      <li><strong>Init</strong> — <code>BrokerRegistry.onModuleInit</code> calls
        <code>BrokerConnection.start()</code> on every broker. Each opens its rhea Connection, wires
        events, and on <code>connection_open</code>: detects the peer's brand
        (<code>RabbitMQ</code> / <code>Artemis</code> / …) and opens the reply receiver if
        <code>replyStreamAddress</code> is set.
        <code>AmqpConsumerExplorer.onModuleInit</code> then walks providers and binds handlers to their
        target brokers.</li>
      <li><strong>Steady state</strong> — each <code>BrokerConnection</code>'s <code>connected$</code>
        tracks its broker's health independently. <code>messages$()</code> gates on connected, then
        opens a receiver and emits incoming messages. rhea auto-reattaches across reconnects.</li>
      <li><strong>Destroy</strong> — <code>BrokerRegistry.onModuleDestroy</code> stops every publisher
        then every connection. No queue cleanup needed (topology is broker-managed).</li>
    </ol>

    <p>
      Property decorators (<code>&#64;AmqpQueue</code>, <code>&#64;AmqpTopic</code>) resolve their
      publisher lazily on first property access, via a module-level singleton registered by
      <code>BrokerRegistry</code>'s constructor — so it's safe to call from <code>OnModuleInit</code> /
      <code>OnApplicationBootstrap</code> and beyond.
    </p>

    <h3>Boot without broker</h3>

    <ul>
      <li>If <code>enabled: true</code> but a broker is unreachable: the app starts cleanly. rhea logs
        reconnect attempts; <code>&#64;Consume</code> consumers wait on the broker's
        <code>connected$</code>; <code>send()</code> calls time out per their <code>timeoutMs</code>.
        Reconnect is fully automatic.</li>
      <li>If <code>enabled: false</code>: every broker loads but is inactive. <code>send()</code>
        errors immediately with <code>AmqpConnectionError</code>; <code>emit()</code> is a silent no-op;
        <code>&#64;Consume</code> handlers are not wired.</li>
    </ul>

    <h3>Reconnect behaviour</h3>

    <p>
      rhea handles reconnects internally with exponential backoff
      (<code>initialReconnectDelayMs</code> &rarr; <code>maxReconnectDelayMs</code>). Receivers and
      senders re-attach automatically — there's nothing for application code to do. Each broker
      re-opens its reply receiver on each <code>connection_open</code>.
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
        <strong>Replay of stream messages</strong> — <code>&#64;Subscribe</code> is hardcoded to
        <code>streamOffset: 'next'</code>. PR welcome for a dedicated <code>&#64;SubscribeStream</code>
        decorator exposing the option.
      </li>
      <li>
        <strong>Delayed retry (<code>retryPolicy</code>)</strong> — only <code>'immediate'</code> is
        functional in 0.2.x. <code>fixed</code> / <code>exponential</code> shapes are accepted by the
        type system for forward-compatibility; runtime falls back to immediate with a boot warning. See
        <a routerLink="/retry-and-dlq">Retry &amp; DLQ</a>.
      </li>
    </ul>

    <h3>Logging</h3>

    <p>
      Every internal log line uses NestJS's <code>Logger</code> with a per-broker context
      (<code>BrokerConnection:&lt;name&gt;</code>, <code>BrokerPublisher:&lt;name&gt;</code>,
      <code>AmqpConsumerExplorer</code>, <code>BrokerRegistry</code>, <code>DlqBrowserService</code>).
      Adjust the level globally via Nest's logger configuration. The library does not register a
      custom logger registry.
    </p>
  `,
})
export class ErrorsLifecycleComponent {}
