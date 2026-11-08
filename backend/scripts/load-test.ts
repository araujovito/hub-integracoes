/**
 * Sustained-load client for the webhook pipeline.
 *
 * Provisions a fresh store through the platform API, sends signed orders at a
 * fixed rate (open loop: the schedule does not slow down when the server does),
 * resends ~5% of accepted events to exercise dedupe, retries 429/5xx/network
 * errors like a real sender would (same eventId, fresh timestamp), then waits
 * until every accepted event is delivered.
 *
 * Usage: tsx scripts/load-test.ts --base http://127.0.0.1:3000 --duration 60 --rate 25
 * Requires PLATFORM_ADMIN_TOKEN in the environment. Exit code 1 on any loss.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { signPayload } from '../src/security.js';

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:3000' },
    duration: { type: 'string', default: '60' },
    rate: { type: 'string', default: '25' },
    'drain-timeout': { type: 'string', default: '180' },
    'tenant-file': { type: 'string' },
  },
});
const base = values.base;
const durationSeconds = Number(values.duration);
const ratePerSecond = Number(values.rate);
const drainTimeoutSeconds = Number(values['drain-timeout']);
const platformToken = process.env.PLATFORM_ADMIN_TOKEN;
if (!platformToken) throw new Error('PLATFORM_ADMIN_TOKEN is required');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function platform(path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-platform-token': platformToken! },
  });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json() as Promise<Record<string, string>>;
}

const tenantId = `load-${Date.now()}`;
await platform('/v1/platform/tenants', { id: tenantId, name: 'Load test' });
const { secret } = await platform(`/v1/platform/tenants/${tenantId}/webhook-keys`, {});
const { token: adminToken } = await platform(`/v1/platform/tenants/${tenantId}/admin-tokens`, { label: 'load-test' });
if (values['tenant-file']) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(values['tenant-file'], tenantId);
}

const statusCounts = new Map<string, number>();
const latencies: number[] = [];
const accepted = new Set<string>();
let gaveUp = 0;
let retries = 0;
const count = (key: string) => statusCounts.set(key, (statusCounts.get(key) ?? 0) + 1);

/** Send one event until the server gives a final answer (2xx or 4xx other than 429). */
async function send(eventId: string, body: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const timestamp = Math.floor(Date.now() / 1000);
    const started = performance.now();
    let status: number | 'network';
    try {
      const response = await fetch(`${base}/v1/webhooks/orders`, {
        method: 'POST', body,
        headers: {
          'content-type': 'application/json', 'x-tenant-id': tenantId,
          'x-webhook-timestamp': String(timestamp), 'x-webhook-signature': signPayload(body, secret!, timestamp),
        },
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
      await response.arrayBuffer();
    } catch {
      status = 'network';
    }
    latencies.push(performance.now() - started);
    count(String(status));
    if (status === 202 || status === 200) {
      accepted.add(eventId);
      return;
    }
    if (status !== 'network' && status !== 429 && status < 500) {
      gaveUp += 1; // a 4xx here is a bug in the client or the server
      return;
    }
    retries += 1;
    await sleep(Math.min(2_000, 100 * 2 ** Math.min(attempt, 5)));
  }
  gaveUp += 1;
}

const bodies = new Map<string, string>();
const inFlight = new Set<Promise<void>>();
const startedAt = Date.now();
const total = Math.round(durationSeconds * ratePerSecond);
for (let i = 0; i < total; i += 1) {
  const due = startedAt + (i * 1000) / ratePerSecond;
  const wait = due - Date.now();
  if (wait > 0) await sleep(wait);
  let eventId: string;
  let body: string;
  const acceptedIds = [...accepted];
  if (i % 20 === 19 && acceptedIds.length > 0) {
    eventId = acceptedIds[Math.floor(Math.random() * acceptedIds.length)]!;
    body = bodies.get(eventId)!; // resend: must not create a second delivery
  } else {
    eventId = `evt-${randomUUID()}`;
    body = JSON.stringify({ eventId, orderId: `ord-${i}`, currency: 'BRL', amountCents: 100 + i, items: [{ sku: `SKU-${i % 50}`, quantity: 1 }] });
    bodies.set(eventId, body);
  }
  const promise = send(eventId, body).finally(() => inFlight.delete(promise));
  inFlight.add(promise);
}
await Promise.all(inFlight);
const sendSeconds = (Date.now() - startedAt) / 1000;

// Drain: wait until every accepted event is delivered (or a terminal failure shows up).
type Summary = { statuses: { status: string; count: number }[]; deadLetters: number };
let summary: Summary | undefined;
const drainDeadline = Date.now() + drainTimeoutSeconds * 1000;
let delivered = 0;
while (Date.now() < drainDeadline) {
  try {
    const response = await fetch(`${base}/v1/operations/summary`, { headers: { 'x-admin-token': adminToken! } });
    if (response.ok) {
      summary = await response.json() as Summary;
      delivered = summary.statuses.find((row) => row.status === 'delivered')?.count ?? 0;
      if (delivered >= accepted.size || summary.deadLetters > 0) break;
    }
  } catch {
    // API may be briefly unavailable during resilience scenarios.
  }
  await sleep(1000);
}

const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0);
const report = {
  tenantId, sendSeconds: Number(sendSeconds.toFixed(1)), requestsScheduled: total,
  uniqueEventsAccepted: accepted.size, delivered, deadLetters: summary?.deadLetters ?? null,
  retries, gaveUp, httpStatus: Object.fromEntries(statusCounts),
  latencyMs: { p50: pct(50), p95: pct(95), p99: pct(99), max: Math.round(sorted.at(-1) ?? 0) },
};
console.log(JSON.stringify(report, null, 2));
const ok = gaveUp === 0 && delivered === accepted.size && (summary?.deadLetters ?? 0) === 0;
if (!ok) {
  console.error('LOAD TEST FAILED: lost, undelivered or dead-lettered events');
  process.exitCode = 1;
}
