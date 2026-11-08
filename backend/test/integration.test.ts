import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { config } from '../src/config.js';
import { deliverEvent } from '../src/delivery.js';
import { recordDeliveryFailure } from '../src/failures.js';
import { runMigrations } from '../src/migrations.js';
import { recordTokenUsage } from '../src/token-usage.js';
import { publishOutboxBatch } from '../src/outbox-publisher.js';
import { runTokenMeterDemo } from '../src/openai-provider.js';
import { reconcileAiUsage } from '../src/ai-reconciliation.js';

const provider = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({ default: class { responses = { create: provider.create }; } }));

const enabled = process.env.RUN_INTEGRATION_TESTS === 'true';
const suite = enabled ? describe : describe.skip;
const schemaName = `integration_test_${randomUUID().replaceAll('-', '')}`;
const adminPool = enabled ? new Pool({ connectionString: config.DATABASE_URL }) : undefined;
const pool = enabled ? new Pool({ connectionString: config.DATABASE_URL, options: `-c search_path=${schemaName}` }) : undefined;
const redis = enabled ? new Redis(config.REDIS_URL, { enableOfflineQueue: false }) : undefined;
const ids: string[] = [];
const usageRequestIds: string[] = [];
const streams: string[] = [];

beforeAll(async () => {
  if (adminPool) await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
});

afterAll(async () => {
  if (pool && ids.length) {
    await pool.query('DELETE FROM dead_letter_events WHERE integration_event_id = ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM erp_deliveries WHERE integration_event_id = ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM outbox_events WHERE integration_event_id = ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM integration_events WHERE id = ANY($1::uuid[])', [ids]);
  }
  if (pool && usageRequestIds.length) {
    await pool.query('DELETE FROM ai_token_usage WHERE provider_request_id = ANY($1::text[])', [usageRequestIds]);
  }
  if (redis && streams.length) await redis.del(...streams);
  await Promise.all([pool?.end(), redis?.quit()]);
  if (adminPool) {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await adminPool.end();
  }
});

