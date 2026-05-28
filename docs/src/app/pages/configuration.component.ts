import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-configuration',
  imports: [CodeComponent, RouterLink],
  template: `
    <h2>Configuration</h2>

    <p>
      The module takes one broker (the 90% case) or several. Each broker is independent: its own
      connection, its own reply stream, its own DLQ, its own body codec, its own enabled switch. Pass
      the options either statically (<code>forRoot</code>) or asynchronously (<code>forRootAsync</code>,
      with a factory pulling from <code>ConfigService</code> or any other source).
    </p>

    <h3>forRoot — minimal (single broker)</h3>

    <p>
      The single-broker form is a flat object <strong>without a <code>name</code> field</strong> — the
      name is internally <code>'default'</code> and isn't referenced by anything in your code
      (decorators resolve the lone broker automatically).
    </p>

    <app-code lang="ts">AmqpModule.forRoot(&#123;
  url: 'amqp://localhost:5672',
  username: 'guest',
  password: 'guest',
&#125;)</app-code>

    <p>
      If you want a custom broker name (visible as the AMQP container ID on the broker management UI),
      switch to the array form — even with a single entry:
    </p>

    <app-code lang="ts">AmqpModule.forRoot([&#123; name: 'bulletin-edition-svc', url: 'amqp://...' &#125;])</app-code>

    <h3>forRoot — full (single broker, all options)</h3>

    <app-code lang="ts">AmqpModule.forRoot(&#123;
  url: 'amqp://localhost:5672',
  enabled: true,                        // default true; set to false to load inactive
  username: 'svc',
  password: '...',
  replyStreamAddress: 'my-svc.replies', // optional — required for send()
  defaultDlqAddress: 'my-svc.dlq',      // optional — used by DLQ admin UI
  reconnectLimit: -1,
  initialReconnectDelayMs: 100,
  maxReconnectDelayMs: 30_000,
  idleTimeoutMs: 60_000,
  defaultSendTimeoutMs: 30_000,
  bodyCodec: undefined,                 // optional — defaults to JsonBodyCodec
&#125;)</app-code>

    <h3>forRoot — multiple brokers</h3>
    <p>
      Pass an array. See <a routerLink="/multi-broker">Multi-broker</a> for the full story.
    </p>
    <app-code lang="ts">AmqpModule.forRoot([
  &#123; name: 'primary',   url: 'amqp://broker-a:5672', username: '...', password: '...' &#125;,
  &#123; name: 'analytics', url: 'amqp://broker-b:5672', username: '...', password: '...' &#125;,
])</app-code>

    <h3>forRootAsync — config from ConfigService</h3>

    <app-code lang="ts">import &#123; ConfigModule, ConfigService &#125; from '&#64;nestjs/config';
import &#123; AmqpModule &#125; from '&#64;softwarity/nestjs-amqp';

&#64;Module(&#123;
  imports: [
    AmqpModule.forRootAsync(&#123;
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) =&gt; (&#123;
        url: config.get('AMQP_URL')!,
        username: config.get('AMQP_USER'),
        password: config.get('AMQP_PASSWORD'),
        enabled: config.get('AMQP_ENABLED') !== 'false',
      &#125;),
    &#125;),
  ],
&#125;)
export class AppModule &#123;&#125;</app-code>

    <p>The factory may also return an array for multi-broker setups:</p>

    <app-code lang="ts">useFactory: (config: ConfigService) =&gt; [
  &#123; name: 'primary',   url: config.get('PRIMARY_URL')! &#125;,
  &#123; name: 'analytics', url: config.get('ANALYTICS_URL')! &#125;,
],</app-code>

    <h3>forRootAsync — via a factory class</h3>

    <app-code lang="ts">&#64;Injectable()
export class AmqpOptionsProvider implements AmqpOptionsFactory &#123;
  constructor(private readonly config: ConfigService) &#123;&#125;

  createAmqpOptions(): SingleBrokerOptions &#123;
    return &#123;
      url: this.config.get('AMQP_URL')!,
    &#125;;
  &#125;
&#125;

AmqpModule.forRootAsync(&#123;
  imports: [ConfigModule],
  useClass: AmqpOptionsProvider,
&#125;)</app-code>

    <h3>BrokerOptions reference</h3>

    <table>
      <thead>
        <tr><th>Option</th><th>Default</th><th>Meaning</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><code>name</code></td>
          <td><em>(required)</em></td>
          <td>Unique logical identifier referenced by decorators
            (<code>&#64;Consume('addr', 'name')</code>) and the DLQ admin URL.</td>
        </tr>
        <tr><td><code>url</code></td><td><em>(required)</em></td><td>Broker URL (<code>amqp://</code> or <code>amqps://</code>).</td></tr>
        <tr>
          <td><code>enabled</code></td>
          <td><code>true</code></td>
          <td>Per-broker kill switch. <code>false</code> &rarr; this broker loads but is inactive (no
            connection, its consumers not wired, <code>send()</code> errors, <code>emit()</code> returns
            <code>false</code>). Useful for local dev without a running broker, or to disable one broker
            in a multi-broker setup (the others stay live).</td>
        </tr>
        <tr><td><code>username</code></td><td><em>(unset)</em></td><td>SASL PLAIN username.</td></tr>
        <tr><td><code>password</code></td><td><em>(unset)</em></td><td>SASL PLAIN password.</td></tr>
        <tr><td><code>reconnectLimit</code></td><td><code>-1</code></td><td>Reconnect attempts; <code>-1</code> = forever.</td></tr>
        <tr><td><code>initialReconnectDelayMs</code></td><td><code>100</code></td><td>First retry delay; doubles up to <code>maxReconnectDelayMs</code>.</td></tr>
        <tr><td><code>maxReconnectDelayMs</code></td><td><code>30000</code></td><td>Ceiling for the exponential backoff.</td></tr>
        <tr><td><code>idleTimeoutMs</code></td><td><code>60000</code></td><td>Heartbeat / idle detection.</td></tr>
        <tr><td><code>defaultSendTimeoutMs</code></td><td><code>30000</code></td><td>Default reply timeout for <code>send()</code>.</td></tr>
        <tr>
          <td><code>replyStreamAddress</code></td>
          <td><em>(unset)</em></td>
          <td><strong>Required if you use <code>send()</code></strong> on this broker — must be
            pre-declared as a stream queue. Absent → <code>send()</code> throws
            <code>AmqpConnectionError</code>; <code>emit()</code> and <code>&#64;Consume</code> work
            unchanged. See <a routerLink="/request-reply">Request / reply</a>.</td>
        </tr>
        <tr>
          <td><code>defaultDlqAddress</code></td>
          <td><em>(unset)</em></td>
          <td><strong>Optional</strong>. The DLQ admin UI pre-fills this address when opening a session.
            The lib never publishes to it itself — it only <code>delivery.reject()</code>, the broker
            routes via its own DLX. See <a routerLink="/retry-and-dlq">Retry &amp; DLQ</a>.</td>
        </tr>
        <tr>
          <td><code>bodyCodec</code></td>
          <td><code>JsonBodyCodec</code></td>
          <td>Custom wire codec for this broker. See the <a routerLink="/serialization">Serialization</a> page.</td>
        </tr>
      </tbody>
    </table>

    <h3>Disabled mode — booting without a broker</h3>
    <p>
      Pass <code>enabled: false</code> on a broker to load it in inactive mode. The app starts cleanly,
      no connection is opened for that broker, its <code>&#64;Consume</code> / <code>&#64;Subscribe</code>
      handlers are not wired, <code>emit()</code> on its handles returns <code>false</code>, and
      <code>send()</code> errors immediately with <code>AmqpConnectionError</code>. This is the
      recommended way to work offline (PR review, unit tests, local dev without docker). In a
      multi-broker setup, you can disable individual brokers without affecting the others.
    </p>

    <div class="callout danger">
      <strong>⚠ Pre-declaration of every destination is mandatory.</strong> The shared reply stream (if
      <code>send()</code> is used), every <code>&#64;Consume</code> queue, every
      <code>&#64;Subscribe</code> stream, the DLX and the DLQ all must exist on the broker before
      the app starts. The library does not call any Management API — missing topology =
      <code>amqp:not-found</code> at link-open time. See the
      <a routerLink="/broker-topology">Broker topology</a> page for full examples.
    </div>
  `,
})
export class ConfigurationComponent {}
