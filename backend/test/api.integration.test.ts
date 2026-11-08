import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { config } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { signPayload } from '../src/security.js';
import { createIsolatedDatabase } from './helpers/isolated-db.js';
import { createPool } from '../src/database.js';

const enabled = process.env.RUN_INTEGRATION_TESTS === 'true';
const suite = enabled ? describe : describe.skip;

const secrets = {
  PLATFORM_ADMIN_TOKEN: 'api-test-platform-token-with-32-characters-or-more',
  TENANT_SECRETS_KEY: randomBytes(32),
  TENANT_SECRETS_KEY_PREVIOUS: [] as Buffer[],
};
const platform = { 'x-platform-token': secrets.PLATFORM_ADMIN_TOKEN };

let db: Awaited<ReturnType<typeof createIsolatedDatabase>>;
let redis: Redis;
let app: Awaited<ReturnType<typeof buildApp>>;
type Store = { id: string; webhookSecret: string; adminToken: string; adminTokenId: string };
let storeA: Store;
let storeB: Store;

async function provisionStore(id: string): Promise<Store> {
  expect((await app.inject({ method: 'POST', url: '/v1/platform/tenants', headers: platform, payload: { id, name: `Loja ${id}` } })).statusCode).toBe(201);
  const key = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${id}/webhook-keys`, headers: platform, payload: {} });
  expect(key.statusCode).toBe(201);
  expect(key.headers['cache-control']).toBe('no-store');
  const token = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${id}/admin-tokens`, headers: platform, payload: { label: 'operador' } });
  expect(token.statusCode).toBe(201);
  return { id, webhookSecret: key.json().secret, adminToken: token.json().token, adminTokenId: token.json().tokenId };
}

beforeAll(async () => {
  if (!enabled) return;
  db = await createIsolatedDatabase();
  redis = new Redis(config.REDIS_URL, { enableOfflineQueue: false, lazyConnect: true });
  await redis.connect();
  app = await buildApp({ pool: db.pool, redis, secrets, logger: false });
  storeA = await provisionStore(`loja-a-${randomUUID().slice(0, 8)}`);
  storeB = await provisionStore(`loja-b-${randomUUID().slice(0, 8)}`);
});

afterAll(async () => {
  if (!enabled) return;
  await app.close();
  await redis.quit();
  await db.drop();
});

