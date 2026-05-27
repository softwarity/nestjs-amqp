# @softwarity/nestjs-amqp

[![npm version](https://img.shields.io/npm/v/@softwarity/nestjs-amqp.svg)](https://www.npmjs.com/package/@softwarity/nestjs-amqp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/node/v/@softwarity/nestjs-amqp.svg)](https://nodejs.org)

**AMQP 1.0 integration for NestJS, powered by [rhea](https://github.com/amqp/rhea).** A thin, RxJS-friendly wrapper that exposes decorator-based publishers and consumers — designed for RabbitMQ 4.x (native AMQP 1.0), Apache ActiveMQ Artemis, Apache Qpid, and Azure Service Bus.

📚 **Full documentation:** [softwarity.github.io/nestjs-amqp](https://softwarity.github.io/nestjs-amqp/)

---

> ## ⚠ Read this before your first deploy
>
> **This library does NOT create topology at runtime.** It opens senders and receivers on destinations that **must already exist** on the broker — queues, streams, exchanges, DLX bindings, the lot. Missing topology = silent failure (the AMQP link is rejected with `amqp:not-found`; the rest of the connection stays up and the app looks healthy).
>
> Declare everything broker-side via a definitions file or an IaC script. Full examples for **RabbitMQ 4.x** (`definitions.json` + docker-compose), **ActiveMQ Artemis** (`broker.xml`), **Azure Service Bus** (Azure CLI), and **Apache Qpid** are in [Broker topology](#broker-topology) below and on the [doc site](https://softwarity.github.io/nestjs-amqp/#/broker-topology).

---

## Why?

`@nestjs/microservices` only covers AMQP 0.9.1 (via `amqplib`). When you want **AMQP 1.0** features — long-lived sessions, link credit, source filters, message annotations, stream consumers — `rhea` is the canonical Node.js client. This library wraps rhea so the rest of your codebase only sees `@AmqpQueue`, `@Subscribe`, and Observables.

## Features

- 🎯 **Decorator-based** publishers (`@AmqpQueue`, `@AmqpTopic`) and consumers (`@Subscribe`, `@SubscribeTopic`)
- 🔄 **Request/Reply** via per-process correlation prefix on a shared reply stream
- 📡 **Broadcast/PubSub** via RabbitMQ streams (`@SubscribeTopic`)
- 🔁 **Built-in retry policy** (`maxDelivery`, `dlq`) on work-queue consumers
- 💀 **Optional DLQ browser** — paginate, replay, drop dead-lettered messages
- 🧬 **Pluggable wire codec** — JSON by default with `Date` round-trip; bring your own (msgpack, protobuf, …)
- 🔧 **`forRoot` / `forRootAsync`** configuration
- ⚛️ **RxJS-native** — no Promise wrapper, no axios-style imperative shapes

## Installation

```bash
npm install @softwarity/nestjs-amqp rhea
# peer deps you probably already have
npm install @nestjs/common @nestjs/core rxjs reflect-metadata
```

## Quick start

### 1. Register the module

```ts
import { Module } from '@nestjs/common';
import { AmqpModule } from '@softwarity/nestjs-amqp';

@Module({
  imports: [
    AmqpModule.forRoot({
      appName: 'my-service',           // -> default replyStream: 'my-service.replies', default DLQ: 'my-service.dlq'
      url: 'amqp://localhost:5672',
      username: 'guest',
      password: 'guest',
    }),
  ],
})
export class AppModule {}
```

Or async, pulling from `ConfigService`:

```ts
AmqpModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    appName: config.get('APP_NAME'),
    url: config.get('AMQP_URL'),
    username: config.get('AMQP_USER'),
    password: config.get('AMQP_PASSWORD'),
  }),
})
```

### 2. Consume

```ts
import { Injectable } from '@nestjs/common';
import { EMPTY, Observable, of } from 'rxjs';
import {
  Subscribe,
  SubscribeTopic,
  AmqpBody,
  AmqpDeliveryCount,
  AmqpSettler,
  type AmqpSettler as AmqpSettlerType,
} from '@softwarity/nestjs-amqp';

@Injectable()
export class OrdersListener {
  // Work-queue, default: 1 attempt, drop silently on error.
  // Single un-annotated arg → implicitly bound as @AmqpBody().
  @Subscribe('orders.created')
  onCreated(order: OrderBody): void {
    this.svc.handle(order);
  }

  // Observable<T> with msg.reply_to -> auto-replies to the sender
  @Subscribe('queries.balance')
  onBalance(q: BalanceQuery): Observable<BalanceResponse> {
    return of({ amount: 42 });
  }

  // Retry up to 5 times then DLQ
  @Subscribe('payments.process', { maxDelivery: 5, dlq: true })
  onPayment(
    @AmqpBody() body: Payment,
    @AmqpDeliveryCount() count: number,
    @AmqpSettler() settle: AmqpSettlerType,
  ): Observable<Result> {
    if (body.amount < 0) {
      settle.reject({ condition: 'amqp:precondition-failed', description: 'negative amount' });
      return EMPTY;
    }
    return this.svc.process(body);
  }

  // Topic / broadcast consumer - every instance receives every message
  @SubscribeTopic('changes.bulletin')
  onBulletinChanged(@AmqpBody() change: BulletinChange): void {
    this.realtimeBus.publish(change);
  }
}
```

### 3. Publish

```ts
import { Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AmqpQueue, AmqpTopic } from '@softwarity/nestjs-amqp';

interface BulletinChangedEvent {
  bulletinId: string;
  when: string;
}

@Injectable()
export class OrdersService {
  // Work-queue handle, generic on the payload type. Supports send() + emit().
  @AmqpQueue('orders.create')
  private readonly orders!: AmqpQueue<OrderBody>;

  // Topic handle, generic on the payload type. Only emit().
  @AmqpTopic('changes.bulletin')
  private readonly changes!: AmqpTopic<BulletinChangedEvent>;

  createOrder(body: OrderBody): Observable<OrderConfirmation> {
    return this.orders.send<OrderConfirmation>(body, {
      timeoutMs: 5000,
      properties: { message_id: body.id, subject: 'order.create.v2' },
      applicationProperties: { tenantId: body.tenantId },
    });
  }

  notifyBulletinChanged(bulletinId: string): void {
    this.changes.emit({ bulletinId, when: new Date().toISOString() });
    // this.changes.emit({ foo: 'bar' });   ❌ TS error: not assignable to BulletinChangedEvent
    // this.changes.send(...)               ❌ TS error: AmqpTopic has no send()
  }
}
```

## Broker topology

> 🚨 **Topology must exist before the app starts.** This library never declares queues, streams, or exchanges at runtime, and never calls the broker Management API. Pre-declare everything broker-side. Below is what you need, then per-broker examples.

### What you need to declare

| For… | You need |
|---|---|
| Each `@Subscribe(addr)` | A **classic or quorum queue** at `addr`. Add `x-dead-letter-exchange` + `x-dead-letter-routing-key` if you set `dlq: true`. |
| Each `@SubscribeTopic(addr)` (RabbitMQ) | A **stream queue** at `addr` with an appropriate `x-max-age`. |
| Any use of `send()` (request/reply) | A **stream queue** at `replyStreamAddress` (default `<appName>.replies`). Short `x-max-age` (e.g. `5m`) is fine — replies are consumed almost immediately. |
| Any consumer with `dlq: true` | A **DLX** (typically direct) + one or more **DLQs** (typically quorum) bound to it. |

### RabbitMQ 4.x (recommended)

Native AMQP 1.0 since 4.0, streams, quorum queues, v2 addressing on by default. Mount a `definitions.json` and let the broker do the work at boot. Topology becomes a normal git-tracked file.

**`docker/rabbitmq/definitions.json`** — complete example for a service named `my-service` with three work-queues, one broadcast topic, the shared reply stream, and a catch-all DLQ:

```json
{
  "rabbit_version": "4.0.0",

  "users": [
    {
      "name": "my-service",
      "password": "change-me",
      "tags": ""
    }
  ],

  "vhosts": [
    { "name": "/" }
  ],

  "permissions": [
    {
      "user": "my-service",
      "vhost": "/",
      "configure": ".*",
      "write": ".*",
      "read": ".*"
    }
  ],

  "exchanges": [
    {
      "name": "my-service.dlx",
      "vhost": "/",
      "type": "direct",
      "durable": true,
      "auto_delete": false,
      "internal": false,
      "arguments": {}
    }
  ],

  "queues": [
    {
      "name": "orders.created",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": {
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": "my-service.dlx",
        "x-dead-letter-routing-key": "orders.created"
      }
    },
    {
      "name": "orders.shipped",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": {
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": "my-service.dlx",
        "x-dead-letter-routing-key": "orders.shipped"
      }
    },
    {
      "name": "payments.process",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": {
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": "my-service.dlx",
        "x-dead-letter-routing-key": "payments.process"
      }
    },

    {
      "name": "my-service.dlq",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": {
        "x-queue-type": "quorum"
      }
    },

    {
      "name": "my-service.replies",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": {
        "x-queue-type": "stream",
        "x-max-age": "5m"
      }
    },

    {
      "name": "changes.bulletin",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": {
        "x-queue-type": "stream",
        "x-max-age": "1h"
      }
    }
  ],

  "bindings": [
    {
      "source": "my-service.dlx",
      "vhost": "/",
      "destination": "my-service.dlq",
      "destination_type": "queue",
      "routing_key": "orders.created",
      "arguments": {}
    },
    {
      "source": "my-service.dlx",
      "vhost": "/",
      "destination": "my-service.dlq",
      "destination_type": "queue",
      "routing_key": "orders.shipped",
      "arguments": {}
    },
    {
      "source": "my-service.dlx",
      "vhost": "/",
      "destination": "my-service.dlq",
      "destination_type": "queue",
      "routing_key": "payments.process",
      "arguments": {}
    }
  ]
}
```

**`docker/rabbitmq/rabbitmq.conf`**:

```
management.load_definitions = /etc/rabbitmq/definitions.json
consumer_timeout = 1800000   # 30 min — keep > DLQ-browser hard TTL (25 min)
```

**`docker-compose.yml`**:

```yaml
services:
  rabbitmq:
    image: rabbitmq:4-management
    ports:
      - "5672:5672"     # AMQP 1.0
      - "15672:15672"   # Management UI
    volumes:
      - ./docker/rabbitmq/definitions.json:/etc/rabbitmq/definitions.json:ro
      - ./docker/rabbitmq/rabbitmq.conf:/etc/rabbitmq/rabbitmq.conf:ro
      - rabbitmq-data:/var/lib/rabbitmq
volumes:
  rabbitmq-data:
```

> ⚠ **Destructive changes**: queue types are immutable. Changing classic → quorum → stream requires deleting the queue first (Management UI / API) before re-importing the definitions. In dev: `docker compose down -v && docker compose up -d`.

### Apache ActiveMQ Artemis

Artemis speaks AMQP 1.0 natively on port 5672. Topology lives in `broker.xml`. **Use `autoPrefixQueues: false`** — Artemis uses bare names.

```xml
<configuration>
  <core>
    <addresses>
      <address name="orders.created">
        <anycast>
          <queue name="orders.created"><durable>true</durable></queue>
        </anycast>
      </address>

      <address name="my-service.dlq">
        <anycast>
          <queue name="my-service.dlq"><durable>true</durable></queue>
        </anycast>
      </address>

      <!-- Broadcast (multicast = pub/sub) -->
      <address name="changes.bulletin">
        <multicast/>
      </address>
    </addresses>

    <address-settings>
      <address-setting match="orders.#">
        <dead-letter-address>my-service.dlq</dead-letter-address>
        <max-delivery-attempts>5</max-delivery-attempts>
      </address-setting>
    </address-settings>
  </core>
</configuration>
```

**Key differences from RabbitMQ:**

- **No streams.** Broadcast uses `multicast` addresses — each receiver gets its own auto-deleted subscription queue on attach.
- **Reply queue**: a regular durable (anycast) queue instead of a stream. Correlation works the same way, but only one instance receives each reply. For multi-instance services, declare one reply queue per instance or use a multicast address.
- **DLQ semantics**: Artemis tracks attempts via `max-delivery-attempts` on the address-setting. Coordinate with the library's `maxDelivery` (set Artemis higher so the library's policy wins).

### Azure Service Bus

Fully AMQP 1.0 native. **Use `autoPrefixQueues: false`**. Connection URL: `amqps://<namespace>.servicebus.windows.net:5671`. Auth via SAS token or AAD.

```bash
RG=my-rg
NS=my-namespace
LOC=westeurope

az group create --name $RG --location $LOC

az servicebus namespace create --name $NS --resource-group $RG \
  --location $LOC --sku Standard   # Standard required for topics

# Work queues (each gets an automatic $DeadLetterQueue sub-queue)
az servicebus queue create --resource-group $RG --namespace-name $NS \
  --name orders.created --max-delivery-count 5
az servicebus queue create --resource-group $RG --namespace-name $NS \
  --name payments.process --max-delivery-count 5

# Reply queue (anycast, one per consumer instance)
az servicebus queue create --resource-group $RG --namespace-name $NS \
  --name my-service.replies --default-message-time-to-live PT5M

# Broadcast: topic + one subscription per consumer instance
az servicebus topic create --resource-group $RG --namespace-name $NS \
  --name changes.bulletin
az servicebus topic subscription create --resource-group $RG \
  --namespace-name $NS --topic-name changes.bulletin --name my-service-inst-1
```

**Key differences:**

- **Built-in dead-letter** — every queue/subscription gets a `$DeadLetterQueue` sub-queue at `<queue>/$DeadLetterQueue`. No DLX/binding declaration needed.
- **No streams** — use a regular queue for replies, topics+subscriptions for broadcast.
- **Subscription address** for `@SubscribeTopic`: `<topic>/Subscriptions/<sub-name>`.
- **SKU matters** — topics require Standard or Premium.

### Apache Qpid Broker-J

AMQP 1.0 native. Topology in `config.json` (or the web console at port 8080). Supports queues + exchanges similar to RabbitMQ classic queues — **no streams**. Use `autoPrefixQueues: false`.

Good fit for pure work-queue workloads. For `@SubscribeTopic`-style broadcast or stream-backed reply correlation, fall back to per-instance queues + topic-exchange bindings, or use RabbitMQ where stream semantics matter.

### Verification at boot — optional

This library doesn't ping the Management API. If you want a sanity check that the broker is in the expected state, do it in an `OnApplicationBootstrap` hook of your own:

- **RabbitMQ** — `GET /api/queues/%2F/<queue>` on the Management API.
- **Azure SB** — `@azure/service-bus-management` SDK (`queueExists()`, `topicExists()`).
- **Artemis** — JMX / Jolokia REST endpoint.

Production deployments should fail loudly at infra provisioning time (Terraform plan, Helm upgrade, definitions import), not silently at app startup.

---

## Configuration reference

| Option | Default | Meaning |
|---|---|---|
| `appName` | `''` | Drives default `replyStreamAddress` (`<appName>.replies`), `defaultDlqAddress` (`<appName>.dlq`), and the AMQP container ID. |
| `enabled` | `true` | Master switch. `false` → module loads but is inactive (no broker connection, `@Subscribe` not wired, `send()` errors, `emit()` is a silent no-op). |
| `url` | `amqp://localhost:5672` | Broker URL (`amqps://` for TLS). |
| `username` | _unset_ | SASL PLAIN username. |
| `password` | _unset_ | SASL PLAIN password. |
| `reconnectLimit` | `-1` | Reconnect attempts; `-1` = forever. |
| `initialReconnectDelayMs` | `100` | First retry delay; doubles up to max. |
| `maxReconnectDelayMs` | `30000` | Ceiling for the exponential backoff. |
| `idleTimeoutMs` | `60000` | Heartbeat / idle detection. |
| `defaultSendTimeoutMs` | `30000` | Default reply timeout for `send()`. |
| `replyStreamAddress` | `<appName>.replies` | Address of the shared reply stream. **Must be pre-declared as a stream queue.** If unset and no `appName`, `send()` is unavailable. |
| `defaultDlqAddress` | `<appName>.dlq` | Default DLQ for the `DlqBrowserService`. |
| `autoPrefixQueues` | `true` | Auto-prefix bare addresses with `/queues/` (RabbitMQ 4.x v2 addressing). |
| `bodyCodec` | `JsonBodyCodec` | Custom wire codec (msgpack, protobuf, mongoose ObjectId, …). See [Codec](#codec). |

## Publisher decorators — `@AmqpQueue` & `@AmqpTopic`

Property decorators. First access resolves the publisher singleton; subsequent accesses reuse a memoised handle. Throws if accessed before the AMQP module has finished `OnModuleInit` (typically only an issue in service constructors — defer to methods or `OnApplicationBootstrap`).

Both interfaces are **generic on the payload type** `T` (defaults to `unknown`). Declare the queue or topic with its event shape and every `emit()` / `send()` call site is type-checked at compile time. The generic is purely a compile-time contract — at runtime every payload reaches the JSON codec the same way.

### `@AmqpQueue(address)` → `AmqpQueue<T>`

For **work-queues**. Exposes both `send()` and `emit()`.

```ts
interface AmqpQueue<T = unknown> {
  send<TRes>(payload: T, options?: SendOptions): Observable<TRes>;
  emit(payload: T, options?: EmitOptions): void;
}
```

```ts
@AmqpQueue('orders.create')
private readonly orders!: AmqpQueue<OrderBody>;

this.orders.emit(body);                 // ✅ checked against OrderBody
this.orders.send<Confirmation>(body);   // ✅ payload typed; TRes per call
// this.orders.emit({ foo: 'bar' });    ❌ TS error
```

The second generic `TRes` on `send()` is supplied per call site — different requests on the same queue can return different reply shapes.

### `@AmqpTopic(address)` → `AmqpTopic<T>`

For **topics** (stream-backed broadcast). Only `emit()` — calling `send()` is a compile-time TypeScript error.

```ts
interface AmqpTopic<T = unknown> {
  emit(payload: T, options?: EmitOptions): void;
}
```

```ts
@AmqpTopic('changes.bulletin')
private readonly changes!: AmqpTopic<BulletinChangedEvent>;

this.changes.emit({ bulletinId, when });   // ✅
// this.changes.send(...);                  ❌ TS error: AmqpTopic has no send()
```

### `SendOptions` / `EmitOptions`

| Option | Used by | Meaning |
|---|---|---|
| `timeoutMs` | `send` | Override the default. Errors with `AmqpTimeoutError`. |
| `properties` | both | AMQP standard properties (`message_id`, `subject`, `content_type`, `creation_time`, `user_id`, …). `reply_to` and `correlation_id` are managed internally. |
| `applicationProperties` | both | Custom `Record<string, unknown>` — tenant ID, trace ID, etc. |

## Consumer decorators — `@Subscribe` & `@SubscribeTopic`

Both walk every provider via `DiscoveryService` + `MetadataScanner` at module-init, find decorated methods, validate every parameter (with the implicit-body rule, see below), open a receiver per handler, and dispatch.

### Implicit-body rule

To keep the dominant case ergonomic, exactly **one un-annotated parameter is allowed** per handler — it is bound as if you had written `@AmqpBody()`. The rule:

| Situation | Behaviour |
|---|---|
| All parameters annotated | Pass through — used as declared. |
| Exactly 1 un-annotated parameter | Treated as `@AmqpBody()` implicitly. |
| 2+ un-annotated parameters | **Throws at boot** — ambiguous (which one is the body?). |
| 1 un-annotated + an explicit `@AmqpBody()` elsewhere | **Throws at boot** — mixed styles refused. Pick one. |

Both styles are valid and equivalent:

```ts
// Implicit
@Subscribe('orders.created')
onCreated(order: OrderBody): void { this.svc.handle(order); }

// Explicit
@Subscribe('orders.created')
onCreated(@AmqpBody() order: OrderBody): void { this.svc.handle(order); }
```

The validation runs at module init and throws with a precise diagnostic — never silently at runtime.

### `@Subscribe(address, options?)` — work-queue consumer

Competing-consumer semantics — one message processed by exactly one consumer.

| Option | Default | Meaning |
|---|---|---|
| `maxDelivery` | `1` | Total attempts before giving up. `1` = no retry. Higher: on error, the framework `modified({delivery_failed:true})` until `deliveryCount >= maxDelivery`, then applies `dlq`. |
| `dlq` | `false` | On final failure: route to DLX (`true`) or `accept()` and drop silently (`false`). |
| `maxWindow` | `100` | AMQP credit window — max in-flight unsettled messages. |

### `@SubscribeTopic(address, options?)` — topic consumer

Broadcast / pub-sub semantics — every connected consumer receives every message. Implicitly attaches with `rabbitmq:stream-offset-spec: 'next'`.

| Option | Default | Meaning |
|---|---|---|
| `maxWindow` | `100` | AMQP credit window. |

**Why no `maxDelivery` / `dlq` here?** Streams don't redeliver via `modified(delivery_failed: true)` — they're append-only logs. If a stream handler errors, the framework `accept()`s to advance the offset (drop the message).

### Error policy (for `@Subscribe`)

```
handler throws or Observable.error fires
                |
                v
   ctx.settled === true (manual settle via @AmqpSettler) ?
        |              |
       yes             no
        |              |
        v              v
    do nothing   deliveryCount < maxDelivery ?
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
                              broker DLX
```

### Reply routing

If the handler returns a value (sync) or an `Observable` that `next`s, and the message has `reply_to`, the value is JSON-encoded and sent on `reply_to` with the original `correlation_id`.

## Parameter decorators

| Decorator | Type injected | Source |
|---|---|---|
| `@AmqpBody()` | `T` (cast at the call site) | `codec.decode(message.body)` |
| `@AmqpAddress()` | `string` | The address the `@Subscribe` was bound to |
| `@AmqpDeliveryCount()` | `number` | 1-based attempt count |
| `@AmqpHeader()` | `MessageHeader` | `message.header` |
| `@AmqpProperties()` | `MessageProperties` | Full `message.properties` |
| `@AmqpProperty(name)` | `string \| number \| undefined` | One field of `message.properties` |
| `@AmqpAppProperties()` | `Record<string, unknown>` | Full `message.application_properties` |
| `@AmqpAppProperty(name)` | `unknown` | One field of `application_properties` |
| `@AmqpSettler()` | `AmqpSettler` | `{ accept, release, reject }` — manual settle |
| `@AmqpContext()` | `AmqpContext` | Full envelope + settle helpers (escape hatch) |

### Manual settle — `@AmqpSettler`

Calling any method on the injected settler suppresses the framework's automatic policy:

| Method | Broker action | When |
|---|---|---|
| `settle.accept()` | Remove from queue (consumed) | Idempotency check — you've already done this work |
| `settle.release()` | Return to queue, no delivery_count++ | "Not for me, let someone else try" |
| `settle.reject(err)` | Route to DLX immediately | Definitive business failure — bypass `maxDelivery` |

`reject()` differs from `throw`: `throw` follows the configured `maxDelivery`/`dlq` policy; `reject()` is **immediate DLQ regardless** of remaining attempts.

## Address resolution

With `autoPrefixQueues: true` (default), bare names like `orders.created` become `/queues/orders.created` (RabbitMQ 4.x v2 addressing — required, the bare form is rejected with `amqp:invalid-field`). Already-prefixed addresses pass through unchanged:

```ts
@AmqpQueue('/exchanges/amq.topic/orders.created.high')
private readonly highPriority!: AmqpQueue;
```

For brokers that accept bare names (Artemis, Qpid, Azure SB), set `autoPrefixQueues: false`.

## Codec

The wire codec converts JS values ↔ message bodies. The default `JsonBodyCodec`:

- Encodes/decodes as UTF-8 JSON
- Round-trips `Date` instances via `{ "$date": "<ISO>" }`
- Encodes ObjectId-like values (duck-typed on `_bsontype === 'ObjectId'`) as `{ "$oid": "<hex>" }`
- **Auto-rehydrates `$oid` to a native ObjectId on decode**: probes `mongoose`
  (then `bson`) at module load and, if present, returns `new mongoose.Types.ObjectId(hex)`
  (or `new bson.ObjectId(hex)`). If neither is installed, the marker object
  `{ "$oid": "<hex>" }` is returned untouched.

This means projects using mongoose / bson get real `ObjectId` instances in
their `@Subscribe` handler payloads with zero configuration. The library
itself stays dependency-free — neither package is declared as a peer dep,
the lookup is a soft `require(pkg)` in a try-catch.

For custom rehydration (msgpack body, a non-mongoose ObjectId implementation,
keeping the raw marker, …), extend `JsonBodyCodec` and override the protected
`restoreOid(hex)` hook:

```ts
import { AmqpModule, JsonBodyCodec } from '@softwarity/nestjs-amqp';

class MarkerCodec extends JsonBodyCodec {
  // Skip auto-detection: keep `$oid` as a plain marker object for downstream
  // processing. The walk is single-pass (no second `super.decode` traversal).
  protected restoreOid(hex: string): unknown {
    return { $oid: hex };
  }
}

AmqpModule.forRoot({ appName: 'svc', bodyCodec: new MarkerCodec() });
```

The same hook lets you swap to a different ObjectId implementation, or do
type tagging:

```ts
class TaggedCodec extends JsonBodyCodec {
  protected restoreOid(hex: string): unknown {
    return { kind: 'OID', hex };
  }
}
```

## DLQ browser (optional)

Two pieces:

- `DlqBrowserService` — programmatic API. Always provided by `AmqpModule`.
- `DlqAdminModule` — HTTP controller. Opt-in.

### Programmatic use

```ts
@Injectable()
export class AdminService {
  constructor(private readonly browser: DlqBrowserService) {}

  inspect(): Observable<DlqSession> {
    return this.browser.openSession('orders.dlq', 50, 'cli-user');
  }
}
```

### HTTP endpoints

```ts
@Module({
  imports: [
    AmqpModule.forRoot({ appName: 'my-svc' }),
    DlqAdminModule,
  ],
})
export class AppModule {}
```

Exposes:

```
POST /admin/dlq/sessions                            { dlqAddress, pageSize? }
GET  /admin/dlq/sessions/:token
POST /admin/dlq/sessions/:token/next-page
POST /admin/dlq/sessions/:token/messages/:idx/replay
POST /admin/dlq/sessions/:token/messages/:idx/drop
POST /admin/dlq/sessions/:token/close
```

**⚠️ Auth not included.** The controller is unguarded — wrap with your own `Guard` (global or per-route), or sub-class and redeclare with your decorators. The `openedBy` field is read from `req.user.username ?? req.user.id ?? 'anonymous'`; plug your auth middleware so `req.user` is populated.

### Workflow

1. `POST /admin/dlq/sessions` — backend drains N messages, returns session token + held messages
2. User picks a message → `POST .../messages/:idx/replay` (publishes back to origin queue) or `.../drop` (accept only)
3. `POST .../next-page` releases the current page and drains the next
4. `POST .../close` releases everything and frees the receiver

### Lifecycle guarantees

- **5 min idle TTL** — auto-close releases held messages back to the DLQ
- **25 min hard TTL** — kept under RabbitMQ's default `consumer_timeout` (30 min)
- **Backend crash** — AMQP connection drop = broker re-queues all un-settled deliveries (free rollback)
- **`release()` semantics** — held messages keep their `delivery_count` (not counted as a failed attempt)
- **Mono-instance assumption** — session state lives in RAM. For multi-instance, configure sticky sessions or dedicate one replica.

## Errors

| Class | Where it surfaces |
|---|---|
| `AmqpConnectionError` | Connection-level issues, `send()` when AMQP is disabled or no reply stream is configured. |
| `AmqpTimeoutError` | `send()` Observable when no reply arrives in time. Carries `address`, `correlationId`, `timeoutMs`. |
| `AmqpHandlerError` | Reserved for future use. |
| `AmqpError` | Abstract base — `if (err instanceof AmqpError) …`. |

## Architecture

```
src/
├─ amqp.module.ts             Dynamic module — forRoot / forRootAsync
├─ amqp.options.ts            Options types + defaults resolution
├─ amqp.client.ts             rhea wrapper — Connection, reply stream receiver, sender pool
├─ amqp.publisher.ts          send() correlation, emit() fast-path
├─ amqp.queue.ts              @AmqpQueue / @AmqpTopic decorators + interfaces
├─ amqp.consumer-explorer.ts  @Subscribe discovery, param resolution, dispatch, error policy
├─ subscribe.decorator.ts     @Subscribe / @SubscribeTopic + metadata key
├─ amqp.param-decorators.ts   10 @Amqp*() param decorators + AmqpContext / AmqpSettler interfaces
├─ amqp.types.ts              Public types (SubscribeOptions, SendOptions, EmitOptions, …)
├─ amqp.errors.ts             AmqpError + 3 subclasses
├─ body-codec.ts              JsonBodyCodec + AmqpBodyCodec interface + setActiveBodyCodec
├─ dlq-browser.service.ts     DLQ browse / replay / drop, session lifecycle
├─ dlq-browser.types.ts       DlqSession, HeldMessage, XDeath
├─ admin/
│  ├─ dlq-admin.module.ts     Opt-in HTTP module
│  ├─ dlq-admin.controller.ts Un-guarded REST controller
│  └─ dlq.dto.ts              Request / response DTOs
├─ rhea.d.ts                  Ambient typings for rhea
└─ index.ts                   Public barrel
```

## Known limitations

- **In-flight `send()` across reconnects** — if a reconnect happens between sending and receiving the reply, the reply is lost (we re-subscribe with `streamOffset: 'next'`). The pending call times out.
- **`topic.send()` (scatter-gather RPC)** — not supported. Build aggregation in user code on top of `emit()` if needed.
- **`@SubscribeTopic` replay** — hardcoded to `streamOffset: 'next'`. PR welcome for a dedicated `@SubscribeStream` exposing the option.

## License

MIT © François ACHACHE

## Contributing

PRs welcome. Run `npm test && npm run lint && npm run build` before submitting.
