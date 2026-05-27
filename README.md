# @softwarity/nestjs-amqp

[![npm version](https://img.shields.io/npm/v/@softwarity/nestjs-amqp.svg)](https://www.npmjs.com/package/@softwarity/nestjs-amqp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/node/v/@softwarity/nestjs-amqp.svg)](https://nodejs.org)

**AMQP 1.0 integration for NestJS, powered by [rhea](https://github.com/amqp/rhea).** A thin, RxJS-friendly wrapper that exposes decorator-based publishers and consumers — designed for RabbitMQ 4.x (native AMQP 1.0), Apache ActiveMQ Artemis, Apache Qpid, and Azure Service Bus.

📚 **Full documentation:** [softwarity.github.io/nestjs-amqp](https://softwarity.github.io/nestjs-amqp/)

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
  // Work-queue, default: 1 attempt, drop silently on error
  @Subscribe('orders.created')
  onCreated(@AmqpBody() order: OrderBody): void {
    this.svc.handle(order);
  }

  // Observable<T> with msg.reply_to -> auto-replies to the sender
  @Subscribe('queries.balance')
  onBalance(@AmqpBody() q: BalanceQuery): Observable<BalanceResponse> {
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

@Injectable()
export class OrdersService {
  // Work-queue handle - supports both send() and emit()
  @AmqpQueue('orders.create')
  private readonly orders!: AmqpQueue;

  // Topic handle - only emit() (broadcast, no reply correlation)
  @AmqpTopic('changes.bulletin')
  private readonly changes!: AmqpTopic;

  createOrder(body: OrderBody): Observable<OrderConfirmation> {
    return this.orders.send<OrderConfirmation>(body, {
      timeoutMs: 5000,
      properties: { message_id: body.id, subject: 'order.create.v2' },
      applicationProperties: { tenantId: body.tenantId },
    });
  }

  notifyBulletinChanged(bulletinId: string): void {
    this.changes.emit({ bulletinId, when: new Date().toISOString() });
    // this.changes.send(...) -> TypeScript error: AmqpTopic has no send()
  }
}
```

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

### `@AmqpQueue(address)` → `AmqpQueue`

For **work-queues**. Exposes both `send()` and `emit()`.

```ts
interface AmqpQueue {
  send<TRes>(payload: unknown, options?: SendOptions): Observable<TRes>;
  emit(payload: unknown, options?: EmitOptions): void;
}
```

### `@AmqpTopic(address)` → `AmqpTopic`

For **topics** (stream-backed broadcast). Only `emit()` — calling `send()` is a compile-time TypeScript error.

```ts
interface AmqpTopic {
  emit(payload: unknown, options?: EmitOptions): void;
}
```

### `SendOptions` / `EmitOptions`

| Option | Used by | Meaning |
|---|---|---|
| `timeoutMs` | `send` | Override the default. Errors with `AmqpTimeoutError`. |
| `properties` | both | AMQP standard properties (`message_id`, `subject`, `content_type`, `creation_time`, `user_id`, …). `reply_to` and `correlation_id` are managed internally. |
| `applicationProperties` | both | Custom `Record<string, unknown>` — tenant ID, trace ID, etc. |

## Consumer decorators — `@Subscribe` & `@SubscribeTopic`

Both walk every provider via `DiscoveryService` + `MetadataScanner` at module-init, find decorated methods, validate every parameter is annotated with an `@Amqp*()` decorator (throws at boot otherwise), open a receiver per handler, and dispatch.

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
- Leaves `$oid` as a marker object on decode (the library has no mongoose / bson dependency)

To rehydrate to real mongoose `ObjectId`, msgpack, protobuf, or anything else, provide your own:

```ts
import { Types } from 'mongoose';
import { AmqpModule, type AmqpBodyCodec, JsonBodyCodec } from '@softwarity/nestjs-amqp';

class MongooseAwareCodec extends JsonBodyCodec {
  decode(body: unknown): unknown {
    const v = super.decode(body);
    return rehydrateOids(v);
  }
}

function rehydrateOids(v: unknown): unknown {
  // walk and convert {$oid: hex} -> new Types.ObjectId(hex)
  // ...
}

AmqpModule.forRoot({ appName: 'svc', bodyCodec: new MongooseAwareCodec() });
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
