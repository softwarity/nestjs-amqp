import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-dlq-browser',
  imports: [CodeComponent, RouterLink],
  template: `
    <h2>DLQ browser</h2>

    <p>
      A stateful API to <strong>browse, replay, or drop</strong> dead-lettered messages from a DLQ.
      Backed by AMQP 1.0 manual credit + <code>release()</code> semantics —
      <strong>no broker Management API call</strong>. Each session is bound to one broker (the broker
      whose DLQ is being browsed); cross-broker replay is not supported. Two pieces:
    </p>

    <ul>
      <li><code>DlqBrowserService</code> — programmatic API, always provided by <code>AmqpModule</code></li>
      <li><code>DlqAdminModule</code> — opt-in HTTP controller exposing the service over REST</li>
    </ul>

    <p>
      This page is about <em>browsing</em> the DLQ — for the upstream story (how messages end up there in
      the first place), see <a routerLink="/retry-and-dlq">Retry &amp; DLQ</a>.
    </p>

    <h3>Programmatic use</h3>

    <app-code lang="ts">import &#123; Injectable &#125; from '&#64;nestjs/common';
import &#123; DlqBrowserService &#125; from '&#64;softwarity/nestjs-amqp';

&#64;Injectable()
export class AdminService &#123;
  constructor(private readonly browser: DlqBrowserService) &#123;&#125;

  // Single-broker: brokerName omitted, defaults to the lone broker
  inspect(addr: string) &#123;
    return this.browser.openSession(addr, 50, 'cli-user');
  &#125;

  // Multi-broker: pass the brokerName explicitly
  inspectAnalytics(addr: string) &#123;
    return this.browser.openSession(addr, 50, 'cli-user', 'analytics');
  &#125;
&#125;</app-code>

    <p>The browser exposes 6 methods, all returning Observables:</p>

    <table>
      <thead><tr><th>Method</th><th>Effect</th></tr></thead>
      <tbody>
        <tr>
          <td><code>openSession(addr, pageSize, openedBy, brokerName?)</code></td>
          <td>Open a manual receiver on the broker, add <code>pageSize</code> credits, drain. Returns the populated session.</td>
        </tr>
        <tr>
          <td><code>get(token)</code></td>
          <td>Read current session state (held messages, broker name).</td>
        </tr>
        <tr>
          <td><code>loadNextPage(token)</code></td>
          <td>Release the current page back to the broker, drain the next page.</td>
        </tr>
        <tr>
          <td><code>replay(token, idx)</code></td>
          <td>Publish a copy to <code>xDeath[0].queue</code> on the session's broker, accept the original.</td>
        </tr>
        <tr>
          <td><code>drop(token, idx)</code></td>
          <td>Accept the original — no republish.</td>
        </tr>
        <tr>
          <td><code>close(token)</code></td>
          <td>Release remaining + close receiver + free session.</td>
        </tr>
      </tbody>
    </table>

    <h3>HTTP API — DlqAdminModule</h3>

    <p>Import the optional module to expose the service over REST:</p>

    <app-code lang="ts">&#64;Module(&#123;
  imports: [
    AmqpModule.forRoot(&#123; brokers: [&#123; name: 'primary', url: 'amqp://...', /* ... */ &#125;] &#125;),
    DlqAdminModule,
  ],
&#125;)
export class AppModule &#123;&#125;</app-code>

    <h4>Routes — single-broker shortcut</h4>

    <p>
      When you only have one broker, use the shortcut path — no broker name in the URL. The default
      broker (first <code>brokers[]</code> entry) is used automatically.
    </p>

    <app-code lang="text">POST /admin/dlq/sessions                              &#123; dlqAddress, pageSize? &#125;
GET  /admin/dlq/sessions/:token
POST /admin/dlq/sessions/:token/next-page
POST /admin/dlq/sessions/:token/messages/:idx/replay
POST /admin/dlq/sessions/:token/messages/:idx/drop
POST /admin/dlq/sessions/:token/close</app-code>

    <h4>Routes — multi-broker explicit</h4>

    <p>
      With several brokers, prefix the open-session URL with the broker name. The other routes use the
      session token, which already knows its broker, so they don't need the broker in the path.
    </p>

    <app-code lang="text">POST /admin/dlq/:broker/sessions                     &#123; dlqAddress, pageSize? &#125;
GET  /admin/dlq/sessions/:token
POST /admin/dlq/sessions/:token/next-page
POST /admin/dlq/sessions/:token/messages/:idx/replay
POST /admin/dlq/sessions/:token/messages/:idx/drop
POST /admin/dlq/sessions/:token/close</app-code>

    <p>
      Unknown broker name in the path → <code>400 Bad Request</code> with the list of valid names.
      <code>POST /admin/dlq/sessions</code> in a multi-broker setup defaults to the first broker — a
      convenience for the most common operator workflow.
    </p>

    <div class="callout danger">
      <strong>⚠ Auth is NOT included.</strong> The controller is unguarded by design — the library has no
      opinion on your auth stack. Wrap it with a global Guard, plug your middleware so
      <code>req.user</code> is populated (<code>openedBy</code> is read from
      <code>req.user.username ?? req.user.id ?? 'anonymous'</code>), or sub-class the controller and
      redeclare the routes with your own decorators (<code>&#64;UseGuards()</code>,
      <code>&#64;Roles()</code>, …).
    </div>

    <h3>Workflow</h3>

    <app-code lang="text">1. POST /admin/dlq/primary/sessions  &#123; dlqAddress: 'my-svc.dlq', pageSize: 20 &#125;
     -&gt; backend opens manual receiver on broker 'primary', adds 20 credits,
        drains, returns
        &#123; token, brokerName: 'primary',
          messages: [ &#123; idx, body, properties, xDeath, … &#125;, … ] &#125;
     -&gt; messages are held un-settled on the broker

2. User picks msg[3] -&gt; POST /admin/dlq/sessions/&lt;token&gt;/messages/3/replay
     -&gt; backend reads xDeath[0].queue (origin), publishes a copy there
        on broker 'primary', accept() the original
     -&gt; message gone from my-svc.dlq
     -&gt; session.messages[3] removed, lastActivityAt refreshed

3. User picks msg[5] -&gt; POST .../messages/5/drop
     -&gt; backend accept() only -&gt; message gone, no republish

4. User clicks "next page" -&gt; POST .../next-page
     -&gt; backend release() all remaining (delivery_count UNCHANGED), adds
        20 more credits, drains -&gt; returns next batch

5. User closes the page -&gt; POST .../close
     -&gt; backend release() the rest, closes receiver, frees session

   OR: no action for 5 min -&gt; idle TTL sweeper auto-closes (release + log)
   OR: backend crashes -&gt; AMQP drops the connection -&gt; broker re-queues
       every un-settled delivery (free rollback)</app-code>

    <h3>Lifecycle guarantees</h3>

    <ul>
      <li><strong>5 min idle TTL</strong> — any session without an action for 5 minutes is auto-closed,
        releasing any held messages back to the DLQ.</li>
      <li><strong>25 min hard TTL</strong> — kept under RabbitMQ's default <code>consumer_timeout</code>
        (30 min), so the broker never yanks our session out from under us.</li>
      <li><strong>Backend crash</strong> — AMQP connection drop = broker re-queues all un-settled
        deliveries. No code-side cleanup needed.</li>
      <li><strong><code>release()</code> semantics</strong> — when paging or closing, held messages are
        put back without <code>delivery_count++</code> (they're not "failed", just "looked at"). Repeated
        paging is safe.</li>
      <li><strong>Concurrent sessions allowed</strong> — each session has its own receiver and gets its
        own slice of the FIFO. No locking.</li>
    </ul>

    <div class="callout warn">
      <strong>Mono-instance assumption.</strong> Session state lives in RAM. For multi-instance
      deployments, configure sticky sessions at the load balancer or dedicate one replica to admin
      traffic. The library does not implement session sharing.
    </div>

    <h3>What's in xDeath</h3>

    <p>RabbitMQ 4.x (AMQP 1.0) adds an <code>x-opt-deaths</code> message annotation on each dead-letter
       event. The browser exposes it on each held message:</p>

    <app-code lang="json">"xDeath": [&#123;
  "queue": "orders.created",
  "reason": "rejected",
  "routing-keys": ["orders.created"],
  "count": 5,
  "exchange": "",
  "first-time": "2026-05-27T10:00:00.000Z",
  "last-time":  "2026-05-27T10:05:00.000Z"
&#125;]</app-code>

    <p>
      <code>xDeath[0]</code> is the most recent event — the queue the message was rejected from, used by
      <code>replay()</code> to publish back. <code>reason</code> is one of <code>'rejected'</code>,
      <code>'expired'</code>, <code>'maxlen'</code>, <code>'delivery_limit'</code>. <code>count</code> is
      how many times this same dead-letter event has happened (e.g. a message replayed twice and
      re-rejected each time would have count=2).
    </p>

    <div class="callout warn">
      <strong>The <code>description</code> from <code>reject(&#123;condition, description&#125;)</code> is
      NOT preserved by RabbitMQ</strong> — only the reason category. For richer error context, attach an
      <code>application_property</code> before rejecting.
    </div>

    <h3>Streams don't use the DLQ pattern</h3>

    <p>
      Streams are append-only logs; "rejected" messages stay in the log (the offset just advances past
      them). For streams, use <code>maxDelivery: 1, dlq: false</code> (defaults) and handle retries in
      application code if needed.
    </p>
  `,
})
export class DlqBrowserComponent {}
