/**
 * Demo data for the dashboard review: one store with an operator and a viewer
 * token, and a few dozen signed orders sent through the real webhook (some
 * resent, to show deduplication). Waits until they are delivered.
 *
 * Usage: tsx scripts/seed-demo.ts --base http://127.0.0.1:3000 --out demo.json
 * Requires PLATFORM_ADMIN_TOKEN. AI usage is deliberately left empty: token
 * counts only ever come from a real provider response.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { signPayload } from '../src/security.js';

const { values } = parseArgs({ options: { base: { type: 'string', default: 'http://127.0.0.1:3000' }, out: { type: 'string', default: 'demo.json' } } });
const base = values.base;
const platformToken = process.env.PLATFORM_ADMIN_TOKEN;
if (!platformToken) throw new Error('PLATFORM_ADMIN_TOKEN is required');

async function platform(path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-platform-token': platformToken! },
  });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json() as Promise<Record<string, string>>;
}

const tenantId = 'loja-aurora';
await platform('/v1/platform/tenants', { id: tenantId, name: 'Loja Aurora (demonstração)' });
const { secret } = await platform(`/v1/platform/tenants/${tenantId}/webhook-keys`, {});
const operator = await platform(`/v1/platform/tenants/${tenantId}/admin-tokens`, { label: 'operação', role: 'operator', expiresInDays: 90 });
const viewer = await platform(`/v1/platform/tenants/${tenantId}/admin-tokens`, { label: 'auditoria', role: 'viewer', expiresInDays: 30 });

const skus = ['CAD-AZUL-A5', 'CANETA-GEL-07', 'AGENDA-2027', 'MARCA-TEXTO-AM', 'PASTA-SANFONA'];
const sent: string[] = [];
for (let i = 1; i <= 36; i += 1) {
  const eventId = `aurora-${String(1000 + i)}`;
  const body = JSON.stringify({
    eventId, orderId: `PED-${String(52000 + i)}`, currency: 'BRL', amountCents: 1990 + ((i * 731) % 18000),
    items: [{ sku: skus[i % skus.length], quantity: 1 + (i % 4) }],
  });
  for (const attempt of i % 9 === 0 ? [1, 2] : [1]) { // every 9th order is resent once
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetch(`${base}/v1/webhooks/orders`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId, 'x-webhook-timestamp': String(timestamp), 'x-webhook-signature': signPayload(body, secret!, timestamp) },
    });
    if (![200, 202].includes(response.status)) throw new Error(`order ${eventId} attempt ${attempt} -> ${response.status}`);
  }
  sent.push(eventId);
}

for (let i = 0; i < 60; i += 1) {
  const summary = await (await fetch(`${base}/v1/operations/summary`, { headers: { 'x-admin-token': operator.token! } })).json() as { statuses: { status: string; count: number }[] };
  if ((summary.statuses.find((row) => row.status === 'delivered')?.count ?? 0) >= sent.length) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

await writeFile(values.out, JSON.stringify({ tenantId, operatorToken: operator.token, viewerToken: viewer.token, orders: sent.length }));
console.log(JSON.stringify({ tenantId, orders: sent.length }));
