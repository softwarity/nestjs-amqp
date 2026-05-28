# Integration tests

End-to-end tests that exercise the library against **real broker containers** (RabbitMQ 4.x, ActiveMQ Artemis). Run separately from the unit suite to keep `npm test` fast and Docker-free.

## Prerequisites

- Docker + Compose v2 (`docker compose ...`)
- The library deps (`npm ci` at the repo root)

## Ports used (host side)

To avoid conflicting with a local broker on the standard ports, the compose
file maps the test brokers to non-default host ports:

| Broker | Host port | Container port | Mgmt UI |
|---|---|---|---|
| RabbitMQ | `5674` | 5672 | http://localhost:15674 |
| Artemis  | `5675` | 5672 | http://localhost:8161 |

Override per-spec via `AMQP_RABBITMQ_URL` / `AMQP_ARTEMIS_URL` env vars.

## One-shot run

```bash
npm run test:integration
```

Jest spawns Docker via the `globalSetup`/`globalTeardown` hooks. The containers are torn down even if tests fail.

## Iterating on a single spec

To skip the docker compose lifecycle (e.g. when iterating in your IDE):

```bash
# In a separate shell, start the brokers manually:
docker compose -f integration/docker-compose.yml up -d --wait

# Run jest with the lifecycle disabled:
SKIP_BROKER_SETUP=1 KEEP_BROKERS=1 npx jest --config integration/jest.config.js integration/specs/rabbitmq.spec.ts
```

## What's covered

Each broker spec runs the same 7 scenarios:

1. `emit` + `@Consume` round-trip
2. `send` + return value (request/reply via the shared reply stream)
3. `@Subscribe` topic broadcast (stream / multicast)
4. Retry on throw — succeeds on a later attempt (`maxDelivery > 1`)
5. DLQ on permanent failure — message routed to the broker DLQ
6. Body codec — `Date` round-trip
7. `AmqpDestinations` runtime lookup

A separate `multi-broker.spec.ts` boots both brokers in one process and verifies cross-broker isolation, brand detection, and the strict broker-name requirement.

## Topology

- **RabbitMQ** — full `rabbitmq/definitions.json` loaded at boot by the management plugin (queues, DLX, bindings, the lot).
- **Artemis** — runs with the image's default `broker.xml` (auto-create-queues enabled). Mounting a custom `broker.xml` short-circuits the image's `artemis create` init step, so we accept the defaults and skip the two scenarios that need explicit topology (broadcast multicast, DLQ via DLX). Those are fully covered by the RabbitMQ spec.

We don't dogfood `emitTopologyManifest` here — keeping the test orchestration independent of the feature under test.

## CI

The `.github/workflows/main.yml` workflow runs `npm run test:integration` on every PR. Total runtime including container boot: ~1–2 min on `ubuntu-latest`.
