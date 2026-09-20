import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-broker-support',
  imports: [RouterLink],
  template: `
    <h2>Broker support</h2>

    <p>
      Three brokers run in the integration suite on every push. This matrix says what is
      <strong>verified</strong> there — not what ought to work by reading the AMQP 1.0 spec.
    </p>

    <p>
      <strong>✅</strong> verified &nbsp;·&nbsp; <strong>⚠️</strong> works with a caveat
      &nbsp;·&nbsp; <strong>❌</strong> not usable
    </p>

    <table>
      <thead>
        <tr>
          <th></th>
          <th>RabbitMQ 4.x</th>
          <th>ActiveMQ Artemis</th>
          <th>Qpid Broker-J</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>Integration suite</strong></td>
          <td>9 / 9 scenarios</td>
          <td>7 / 9</td>
          <td>8 / 9</td>
        </tr>
        <tr>
          <td><code>emit()</code> + <code>&#64;Consume</code></td>
          <td>✅</td>
          <td>✅</td>
          <td>✅</td>
        </tr>
        <tr>
          <td><a routerLink="/confirmed-publish"><code>emitConfirmed()</code></a></td>
          <td>✅</td>
          <td>✅</td>
          <td>✅</td>
        </tr>
        <tr>
          <td><a routerLink="/request-reply"><code>send()</code> request / reply</a></td>
          <td>✅ stream reply queue</td>
          <td>⚠️ single instance</td>
          <td>⚠️ single instance</td>
        </tr>
        <tr>
          <td><code>&#64;Subscribe</code> fan-out</td>
          <td>✅ stream queue, offset <code>next</code></td>
          <td>⚠️ needs a multicast address</td>
          <td>⚠️ single subscriber only</td>
        </tr>
        <tr>
          <td><a routerLink="/retry-and-dlq">Retry (<code>maxDelivery</code>)</a></td>
          <td>✅ classic · ⚠️ quorum</td>
          <td>✅</td>
          <td>❌ no <code>delivery-count</code></td>
        </tr>
        <tr>
          <td><a routerLink="/retry-and-dlq">DLQ (<code>dlq: true</code>)</a></td>
          <td>✅ via DLX</td>
          <td>⚠️ needs <code>dead-letter-address</code></td>
          <td>❌ no <code>delivery-count</code></td>
        </tr>
        <tr>
          <td>Missing destination</td>
          <td>link attach fails &rarr; <code>unsent</code></td>
          <td>auto-created &rarr; <code>accepted</code></td>
          <td>link attach fails &rarr; <code>unsent</code></td>
        </tr>
        <tr>
          <td>Address scheme</td>
          <td><code>/queues/&lt;name&gt;</code> added automatically</td>
          <td>bare names</td>
          <td>bare names</td>
        </tr>
        <tr>
          <td><a routerLink="/broker-topology">Topology manifest</a></td>
          <td>JSON</td>
          <td>XML</td>
          <td>JSON</td>
        </tr>
      </tbody>
    </table>

    <h3>Reading the caveats</h3>

    <h4>&#64;Subscribe and send() on Artemis / Qpid — one instance</h4>

    <p>
      Both rest on the same assumption: a <strong>broadcast</strong> destination, where every
      instance sees every message and keeps its own. RabbitMQ stream queues do exactly that — the
      reply stream is filtered by a per-process correlation prefix, and <code>&#64;Subscribe</code>
      attaches at offset <code>next</code>.
    </p>

    <p>
      On a plain queue, messages are competing-consumed instead. A second instance can swallow a
      reply meant for the first — which then times out — and only one subscriber gets each broadcast.
      One instance per service: fine, and that's what the suite verifies. Several instances: use
      RabbitMQ, declare a multicast address on Artemis / a topic exchange on Qpid, or stay with
      <code>emit()</code> and <a routerLink="/confirmed-publish"><code>emitConfirmed()</code></a>,
      which have no such constraint anywhere.
    </p>

    <div class="callout warn">
      <strong>Retry and DLQ don't work on Qpid Broker-J.</strong> The library counts attempts with
      the AMQP <code>delivery-count</code> header, which Qpid does not increment on
      <code>modified(delivery_failed: true)</code>. <code>maxDelivery</code> therefore never trips
      and <code>dlq: true</code> never fires: a handler that always throws is re-invoked in a hot
      loop — measured at roughly <strong>24 000 invocations in 5 seconds</strong>. On that broker,
      settle explicitly with <code>&#64;AmqpSettler</code> instead of relying on the automatic
      policy. RabbitMQ quorum queues share a milder version of the same unevenness; classic queues
      are reliable.
    </div>

    <h4>A missing destination isn't reported the same way</h4>

    <p>
      Pure broker policy. Artemis ships with <code>auto-create-queues = true</code>, so publishing to
      an address that doesn't exist <em>creates</em> it and the publish is accepted — a typo goes
      unnoticed. RabbitMQ and Qpid declare nothing on their own: the link attach fails with
      <code>amqp:not-found</code> and <code>emitConfirmed()</code> reports
      <code>outcome: 'unsent'</code> straight away. Turn auto-creation off on Artemis if you want
      that safety net.
    </p>

    <h4>Stream offsets are RabbitMQ-only, on purpose</h4>

    <p>
      The <code>rabbitmq:stream-offset-spec</code> source filter is sent to RabbitMQ peers only. It
      is a vendor extension, and Qpid Broker-J doesn't merely ignore it — it validates the filter set
      and closes the <strong>connection</strong>. Brand detection (from the peer's Open frame) keeps
      the filter where it belongs; Artemis and Qpid have no stream queues, so there is no offset to
      position anyway.
    </p>

    <h3>Other AMQP 1.0 peers</h3>

    <p>
      The library speaks standard AMQP 1.0 and falls back to standard behaviour for a peer it doesn't
      recognise: bare addresses, no vendor filter, and a plain-text
      <a routerLink="/broker-topology">topology manifest</a>. Publishing, consuming and delivery
      verdicts are core protocol and should work; retry and DLQ depend on the peer tracking
      <code>delivery-count</code>, as the table above shows. Nothing beyond the three brokers here is
      covered by the suite, so treat it as untested rather than unsupported.
    </p>

    <h3>Running the suite yourself</h3>

    <p>
      Each broker has its configuration checked in under <code>integration/</code> — a declared
      topology for RabbitMQ and Qpid, the image defaults for Artemis — and they double as working
      examples. Docker is the only prerequisite:
    </p>

    <pre><code>npm run test:integration                                   # all brokers
npm run test:integration -- integration/specs/qpid.spec.ts  # one of them</code></pre>
  `,
})
export class BrokerSupportComponent {}
