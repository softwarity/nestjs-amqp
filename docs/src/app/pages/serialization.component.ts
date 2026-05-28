import { Component } from '@angular/core';
import { CodeComponent } from '../code/code.component';

@Component({
  selector: 'app-serialization',
  imports: [CodeComponent],
  template: `
    <h2>Serialization / Deserialization</h2>

    <p>
      The library serializes JS values to the bytes that travel on AMQP and deserializes them on the
      consume side. The pluggable layer is called a <strong>wire codec</strong>: it implements
      <code>encode(value): unknown</code> and <code>decode(body): unknown</code>. The default
      (<code>JsonBodyCodec</code>) is JSON-based with extras for <code>Date</code> and
      <code>ObjectId</code> round-trip; you can swap it <strong>per broker</strong> via the
      <code>bodyCodec</code> option (useful if your primary broker speaks JSON and your analytics
      broker speaks msgpack, for example).
    </p>

    <p>
      <strong>Symptoms that point here:</strong> <code>Date</code> instances arriving as ISO strings,
      <code>ObjectId</code> arriving as <code>&#123; $oid: '...' &#125;</code> instead of a real
      instance, BigInt being lost silently, custom types not surviving the round-trip,
      <code>Buffer</code> bodies not being parsed as JSON, etc.
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
          <td>✅ auto-detected: <code>mongoose</code> &gt; <code>bson</code> &gt; marker object</td>
        </tr>
      </tbody>
    </table>

    <p>
      Marker names match MongoDB Extended JSON (EJSON) — anyone who has debugged a BSON dump will
      recognise them.
    </p>

    <div class="callout">
      <strong>ObjectId auto-rehydration.</strong> If <code>mongoose</code> is installed in your host
      project, <code>$oid</code> on the wire becomes a real <code>Types.ObjectId</code> instance on
      decode. If not, the lib falls back to <code>bson</code>'s <code>ObjectId</code>. If neither is
      installed, you get the marker object <code>&#123; $oid: '&lt;hex&gt;' &#125;</code>. Both packages
      are optional peer deps — no install required.
    </div>

    <h3>Bringing your own codec — per broker</h3>

    <p>Implement the <code>AmqpBodyCodec</code> interface and attach it to whichever broker you want:</p>

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

AmqpModule.forRoot([
  &#123;
    name: 'primary',
    url: 'amqp://primary',
    // No bodyCodec → default JSON codec
  &#125;,
  &#123;
    name: 'analytics',
    url: 'amqp://analytics',
    bodyCodec: new MsgpackCodec(),    // ← per-broker codec
  &#125;,
]);</app-code>

    <h3>Extending the default codec — keep JSON, tweak ObjectId</h3>

    <p>
      Subclass <code>JsonBodyCodec</code> and override the protected <code>restoreOid(hex)</code> hook
      to control how <code>$oid</code> markers are rehydrated. For example, force the marker form
      regardless of installed deps:
    </p>

    <app-code lang="ts">import &#123; JsonBodyCodec &#125; from '&#64;softwarity/nestjs-amqp';

export class MarkerOidCodec extends JsonBodyCodec &#123;
  protected restoreOid(hex: string): unknown &#123;
    return &#123; $oid: hex &#125;;   // never rehydrate, even if mongoose is installed
  &#125;
&#125;</app-code>

    <p>Or wrap to a custom type:</p>

    <app-code lang="ts">export class TaggedOidCodec extends JsonBodyCodec &#123;
  protected restoreOid(hex: string): unknown &#123;
    return new MyObjectId(hex);
  &#125;
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
      Codec scope is <strong>per broker</strong>. Two brokers can disagree on the wire format —
      typical case: primary speaks JSON (debuggable on the wire), analytics speaks msgpack (compact for
      high volume). Inside a single broker the format must be consistent: producers and consumers on the
      same address must agree, otherwise you get garbled bodies. The default JSON codec is the safe
      starting point.
    </p>
  `,
})
export class SerializationComponent {}
