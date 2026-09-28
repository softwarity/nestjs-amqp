import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-tracing',
  imports: [CodeComponent, RouterLink],
  template: `
    <h2>Observability — OpenTelemetry</h2>

    <p>
      <a href="https://opentelemetry.io/" target="_blank" rel="noopener">
        <img
          src="https://img.shields.io/badge/OpenTelemetry-natively%20instrumented-f5a800?logo=opentelemetry&logoColor=white"
          alt="OpenTelemetry: natively instrumented"
        />
      </a>
    </p>

    <p>
      <strong>Your trace does not stop at the broker, and the half of your system no HTTP request ever
      touches stops being invisible.</strong> This library is
      <a href="https://opentelemetry.io/docs/concepts/instrumentation/libraries/" target="_blank" rel="noopener">
        natively instrumented</a>: it emits its own spans and carries the W3C trace context in every message, so the
      work a consumer does belongs to the trace of the HTTP request that published it — across the wire, across
      services.
    </p>

    <p>Nothing to enable, nothing to configure, no option to pass.</p>

    <app-code lang="ts">// Nothing here mentions telemetry. That's the point.
this.orders.emit(body);</app-code>

    <app-code lang="text">GET /orders/42                                  ← your gateway
└─ send orders.create               PRODUCER    ← this library, publisher side
   └─ process orders.create         CONSUMER    ← this library, consumer side
      └─ pg.query                               ← your other instrumentation</app-code>

    <h3>Why it has to live in the library</h3>

    <p>
      There is no <code>&#64;opentelemetry/instrumentation-rhea</code> on npm, and
      <code>instrumentation-amqplib</code> only covers AMQP 0.9.1 — a different protocol. Nothing outside this package
      can ever trace it, which is exactly the case OpenTelemetry describes as a natively instrumented library: the
      library ships its own instrumentation.
    </p>

    <h3>Built in and optional at the same time</h3>

    <p>
      The package depends on <code>&#64;opentelemetry/api</code> — and on nothing else. Not the SDK, not an exporter.
      That package has <strong>zero dependencies</strong> and is inert on its own: with no SDK registered by your
      application, <code>trace.getTracer()</code> returns a no-op tracer and the context injection writes
      <strong>nothing</strong>. So the instrumentation code carries no flag and no <code>if</code> — and costs nothing
      when you don't do observability.
    </p>

    <div class="callout">
      <strong>The claim is tested, not asserted.</strong> A unit spec holds it to the wire: with no SDK registered, a
      published message gets <strong>no</strong> <code>application_properties</code> added — not an empty map, absent —
      and every call behaves exactly as it did before.
    </div>

    <p>
      The endpoint, the exporter, the sampler and the service name belong to your application's telemetry bootstrap.
      This library reads no environment variable and never forces a sampling decision.
    </p>

    <h3>What it emits</h3>

    <p>
      Two spans per hop. Propagation alone would not do: a span crossing a broker has to <em>show</em> the hop, not
      hide it — otherwise the queue wait is invisible and a consumer that instruments nothing of its own produces
      nothing at all.
    </p>

    <table>
      <thead><tr><th>Span</th><th>Kind</th><th>When it ends</th></tr></thead>
      <tbody>
        <tr>
          <td><code>send &lt;address&gt;</code></td>
          <td><code>PRODUCER</code></td>
          <td><code>emit()</code>: the message is handed to the sender.
            <a routerLink="/confirmed-publish"><code>emitConfirmed()</code></a>: <strong>the broker's verdict
            arrives</strong> — the span's duration is the confirm latency</td>
        </tr>
        <tr>
          <td><code>send &lt;address&gt;</code></td>
          <td><code>CLIENT</code></td>
          <td><a routerLink="/request-reply"><code>send()</code></a>: the whole request/reply round trip, with the
            publish nested inside it</td>
        </tr>
        <tr>
          <td><code>process &lt;address&gt;</code></td>
          <td><code>CONSUMER</code></td>
          <td>your handler returns, or its Observable completes or errors</td>
        </tr>
      </tbody>
    </table>

    <p>Attributes follow the messaging semantic conventions:</p>

    <table>
      <thead><tr><th>Attribute</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td><code>messaging.system</code></td><td>from the detected broker brand — <code>rabbitmq</code>, <code>activemq</code> for Artemis, <code>qpid</code>, else <code>amqp</code></td></tr>
        <tr><td><code>messaging.destination.name</code></td><td>the address you used, not the broker-specific rewrite</td></tr>
        <tr><td><code>messaging.operation.name</code> / <code>.type</code></td><td><code>send</code> or <code>process</code></td></tr>
        <tr><td><code>messaging.message.id</code></td><td><code>properties.message_id</code>, when set</td></tr>
        <tr><td><code>messaging.message.conversation_id</code></td><td>the correlation id, on both sides of a request/reply</td></tr>
        <tr><td><code>error.type</code></td><td>on failure — the AMQP outcome (<code>released</code>, <code>rejected</code>, <code>unsent</code>, <code>timeout</code>) or the error's class</td></tr>
      </tbody>
    </table>

    <h3>Parent-child, and what follows from it</h3>

    <p>
      A consumer's <code>process</code> span is a <strong>child</strong> of the publish, not a linked root. The
      conventions make links their default and allow parent-child for message-by-message processing — which is this
      library's only mode (there is no batch consumption).
    </p>

    <p>
      The consequence is the whole point: a consumer that instruments nothing of its own still appears inside the trace
      that caused it, and <strong>inherits that trace's sampling decision</strong>. If a single gateway starts your
      traces and every service runs <code>parentbased_always_off</code>, that invariant survives untouched — with
      links, the consumer span would be a root and the root sampler would drop it every time.
    </p>

    <div class="callout warn">
      <strong>The honest cost.</strong> A message that sits in a queue for a long time produces a long trace with a
      gap in it, and a publisher that fans out in a single request produces a big one. If one queue ever makes that
      painful, treat it as a special case — not a reason to change the default.
    </div>

    <h4>A message from a system that sets no traceparent</h4>

    <p>
      Then there is nothing to inherit: the <code>process</code> span is a <strong>root</strong>, and your
      application's sampler decides whether this service is an entry point for traces. It has what it needs to decide
      well — a sampler receives the span name (<code>process orders.create</code>), the kind
      (<code>CONSUMER</code>) and the attributes, so you can sample exactly those roots, per destination, in your own
      <code>telemetry.ts</code>. That is why this library exposes no option for it: sampling policy is the
      application's, never the library's.
    </p>

    <h3>Request / reply, and dead letters</h3>

    <ul>
      <li>
        <strong><code>send()</code></strong> opens a <code>CLIENT</code> span for the round trip and attaches the
        reply as a <strong>link</strong>, not a child. On a shared reply stream the reply belongs to the consumer's
        trace; claiming it as a descendant of the request would be a fiction.
      </li>
      <li>
        <strong>A message that already carries a trace context keeps it.</strong> It is never overwritten — the
        publish gets a link to it instead. That is what keeps a <strong>dead letter</strong> correlated with the
        publication that produced it, and what makes a
        <a routerLink="/dlq-browser">DLQ replay</a> point back at the original trace rather than at the admin request
        that replayed it.
      </li>
    </ul>

    <h3>Verified across the brokers</h3>

    <p>
      The integration suite publishes inside a recorded span and asserts the consumer receives the context, against
      <strong>RabbitMQ 4.x, Artemis and Qpid Broker-J</strong> — see
      <a routerLink="/broker-support">Broker support</a>. Propagation rides in
      <code>application_properties</code>, which is core AMQP 1.0: no broker-specific handling anywhere.
    </p>

    <h3>Metrics</h3>

    <p>
      The traces above need a parent to be worth anything. A consumer draining a queue filled by a scheduler, a retry
      or a DLQ replay has <strong>no HTTP request and — under a <code>parentbased_always_off</code> sampler — no trace
      either</strong>. Metrics are what make that half of the system visible, and the library emits four of them on
      the same terms as the spans: the API only, no configuration, no option.
    </p>

    <table>
      <thead><tr><th>Instrument</th><th>Type</th><th>Recorded</th></tr></thead>
      <tbody>
        <tr>
          <td><code>messaging.client.sent.messages</code></td>
          <td>counter</td>
          <td>one per publish attempt, success or not</td>
        </tr>
        <tr>
          <td><code>messaging.client.operation.duration</code></td>
          <td>histogram, seconds</td>
          <td>the publish — for <a routerLink="/confirmed-publish"><code>emitConfirmed()</code></a>,
            <strong>up to the broker's verdict</strong>, so it measures confirm latency</td>
        </tr>
        <tr>
          <td><code>messaging.client.consumed.messages</code></td>
          <td>counter</td>
          <td>one per message handed to a handler</td>
        </tr>
        <tr>
          <td><code>messaging.process.duration</code></td>
          <td>histogram, seconds</td>
          <td>how long the handler took, Observable handlers included</td>
        </tr>
      </tbody>
    </table>

    <p>
      Attributes are the conventional ones — <code>messaging.system</code>,
      <code>messaging.destination.name</code>, <code>messaging.operation.name</code>, and
      <code>error.type</code> when it failed, carrying the AMQP outcome so <code>released</code>,
      <code>rejected</code>, <code>unsent</code> and <code>timeout</code> are what you alert on. Histogram buckets
      come from the conventions' own recommendation, passed as <em>advice</em> so your views can override them.
    </p>

    <h4>The signal for work failing quietly</h4>

    <p>
      <code>messaging.client.operation.duration</code> also records the settlements that are not plain acceptances,
      with the AMQP outcome in <code>messaging.operation.name</code>:
    </p>

    <table>
      <thead><tr><th><code>messaging.operation.name</code></th><th>What happened</th></tr></thead>
      <tbody>
        <tr><td><code>reject</code></td><td>attempts exhausted, routed to the dead-letter queue</td></tr>
        <tr>
          <td><code>accept</code> <strong>with</strong> <code>error.type</code></td>
          <td>attempts exhausted with <strong>no DLQ configured</strong> — the message was dropped, and nothing holds
            it now. The most insidious of the three</td>
        </tr>
        <tr><td><code>modify</code></td><td>handed back for another delivery: a retry</td></tr>
      </tbody>
    </table>

    <p>
      A successful acceptance is never recorded here — <code>messaging.client.consumed.messages</code> already counts
      it. So any point on this instrument is, by construction, something going wrong.
    </p>

    <div class="callout warn">
      <strong>The library emits; collecting is your application's business.</strong> Worth stating plainly, because
      metrics are absent far more often than traces: <code>NodeSDK</code> points
      <code>OTEL_METRICS_EXPORTER</code> at <code>otlp</code> by default, which fails loudly every minute when nothing
      is listening — so plenty of services pin it to <code>none</code> on purpose and never think about it again. A
      service can therefore have working traces and <strong>no meter at all</strong>. This library then records into
      no-op instruments, costs nothing and says nothing. Updating does not make metrics appear; registering a
      <code>MeterProvider</code> in your application does.
    </div>

    <h4>What this library deliberately does not measure</h4>

    <p>
      Queue depth, the age of the oldest message, how many consumers are connected: the <strong>broker</strong>
      publishes those, and it is the only one with the whole picture. A client-side guess would be partial and would
      drift. This library sticks to what it alone knows — what <em>this</em> service publishes and consumes, and how
      that goes.
    </p>

    <div class="callout">
      <strong>Caveat worth knowing.</strong> Messaging semantic conventions — metrics included — are still in
      <em>development</em> status
      upstream. Attribute names may move; the spec's own advice is not to chase versions until they stabilise, which is
      what this library does.
    </div>
  `,
})
export class TracingComponent {}