function order(eventId = `evt-${randomUUID()}`) {
  return { eventId, orderId: `order-${randomUUID()}`, currency: 'BRL', amountCents: 1990, items: [{ sku: 'SKU-1', quantity: 2 }] };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function postWebhook(tenantId: string, secret: string, body = JSON.stringify(order()), timestamp = nowSeconds()) {
  return app.inject({
    method: 'POST', url: '/v1/webhooks/orders', payload: body,
    headers: {
      'content-type': 'application/json', 'x-tenant-id': tenantId,
      'x-webhook-timestamp': String(timestamp), 'x-webhook-signature': signPayload(body, secret, timestamp),
    },
  });
}

const asAdmin = (store: Store, url: string, method: 'GET' | 'POST' = 'GET') =>
  app.inject({ method, url, headers: { 'x-admin-token': store.adminToken } });

suite('HTTP API with multiple stores', () => {
  it('accepts a signed order once and ignores the same event afterwards', async () => {
    const body = JSON.stringify(order());
    expect((await postWebhook(storeA.id, storeA.webhookSecret, body)).statusCode).toBe(202);
    const second = await postWebhook(storeA.id, storeA.webhookSecret, body);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: 'duplicate_ignored' });
  });

  it("rejects another store's key, unknown stores and missing store ids alike", async () => {
    const otherKey = await postWebhook(storeA.id, storeB.webhookSecret);
    const unknown = await postWebhook('loja-inexistente', storeA.webhookSecret);
    const malformed = await postWebhook('Loja Inválida', storeA.webhookSecret);
    for (const response of [otherKey, unknown, malformed]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'invalid_signature' });
    }
  });

  it("shows each admin token only its own store's events", async () => {
    const eventB = order();
    expect((await postWebhook(storeB.id, storeB.webhookSecret, JSON.stringify(eventB))).statusCode).toBe(202);
    const eventsA = (await asAdmin(storeA, '/v1/operations/events')).json().events as { externalEventId: string; id: string }[];
    const eventsB = (await asAdmin(storeB, '/v1/operations/events')).json().events as { externalEventId: string; id: string }[];
    expect(eventsB.map((event) => event.externalEventId)).toContain(eventB.eventId);
    expect(eventsA.map((event) => event.externalEventId)).not.toContain(eventB.eventId);
    // A cursor pointing at another store's event yields nothing rather than its neighbours.
    const crossCursor = await asAdmin(storeA, `/v1/operations/events?cursor=${eventsB[0]!.id}`);
    expect(crossCursor.json().events).toEqual([]);
  });

  it("cannot redrive another store's dead letter", async () => {
    const eventB = (await asAdmin(storeB, '/v1/operations/events')).json().events[0] as { id: string };
    const deadLetter = await db.pool.query<{ id: string }>(
      "INSERT INTO dead_letter_events (integration_event_id, stream_id, attempts, reason) VALUES ($1, $2, 5, 'test') RETURNING id",
      [eventB.id, `test-${randomUUID()}`],
    );
    const fromA = await asAdmin(storeA, `/v1/operations/dead-letters/${deadLetter.rows[0]!.id}/redrive`, 'POST');
    expect(fromA.statusCode).toBe(404);
    expect((await asAdmin(storeA, '/v1/operations/dead-letters')).json().deadLetters).toEqual([]);
    expect((await asAdmin(storeB, '/v1/operations/dead-letters')).json().deadLetters).toHaveLength(1);
  });

  it('keeps shared-stream metrics out of the store summary', async () => {
    const summary = (await asAdmin(storeA, '/v1/operations/summary')).json();
    expect(summary).not.toHaveProperty('redisPending');
    const queue = await app.inject({ method: 'GET', url: '/v1/platform/queue', headers: platform });
    expect(queue.statusCode).toBe(200);
    expect(queue.json()).toHaveProperty('redisPending');
  });

  it('separates platform and store credentials', async () => {
    const storeTokenOnPlatform = await app.inject({ method: 'POST', url: '/v1/platform/tenants', headers: { 'x-platform-token': storeA.adminToken }, payload: { id: 'loja-x', name: 'X' } });
    expect(storeTokenOnPlatform.statusCode).toBe(401);
    const platformTokenOnStore = await app.inject({ method: 'GET', url: '/v1/operations/events', headers: { 'x-admin-token': secrets.PLATFORM_ADMIN_TOKEN } });
    expect(platformTokenOnStore.statusCode).toBe(401);
    const duplicate = await app.inject({ method: 'POST', url: '/v1/platform/tenants', headers: platform, payload: { id: storeA.id, name: 'De novo' } });
    expect(duplicate.statusCode).toBe(409);
  });

  it('rejects captured requests outside the timestamp window, even with a valid signature', async () => {
    const stale = await postWebhook(storeA.id, storeA.webhookSecret, JSON.stringify(order()), nowSeconds() - config.WEBHOOK_TOLERANCE_SECONDS - 5);
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ error: 'timestamp_out_of_tolerance' });
    const future = await postWebhook(storeA.id, storeA.webhookSecret, JSON.stringify(order()), nowSeconds() + config.WEBHOOK_TOLERANCE_SECONDS + 5);
    expect(future.statusCode).toBe(401);
  });

  it('does not let a sender move the timestamp of a captured request', async () => {
    const body = JSON.stringify(order());
    const original = nowSeconds() - config.WEBHOOK_TOLERANCE_SECONDS - 60;
    const forged = await app.inject({
      method: 'POST', url: '/v1/webhooks/orders', payload: body,
      headers: {
        'content-type': 'application/json', 'x-tenant-id': storeA.id,
        'x-webhook-timestamp': String(nowSeconds()), 'x-webhook-signature': signPayload(body, storeA.webhookSecret, original),
      },
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.json()).toEqual({ error: 'invalid_signature' });
  });

  it('absorbs a replay inside the window through event-id dedupe', async () => {
    const body = JSON.stringify(order());
    const timestamp = nowSeconds();
    expect((await postWebhook(storeA.id, storeA.webhookSecret, body, timestamp)).statusCode).toBe(202);
    const replay = await postWebhook(storeA.id, storeA.webhookSecret, body, timestamp);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ status: 'duplicate_ignored' });
  });

  it('rotates webhook keys with a grace period and revokes immediately', async () => {
    const graced = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${storeA.id}/webhook-keys`, headers: platform, payload: { graceHours: 1 } });
    const newSecret = graced.json().secret as string;
    expect((await postWebhook(storeA.id, storeA.webhookSecret)).statusCode).toBe(202);
    expect((await postWebhook(storeA.id, newSecret)).statusCode).toBe(202);

    const immediate = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${storeA.id}/webhook-keys`, headers: platform, payload: { graceHours: 0 } });
    const latest = immediate.json() as { keyId: string; secret: string };
    expect((await postWebhook(storeA.id, storeA.webhookSecret)).statusCode).toBe(401);
    expect((await postWebhook(storeA.id, newSecret)).statusCode).toBe(401);
    expect((await postWebhook(storeA.id, latest.secret)).statusCode).toBe(202);

    const revoke = await app.inject({ method: 'DELETE', url: `/v1/platform/tenants/${storeA.id}/webhook-keys/${latest.keyId}`, headers: platform });
    expect(revoke.statusCode).toBe(204);
    expect((await postWebhook(storeA.id, latest.secret)).statusCode).toBe(401);
  });

  it('stops accepting a revoked admin token', async () => {
    expect((await asAdmin(storeB, '/v1/operations/summary')).statusCode).toBe(200);
    const revoke = await app.inject({ method: 'DELETE', url: `/v1/platform/tenants/${storeB.id}/admin-tokens/${storeB.adminTokenId}`, headers: platform });
    expect(revoke.statusCode).toBe(204);
    expect((await asAdmin(storeB, '/v1/operations/summary')).statusCode).toBe(401);
  });

  it('answers 503 without internal details when the database is unreachable', async () => {
    const unreachable = createPool('test', { connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
    const offline = await buildApp({ pool: unreachable, redis, secrets, logger: false });
    try {
      const response = await offline.inject({ method: 'GET', url: '/v1/operations/summary', headers: { 'x-admin-token': 'hub_adm_anything' } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'temporarily_unavailable' });
      expect(response.body).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|postgres/i);
    } finally {
      await offline.close();
      await unreachable.end();
    }
  });

  it('lets a viewer token read but not act, and reports the session', async () => {
    const created = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${storeA.id}/admin-tokens`, headers: platform, payload: { label: 'auditoria', role: 'viewer', expiresInDays: 7 } });
    expect(created.statusCode).toBe(201);
    const viewer = created.json() as { token: string; role: string; expiresAt: string };
    expect(viewer.role).toBe('viewer');
    const headers = { 'x-admin-token': viewer.token };

    const session = await app.inject({ method: 'GET', url: '/v1/session', headers });
    expect(session.json()).toMatchObject({ tenantId: storeA.id, role: 'viewer' });
    expect((await app.inject({ method: 'GET', url: '/v1/operations/events', headers })).statusCode).toBe(200);
    for (const action of [
      { method: 'POST' as const, url: `/v1/operations/dead-letters/${randomUUID()}/redrive` },
      { method: 'POST' as const, url: '/v1/ai/demo' },
      { method: 'POST' as const, url: `/v1/ai/unresolved/${randomUUID()}/reconcile`, payload: {} },
    ]) {
      const response = await app.inject({ ...action, headers });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'forbidden', requiredRole: 'operator' });
    }
  });

  it('lists token metadata for the platform without exposing tokens or digests', async () => {
    const list = await app.inject({ method: 'GET', url: `/v1/platform/tenants/${storeA.id}/admin-tokens`, headers: platform });
    expect(list.statusCode).toBe(200);
    const tokens = list.json().tokens as Record<string, unknown>[];
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(tokens[0]!).sort()).toEqual(['active', 'createdAt', 'expiresAt', 'id', 'label', 'revokedAt', 'role']);
    expect(list.body).not.toContain('hub_adm_');
    expect((await app.inject({ method: 'GET', url: `/v1/platform/tenants/${storeA.id}/admin-tokens`, headers: { 'x-admin-token': storeA.adminToken } })).statusCode).toBe(401);
  });

  it('rejects invalid token lifetimes and roles', async () => {
    for (const payload of [{ expiresInDays: 0 }, { expiresInDays: 400 }, { role: 'admin' }]) {
      const response = await app.inject({ method: 'POST', url: `/v1/platform/tenants/${storeA.id}/admin-tokens`, headers: platform, payload });
      expect(response.statusCode).toBe(400);
    }
  });
});
