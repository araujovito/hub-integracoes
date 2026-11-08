import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { runMigrations } from './migrations.js';
import { applyRetention, trimStream } from './maintenance.js';

const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
let stopping = false;
let wake: (() => void) | undefined;
const stop = () => { stopping = true; wake?.(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const sleep = (ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); wake = () => { clearTimeout(timer); resolve(); }; });

/** One maintenance pass; a session advisory lock keeps replicas from overlapping. */
async function runOnce(): Promise<void> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('hub-integracoes:maintenance', 0)) AS acquired");
    if (!lock.rows[0]?.acquired) return;
    try {
      const trimmed = await trimStream(redis, config.REDIS_STREAM_KEY, config.REDIS_CONSUMER_GROUP, config.STREAM_RETENTION_HOURS * 3_600_000);
      const retention = await applyRetention(pool, config.DATA_RETENTION_DAYS);
      console.info(JSON.stringify({ service: 'maintenance', status: 'ok', trimmedStreamEntries: trimmed, ...retention }));
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended('hub-integracoes:maintenance', 0))");
    }
  } finally {
    client.release();
  }
}

try {
  await runMigrations(pool);
  console.info(JSON.stringify({ service: 'maintenance', streamRetentionHours: config.STREAM_RETENTION_HOURS,
    dataRetentionDays: config.DATA_RETENTION_DAYS, intervalSeconds: config.MAINTENANCE_INTERVAL_SECONDS }));
  while (!stopping) {
    try {
      await runOnce();
    } catch (error) {
      console.error(JSON.stringify({ service: 'maintenance', status: 'failed', error: error instanceof Error ? error.message : 'unknown' }));
    }
    await sleep(config.MAINTENANCE_INTERVAL_SECONDS * 1000);
  }
} finally {
  await Promise.all([pool.end(), redis.quit()]);
}
