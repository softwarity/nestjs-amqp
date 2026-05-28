import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * Jest globalTeardown — stops the broker containers and removes their
 * volumes so the next run starts from a clean topology.
 *
 * Set `KEEP_BROKERS=1` to leave the containers running between runs (handy
 * during iteration).
 */
export default async function globalTeardown(): Promise<void> {
  if (process.env.KEEP_BROKERS === '1') {
    console.log('[integration:teardown] KEEP_BROKERS=1 — leaving brokers up');
    return;
  }
  const compose = path.join(__dirname, 'docker-compose.yml');
  console.log('[integration:teardown] stopping brokers…');
  execSync(`docker compose -f "${compose}" down -v`, { stdio: 'inherit' });
}
