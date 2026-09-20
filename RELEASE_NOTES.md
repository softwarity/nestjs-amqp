# Release Notes

## NEXT RELEASE

### Changes

- **Confirmed publish — `emitConfirmed()`.** New method on `AmqpQueue<T>` and `AmqpTopic<T>` (decorators and `AmqpDestinations` alike): it publishes and returns an `Observable<void>` that completes only once the broker **accepted** the delivery, and errors with the new `AmqpPublishError` otherwise. Until now a message that matched no queue — the most common topology mistake — left without a trace, because `emit()` returns as soon as rhea's sender takes it. The mental model: *`emit()`, I don't want to know; `emitConfirmed()`, tell me what the broker did with it*. Not to be confused with `send()`, which waits for an application **reply**; `emitConfirmed()` waits for a delivery **verdict** and needs neither a reply stream nor a consumer.

  The error's `outcome` discriminates the failure: `released` (routed to no queue), `rejected` (a queue refused it — carries the AMQP `condition` / `description`), `modified`, plus three cases that never reach the broker and so can never be mistaken for a success: `unsent` (broker disabled, connection not open, link failed), `disconnected` and `timeout`.

  `emit()` is unchanged — still synchronous, still a boolean, still fire-and-forget. This adds a method, it modifies none.

- **New broker option `confirmTimeoutMs`** — guard delay for `emitConfirmed()`, overridable per call with `{ timeoutMs }`. Defaults to `defaultSendTimeoutMs` (30s), so nothing to configure to get started; set it lower when a publisher should give up quickly, since a delivery verdict is a broker round-trip rather than an application one. When the link has no credit yet (normal right after connecting, or under broker flow control), the message is held back instead of being handed to rhea — that wait is part of the same delay, and it keeps the guarantee that a failed confirm means nothing was published.

- **`released` deliveries are now logged at `warn`**, next to the `rejected` ones, for every publish including `emit()`. A one-liner that saves hours on a wrong routing key.

### Internal changes

- Senders are opened with rhea's `treat_modified_as_released: false`, so the four AMQP 1.0 delivery outcomes map one-to-one onto the events the library listens to (rhea re-dispatches `modified` as `released` by default).
- A link failure (`sender_error` — unknown address, revoked permission) now fails the confirmed publishes that link was carrying, instead of leaving them to hit the guard delay. Same for `disconnected` and for shutdown.
- `test/publish-confirmed.spec.ts` covers the four outcomes, the credit wait, link failure, disconnect, shutdown, the guard delay, the cold-Observable semantics, and `emit()` non-regression, against a simulated rhea sender.
- Integration coverage on **both** brokers, since delivery outcomes are core AMQP 1.0 and not a RabbitMQ extension: RabbitMQ 4.x (accepted, plus an address nothing is bound to — the link attach fails, so it surfaces as `unsent` / `amqp:not-found`) and Artemis (accepted; with its default `auto-create-queues = true` an unknown address is created and the publish is accepted — a broker policy, not a library behaviour).

---

## 1.0.0

### Changes

- **Relicensed under Apache-2.0** (previously MIT), for its explicit patent grant — easier to adopt for companies whose legal teams pre-approve Apache over MIT. `LICENSE` and the `package.json` `license` field are updated; versions up to 0.3.4 stay MIT.

- **NestJS 12 support.** The `@nestjs/common` / `@nestjs/core` peer range is widened to `>=10.0.0 <13.0.0`. NestJS 12 ships as ESM only; the library stays CommonJS and loads it through Node's `require(esm)`, so with NestJS 12 the host app needs Node.js ≥ 20.19 or ≥ 22.12 (the same requirement NestJS 12 itself has for CommonJS apps). ESM host apps work too. No API change; NestJS 10 and 11 remain supported.

- **Shutdown order under NestJS 12.** NestJS 12 calls lifecycle hooks by dependency level, so on `app.close()` the `DlqBrowserService` now releases its open DLQ sessions *before* `BrokerRegistry` closes the connections (NestJS 11 did it the other way round). Startup order is unchanged: brokers come up before consumers are wired.

### Fixes

- **`@AmqpQueue` / `@AmqpTopic` properties were `undefined`** in projects compiled with `target: ES2022` or later, which includes the NestJS 11 and 12 project templates (`ES2023`). There, TypeScript's `useDefineForClassFields` turns `private readonly orders!: AmqpQueue<T>` into a class field that hides the decorator's accessor, so `this.orders.emit()` threw `Cannot read properties of undefined`. The decorators now remove that field right after Nest builds the instance (providers, controllers, any scope), whatever the compiler options — no change needed in your code. An object built by hand with `new` still gets the class field: inject `AmqpDestinations` there.

### Internal changes

