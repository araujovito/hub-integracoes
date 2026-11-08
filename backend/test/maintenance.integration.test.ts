import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { config } from '../src/config.js';
import { applyRetention, trimStream } from '../src/maintenance.js';
import { createIsolatedDatabase } from './helpers/isolated-db.js';

const enabled = process.env.RUN_INTEGRATION_TESTS === 'true';
const suite = enabled ? describe : describe.skip;
let db: Awaited<ReturnType<typeof createIsolatedDatabase>>;
let redis: Redis;
const stream = `integration:maintenance:${randomUUID()}`;
const group = 'maintenance-test';

beforeAll(async () => {
  if (!enabled) return;
  db = await createIsolatedDatabase();
  redis = new Redis(config.REDIS_URL, { enableOfflineQueue: false, lazyConnect: true });
  await redis.connect();
  await db.pool.query("INSERT INTO tenants (id, name) VALUES ('loja-ret', 'Retenção')");
});

afterAll(async () => {
  if (!enabled) return;
  await redis.del(stream);
  await redis.quit();
  await db.drop();
});

suite('maintenance', () => {
  it('trims only old acknowledged entries, keeping pending and unread ones', async () => {
    const day = 86_400_000;
    const now = Date.now();
    // Four old entries (10 days) and one recent.
    const ids = [];
    for (let i = 1; i <= 4; i += 1) ids.push(await redis.xadd(stream, `${now - 10 * day + i}-0`, 'n', String(i)));
    await redis.xgroup('CREATE', stream, group, '0');
    // Read the first three; ack 1 and 3, leave 2 pending; entry 4 stays unread.
    await redis.xreadgroup('GROUP', group, 'c1', 'COUNT', 3, 'STREAMS', stream, '>');
    await redis.xack(stream, group, ids[0]!, ids[2]!);
    await redis.xadd(stream, '*', 'n', 'recent');

    const removed = await trimStream(redis, stream, group, 3 * day, now);
    expect(removed).toBe(1); // only entry 1: entry 2 is pending, so it and everything after stay
    const remaining = (await redis.xrange(stream, '-', '+')).map(([, fields]) => fields[1]);
    expect(remaining).toEqual(['2', '3', '4', 'recent']);

    await redis.xack(stream, group, ids[1]!);
    expect(await trimStream(redis, stream, group, 3 * day, now)).toBe(2); // 2 and 3; 4 was never read
    expect((await redis.xrange(stream, '-', '+')).map(([, fields]) => fields[1])).toEqual(['4', 'recent']);
  });

  it('keeps everything when the consumer group does not exist', async () => {
    const other = `integration:maintenance:${randomUUID()}`;
    await redis.xadd(other, '1-0', 'n', 'old');
    expect(await trimStream(redis, other, 'no-group', 1000, Date.now())).toBe(0);
    expect(await redis.xlen(other)).toBe(1);
    await redis.del(other);
  });

  it('redacts old delivered payloads, keeps failed and recent ones, and drops old published outbox rows', async () => {
    const insert = async (status: string, ageDays: number) => {
      const id = randomUUID();
      await db.pool.query(
        `INSERT INTO integration_events (id, tenant_id, source, external_event_id, order_id, payload, status, updated_at)
         VALUES ($1, 'loja-ret', 'test', $2, 'o', '{"items":[1]}', $3, now() - make_interval(days => $4))`,
        [id, `evt-${id}`, status, ageDays],
      );
      await db.pool.query(
        `INSERT INTO outbox_events (integration_event_id, event_type, payload, published_at)
         VALUES ($1, 'order.received', '{}', now() - make_interval(days => $2))`, [id, ageDays],
      );
      if (status === 'delivered') {
        await db.pool.query(
          `INSERT INTO erp_deliveries (tenant_id, integration_event_id, order_id, payload, delivered_at)
           VALUES ('loja-ret', $1, 'o', '{"items":[1]}', now() - make_interval(days => $2))`, [id, ageDays],
        );
      }
      return id;
    };
    const oldDelivered = await insert('delivered', 120);
    const oldFailed = await insert('failed', 120);
    const recentDelivered = await insert('delivered', 5);

    const result = await applyRetention(db.pool, 90, 1);
    expect(result).toEqual({ redactedEvents: 1, redactedDeliveries: 1, deletedOutbox: 2 });

    const events = await db.pool.query<{ id: string; payload: unknown; redacted: boolean }>(
      'SELECT id, payload, payload_redacted_at IS NOT NULL AS redacted FROM integration_events WHERE id = ANY($1)',
      [[oldDelivered, oldFailed, recentDelivered]],
    );
    const byId = Object.fromEntries(events.rows.map((row) => [row.id, row]));
    expect(byId[oldDelivered]).toMatchObject({ payload: {}, redacted: true });
    expect(byId[oldFailed]).toMatchObject({ payload: { items: [1] }, redacted: false });
    expect(byId[recentDelivered]).toMatchObject({ payload: { items: [1] }, redacted: false });

    // The identity row remains, so the same event id is still recognised as a duplicate.
    const dedupe = await db.pool.query(
      `INSERT INTO integration_events (tenant_id, source, external_event_id, order_id, payload)
       VALUES ('loja-ret', 'test', $1, 'o', '{}') ON CONFLICT DO NOTHING RETURNING id`, [`evt-${oldDelivered}`],
    );
    expect(dedupe.rowCount).toBe(0);
    expect(await applyRetention(db.pool, 90)).toEqual({ redactedEvents: 0, redactedDeliveries: 0, deletedOutbox: 0 });
  });
});
