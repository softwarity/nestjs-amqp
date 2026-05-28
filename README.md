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
> Declare everything broker-side via a definitions file or an IaC script. Full examples for **RabbitMQ 4.x** (`definitions.json` + docker-compose), **ActiveMQ Artemis** (`broker.xml`), **Azure Service Bus** (Azure CLI), and **Apache Qpid** live on the [doc site](https://softwarity.github.io/nestjs-amqp/#/broker-topology).

---

## Why?

`@nestjs/microservices` only covers AMQP 0.9.1 (via `amqplib`). When you want **AMQP 1.0** features — long-lived sessions, link credit, source filters, message annotations, stream consumers — `rhea` is the canonical Node.js client. This library wraps rhea so the rest of your codebase only sees `@AmqpQueue`, `@Consume`, and Observables.

## Features

- 🎯 **Decorator-based** publishers (`@AmqpQueue`, `@AmqpTopic`) and consumers (`@Consume`, `@Subscribe`)
- 🌐 **Multi-broker** — speak to several brokers from one service; one connection / reply stream / DLQ per broker
- 🔄 **Request/Reply** via per-process correlation prefix on a shared reply stream (opt-in)
- 📡 **Broadcast/PubSub** via RabbitMQ streams (`@Subscribe`)
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
      brokers: [{
        name: 'default',
        url: 'amqp://localhost:5672',
        username: 'guest',
        password: 'guest',
      }],
    }),
  ],
})
export class AppModule {}
```

Because only one broker is configured, the `brokerName` argument is optional on every decorator and on the locator — the library resolves the lone broker automatically.

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
| [Retry & DLQ](#retry--dlq--opt-in) | Auto-retry on handler error, then route the failed message to a DLQ. | Declare a DLX + DLQ broker-side, set `{ maxDelivery, dlq: true }` on the decorator. |
| [Multiple brokers](#multi-broker) | Speak to several brokers from one service. | Add more entries to `brokers: [...]`, pass `brokerName` on each decorator. |

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
  brokers: [{
    name: 'default',
    url: 'amqp://localhost:5672',
    username: 'guest', password: 'guest',
    replyStreamAddress: 'my-service.replies',   // ← REQUIRED for send()
  }],
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
  brokers: [{
    name: 'default',
    url: 'amqp://localhost:5672',
    username: 'guest', password: 'guest',
    defaultDlqAddress: 'my-service.dlq',
  }],
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

Add more entries to `brokers: [...]` and pass the broker name on each decorator. Each broker is independent — its own connection, reply stream, DLQ, body codec.

```ts
AmqpModule.forRoot({
  brokers: [
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
      // No reply stream / DLQ — analytics is emit-only.
    },
  ],
});

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
@AmqpQueue(address, brokerName?)        // Property → AmqpQueue<T> (emit + send)
@AmqpTopic(address, brokerName?)        // Property → AmqpTopic<T> (emit only)

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
    AmqpModule.forRoot({ brokers: [{ /* ... */ }] }),
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
AmqpModule.forRoot({
  brokers: [
    { name: 'primary',   url: '...', /* default JSON codec */ },
    { name: 'analytics', url: '...', bodyCodec: new MsgpackCodec() },
  ],
});
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
| `AmqpHandlerError` | Reserved for future use |
| `AmqpError` | Abstract base — `if (err instanceof AmqpError) …` |

## Known limitations

- **In-flight `send()` across reconnects** — if a reconnect happens between sending and receiving the reply, the reply is lost (we re-subscribe with `streamOffset: 'next'`). The pending call times out.
- **`topic.send()` (scatter-gather RPC)** — not supported. Build aggregation in user code on top of `emit()` if needed.
- **`@Subscribe` replay** — hardcoded to `streamOffset: 'next'`. PR welcome for a dedicated `@SubscribeStream` exposing the option.
- **Delayed retry (`retryPolicy`)** — only `'immediate'` is functional in 0.2.x. `fixed` / `exponential` shapes accepted by the type system; runtime falls back to immediate with a boot warning.

## License

MIT © François ACHACHE

## Contributing

PRs welcome. Run `npm test && npm run lint && npm run build` before submitting.