- `test/amqp.queue.spec.ts` covers both property decorators on Nest-built providers and controllers, with the project's own `ES2022` target reproducing the shadowing field.
- Dev dependencies moved to NestJS 12 (`@nestjs/common`, `@nestjs/core`, `@nestjs/testing`, `@nestjs/swagger` `^12.0.1`) and Jest 30 (`jest`, `@types/jest` `^30`, `ts-jest` `^29.4`).
- Jest can only load the ESM-only NestJS packages through its `require(esm)` support, which needs `--experimental-vm-modules` and Node.js ≥ 24.9. `npm test`, `test:watch`, `test:cov` and `test:integration` now run `node --experimental-vm-modules node_modules/jest/bin/jest.js`; running the test suites locally requires Node 24.9+.
- CI workflows that run Jest (unit tests, publish, the three integration jobs) now use Node 24; the integration jobs call `npm run test:integration -- <spec>` instead of `npx jest`.
- Releases now go through [`softwarity/release-flow`](https://github.com/softwarity/release-flow): the *Create Tag/Release* workflow takes a `patch` / `minor` / `major` choice (it could only do patches), checks lint, tests and build before tagging, resolves this `## NEXT RELEASE` section into the version and publishes the GitHub Release from it. The tag now stays on `main` — the old `npm version` + `git commit --amend` left it on an orphan commit.
- Doc site: icons migrated to Material Symbols, header layout and badges reworked (license badge now Apache-2.0).

---

## 0.3.4 — Topology manifest refinements

Follow-up to the 0.3.3 manifest feature, fixing three sharp edges spotted on the first real-world usage.

### Changes

- **Azure Service Bus support dropped.** No local image to test against in CI, so the dedicated generator and brand were unmaintainable. `BrokerBrand` narrowed to `'rabbitmq' | 'artemis' | 'qpid' | 'unknown'`; a peer that announces itself as Azure now falls back to the generic text generator. `ALL_KNOWN_BRANDS` shrunk from 4 to 3 — only `<broker>.rabbitmq.json`, `<broker>.artemis.xml`, `<broker>.qpid.json` are written when `emitTopologyManifest: true`.

- **DLX wiring is now defensive.** When the broker has a `defaultDlqAddress`, the manifest wires DLX on **every** consumer queue (not just those whose `@Consume` has `dlq: true`). Queue arguments are immutable on most brokers — pre-wiring DLX avoids a broker-side recreate when the application later flips `dlq: true` at the call site. The matching bindings follow.

- **JSON outputs are strictly valid.** The `//` comment header in `rabbitmq.json` and `qpid.json` is gone, replaced by a `_meta` JSON block at the top of the document:
  ```json
  {
    "_meta": {
      "generated_by": "@softwarity/nestjs-amqp",
      "broker_name": "default",
      "target_brand": "rabbitmq",
      "note": "Topology snippet — merge with your existing broker config..."
    },
    "exchanges": [...],
    "queues": [...],
    "bindings": [...]
  }
  ```
  The files are now importable as-is by RabbitMQ's `management.load_definitions` (unknown root keys are ignored) and `jq`-parseable for tooling. The Artemis XML output keeps its `<!-- -->` header (valid XML). The Qpid `_meta` carries an extra `streams_warning` field listing any `@Subscribe` addresses (Qpid Broker-J has no native stream type).

### Internal changes

- `AzureServiceBusGenerator` deleted; `ALL_KNOWN_BRANDS` shrunk to 3 entries.
- Brand detection in `BrokerConnection.detectBrand` no longer recognises Azure SB product strings.
- `topology-manifest.spec.ts` revised: Azure describe block removed, new tests for defensive DLX, `_meta` block presence, strict JSON validity.
- `package.json` keywords: `azure-service-bus` removed.
- Doc pages: Azure SB sections + references removed from `broker-topology`, `getting-started`, `configuration`, `publishers`, `request-reply`, `retry-and-dlq`. README and `app.component.html` updated to drop Azure SB from the broker list.

---

## 0.3.3 — Auto-generated topology manifest

New opt-in DX feature: the library can emit broker-side ready topology snippets at boot, **one file per supported brand**, for every configured broker. Non-breaking — disabled by default.

### New feature

- **`BrokerOptions.emitTopologyManifest?: boolean`** (default `false`). When `true`, the library writes one file per known brand (RabbitMQ, Artemis, Azure Service Bus, Qpid) to `os.tmpdir() / amqp-topology / <brokerName>.<brand>.<ext>` at `onModuleInit` time. The generation is **purely static** — derived from `@Consume` / `@Subscribe` metadata and broker options. It runs whether or not the broker is connected (and even when `enabled: false`), so a fresh checkout can produce the topology snippets on the very first launch without any broker running.

  ```ts
  AmqpModule.forRoot({
    url: 'amqp://localhost:5672',
    username: 'guest', password: 'guest',
    emitTopologyManifest: true,
  });
  ```

  ```
  [AmqpConsumerExplorer] broker 'default': 4 consumer(s)
  [AmqpConsumerExplorer]   - @Consume orders.create -> OrdersListener.onCreate
  [AmqpConsumerExplorer]   - @Consume payments.process -> PaymentListener.onPayment
  [AmqpConsumerExplorer]   - @Consume orders.ship -> OrdersListener.onShip
  [AmqpConsumerExplorer]   - @Subscribe changes.bulletin -> BulletinPublisher.onChanged
  [AmqpConsumerExplorer] broker 'default': topology manifests written:
  [AmqpConsumerExplorer]   - /tmp/amqp-topology/default.rabbitmq.json
  [AmqpConsumerExplorer]   - /tmp/amqp-topology/default.artemis.xml
  [AmqpConsumerExplorer]   - /tmp/amqp-topology/default.azure-service-bus.sh
  [AmqpConsumerExplorer]   - /tmp/amqp-topology/default.qpid.json
  ```

  When the option is `false`/omitted, the explorer logs a one-line discoverability hint per broker at boot pointing to the option — feature stays findable without being intrusive.

  Manifest content per broker:
  - One queue per `@Consume(addr)` (quorum on RabbitMQ, anycast on Artemis, …)
  - One stream / topic per `@Subscribe(addr)` (stream on RabbitMQ, multicast on Artemis, topic + subscription on Azure SB, …)
  - The `replyStreamAddress` if declared (drives the `send()` reply queue)
  - The `defaultDlqAddress` and full DLX wiring if any consumer uses `dlq: true`

  Supported brands & formats:

  | Brand | Format | Example file |
  |---|---|---|
  | RabbitMQ | `definitions.json` snippet (queues + exchanges + bindings) | `main.rabbitmq.json` |
  | Artemis | `broker.xml` snippet (`<addresses>` + `<address-settings>`) | `main.artemis.xml` |
  | Azure Service Bus | bash script with `az servicebus` commands | `main.azure-service-bus.sh` |
  | Qpid Broker-J | `config.json` snippet | `main.qpid.json` |

  Manifest is a **hint** — the library still doesn't declare topology at runtime. Pick the file matching your broker, merge the snippet into your existing `definitions.json` / `broker.xml` / IaC scripts. Don't run it as-is in prod.

### Internal changes

- New `src/topology-manifest.ts` with per-brand generators (`RabbitMqGenerator`, `ArtemisGenerator`, `AzureServiceBusGenerator`, `QpidGenerator`, `GenericGenerator`) and a `writeTopologyManifestForAllBrands` helper.
- `BrokerConnection` tracks `expectedDestinations` (populated by `AmqpConsumerExplorer.wire`), exposes a `getExpectedDestinations()` snapshot.
- `AmqpConsumerExplorer.onModuleInit` emits the manifests after wiring — fully decoupled from the broker connection lifecycle.
- 22 new tests in `test/topology-manifest.spec.ts` covering every generator's output for queues, streams, DLQ wiring, reply stream, and edge cases (empty destinations, no DLX, etc.).

---

## 0.3.2 — Name-less single broker (BREAKING)

Type-level ergonomic tightening: `name` is now forbidden in the single-broker form of `forRoot`. It was always irrelevant in single-broker mode (the lone broker is resolved automatically by every decorator and the locator); making it a TypeScript error removes a useless decision from the 90% case.

### Breaking changes

- **`forRoot` single-broker form no longer accepts `name`.** The signature is now `forRoot(options: SingleBrokerOptions | BrokerOptions[])`, where `SingleBrokerOptions = Omit<BrokerOptions, 'name'>`. The internal name is `'default'` in single-broker mode. If you want a custom broker name (visible as the AMQP container ID on the broker management UI), switch to the array form — even with a single entry.

  Before (0.3.1):
  ```ts
  AmqpModule.forRoot({
    name: 'default',
    url: 'amqp://localhost:5672',
    username: 'guest', password: 'guest',
  })
  ```
  After (0.3.2):
  ```ts
  // single broker — name forbidden, becomes 'default' internally
  AmqpModule.forRoot({
    url: 'amqp://localhost:5672',
    username: 'guest', password: 'guest',
  })

  // single broker with custom name → array form, single entry
  AmqpModule.forRoot([{
    name: 'bulletin-edition-svc',
    url: 'amqp://localhost:5672',
    username: 'guest', password: 'guest',
  }])
  ```
  The boot log reflects the resolved name: `[BrokerConnection:default]` (single form) or `[BrokerConnection:bulletin-edition-svc]` (array form with custom name).

- **`AmqpOptionsFactory.createAmqpOptions()` return type updated.** It now returns `SingleBrokerOptions | BrokerOptions[]` — same constraint as `forRoot`. A factory class returning a single broker must drop the `name` field.

### Migration guide

Find every single-broker `forRoot` call site and drop the `name` line:

```diff
 AmqpModule.forRoot({
-  name: 'default',
   url: cfg.get('AMQP_URL')!,
   username: cfg.get('AMQP_USER'),
   password: cfg.get('AMQP_PASSWORD'),
 })
```

If you were using a non-`'default'` name in single-broker mode and relied on it being visible on the broker management UI, switch to the array form to keep it:

```diff
-AmqpModule.forRoot({
+AmqpModule.forRoot([{
   name: 'bulletin-edition-svc',
   url: cfg.get('AMQP_URL')!,
-})
+}])
```

### Internal changes

- New `SingleBrokerOptions` type exported from the public barrel for typed factory implementations.
- `resolveAmqpOptions` accepts the new union; injects `name: 'default'` when the input isn't an array.
- 3 new tests in `amqp.options.spec.ts` cover the name-less single form, the single-entry array escape hatch, and the implicit-default-name path.

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
