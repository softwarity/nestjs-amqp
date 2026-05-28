import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-request-reply',
  imports: [CodeComponent, RouterLink],
  template: `
    <h2>Request / reply — <code>send()</code></h2>

    <p>
      <code>AmqpQueue.send()</code> is an opt-in feature. It returns an <code>Observable</code> that
      resolves with the peer's reply when one arrives — RPC-style messaging on top of AMQP. To use it
      you need three things:
    </p>

    <ol>
      <li>A <strong>shared reply stream</strong> declared broker-side</li>
      <li>The address of that stream set as <code>replyStreamAddress</code> in the broker options</li>
      <li>A consumer on the other side that returns a value (or an <code>Observable</code>) from its
        <code>&#64;Consume</code> handler</li>
    </ol>

    <p>If you only need fire-and-forget, stick to <code>emit()</code> — none of this applies.</p>

    <h3>How it works</h3>

    <ol>
      <li>The library generates <code>correlationId = $&#123;client.replyPrefix&#125;:$&#123;randomUUID()&#125;</code></li>
      <li>It publishes the body with <code>reply_to</code> set to the shared reply stream and the correlation ID</li>
      <li>It returns an Observable that resolves when a reply with the matching correlation ID arrives</li>
      <li>It times out after <code>opts.timeoutMs</code> (or the broker's <code>defaultSendTimeoutMs</code>),
        erroring with <code>AmqpTimeoutError</code></li>
    </ol>

    <p>
      The reply stream is <strong>shared across all processes</strong> of your service. Each process
      generates a per-process <code>replyPrefix</code> at boot. When a reply lands on the stream, every
      process sees it but only routes those whose <code>correlation_id</code> starts with its own prefix
      to its local pending-replies map. Others are accept-and-dropped (the stream offset just advances).
    </p>

    <h3>1. Declare the reply stream broker-side</h3>

    <p>It MUST be a stream queue (AMQP 1.0 stream offset filter). RabbitMQ 4.x example:</p>

    <app-code lang="json">&#123;
  "queues": [
    &#123;
      "name": "my-service.replies",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": &#123;
        "x-queue-type": "stream",
        "x-max-age": "5m"
      &#125;
    &#125;
  ]
&#125;</app-code>

    <p>
      Short <code>x-max-age</code> (5 minutes) is fine — replies are consumed almost immediately, and
      anything older than the longest sensible <code>timeoutMs</code> is dead weight. On Artemis use a
      regular anycast durable queue. See
      <a routerLink="/broker-topology">Broker topology</a> for the variants.
    </p>

    <h3>2. Set <code>replyStreamAddress</code> on the broker options</h3>

    <app-code lang="ts">AmqpModule.forRoot(&#123;
  url: 'amqp://localhost:5672',
  username: '...', password: '...',
  replyStreamAddress: 'my-service.replies',   // ← REQUIRED for send()
&#125;)</app-code>

    <p>
      If <code>replyStreamAddress</code> is absent, <code>send()</code> throws
      <code>AmqpConnectionError</code> at the call site. <code>emit()</code> and
      <code>&#64;Consume</code> continue to work — only <code>send()</code> is disabled.
    </p>

    <h3>3. Call <code>send()</code> on the publisher side</h3>

    <app-code lang="ts">&#64;Injectable()
export class OrdersService &#123;
  &#64;AmqpQueue('orders.create')
  private readonly orders!: AmqpQueue&lt;OrderBody&gt;;

  createOrder(body: OrderBody): Observable&lt;OrderConfirmation&gt; &#123;
    return this.orders.send&lt;OrderConfirmation&gt;(body, &#123;
      timeoutMs: 5000,
      properties: &#123; subject: 'order.create.v2' &#125;,
      applicationProperties: &#123; tenantId: body.tenantId &#125;,
    &#125;);
  &#125;
&#125;</app-code>

    <p>
      The second generic <code>TRes</code> is supplied at the call site — it can vary per request even on
      the same queue. The queue's static <code>T</code> only constrains the request payload.
    </p>

    <h3>4. Return a value from the consumer to auto-reply</h3>

    <p>
      On the other side, the <code>&#64;Consume</code> handler just returns the response. The library
      reads <code>incoming.message.properties.reply_to</code> and ships the returned value on that
      address with the original <code>correlation_id</code> — no code in the handler needed.
    </p>

    <app-code lang="ts">&#64;Consume('orders.create')
onCreate(body: OrderBody): Observable&lt;OrderConfirmation&gt; &#123;
  return this.svc.create(body);   // resolved value -&gt; auto-shipped on reply_to
&#125;</app-code>

    <p>
      Works with synchronous returns too — return a plain object and it's sent immediately. Return
      <code>undefined</code> / <code>void</code> and no reply is sent (the message is just
      <code>accept()</code>-ed). Return an <code>Observable</code> that errors and the auto-settle policy
      kicks in instead (modified → DLQ etc., depending on <code>maxDelivery</code> /
      <code>dlq</code> — see <a routerLink="/retry-and-dlq">Retry &amp; DLQ</a>).
    </p>

    <h3>Trade-offs of the shared reply stream</h3>

    <ul>
      <li><strong>N× bandwidth per reply</strong> — every instance of the service reads every reply, then
        drops the ones that don't match its prefix. For low-volume request/reply on a LAN this is
        invisible. For high-volume RPC, consider per-instance reply queues (Artemis-style) — pass each
        process a different <code>replyStreamAddress</code>.</li>
      <li><strong>Reply across reconnect = timeout</strong> — the reply stream is re-attached with
        <code>streamOffset: 'next'</code> on every reconnect. Replies that arrived during the gap are
        lost; the pending <code>send()</code> times out. Acceptable for a request/reply pattern (callers
        are expected to retry).</li>
      <li><strong>No scatter-gather</strong> — <code>send()</code> waits for one matching reply and
        completes. There is no built-in support for fan-out queries that collect responses from N
        responders. Build that on top of <code>emit()</code> if you need it.</li>
    </ul>

    <h3>Error handling on the caller side</h3>

    <app-code lang="ts">try &#123;
  const confirmation = await firstValueFrom(this.orders.send&lt;Confirmation&gt;(body));
&#125; catch (err) &#123;
  if (err instanceof AmqpTimeoutError) &#123;
    this.logger.warn(\`no reply within \$&#123;err.timeoutMs&#125;ms (corr=\$&#123;err.correlationId&#125;)\`);
  &#125; else if (err instanceof AmqpConnectionError) &#123;
    // Broker disabled, or replyStreamAddress missing
    this.logger.error(err.message);
  &#125; else &#123;
    throw err;
  &#125;
&#125;</app-code>
  `,
})
export class RequestReplyComponent {}
