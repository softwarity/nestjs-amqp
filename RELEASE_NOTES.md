# Release Notes

## 0.3.2

---

## 0.3.1 — Flattened forRoot + per-broker enabled (BREAKING)

Ergonomic follow-up to 0.2.1. Two small but breaking config changes.

### Breaking changes

- **`AmqpModule.forRoot(...)` accepts `BrokerOptions | BrokerOptions[]` directly.** The outer `{ brokers: [...] }` wrapper is gone — pass a single broker as a flat object (the 90% case) or an array for multi-broker. `AmqpModuleOptions` is removed from the public API.

  Before (0.2.1):
  ```ts
  AmqpModule.forRoot({
    brokers: [{
      name: 'default',
      url: 'amqp://localhost:5672',
      username: 'guest',
      password: 'guest',
    }],
  })
  ```
  After (0.3.1):
  ```ts
  // single broker — flat
  AmqpModule.forRoot({
    name: 'default',
    url: 'amqp://localhost:5672',
    username: 'guest',
    password: 'guest',
  })

  // multi-broker — array
  AmqpModule.forRoot([
    { name: 'primary',   url: 'amqp://broker-a', /* ... */ },
    { name: 'analytics', url: 'amqp://broker-b', /* ... */ },
  ])
  ```
  `forRootAsync` factory and `AmqpOptionsFactory.createAmqpOptions()` return type updated identically — they now return `BrokerOptions | BrokerOptions[]`.

- **`enabled` moved from the root to `BrokerOptions` (per broker).** The global kill switch is gone — each broker has its own `enabled?: boolean` flag (default `true`). Lets you disable a single broker in a multi-broker setup without affecting the others (e.g. analytics offline for maintenance while primary keeps running).

  Before (0.2.1):
  ```ts
  AmqpModule.forRoot({ enabled: false, brokers: [{ /* ... */ }] })
  ```
  After (0.3.1):
  ```ts
  // single broker
  AmqpModule.forRoot({ name: 'default', url: '...', enabled: false })

  // multi-broker — only one disabled
  AmqpModule.forRoot([
    { name: 'primary',   url: '...' },                  // enabled (default)
    { name: 'analytics', url: '...', enabled: false },  // off
  ])
  ```

### Migration guide

Most migrations are a one-line search-replace:

```diff
 AmqpModule.forRoot({
-  brokers: [{
-    name: 'default',
-    url: 'amqp://localhost:5672',
-    username: 'guest',
-    password: 'guest',
-  }],
+  name: 'default',
+  url: 'amqp://localhost:5672',
+  username: 'guest',
+  password: 'guest',
 })
```

If you were using a global `enabled: false`, move it onto each broker (or rely on the per-broker default for finer control).

### Internal changes

- `BrokerConnection` constructor no longer takes a separate `enabled` argument — reads `options.enabled` directly.
- `BrokerRegistry` boot log now reports enabled vs disabled brokers explicitly.
- 2 new tests in `amqp.options.spec.ts` cover the single + array input forms.

---

## 0.2.1 — Multi-broker (BREAKING)

This release introduces first-class **multi-broker** support and refactors the configuration schema accordingly. The change is breaking: every project upgrading from 0.1.x needs to rewrite its `AmqpModule.forRoot(...)` call.

### Breaking changes

- **`AmqpModuleOptions` schema changed**. The flat per-broker fields (`url`, `username`, `password`, `replyStreamAddress`, …) are gone. Brokers now live in a required `brokers: BrokerOptions[]` array. The `enabled` flag stays at the root.

  Before (0.1.x):
  ```ts
  AmqpModule.forRoot({
    appName: 'my-service',
    url: 'amqp://localhost:5672',
    username: 'guest',
    password: 'guest',
  })
  ```
  After (0.2.x):
  ```ts
  AmqpModule.forRoot({
    brokers: [{
      name: 'default',
      url: 'amqp://localhost:5672',
      username: 'guest',
      password: 'guest',
    }],
  })
  ```

