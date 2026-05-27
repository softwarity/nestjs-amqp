# Release Notes

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
