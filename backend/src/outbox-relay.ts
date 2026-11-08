import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { createPool, migrateWhenReady } from './database.js';
import { publishOutboxBatch } from './outbox-publisher.js';

const pool = createPool('outbox-relay', { connectionString: config.DATABASE_URL, max: 5 });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
const batchSize = 25;

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

function retryDelay(attempt: number): number {
  const ceiling = Math.min(5_000, 250 * 2 ** Math.min(attempt, 5));
  return Math.floor(ceiling * (0.5 + Math.random() * 0.5));
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

try {
  await migrateWhenReady(pool, 'outbox-relay', () => stopping);
  const consumer = randomUUID();
  console.info(JSON.stringify({ service: 'outbox-relay', consumer, stream: config.REDIS_STREAM_KEY }));
  let failures = 0;
  while (!stopping) {
    try {
      const published = await publishOutboxBatch(pool, redis, config.REDIS_STREAM_KEY, batchSize);
      failures = 0;
      if (published === 0) await sleep(1000);
    } catch {
      failures += 1;
      const delayMs = retryDelay(failures);
      console.error(JSON.stringify({ service: 'outbox-relay', status: 'retrying', failures, delayMs }));
      await sleep(delayMs);
    }
  }
} catch (error) {
  console.error(JSON.stringify({ service: 'outbox-relay', error: error instanceof Error ? error.message : 'unknown' }));
  process.exitCode = 1;
} finally {
  await Promise.all([pool.end(), redis.quit()]);
}
