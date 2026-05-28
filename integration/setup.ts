import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * Jest globalSetup — starts the broker containers via docker compose and
 * blocks until every healthcheck passes (compose v2 `--wait`). The runner
 * just needs Docker installed; nothing else.
 *
 * Set `SKIP_BROKER_SETUP=1` to reuse already-running containers (handy when
 * iterating on a single spec from your IDE).
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.SKIP_BROKER_SETUP === '1') {
    console.log('[integration:setup] SKIP_BROKER_SETUP=1 — assuming brokers are already running');
    return;
  }
  const compose = path.join(__dirname, 'docker-compose.yml');
  console.log('[integration:setup] starting brokers via docker compose…');
  execSync(`docker compose -f "${compose}" up -d --wait`, { stdio: 'inherit' });
  console.log('[integration:setup] brokers ready');
}
