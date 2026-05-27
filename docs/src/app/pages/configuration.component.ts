import { Component } from '@angular/core';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-configuration',
  imports: [CodeComponent],
  template: `
    <h2>Configuration</h2>

    <p>
      The module accepts options either statically (<code>forRoot</code>) or asynchronously
      (<code>forRootAsync</code>, with a factory pulling from <code>ConfigService</code> or any other
      source). Every option has a sane default; you can call <code>AmqpModule.forRoot()</code> with no
      argument and get a working module pointed at <code>amqp://localhost:5672</code>.
    </p>

    <h3>forRoot — static options</h3>

    <app-code lang="ts">AmqpModule.forRoot(&#123;
  appName: 'my-service',
  url: 'amqp://localhost:5672',
  username: 'guest',
  password: 'guest',
  reconnectLimit: -1,            // infinite
  idleTimeoutMs: 60_000,
  defaultSendTimeoutMs: 30_000,
&#125;)</app-code>

    <h3>forRootAsync — config from ConfigService</h3>

    <app-code lang="ts">import &#123; ConfigModule, ConfigService &#125; from '&#64;nestjs/config';
import &#123; AmqpModule &#125; from '&#64;softwarity/nestjs-amqp';

&#64;Module(&#123;
  imports: [
    AmqpModule.forRootAsync(&#123;
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) =&gt; (&#123;
        appName: config.get('APP_NAME'),
        url: config.get('AMQP_URL'),
        username: config.get('AMQP_USER'),
        password: config.get('AMQP_PASSWORD'),
      &#125;),
    &#125;),
  ],
&#125;)
export class AppModule &#123;&#125;</app-code>

    <h3>forRootAsync — via a factory class</h3>

    <app-code lang="ts">&#64;Injectable()
export class AmqpOptionsProvider implements AmqpOptionsFactory &#123;
  constructor(private readonly config: ConfigService) &#123;&#125;

  createAmqpOptions(): AmqpModuleOptions &#123;
    return &#123;
      appName: this.config.get('APP_NAME'),
      url: this.config.get('AMQP_URL'),
    &#125;;
  &#125;
&#125;

AmqpModule.forRootAsync(&#123;
  imports: [ConfigModule],
  useClass: AmqpOptionsProvider,
&#125;)</app-code>

    <h3>Full reference</h3>

    <table>
      <thead>
        <tr><th>Option</th><th>Default</th><th>Meaning</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><code>appName</code></td>
          <td><em>(empty)</em></td>
          <td>Drives default <code>replyStreamAddress</code> (<code>&lt;appName&gt;.replies</code>),
            <code>defaultDlqAddress</code> (<code>&lt;appName&gt;.dlq</code>), and the AMQP container ID.</td>
        </tr>
        <tr>
          <td><code>enabled</code></td>
          <td><code>true</code></td>
          <td>Master switch. <code>false</code> &rarr; module loads but is inactive (no connection,
            <code>&#64;Subscribe</code> not wired, <code>send()</code> errors, <code>emit()</code> is a silent
            no-op). Useful for local dev without a broker.</td>
        </tr>
        <tr><td><code>url</code></td><td><code>amqp://localhost:5672</code></td><td>Broker URL (<code>amqps://</code> for TLS).</td></tr>
        <tr><td><code>username</code></td><td><em>(unset)</em></td><td>SASL PLAIN username.</td></tr>
        <tr><td><code>password</code></td><td><em>(unset)</em></td><td>SASL PLAIN password.</td></tr>
        <tr><td><code>reconnectLimit</code></td><td><code>-1</code></td><td>Reconnect attempts; <code>-1</code> = forever.</td></tr>
        <tr><td><code>initialReconnectDelayMs</code></td><td><code>100</code></td><td>First retry delay; doubles up to <code>maxReconnectDelayMs</code>.</td></tr>
        <tr><td><code>maxReconnectDelayMs</code></td><td><code>30000</code></td><td>Ceiling for the exponential backoff.</td></tr>
        <tr><td><code>idleTimeoutMs</code></td><td><code>60000</code></td><td>Heartbeat / idle detection.</td></tr>
        <tr><td><code>defaultSendTimeoutMs</code></td><td><code>30000</code></td><td>Default reply timeout for <code>send()</code>.</td></tr>
        <tr>
          <td><code>replyStreamAddress</code></td>
          <td><code>&lt;appName&gt;.replies</code></td>
          <td>Shared reply stream — <strong>must be pre-declared as a stream queue</strong>. If unset and
            no <code>appName</code>, <code>send()</code> is unavailable (use <code>emit()</code> only).</td>
        </tr>
        <tr>
          <td><code>defaultDlqAddress</code></td>
          <td><code>&lt;appName&gt;.dlq</code></td>
          <td>Default DLQ used by <code>DlqBrowserService</code> when no address is passed.</td>
        </tr>
        <tr>
          <td><code>autoPrefixQueues</code></td>
          <td><code>true</code></td>
          <td>Auto-prefix bare addresses with <code>/queues/</code> (RabbitMQ 4.x v2 addressing). Disable for
            Artemis/Qpid/Azure SB.</td>
        </tr>
        <tr>
          <td><code>bodyCodec</code></td>
          <td><code>JsonBodyCodec</code></td>
          <td>Custom wire codec. See the <em>Wire codec</em> page.</td>
        </tr>
      </tbody>
    </table>

    <h3>Disabled mode — booting without a broker</h3>
    <p>
      Pass <code>enabled: false</code> to load the module in inactive mode. The app starts cleanly, no
      connection is opened, <code>&#64;Subscribe</code> handlers are not wired, <code>emit()</code> is a
      silent no-op, and <code>send()</code> errors immediately with <code>AmqpConnectionError</code>. This
      is the recommended way to work offline (PR review, unit tests, local dev without docker).
    </p>

    <div class="callout warn">
      <strong>Stream pre-declaration is mandatory.</strong> The shared reply stream and any
      <code>&#64;SubscribeTopic</code> address must exist on the broker before the app starts —
      typically via a <code>definitions.json</code> mounted on RabbitMQ. The library does not call the
      Management API.
    </div>
  `,
})
export class ConfigurationComponent {}
