import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

export type WebhookResult =
  | 'accepted' | 'duplicate' | 'invalid_signature' | 'stale_timestamp'
  | 'invalid_order' | 'unsupported_media_type' | 'unavailable';

/**
 * Prometheus metrics for one API instance.
 * - Counters/histograms are per process (sum them across replicas in queries).
 * - Pipeline gauges are read from PostgreSQL/Redis at scrape time, so every
 *   replica reports the same global values (use max() rather than sum()).
 * Labels never include tenant ids, order ids or raw URLs: cardinality stays
 * bounded and the endpoint does not enumerate stores.
 */
export function createMetrics(deps: { pool: Pool; redis: Redis; streamKey: string; group: string }) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'hub_' });
  const registers = [registry];

  const httpRequests = new Counter({
    name: 'hub_http_requests_total', help: 'HTTP requests by route template and status code.',
    labelNames: ['method', 'route', 'status'] as const, registers,
  });
  const httpDuration = new Histogram({
    name: 'hub_http_request_duration_seconds', help: 'HTTP request latency by route template.',
    labelNames: ['method', 'route'] as const, buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers,
  });
  const webhooks = new Counter({
    name: 'hub_webhooks_total', help: 'Order webhooks by outcome.', labelNames: ['result'] as const, registers,
  });

  const { pool, redis } = deps;
  new Gauge({
    name: 'hub_events_backlog', help: 'Events not delivered yet, by status (failed = in dead letter).',
    labelNames: ['status'] as const, registers,
    async collect() {
      const rows = await pool.query<{ status: string; count: number }>(
        "SELECT status, count(*)::int AS count FROM integration_events WHERE status <> 'delivered' GROUP BY status",
      );
      this.reset();
      for (const status of ['received', 'queued', 'processing', 'failed']) {
        this.set({ status }, rows.rows.find((row) => row.status === status)?.count ?? 0);
      }
    },
  });
  new Gauge({
    name: 'hub_dead_letters_pending', help: 'Dead letters waiting for a decision (not redriven).', registers,
    async collect() {
      this.set((await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM dead_letter_events WHERE redriven_at IS NULL')).rows[0]?.count ?? 0);
    },
  });
  new Gauge({
    name: 'hub_outbox_unpublished', help: 'Outbox rows not yet published to Redis.', registers,
    async collect() {
      this.set((await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM outbox_events WHERE published_at IS NULL')).rows[0]?.count ?? 0);
    },
  });
  new Gauge({
    name: 'hub_outbox_oldest_age_seconds', help: 'Age of the oldest unpublished outbox row (0 when empty).', registers,
    async collect() {
      const row = (await pool.query<{ age: number | null }>(
        'SELECT extract(epoch FROM now() - min(created_at))::float AS age FROM outbox_events WHERE published_at IS NULL',
      )).rows[0];
      this.set(row?.age ?? 0);
    },
  });
  new Gauge({
    name: 'hub_deliveries_last_5m', help: 'ERP deliveries completed in the last 5 minutes.', registers,
    async collect() {
      this.set((await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM erp_deliveries WHERE delivered_at > now() - interval '5 minutes'",
      )).rows[0]?.count ?? 0);
    },
  });
  new Gauge({
    name: 'hub_redis_stream_pending', help: 'Messages read by the consumer group but not acknowledged.', registers,
    async collect() {
      try {
        const pending = await redis.call('XPENDING', deps.streamKey, deps.group) as [number];
        this.set(pending[0] ?? 0);
      } catch {
        this.set(0); // stream or group not created yet
      }
    },
  });
  new Gauge({
    name: 'hub_redis_stream_length', help: 'Entries kept in the Redis stream (trimmed by maintenance).', registers,
    async collect() {
      this.set(await redis.xlen(deps.streamKey));
    },
  });

  return {
    registry,
    observeRequest(method: string, route: string, status: number, seconds: number) {
      httpRequests.inc({ method, route, status: String(status) });
      httpDuration.observe({ method, route }, seconds);
    },
    webhook(result: WebhookResult) {
      webhooks.inc({ result });
    },
  };
}