suite('local integration services', () => {
  it('applies additive migrations repeatedly without destructive changes', async () => {
    await Promise.all([runMigrations(pool!), runMigrations(pool!), runMigrations(pool!)]);
    await runMigrations(pool!);
    const result = await pool!.query("SELECT to_regclass('erp_deliveries') AS table_name");
    expect(result.rows[0]?.table_name).toBe('erp_deliveries');
    const migrations = await pool!.query('SELECT count(*)::int AS count FROM schema_migrations');
    expect(migrations.rows[0]?.count).toBe(9);
    // Tenant-scoped tables reference tenants (migration 009); later tests write to this tenant.
    await pool!.query('INSERT INTO tenants (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [config.DEMO_TENANT_ID]);
  });

  it('keeps an outbox event pending through Redis outage and publishes it after recovery', async () => {
    const id = randomUUID();
    const stream = `integration:outage:${id}`;
    ids.push(id);
    streams.push(stream);
    const orderId = `order-${id}`;
    await pool!.query(
      `INSERT INTO integration_events(id,tenant_id,source,external_event_id,order_id,payload)
       VALUES($1,$2,'integration-test',$3,$4,'{}'::jsonb)`,
      [id, config.DEMO_TENANT_ID, `outage-${id}`, orderId],
    );
    await pool!.query(
      `INSERT INTO outbox_events(integration_event_id,event_type,payload) VALUES($1,'order.received','{}'::jsonb)`,
      [id],
    );

    const unavailableRedis = new Redis('redis://127.0.0.1:1', {
      connectTimeout: 300, maxRetriesPerRequest: 0, enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    unavailableRedis.on('error', () => undefined);
    try {
      await expect(publishOutboxBatch(pool!, unavailableRedis, stream)).rejects.toThrow();
    } finally {
      await unavailableRedis.quit().catch(() => undefined);
    }

    const afterFailure = await pool!.query(
      'SELECT published_at FROM outbox_events WHERE integration_event_id=$1', [id],
    );
    expect(afterFailure.rows[0]?.published_at).toBeNull();

    expect(await publishOutboxBatch(pool!, redis!, stream)).toBe(1);
    const recovered = await pool!.query(
      'SELECT published_at,redis_stream_id FROM outbox_events WHERE integration_event_id=$1', [id],
    );
    expect(recovered.rows[0]?.published_at).toBeTruthy();
    expect(recovered.rows[0]?.redis_stream_id).toMatch(/^\d+-\d+$/);
    expect(await redis!.xlen(stream)).toBe(1);
  });

  it('records provider-reported token usage exactly once per request ID', async () => {
    const requestId = `integration-test-${randomUUID()}`;
    usageRequestIds.push(requestId);
    const usage = {
      tenantId: config.DEMO_TENANT_ID, task: 'integration-test', provider: 'test-provider', model: 'test-model',
      providerRequestId: requestId, inputTokens: 120, cachedInputTokens: 20,
      outputTokens: 35, reasoningTokens: 8, totalTokens: 155,
    };
    await recordTokenUsage(pool!, usage);
    await recordTokenUsage(pool!, usage);
    const result = await pool!.query(
      'SELECT count(*)::int AS requests, sum(total_tokens)::int AS total FROM ai_token_usage WHERE provider=$1 AND provider_request_id=$2',
      ['test-provider', requestId],
    );
    expect(result.rows[0]).toEqual({ requests: 1, total: 155 });
  });

  it('records successful AI usage and blocks further calls after an unrecordable response', async () => {
    const previousKey = config.OPENAI_API_KEY;
    config.OPENAI_API_KEY = 'test-key';
    const usage = { input_tokens: 12, output_tokens: 3, total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
    provider.create.mockReset();
    provider.create.mockResolvedValueOnce({ id: 'test-success', model: 'test-model', output_text: 'ok', usage });
    provider.create.mockResolvedValueOnce({ id: 'test-unknown', model: 'test-model', output_text: 'ok', usage: { ...usage, total_tokens: 16 } });
    try {
      const result = await runTokenMeterDemo(pool!);
      expect(result.usage.totalTokens).toBe(15);
      await expect(runTokenMeterDemo(pool!)).rejects.toThrow();
      await expect(runTokenMeterDemo(pool!)).rejects.toThrow('ai_usage_unresolved');
      expect(provider.create).toHaveBeenCalledTimes(2);
      const journal = await pool!.query("SELECT status, count(*)::int AS count FROM ai_request_journal GROUP BY status ORDER BY status");
      expect(journal.rows).toEqual([{ status: 'pending', count: 1 }, { status: 'recorded', count: 1 }]);
      const pending = await pool!.query("SELECT id FROM ai_request_journal WHERE status='pending'");
      const reconciledUsage = { tenantId: config.DEMO_TENANT_ID, task: 'portfolio-token-meter-demo', provider: 'openai', model: 'test-model', providerRequestId: 'test-reconciled', inputTokens: 12, outputTokens: 3, totalTokens: 15 };
      await reconcileAiUsage(pool!, pending.rows[0].id, config.DEMO_TENANT_ID, reconciledUsage, 'verified test usage');
      await expect(reconcileAiUsage(pool!, pending.rows[0].id, config.DEMO_TENANT_ID, reconciledUsage, 'verified test usage')).rejects.toThrow('pending_request_not_found');
      expect((await pool!.query("SELECT count(*)::int AS count FROM ai_request_journal WHERE status='pending'")).rows[0].count).toBe(0);
    } finally {
      config.OPENAI_API_KEY = previousKey;
    }
  });

  it('closes the intent on a provider refusal so later calls are not blocked', async () => {
    const previousKey = config.OPENAI_API_KEY;
    config.OPENAI_API_KEY = 'test-key';
    const usage = { input_tokens: 12, output_tokens: 3, total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
    provider.create.mockReset();
    provider.create.mockRejectedValueOnce(Object.assign(new Error('model not found'), { status: 404, requestID: 'test-rejected' }));
    provider.create.mockResolvedValueOnce({ id: 'test-after-rejection', model: 'test-model', output_text: 'ok', usage });
    try {
      await expect(runTokenMeterDemo(pool!)).rejects.toThrow('model not found');
      const rejected = await pool!.query("SELECT status, provider_status, provider_request_id FROM ai_request_journal WHERE provider_request_id='test-rejected'");
      expect(rejected.rows).toEqual([{ status: 'rejected', provider_status: 404, provider_request_id: 'test-rejected' }]);
      const result = await runTokenMeterDemo(pool!);
      expect(result.requestId).toBe('test-after-rejection');
      expect((await pool!.query("SELECT count(*)::int AS count FROM ai_request_journal WHERE status='pending'")).rows[0].count).toBe(0);
    } finally {
      config.OPENAI_API_KEY = previousKey;
    }
  });

  it('serializes token-budget admissions across database sessions', async () => {
    const lockName = `integration-test-token-budget:${randomUUID()}`;
    const first = await pool!.connect();
    const second = await pool!.connect();
    try {
      const acquiredFirst = await first.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [lockName],
      );
      const acquiredSecond = await second.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [lockName],
      );
      expect(acquiredFirst.rows[0]?.acquired).toBe(true);
      expect(acquiredSecond.rows[0]?.acquired).toBe(false);

      await first.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]);
      const acquiredAfterRelease = await second.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [lockName],
      );
      expect(acquiredAfterRelease.rows[0]?.acquired).toBe(true);
    } finally {
      await first.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]).catch(() => undefined);
      await second.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]).catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it('deduplicates webhook identity and destination effect under repeated delivery', async () => {
    const id = randomUUID();
    ids.push(id);
    const eventKey = `integration-test-${id}`;
    const payload = { eventId: eventKey, orderId: `order-${id}`, currency: 'BRL', amountCents: 1200, items: [{ sku: 'SKU-IT', quantity: 1 }] };
    await pool!.query(
      `INSERT INTO integration_events (id, tenant_id, source, external_event_id, order_id, payload)
       VALUES ($1,$2,'integration-test',$3,$4,$5::jsonb)`,
      [id, config.DEMO_TENANT_ID, eventKey, payload.orderId, JSON.stringify(payload)],
    );
    const first = await pool!.query(
      `INSERT INTO integration_events (tenant_id, source, external_event_id, order_id, payload)
       VALUES ($1,'integration-test',$2,$3,$4::jsonb) ON CONFLICT (tenant_id,source,external_event_id) DO NOTHING RETURNING id`,
      [config.DEMO_TENANT_ID, eventKey, payload.orderId, JSON.stringify(payload)],
    );
    expect(first.rowCount).toBe(0);

    const outcomes = await Promise.all([deliverEvent(pool!, id), deliverEvent(pool!, id)]);
    expect(outcomes.sort()).toEqual(['already_delivered', 'delivered']);
    const deliveries = await pool!.query('SELECT count(*)::int AS count FROM erp_deliveries WHERE integration_event_id=$1', [id]);
    expect(deliveries.rows[0]?.count).toBe(1);
  });

  it('limits retries and records one terminal dead letter', async () => {
    const id = randomUUID();
    ids.push(id);
    await pool!.query(
      `INSERT INTO integration_events (id,tenant_id,source,external_event_id,order_id,payload,status)
       VALUES ($1,$2,'integration-test',$3,$4,'{}'::jsonb,'processing')`,
      [id, config.DEMO_TENANT_ID, `failure-${id}`, `order-${id}`],
    );
    const streamId = `test-${id}`;
    const first = await recordDeliveryFailure(pool!, id, streamId, 'temporary_failure', 2);
    const second = await recordDeliveryFailure(pool!, id, streamId, 'temporary_failure', 2);
    expect(first).toMatchObject({ attempts: 1, terminal: false, ignored: false });
    expect(second).toMatchObject({ attempts: 2, terminal: true, ignored: false });
    const persisted = await pool!.query(
      `SELECT e.status,e.attempts,count(d.id)::int AS dead_letters FROM integration_events e
       LEFT JOIN dead_letter_events d ON d.integration_event_id=e.id WHERE e.id=$1 GROUP BY e.id`, [id],
    );
    expect(persisted.rows[0]).toMatchObject({ status: 'failed', attempts: 2, dead_letters: 1 });
    expect(await deliverEvent(pool!, id)).toBe('skipped_failed');
    const duplicate = await recordDeliveryFailure(pool!, id, `duplicate-${id}`, 'duplicate', 2);
    const afterDuplicate = await pool!.query("SELECT status, attempts, (SELECT count(*)::int FROM erp_deliveries WHERE integration_event_id=$1) AS deliveries FROM integration_events WHERE id=$1", [id]);
    expect(duplicate.ignored).toBe(true);
    expect(afterDuplicate.rows[0]).toEqual({ status: 'failed', attempts: 2, deliveries: 0 });
  });

  it('can create and acknowledge a Redis Streams consumer-group message', async () => {
    const stream = `integration:test:${randomUUID()}`;
    const group = 'integration-test-group';
    await redis!.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    const id = await redis!.xadd(stream, '*', 'eventId', randomUUID(), 'payload', '{}');
    const messages = await redis!.xreadgroup('GROUP', group, 'test-consumer', 'COUNT', 1, 'STREAMS', stream, '>');
    expect(messages?.[0]?.[1]?.[0]?.[0]).toBe(id);
    expect(await redis!.xack(stream, group, id!)).toBe(1);
    await redis!.del(stream);
  });

  it('recovers a pending Redis Streams entry with XAUTOCLAIM', async () => {
    const stream = `integration:claim:${randomUUID()}`;
    const group = 'integration-test-group';
    await redis!.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    const id = await redis!.xadd(stream, '*', 'eventId', randomUUID());
    await redis!.xreadgroup('GROUP', group, 'crashed-consumer', 'COUNT', 1, 'STREAMS', stream, '>');
    const response = await redis!.call('XAUTOCLAIM', stream, group, 'recovery-consumer', 0, '0-0', 'COUNT', 10) as [string, unknown[]];
    expect(response[1].map((entry) => (entry as [string])[0])).toContain(id);
    await redis!.xack(stream, group, id!);
    await redis!.del(stream);
  });
});
