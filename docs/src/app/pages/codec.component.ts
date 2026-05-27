import { Component } from '@angular/core';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-codec',
  imports: [CodeComponent],
  template: `
    <h2>Wire codec</h2>

    <p>
      The wire codec converts JS values to the bytes that travel on AMQP, and vice-versa. The library
      ships a default JSON codec (<code>JsonBodyCodec</code>) and exposes a swap point via the
      <code>bodyCodec</code> module option.
    </p>

    <h3>Default codec — JSON with rich-type markers</h3>

    <p>The default codec encodes/decodes as UTF-8 JSON and round-trips two BSON-flavoured types:</p>

    <table>
      <thead><tr><th>JS type</th><th>Wire form</th><th>Encode</th><th>Decode</th></tr></thead>
      <tbody>
        <tr>
          <td><code>Date</code></td>
          <td><code>&#123; "$date": "&lt;ISO&gt;" &#125;</code></td>
          <td>✅ via <code>toISOString()</code></td>
          <td>✅ back to <code>new Date(...)</code></td>
        </tr>
        <tr>
          <td><code>ObjectId</code>-like</td>
          <td><code>&#123; "$oid": "&lt;hex&gt;" &#125;</code></td>
          <td>✅ via duck typing on <code>_bsontype</code></td>
          <td>❌ left as <code>&#123; $oid: hex &#125;</code> (no mongoose dep)</td>
        </tr>
      </tbody>
    </table>

    <p>
      Marker names match MongoDB Extended JSON (EJSON) — anyone who has debugged a BSON dump will
      recognise them.
    </p>

    <div class="callout">
      <strong>Why not decode <code>$oid</code> to a real ObjectId?</strong> Because the library can't
      depend on <code>mongoose</code> or <code>bson</code> — it would force every user to install one of
      them. If you want real <code>ObjectId</code> instances on the consume side, provide a custom codec
      (see below).
    </div>

    <h3>Bringing your own codec</h3>

    <p>Implement the <code>AmqpBodyCodec</code> interface:</p>

    <app-code lang="ts">import &#123; AmqpBodyCodec &#125; from '&#64;softwarity/nestjs-amqp';

class MsgpackCodec implements AmqpBodyCodec &#123;
  encode(value: unknown): Buffer &#123;
    return msgpack.encode(value);
  &#125;

  decode(body: unknown): unknown &#123;
    if (Buffer.isBuffer(body)) return msgpack.decode(body);
    return body;
  &#125;
&#125;

AmqpModule.forRoot(&#123;
  appName: 'my-service',
  bodyCodec: new MsgpackCodec(),
&#125;);</app-code>

    <h3>Extending the default codec — mongoose ObjectId rehydration</h3>

    <app-code lang="ts">import &#123; Types &#125; from 'mongoose';
import &#123; JsonBodyCodec &#125; from '&#64;softwarity/nestjs-amqp';

export class MongooseAwareCodec extends JsonBodyCodec &#123;
  decode(body: unknown): unknown &#123;
    return rehydrateOids(super.decode(body));
  &#125;
&#125;

function rehydrateOids(v: unknown): unknown &#123;
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(rehydrateOids);
  const obj = v as Record&lt;string, unknown&gt;;
  const keys = Object.keys(obj);
  if (keys.length === 1 &amp;&amp; keys[0] === '$oid' &amp;&amp; typeof obj['$oid'] === 'string') &#123;
    return new Types.ObjectId(obj['$oid']);
  &#125;
  const out: Record&lt;string, unknown&gt; = &#123;&#125;;
  for (const [k, val] of Object.entries(obj)) out[k] = rehydrateOids(val);
  return out;
&#125;</app-code>

    <h3>What about Map / Set / RegExp / BigInt?</h3>

    <p>
      The default codec doesn't preserve them — <code>JSON.stringify</code> would emit silently broken
      shapes. Subclass <code>JsonBodyCodec</code> or implement <code>AmqpBodyCodec</code> from scratch
      and add markers for the types you care about (<code>$set</code>, <code>$map</code>,
      <code>$bigint</code>, …). See the default implementation in <code>src/body-codec.ts</code> for the
      pattern.
    </p>

    <h3>The AmqpBodyCodec interface</h3>

    <app-code lang="ts">interface AmqpBodyCodec &#123;
  /** Encode a JS value to whatever rhea will ship as message.body
   *  (typically a UTF-8 string or a Buffer). */
  encode(value: unknown): unknown;

  /** Decode an incoming message.body. rhea passes string | Buffer | object. */
  decode(body: unknown): unknown;
&#125;</app-code>

    <p>
      The codec is set globally at module init. Per-handler or per-publisher codecs are not supported —
      it would make the wire ambiguous (two consumers on the same address could disagree on the format).
    </p>
  `,
})
export class CodecComponent {}