- **`appName` removed.** Reply stream and DLQ addresses are no longer derived. Set `replyStreamAddress` and `defaultDlqAddress` explicitly on each broker that needs them. Both are optional — omit them on emit-only brokers.

- **Consumer decorators renamed.** `@Subscribe` (work-queue) is now `@Consume`, and `@SubscribeTopic` (topic) is now `@Subscribe`. The new naming is aligned with the standard AMQP/JMS vocabulary: "consume" for competing-consumer work-queues, "subscribe" for pub/sub broadcast topics. Side-by-side migration:
  ```ts
  // before (0.1.x)               // after (0.2.x)
  @Subscribe('orders.create')     @Consume('orders.create')
  @SubscribeTopic('changes.bul')  @Subscribe('changes.bul')
  ```
  Associated type renames: `SubscribeOptions` → `ConsumeOptions`, `SubscribeTopicOptions` → `SubscribeOptions`, `SubscribeMetadata` → `ConsumerMetadata` (now carries a `kind: 'consume' | 'subscribe'` field), `ResolvedSubscribeOptions` → `ResolvedConsumerOptions`. Metadata key: `AMQP_SUBSCRIBE_METADATA` → `AMQP_CONSUMER_METADATA`.

- **Decorators take an optional `brokerName` argument.** Optional when a single broker is configured (lone broker resolved automatically). Required when multiple brokers exist.
  ```ts
  @AmqpQueue('orders.create', 'primary')               // multi-broker
  @AmqpTopic('changes.bulletin', 'primary')
  @Consume('orders.create', 'primary', { dlq: true })
  @Subscribe('events.tick', 'analytics')
  ```
  The 2nd argument on `@Consume` / `@Subscribe` is detected at runtime — string = broker name, object = options bag. The forms `(addr)`, `(addr, options)`, `(addr, brokerName)`, `(addr, brokerName, options)` are all valid.

- **`AmqpClient` and `AmqpPublisher` are gone from the public API.** Replaced by per-broker `BrokerConnection` and `BrokerPublisher`, owned by the new `BrokerRegistry` service. `BrokerRegistry` is exposed if you need imperative access to a specific broker; the recommended dynamic API is `AmqpDestinations` (see below).

- **DLQ admin URL changed.** Multi-broker variant: `POST /admin/dlq/:broker/sessions`. Single-broker shortcut: `POST /admin/dlq/sessions` (defaults to the first declared broker). Other routes use the session token, which carries the broker reference, so they don't include the broker in the path.

- **`setActiveBodyCodec` and the global `encodeBody` / `decodeBody` helpers are gone.** Body codecs are now per-broker — declared on `BrokerOptions.bodyCodec` and accessed via `BrokerConnection.encodeBody` / `decodeBody`. This lets two brokers speak different wire formats (JSON on one, msgpack on another).

- **`emit()` now returns `boolean`** (was `void`). `true` if the message was handed off to rhea's sender (broker enabled and connected), `false` if it was dropped (broker disabled or not connected). The boolean enables a clean fallback pattern when the broker is unavailable:
  ```ts
  if (!this.orders.emit(body)) {
    this.bus.emit('orders.create', body);   // e.g. NestJS EventEmitter2
  }
  ```
  Strict TS break (return type widened); zero runtime impact for code that ignored the return value.

- **`autoPrefixQueues` option removed.** The library now detects the broker brand at the AMQP handshake (RabbitMQ via `properties.product`) and applies the `/queues/` v2-addressing prefix only on RabbitMQ. Artemis, Qpid, Azure Service Bus and unknown brands use bare names. Any address starting with `/` still passes through unchanged.

- **`containerId` option removed.** The AMQP container ID is now always the broker's `name`. No reason to expose a separate knob.

### New features

- **Multi-broker.** One service can connect to several brokers from a single `AmqpModule.forRoot`. Each broker has its own connection, reply stream, DLQ, body codec, retry timings.

