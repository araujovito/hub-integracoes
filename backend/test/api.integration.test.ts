import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { config } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { signPayload } from '../src/security.js';
import { createIsolatedDatabase } from './helpers/isolated-db.js';

const enabled = process.env.RUN_INTEGRATION_TESTS === 'true';
const suite = enabled ? describe : describe.skip;

const secrets = {
  WEBHOOK_SECRET: 'api-test-webhook-secret-with-32-characters-or-more',
  ADMIN_API_TOKEN: 'api-test-admin-token-with-32-characters-or-more',
};

let db: Awaited<ReturnType<typeof createIsolatedDatabase>>;
let redis: Redis;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  if (!enabled) return;
  db = await createIsolatedDatabase();
  redis = new Redis(config.REDIS_URL, { enableOfflineQueue: false, lazyConnect: true });
  await redis.connect();
  app = await buildApp({ pool: db.pool, redis, secrets, logger: false });
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

function postWebhook(body: string, signature = signPayload(body, secrets.WEBHOOK_SECRET)) {
  return app.inject({
    method: 'POST', url: '/v1/webhooks/orders', payload: body,
    headers: { 'content-type': 'application/json', 'x-webhook-signature': signature },
  });
}

suite('HTTP API', () => {
  it('accepts a signed order once and ignores the same event afterwards', async () => {
    const body = JSON.stringify(order());
    const first = await postWebhook(body);
    expect(first.statusCode).toBe(202);
    const second = await postWebhook(body);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: 'duplicate_ignored' });
  });

  it('rejects a body whose signature does not match', async () => {
    const body = JSON.stringify(order());
    const response = await postWebhook(body, signPayload(`${body} `, secrets.WEBHOOK_SECRET));
    expect(response.statusCode).toBe(401);
  });

  it('protects operations routes with the admin token', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/v1/operations/events' });
    expect(anonymous.statusCode).toBe(401);
    const authorized = await app.inject({ method: 'GET', url: '/v1/operations/events', headers: { 'x-admin-token': secrets.ADMIN_API_TOKEN } });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json().events.length).toBeGreaterThan(0);
  });
});
