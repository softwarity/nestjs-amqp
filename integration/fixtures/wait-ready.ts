import type { INestApplicationContext } from '@nestjs/common';
import { filter, firstValueFrom, take } from 'rxjs';
import { BrokerRegistry } from '../../src';

/**
 * Wait until every configured broker has signalled `connection_open` plus a
 * small buffer for receivers to attach. Call from `beforeAll` after
 * `testingModule.init()`.
 *
 * Without this, the first `emit()` of a test can land before the consumer
 * receiver is attached. RabbitMQ buffers the message (durable queue) so it's
 * eventually delivered — but the test ends up flaky on tight timeouts.
 *
 * Accepts any `INestApplicationContext` — works with both `TestingModule`
 * (compiled without an HTTP adapter, the cheap path for tests) and a real
 * `INestApplication` (with adapter, when the test needs HTTP).
 */
export async function waitForAllBrokersReady(
  app: INestApplicationContext,
  receiverAttachBufferMs = 300,
): Promise<void> {
  const registry = app.get(BrokerRegistry);
  for (const name of registry.names()) {
    const broker = registry.getConnection(name);
    if (!broker.options.enabled) continue;
    await firstValueFrom(broker.connected$.pipe(filter((c) => c), take(1)));
  }
  await new Promise((r) => setTimeout(r, receiverAttachBufferMs));
}