- **`AmqpDestinations`** — injectable runtime equivalent of `@AmqpQueue` / `@AmqpTopic`. Resolve a publish handle from an address known at runtime, with optional `brokerName`:
  ```ts
  constructor(private readonly amqp: AmqpDestinations) {}
  this.amqp.queue<OrderBody>('orders.create', 'primary').emit(body);
  this.amqp.topic<Metric>('metrics.collected', 'analytics').emit(m);
  ```

- **Broker brand detection.** Each `BrokerConnection` reads the peer's AMQP Open frame `properties.product` on `connection_open` and exposes `brand` (`'rabbitmq' | 'artemis' | 'azure-service-bus' | 'qpid' | 'unknown'`), `peerProduct`, `peerVersion`. Used today for diagnostics; in 0.3.x will gate broker-specific delayed-retry rescheduling.

- **Boot log per broker.** The consumer explorer now prints one section per broker listing every wired consumer (each tagged with the decorator flavour, `@Consume` or `@Subscribe`) — easy way to verify your decorator broker names match the configured brokers.

- **`retryPolicy` option (interface only).** New `RetryPolicy` type accepted on `ConsumeOptions`: `'immediate' | { kind: 'fixed', delayMs } | { kind: 'exponential', initialMs, multiplier, maxMs }`. In 0.2.x only `'immediate'` is functional; the runtime falls back to immediate with a boot warning for the other shapes. Client-side scheduled republish (per-brand annotations: Artemis `x-opt-delivery-time`, Azure SB `x-opt-scheduled-enqueue-time`, RabbitMQ delayed-message-exchange) lands in 0.3.x.

### Migration guide (single-broker)

The smallest migration — wrap your existing flat options in `brokers: [...]` and declare reply/DLQ addresses explicitly:

```diff
 AmqpModule.forRoot({
-  appName: 'my-service',
-  url: 'amqp://localhost:5672',
-  username: 'guest',
-  password: 'guest',
+  brokers: [{
+    name: 'default',
+    url: 'amqp://localhost:5672',
+    username: 'guest',
+    password: 'guest',
+    replyStreamAddress: 'my-service.replies',  // if you use send()
+    defaultDlqAddress: 'my-service.dlq',       // if you use dlq:true anywhere
+  }],
 })
```

Decorators don't need to change — the `brokerName` argument is optional when a single broker is configured.

If your project supplied a custom `bodyCodec`, move it from the root options to the broker options.

### Internal changes (non-breaking for users)

- `src/amqp.client.ts` → `src/broker-connection.ts`
- `src/amqp.publisher.ts` → `src/broker-publisher.ts`
- New `src/broker-registry.ts`
- New `src/amqp.destinations.ts`
- `src/dlq-browser.service.ts` now takes the broker name on `openSession`

---

## 0.1.2

Added rhea-adapter bridging rhea's flat layout to the public nested `MessageProperties` shape, fixing reply correlation on real brokers.

---

## 0.1.0

Initial public release.

- `AmqpModule.forRoot()` / `forRootAsync()` configuration with sensible defaults.
- `@AmqpQueue(address)` / `@AmqpTopic(address)` property decorators for publishers.
- `@Subscribe(address, options?)` / `@SubscribeTopic(address, options?)` method decorators for consumers.
- Parameter decorators: `@AmqpBody`, `@AmqpAddress`, `@AmqpDeliveryCount`, `@AmqpHeader`, `@AmqpProperties`, `@AmqpProperty`, `@AmqpAppProperties`, `@AmqpAppProperty`, `@AmqpSettler`, `@AmqpContext`.
- Request/reply via per-process correlation prefix on a shared reply stream.
- Optional DLQ browser sub-module (`DlqAdminModule`) — browse, replay, drop dead-lettered messages.
- Pluggable wire codec — default JSON with `Date` round-trip + ObjectId duck typing.
- RabbitMQ 4.x v2 addressing (`/queues/<name>`) on by default, configurable.

---
