import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { deliverEvent } from './delivery.js';
import { recordDeliveryFailure } from './failures.js';
import { runMigrations } from './migrations.js';

type StreamEntry = [string, string[]];
type StreamBatch = [string, StreamEntry[]][];

const pool = new Pool({ connectionString: config.DATABASE_URL, max: 5 });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
const consumer = `${config.WORKER_CONSUMER}-${randomUUID()}`;
let stopping = false;

function fieldsToObject(fields: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key !== undefined && value !== undefined) values[key] = value;
  }
  return values;
}

async function ensureConsumerGroup(): Promise<void> {
  try {
    await redis.xgroup('CREATE', config.REDIS_STREAM_KEY, config.REDIS_CONSUMER_GROUP, '0', 'MKSTREAM');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error;
  }
}

async function applyDelivery(streamId: string, fields: Record<string, string>): Promise<void> {
  const eventId = fields.eventId;
  if (!eventId) throw new Error('message_missing_event_id');

  await deliverEvent(pool, eventId);
  await redis.xack(config.REDIS_STREAM_KEY, config.REDIS_CONSUMER_GROUP, streamId);
  console.info(JSON.stringify({ service: 'worker', eventId, streamId, status: 'delivered' }));
}

async function recordFailure(streamId: string, fields: Record<string, string>, error: unknown): Promise<void> {
  const eventId = fields.eventId;
  const reason = error instanceof Error ? error.message.slice(0, 500) : 'unknown_error';
  if (!eventId) {
    await redis.xack(config.REDIS_STREAM_KEY, config.REDIS_CONSUMER_GROUP, streamId);
    console.error(JSON.stringify({ service: 'worker', streamId, status: 'discarded', reason: 'message_missing_event_id' }));
    return;
  }

  const result = await recordDeliveryFailure(pool, eventId, streamId, reason, config.WORKER_MAX_ATTEMPTS);
  if (result.terminal || result.ignored) await redis.xack(config.REDIS_STREAM_KEY, config.REDIS_CONSUMER_GROUP, streamId);
  console.error(JSON.stringify({ service: 'worker', eventId, streamId, attempts: result.attempts,
    status: result.ignored ? 'ignored' : result.terminal ? 'dead_letter' : 'retry_pending', reason }));
}

async function processEntry(entry: StreamEntry): Promise<void> {
  const [streamId, rawFields] = entry;
  const fields = fieldsToObject(rawFields);
  if (!fields.eventId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fields.eventId)) {
    await redis.xack(config.REDIS_STREAM_KEY, config.REDIS_CONSUMER_GROUP, streamId);
    console.error(JSON.stringify({ service: 'worker', streamId, status: 'discarded', reason: 'invalid_event_id' }));
    return;
  }
  try {
    await applyDelivery(streamId, fields);
  } catch (error) {
    await recordFailure(streamId, fields, error);
  }
}

async function claimStaleEntries(): Promise<void> {
  const response = await redis.call(
    'XAUTOCLAIM', config.REDIS_STREAM_KEY, config.REDIS_CONSUMER_GROUP,
    consumer, config.WORKER_CLAIM_IDLE_MS, '0-0', 'COUNT', 10,
  ) as [string, StreamEntry[], string[]?];
  for (const entry of response[1] ?? []) await processEntry(entry);
}

function retryDelay(attempt: number): number {
  const ceiling = Math.min(5_000, 250 * 2 ** Math.min(attempt, 5));
  return Math.floor(ceiling * (0.5 + Math.random() * 0.5));
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

try {
  await runMigrations(pool);
  await ensureConsumerGroup();
  console.info(JSON.stringify({ service: 'worker', consumer, group: config.REDIS_CONSUMER_GROUP }));
  let failures = 0;
  while (!stopping) {
    try {
      await claimStaleEntries();
      const batches = await redis.xreadgroup(
        'GROUP', config.REDIS_CONSUMER_GROUP, consumer,
        'COUNT', 10, 'BLOCK', 5000, 'STREAMS', config.REDIS_STREAM_KEY, '>',
      ) as StreamBatch | null;
      for (const [, entries] of batches ?? []) {
        for (const entry of entries) await processEntry(entry);
      }
      failures = 0;
    } catch {
      failures += 1;
      const delayMs = retryDelay(failures);
      console.error(JSON.stringify({ service: 'worker', status: 'retrying', failures, delayMs }));
      await sleep(delayMs);
    }
  }
} catch (error) {
  console.error(JSON.stringify({ service: 'worker', error: error instanceof Error ? error.message : 'unknown' }));
  process.exitCode = 1;
} finally {
  await Promise.all([pool.end(), redis.quit()]);
}
