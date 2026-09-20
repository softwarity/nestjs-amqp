# @softwarity/nestjs-amqp

[![npm version](https://img.shields.io/npm/v/@softwarity/nestjs-amqp.svg)](https://www.npmjs.com/package/@softwarity/nestjs-amqp)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-yellow.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Node](https://img.shields.io/node/v/@softwarity/nestjs-amqp.svg)](https://nodejs.org)
[![Unit tests](https://github.com/softwarity/nestjs-amqp/actions/workflows/unit-tests.yml/badge.svg)](https://github.com/softwarity/nestjs-amqp/actions/workflows/unit-tests.yml)
[![RabbitMQ](https://github.com/softwarity/nestjs-amqp/actions/workflows/integration-rabbitmq.yml/badge.svg)](https://github.com/softwarity/nestjs-amqp/actions/workflows/integration-rabbitmq.yml)
[![Artemis](https://github.com/softwarity/nestjs-amqp/actions/workflows/integration-artemis.yml/badge.svg)](https://github.com/softwarity/nestjs-amqp/actions/workflows/integration-artemis.yml)
[![Qpid](https://github.com/softwarity/nestjs-amqp/actions/workflows/integration-qpid.yml/badge.svg)](https://github.com/softwarity/nestjs-amqp/actions/workflows/integration-qpid.yml)

**AMQP 1.0 integration for NestJS, powered by [rhea](https://github.com/amqp/rhea).** A thin, RxJS-friendly wrapper that exposes decorator-based publishers and consumers — designed for RabbitMQ 4.x (native AMQP 1.0), Apache ActiveMQ Artemis, and Apache Qpid — all three verified on every push ([support matrix](#broker-support)).

📚 **Full documentation:** [softwarity.github.io/nestjs-amqp](https://softwarity.github.io/nestjs-amqp/)

---

> ## ⚠ Read this before your first deploy
>
> **This library does NOT create topology at runtime.** It opens senders and receivers on destinations that **must already exist** on the broker — queues, streams, exchanges, DLX bindings, the lot. Missing topology = silent failure (the AMQP link is rejected with `amqp:not-found`; the rest of the connection stays up and the app looks healthy).
>
> Declare everything broker-side via a definitions file or an IaC script. Full examples for **RabbitMQ 4.x** (`definitions.json` + docker-compose), **ActiveMQ Artemis** (`broker.xml`), and **Apache Qpid** live on the [doc site](https://softwarity.github.io/nestjs-amqp/#/broker-topology).

---

## Why?

`@nestjs/microservices` only covers AMQP 0.9.1 (via `amqplib`). When you want **AMQP 1.0** features — long-lived sessions, link credit, source filters, message annotations, stream consumers — `rhea` is the canonical Node.js client. This library wraps rhea so the rest of your codebase only sees `@AmqpQueue`, `@Consume`, and Observables.

## Features

- 🎯 **Decorator-based** publishers (`@AmqpQueue`, `@AmqpTopic`) and consumers (`@Consume`, `@Subscribe`)
- 🌐 **Multi-broker** — speak to several brokers from one service; one connection / reply stream / DLQ per broker
- 🔄 **Request/Reply** via per-process correlation prefix on a shared reply stream (opt-in)
- 📡 **Broadcast/PubSub** via RabbitMQ streams (`@Subscribe`)
- ✔️ **Confirmed publish** (`emitConfirmed`) — wait for the broker's delivery verdict instead of an optimistic boolean
- 🔁 **Built-in retry policy** (`maxDelivery`, `dlq`) on work-queue consumers (opt-in)
- 💀 **Optional DLQ browser** — paginate, replay, drop dead-lettered messages
- 🧬 **Pluggable wire codec** — JSON by default with `Date` round-trip + ObjectId auto-rehydration; bring your own per broker (msgpack, protobuf, …)
- 🔧 **`forRoot` / `forRootAsync`** configuration
- ⚛️ **RxJS-native** — no Promise wrapper, no axios-style imperative shapes

## Installation

```bash
npm install @softwarity/nestjs-amqp rhea
# peer deps you probably already have
npm install @nestjs/common @nestjs/core rxjs reflect-metadata
```

Works with NestJS 10, 11 and 12. NestJS 12 ships as ESM only; this library is CommonJS and loads it through Node's `require(esm)`, so with NestJS 12 you need Node.js ≥ 20.19 or ≥ 22.12 (ESM apps work too).

---

# Getting started — the 90% case

The simplest, most common setup: **one broker, fire-and-forget publish, basic consume — no DLQ, no request/reply**. Declare as many queues and topics as you need; the simplification here is the feature surface, not the quantity. Reply/DLQ are opt-in features documented further down.

### 1. Declare your queues and topics broker-side

The library never declares topology — only opens senders/receivers on destinations that already exist. Declare whatever your service needs (one queue, ten queues, mixed work-queues and broadcast streams — same exercise). With RabbitMQ 4.x via `definitions.json`:

```json
{
  "queues": [
    {
      "name": "orders.create",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": { "x-queue-type": "quorum" }
    },
    {
      "name": "orders.ship",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": { "x-queue-type": "quorum" }
    },
    {
      "name": "changes.bulletin",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": { "x-queue-type": "stream", "x-max-age": "1h" }
    }
  ]
}
```

Quorum queues for work-queue semantics (one consumer per message), stream queues for broadcast (every consumer sees every message). The library makes no assumption about how many you declare.

### 2. Register the module

```ts
import { Module } from '@nestjs/common';
import { AmqpModule } from '@softwarity/nestjs-amqp';

@Module({
  imports: [
    AmqpModule.forRoot({
      url: 'amqp://localhost:5672',
      username: 'guest',
      password: 'guest',
    }),
  ],
})
export class AppModule {}
```

A single broker (the name is implicit — internally `'default'`). Because only one broker is configured, the `brokerName` argument is optional on every decorator and on the locator — the library resolves the lone broker automatically. If you want a custom name (visible as the AMQP container ID on the broker management UI), wrap in an array even with one entry: `AmqpModule.forRoot([{ name: 'my-svc', url, ... }])`.

### 3. Publish — fire and forget

```ts
import { Injectable } from '@nestjs/common';
import { AmqpQueue, AmqpTopic } from '@softwarity/nestjs-amqp';

@Injectable()
export class OrdersService {
  @AmqpQueue('orders.create')
  private readonly create!: AmqpQueue<OrderBody>;

  @AmqpQueue('orders.ship')
  private readonly ship!: AmqpQueue<OrderShipped>;

  @AmqpTopic('changes.bulletin')
  private readonly changes!: AmqpTopic<BulletinChange>;

  newOrder(body: OrderBody): void {
    this.create.emit(body);                       // fire-and-forget
  }

  notifyShipped(body: OrderShipped): void {
    this.ship.emit(body);
    this.changes.emit({ type: 'shipped', orderId: body.id, when: new Date().toISOString() });
  }
}
```

`@AmqpQueue` for work-queues (point-to-point) and `@AmqpTopic` for broadcast. `emit()` returns synchronously a `boolean` — `true` if the message was handed off to the sender, `false` if the broker is disabled or not connected. The boolean lets the caller fall back (e.g. NestJS `EventEmitter2` for in-process delivery, a local outbox, …):

```ts
if (!this.orders.emit(body)) {
  this.bus.emit('orders.create', body);   // in-process fallback
}
```

Each handle is generic on the payload type — every call site is type-checked at compile time.

`true` means *handed to the sender*, not *the broker took it*. When you need the broker's word before you commit to something on your side, use [`emitConfirmed()`](#confirmed-publish--emitconfirmed).

### 4. Consume

```ts
import { Injectable } from '@nestjs/common';
import { Consume, Subscribe } from '@softwarity/nestjs-amqp';

@Injectable()
export class OrdersListener {
  // The single un-annotated argument is bound to the JSON-decoded body.
  // Equivalent to writing @AmqpBody() explicitly.
  @Consume('orders.create')
  onCreate(order: OrderBody): void {
    this.svc.handle(order);
  }

  @Consume('orders.ship')
  onShip(shipped: OrderShipped): void {
    this.svc.markShipped(shipped);
  }

  @Subscribe('changes.bulletin')
  onChange(change: BulletinChange): void {
    this.realtime.publish(change);
  }
}
```

Start the app — you'll see a boot log section like `broker 'default': 3 consumer(s)` followed by one line per binding (each tagged `@Consume` or `@Subscribe`). You're done.

### What's NOT in the 90% case

The bootstrap above intentionally skips three optional features. Add them à la carte:

| Feature | What you gain | What you have to do |
|---|---|---|
| [Request / reply (`send()`)](#request--reply--opt-in) | Wait for a reply Observable — RPC-style. | Declare a stream queue broker-side, add `replyStreamAddress` to the broker config. |
| [Confirmed publish (`emitConfirmed()`)](#confirmed-publish--emitconfirmed) | Know whether the broker actually took the message. | Nothing — subscribe to the returned Observable instead of reading `emit()`'s boolean. |
| [Retry & DLQ](#retry--dlq--opt-in) | Auto-retry on handler error, then route the failed message to a DLQ. | Declare a DLX + DLQ broker-side, set `{ maxDelivery, dlq: true }` on the decorator. |
| [Multiple brokers](#multi-broker) | Speak to several brokers from one service. | Pass an array to `forRoot`, pass `brokerName` on each decorator. |

---

# Request / reply — opt-in

`AmqpQueue.send()` returns an `Observable` that resolves with the peer's reply. It needs three things:

### 1. Declare a stream queue broker-side

```json
{
  "queues": [{
    "name": "my-service.replies",
    "vhost": "/",
    "durable": true,
    "auto_delete": false,
    "arguments": { "x-queue-type": "stream", "x-max-age": "5m" }
  }]
}
```

### 2. Set `replyStreamAddress` on the broker options

```ts
AmqpModule.forRoot({
  url: 'amqp://localhost:5672',
  username: 'guest', password: 'guest',
  replyStreamAddress: 'my-service.replies',   // ← REQUIRED for send()
});
```

### 3. Call `send()` on the publisher side

```ts
createOrder(body: OrderBody): Observable<OrderConfirmation> {
  return this.orders.send<OrderConfirmation>(body, { timeoutMs: 5000 });
}
```

### 4. Return a value from the consumer to auto-reply

```ts
@Consume('orders.create')
onCreate(body: OrderBody): Observable<OrderConfirmation> {
  return this.svc.create(body);   // resolved value -> auto-shipped on reply_to
}
```

The library generates a per-process correlation prefix at boot and filters incoming replies on the shared reply stream — every instance sees every reply but only routes its own. Trade-off: N× bandwidth per reply (negligible for low-volume RPC on a LAN).

Without `replyStreamAddress` set on the broker, `send()` throws `AmqpConnectionError` at the call site. `emit()` and `@Consume` continue to work unchanged.

📚 Full details: [doc site → Request / reply](https://softwarity.github.io/nestjs-amqp/#/request-reply)

---

# Confirmed publish — `emitConfirmed()`

**`emit()` — I don't want to know. `emitConfirmed()` — tell me what the broker did with it.**

`emit()` returns as soon as the message is handed to the sender, so a message no queue is bound to leaves silently — the most common topology mistake there is. `emitConfirmed()` returns an Observable that completes only once the broker **accepted** the delivery, and errors with an `AmqpPublishError` otherwise:

```ts
import { AmqpPublishError } from '@softwarity/nestjs-amqp';

@AmqpQueue('tasks.trigger')
private readonly triggers!: AmqpQueue<TriggerBody>;

fire(trigger: TriggerBody): Observable<void> {
  return this.triggers.emitConfirmed(trigger);   // completes = the broker has it
}
```

```ts
this.triggers.emitConfirmed(trigger).subscribe({
  next: () => this.schedule.advanceDueDate(trigger.id),   // safe: the broker took it
  error: (err: AmqpPublishError) => this.logger.error(`${err.outcome}: ${err.message}`),
});
```

The Observable is cold, like `send()`: nothing is published until something subscribes, and each subscription publishes once. It emits a single `void` and completes, so `firstValueFrom(...)` resolves.

### Not the same thing as `send()`

| | Waits for | Resolves when |
|---|---|---|
| `emit()` | nothing — returns a `boolean` synchronously | the message was handed to the sender |
| `emitConfirmed()` | a **delivery verdict** from the broker | the broker took responsibility for the message |
| `send()` | an **application reply** from a consumer | your consumer returned a value |

`emitConfirmed()` needs no `replyStreamAddress` and no consumer: the verdict is an AMQP 1.0 disposition sent by the broker itself. It is available on `AmqpQueue<T>` **and** `AmqpTopic<T>`, from the decorators as well as from `AmqpDestinations`.

### What the broker's verdicts mean

| Outcome | Meaning (RabbitMQ) | Result |
|---|---|---|
| `accepted` | every target queue took the message — on a quorum queue, a majority of replicas wrote it to disk | completes |
| `released` | the message was routed to **no** queue: wrong address, missing binding | errors, `outcome: 'released'` |
| `rejected` | a target queue refused it: length limit reached, queue unavailable | errors, `outcome: 'rejected'`, AMQP `condition` carried |
| `modified` | the broker asked for the message to be changed before redelivery (RabbitMQ doesn't use it publisher-side today) | errors, `outcome: 'modified'` |

Three more failures never reach the broker at all and are reported the same way, so a caller can never mistake them for a success: `'unsent'` (broker disabled, connection not open, or the link failed), `'disconnected'` (the connection dropped before the verdict) and `'timeout'`.

**Portability.** Delivery outcomes are core AMQP 1.0, not a RabbitMQ extension: `emitConfirmed()` carries no broker-specific handling, and is verified against both RabbitMQ 4.x and Artemis in the integration suite. What a broker *reports*, though, follows its own routing policy.

Which one you get for a **missing destination** depends on how the address resolves. On RabbitMQ 4.x a queue that doesn't exist fails the link attach, so it surfaces right away as `'unsent'` with `condition: 'amqp:not-found'` — verified against RabbitMQ 4.x in the integration suite. `'released'` is what you get when the address does resolve but nothing downstream takes the message, typically an exchange with no matching binding. Artemis in its default configuration (`auto-create-queues = true`) **creates** the missing address instead, so the publish comes back `accepted` — verified too. Turn auto-creation off if you want a typo in an address to be caught. In every case, a confirmation means *the broker took the message*, never *a consumer is listening*.

```ts
if (err instanceof AmqpPublishError && err.outcome === 'released') {
  // nothing is bound to this address — a topology bug, not a transient failure
}
```

`released` and `rejected` are also logged at `warn` level by the library, whichever method published the message.

### The guard delay

`emitConfirmed()` never waits forever. The delay covers the whole publish — getting credit on the link, then the broker's verdict:

```ts
AmqpModule.forRoot({
  url: 'amqp://localhost',
  confirmTimeoutMs: 5_000,        // default: defaultSendTimeoutMs (30s)
});

this.triggers.emitConfirmed(trigger, { timeoutMs: 2_000 });   // per call
```

A delivery verdict is a broker round-trip, not an application round-trip: set it well below the reply timeout when a publisher should give up quickly.

When the link has no credit yet — normal right after connecting, or under broker flow control — the message is held back rather than handed to rhea, so a failed confirm always means nothing was published. That wait is part of the same guard delay.

📚 Full details: [doc site → Confirmed publish](https://softwarity.github.io/nestjs-amqp/#/confirmed-publish)

---

# Retry & DLQ — opt-in

Retry and DLQ are off by default (`maxDelivery: 1`, `dlq: false`) — handler errors silently drop the message.

> **The lib never publishes to a DLQ itself.** On terminal failure with `dlq: true`, it calls `delivery.reject()` and the **broker** routes the message via its own DLX configuration. If the queue has no DLX broker-side, `dlq: true` is silently ignored (the broker discards rejected messages).

### Setup with RabbitMQ 4.x

**1. Declare DLX + DLQ broker-side:**

```json
{
  "exchanges": [{
    "name": "my-service.dlx",
    "vhost": "/",
    "type": "direct",
    "durable": true,
    "auto_delete": false
  }],

  "queues": [
    {
      "name": "payments.process",
      "vhost": "/",
      "durable": true,
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
      "arguments": { "x-queue-type": "quorum" }
    }
  ],

  "bindings": [{
    "source": "my-service.dlx",
    "vhost": "/",
    "destination": "my-service.dlq",
    "destination_type": "queue",
    "routing_key": "payments.process",
    "arguments": {}
  }]
}
```

**2. Set `defaultDlqAddress` on the broker options** (used by the DLQ admin UI as a pre-fill):

```ts
AmqpModule.forRoot({
  url: 'amqp://localhost:5672',
  username: 'guest', password: 'guest',
  defaultDlqAddress: 'my-service.dlq',
});
```

**3. Enable the policy on the decorator:**

```ts
@Consume('payments.process', { maxDelivery: 5, dlq: true })
onPayment(body: Payment): Observable<Result> {
  return this.svc.process(body);
}
```

Run-time behaviour: handler throws → `modified(delivery_failed:true)` × 4 retries → on the 5th failure → `reject()` → broker routes to `my-service.dlx` with routing key `payments.process` → `my-service.dlq`.

### `retryPolicy` — delayed retries (in 0.3.x)

The decorator accepts a `retryPolicy` option that defines the timing between retries. **In 0.2.x only `'immediate'` is functional** — `fixed` / `exponential` shapes are accepted by the type system for forward-compatibility (runtime falls back to immediate with a boot warning). Client-side scheduled republish is planned for 0.3.x.

```ts
type RetryPolicy =
  | 'immediate'
  | { kind: 'fixed';       delayMs: number }
  | { kind: 'exponential'; initialMs: number; multiplier: number; maxMs: number };
```

📚 Full details: [doc site → Retry & DLQ](https://softwarity.github.io/nestjs-amqp/#/retry-and-dlq)

---

# Multi-broker

Pass an array to `forRoot` and pass the broker name on each decorator. Each broker is independent — its own connection, reply stream, DLQ, body codec, enabled flag.

```ts
AmqpModule.forRoot([
  {
    name: 'primary',
    url: 'amqp://broker-a:5672',
    username: 'svc', password: '...',
    replyStreamAddress: 'my-svc.replies',
    defaultDlqAddress: 'my-svc.dlq',
  },
  {
    name: 'analytics',
    url: 'amqp://broker-b:5672',
    username: 'svc', password: '...',
    enabled: false,                       // per-broker kill switch
    // No reply stream / DLQ — analytics is emit-only.
  },
]);

@Injectable()
export class MixedService {
  @AmqpQueue('orders.create', 'primary')        private orders!: AmqpQueue<OrderBody>;
  @AmqpTopic('metrics.collected', 'analytics')  private metrics!: AmqpTopic<Metric>;
}

@Injectable()
export class MixedListener {
  @Consume('orders.create', 'primary', { dlq: true })
  onOrder(o: OrderBody): void { ... }

  @Subscribe('events.tick', 'analytics')
  onTick(e: TickEvent): void { ... }
}
```

The 2nd argument on `@Consume` / `@Subscribe` is detected at runtime — string = broker name, object = options. The forms `(addr)`, `(addr, options)`, `(addr, brokerName)`, `(addr, brokerName, options)` are all valid.

Forgetting the broker name in a multi-broker setup throws clearly at boot.

📚 Full details: [doc site → Multi-broker](https://softwarity.github.io/nestjs-amqp/#/multi-broker)

---

## Quick reference

### Decorators

```ts
@AmqpQueue(address, brokerName?)        // Property → AmqpQueue<T> (emit + emitConfirmed + send)
@AmqpTopic(address, brokerName?)        // Property → AmqpTopic<T> (emit + emitConfirmed)

@Consume(address, brokerName?, options?)        // Method, work-queue consumer
@Subscribe(address, brokerName?, options?)   // Method, stream/topic consumer
```

`brokerName` is optional when a single broker is configured. With several brokers, omitting it throws at boot.

### Parameter decorators

```ts
@AmqpBody()                // T — decoded body (also: a single un-annotated param is implicit @AmqpBody())
@AmqpAddress()             // string — the @Subscribe address
@AmqpDeliveryCount()       // number — 1-based attempt count
@AmqpHeader()              // MessageHeader — durable, priority, ttl, delivery_count
@AmqpProperties()          // MessageProperties — full standard properties
@AmqpProperty(name)        // one field of message.properties
@AmqpAppProperties()       // Record<string, unknown> — full application_properties
@AmqpAppProperty(name)     // one field of application_properties
@AmqpSettler()             // AmqpSettler — manual accept/release/reject
@AmqpContext()             // AmqpContext — full envelope + settle helpers
```

### Runtime resolution — `AmqpDestinations`

Inject `AmqpDestinations` to resolve a publish handle dynamically (tenant-scoped queues, dispatchers):

```ts
@Injectable()
export class DynamicPublisher {
  constructor(private readonly amqp: AmqpDestinations) {}

  publish(tenantId: string, body: OrderBody): void {
    this.amqp.queue<OrderBody>(`orders.${tenantId}`).emit(body);
  }
}
```

### DLQ browser — `DlqAdminModule` (opt-in)

```ts
@Module({
  imports: [
    AmqpModule.forRoot({ url: '...', /* ... */ }),
    DlqAdminModule,   // adds /admin/dlq/... routes
  ],
})
export class AppModule {}
```

Routes (single-broker shortcut):

```
POST /admin/dlq/sessions                            { dlqAddress, pageSize? }
GET  /admin/dlq/sessions/:token
POST /admin/dlq/sessions/:token/next-page
POST /admin/dlq/sessions/:token/messages/:idx/replay
POST /admin/dlq/sessions/:token/messages/:idx/drop
POST /admin/dlq/sessions/:token/close
```

Multi-broker variant: `POST /admin/dlq/:broker/sessions { ... }` to scope the open-session to a specific broker. Other routes work off the session token (the session knows its broker).

**⚠️ Auth not included.** The controller is unguarded — wrap with your own `Guard`, or sub-class and redeclare with your decorators. `openedBy` is read from `req.user.username ?? req.user.id ?? 'anonymous'`.

### Serialization / Deserialization — per broker

```ts
AmqpModule.forRoot([
  { name: 'primary',   url: '...', /* default JSON codec */ },
  { name: 'analytics', url: '...', bodyCodec: new MsgpackCodec() },
]);
```

Default `JsonBodyCodec`:
- UTF-8 JSON
- Round-trips `Date` via `{ "$date": "<ISO>" }`
- Encodes ObjectId-like values as `{ "$oid": "<hex>" }`; **decode auto-detects mongoose / bson and returns a real ObjectId instance** if installed, else the marker object

### Errors

| Class | Where it surfaces |
|---|---|
| `AmqpConnectionError` | Connection-level issues, `send()` when AMQP is disabled or no reply stream is configured on the broker |
| `AmqpTimeoutError` | `send()` Observable when no reply arrives in time. Carries `address`, `correlationId`, `timeoutMs` |
| `AmqpPublishError` | `emitConfirmed()` Observable when the broker didn't take the message. Carries `address`, `outcome` (`released` / `rejected` / `modified` / `unsent` / `disconnected` / `timeout`), `reason`, and the AMQP `condition` / `description` when the broker reported one |
| `AmqpHandlerError` | Reserved for future use |
| `AmqpError` | Abstract base — `if (err instanceof AmqpError) …` |

# Broker support

Every broker below runs in the integration suite on each push — the matrix says what is **verified**, not what ought to work. ✅ verified · ⚠️ works with a caveat · ❌ not usable.

| | RabbitMQ 4.x | ActiveMQ Artemis | Qpid Broker-J |
|---|---|---|---|
| **Integration suite** | 9 / 9 scenarios | 7 / 9 | 8 / 9 |
| `emit()` + `@Consume` | ✅ | ✅ | ✅ |
| [`emitConfirmed()`](#confirmed-publish--emitconfirmed) | ✅ | ✅ | ✅ |
| [`send()` request / reply](#request--reply--opt-in) | ✅ stream reply queue | ⚠️ single instance | ⚠️ single instance |
| `@Subscribe` fan-out | ✅ stream queue, offset `next` | ⚠️ needs a multicast address | ⚠️ single subscriber only |
| [Retry (`maxDelivery`)](#retry--dlq--opt-in) | ✅ classic · ⚠️ quorum | ✅ | ❌ no `delivery-count` |
| [DLQ (`dlq: true`)](#retry--dlq--opt-in) | ✅ via DLX | ⚠️ needs `dead-letter-address` | ❌ no `delivery-count` |
| Missing destination | link attach fails → `unsent` | auto-created → `accepted` | link attach fails → `unsent` |
| Address scheme | `/queues/<name>` added automatically | bare names | bare names |
| [Topology manifest](#broker-topology) | JSON | XML | JSON |

### Reading the caveats

- **`send()` on Artemis / Qpid — single instance.** The reply design assumes a *broadcast* reply stream: every instance sees every reply and keeps its own by correlation prefix. RabbitMQ stream queues do exactly that. On a plain queue, replies are competing-consumed, so a second instance can swallow a reply meant for the first — which then times out. One instance per service: fine. Several: use RabbitMQ, or keep to `emit()` / `emitConfirmed()`.
- **`@Subscribe` fan-out.** Same root cause. On Artemis, declare a multicast address broker-side; on Qpid, a topic exchange with one queue per subscriber. Against a plain queue the wiring works, but only one subscriber gets each message.
- **Retry & DLQ on Qpid.** The library counts attempts with the AMQP `delivery-count` header, which Qpid Broker-J does not increment on `modified(delivery_failed: true)`. `maxDelivery` therefore never trips and `dlq: true` never fires: a handler that always throws is re-invoked in a hot loop (measured at ~24 000 times in 5 seconds). Don't rely on retry or DLQ there — accept or reject explicitly with `@AmqpSettler`.
- **Retry on RabbitMQ quorum queues.** Same header, unevenly incremented depending on the failure path. Classic queues are reliable.
- **Missing destination.** Only a policy difference: Artemis ships with `auto-create-queues = true`, so a typo in an address silently creates a queue instead of reporting a failure. Turn it off if you want `emitConfirmed()` to catch that.

Qpid and Artemis run their own configuration in `integration/` (a declared topology for Qpid, the image defaults for Artemis) — both readable as working examples.

---

## Known limitations

- **In-flight `send()` across reconnects** — if a reconnect happens between sending and receiving the reply, the reply is lost (we re-subscribe with `streamOffset: 'next'`). The pending call times out.
- **`topic.send()` (scatter-gather RPC)** — not supported. Build aggregation in user code on top of `emit()` if needed.
- **`@Subscribe` replay** — hardcoded to `streamOffset: 'next'`. PR welcome for a dedicated `@SubscribeStream` exposing the option.
- **Delayed retry (`retryPolicy`)** — only `'immediate'` is functional in 0.2.x. `fixed` / `exponential` shapes accepted by the type system; runtime falls back to immediate with a boot warning.
- **Per-broker gaps** — retry / DLQ need the broker to track `delivery-count` (Qpid doesn't), and `send()` / `@Subscribe` need a broadcast destination to work across several instances. See the [broker support matrix](#broker-support).

## License

Apache-2.0 © François ACHACHE

## Contributing

PRs welcome. Run `npm test && npm run lint && npm run build` before submitting.
