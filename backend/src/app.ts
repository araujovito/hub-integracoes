import Fastify, { type FastifyError, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config, type ApiSecrets } from './config.js';
import { orderSchema } from './orders.js';
import { isFreshTimestamp, parseWebhookTimestamp, verifyAdminToken, verifySignature } from './security.js';
import { isOpenAiConfigured, runTokenMeterDemo } from './openai-provider.js';
import { reconcileAiUsage } from './ai-reconciliation.js';
import { isParsedJson, type ParsedJson } from './json-body.js';
import { isTransientDatabaseError } from './database.js';
import { createMetrics } from './metrics.js';
import {
  activeWebhookSecrets, createAdminToken, createTenant, createWebhookKey,
  listAdminTokens, resolveAdminToken, revokeAdminToken, revokeWebhookKey, TENANT_ID_PATTERN, TenantNotFoundError,
  type AdminRole, type AdminSession,
} from './tenants.js';

export type AppDependencies = {
  pool: Pool;
  redis: Redis;
  secrets: ApiSecrets;
  /** Disable request logging (tests). */
  logger?: boolean;
};

/**
 * Build the HTTP API without listening or migrating, so routes can be exercised
 * with `app.inject()` in tests. Connection lifecycle belongs to the caller.
 */
export async function buildApp({ pool, redis, secrets, logger = true }: AppDependencies) {
  const app = Fastify({
    logger: logger ? { redact: ['req.headers.authorization', 'req.headers.x-admin-token', 'req.headers.x-platform-token', 'req.headers.x-webhook-signature'] } : false,
    bodyLimit: 256 * 1024,
    // Trust only the nearest TRUST_PROXY_HOPS proxies (hop 0 is the socket peer).
    trustProxy: config.TRUST_PROXY_HOPS > 0 ? (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS : false,
  });
  const dashboardHtml = await readFile(resolve(process.cwd(), '../dashboard/index.html'), 'utf8').catch(() => '<h1>Dashboard asset unavailable</h1>');

  type Reply = { code: (status: number) => { send: (payload: unknown) => unknown } };
  const masterKeys = { current: secrets.TENANT_SECRETS_KEY, previous: secrets.TENANT_SECRETS_KEY_PREVIOUS };
  const metrics = createMetrics({ pool, redis, streamKey: config.REDIS_STREAM_KEY, group: config.REDIS_CONSUMER_GROUP });

  // Route template (e.g. /v1/operations/dead-letters/:id/redrive), never the raw
  // URL: ids in paths would explode label cardinality.
  app.addHook('onResponse', async (request, reply) => {
    metrics.observeRequest(request.method, request.routeOptions.url ?? 'unmatched', reply.statusCode, reply.elapsedTime / 1000);
  });

  app.get('/metrics', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!secrets.METRICS_TOKEN) return reply.code(404).send({ error: 'not_found' });
    const authorization = header(request, 'authorization');
    const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!verifyAdminToken(supplied, secrets.METRICS_TOKEN)) return reply.code(401).send({ error: 'unauthorized' });
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  function header(request: FastifyRequest, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }

  /**
   * Session of the X-Admin-Token, or null after replying 401 (unknown, revoked or
   * expired) or 403 (role too low). Every operations query is filtered by the
   * session's tenant, so a token only sees its own store.
   */
  async function requireTenantAdmin(request: FastifyRequest, reply: Reply, required: AdminRole): Promise<AdminSession | null> {
    const session = await resolveAdminToken(pool, header(request, 'x-admin-token'));
    if (!session) {
      reply.code(401).send({ error: 'unauthorized' });
      return null;
    }
    if (required === 'operator' && session.role !== 'operator') {
      reply.code(403).send({ error: 'forbidden', requiredRole: 'operator' });
      return null;
    }
    return session;
  }

  /** Platform operator (manages stores and their credentials); sees no store data. */
  function requirePlatformAdmin(request: FastifyRequest, reply: Reply): boolean {
    if (verifyAdminToken(header(request, 'x-platform-token'), secrets.PLATFORM_ADMIN_TOKEN)) return true;
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }

  // Never return internal error messages (hostnames, SQL, stack details).
  // Client errors raised by Fastify itself (4xx) keep their status and message.
  app.setErrorHandler((rawError, request, reply) => {
    const error = rawError as FastifyError;
    const statusCode = error.statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: error.code ?? 'bad_request', message: error.message });
    }
    if (isTransientDatabaseError(error) || (error as { name?: string }).name === 'MaxRetriesPerRequestError') {
      request.log.warn({ err: error }, 'dependency unavailable');
      if (request.routeOptions.url === '/v1/webhooks/orders') metrics.webhook('unavailable');
      return reply.code(503).send({ error: 'temporarily_unavailable' });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    try {
      const raw = body.toString('utf8');
      done(null, { raw, value: JSON.parse(raw) } satisfies ParsedJson);
    } catch {
      done(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
    }
  });

  await app.register(rateLimit, { global: false, redis, nameSpace: 'hub-rate-limit:' });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('strict-transport-security', config.NODE_ENV === 'production' ? 'max-age=31536000; includeSubDomains' : 'max-age=0');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    return payload;
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      await redis.ping();
      return { ready: true };
    } catch {
      return reply.code(503).send({ ready: false });
    }
  });

  app.get('/dashboard', async (_request, reply) => {
    if (config.DASHBOARD_ENABLED !== 'true') return reply.code(404).send({ error: 'not_found' });
    const nonce = randomBytes(18).toString('base64');
    reply.header('cache-control', 'no-store');
    reply.header('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`);
    return reply.type('text/html; charset=utf-8')
      .send(dashboardHtml.replace('<script>', `<script nonce="${nonce}">`).replace('<style>', `<style nonce="${nonce}">`));
  });

  app.get('/v1/session', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const session = await requireTenantAdmin(request, reply, 'viewer');
    if (!session) return;
    return session;
  });

  app.get('/v1/operations/summary', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const session = await requireTenantAdmin(request, reply, 'viewer');
    if (!session) return;
    const { tenantId } = session;
    const result = await pool.query(
      `SELECT e.status, count(*)::int AS count,
              coalesce(avg(extract(epoch FROM (e.updated_at - e.received_at))) FILTER (WHERE e.status = 'delivered'), 0)::float AS avg_delivery_seconds
         FROM integration_events e WHERE e.tenant_id = $1 GROUP BY e.status`,
      [tenantId],
    );
    const pending = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM outbox_events o JOIN integration_events e ON e.id=o.integration_event_id
        WHERE e.tenant_id=$1 AND o.published_at IS NULL`, [tenantId],
    );
    const deadLetters = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM dead_letter_events d JOIN integration_events e ON e.id=d.integration_event_id
        WHERE e.tenant_id=$1 AND d.redriven_at IS NULL`, [tenantId],
    );
    const oldestPending = await pool.query<{ age_seconds: number | null }>(
      `SELECT extract(epoch FROM (now()-min(o.created_at)))::float AS age_seconds
         FROM outbox_events o JOIN integration_events e ON e.id=o.integration_event_id
        WHERE e.tenant_id=$1 AND o.published_at IS NULL`, [tenantId],
    );
    // The Redis stream is shared by all stores, so its pending count is a
    // platform metric (GET /v1/platform/queue), not part of a store's view.
    return {
      statuses: result.rows,
      unpublishedOutbox: pending.rows[0]?.count ?? 0,
      oldestOutboxAgeSeconds: oldestPending.rows[0]?.age_seconds ?? 0,
      deadLetters: deadLetters.rows[0]?.count ?? 0,
    };
  });

  app.get('/v1/ai/status', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const session = await requireTenantAdmin(request, reply, 'viewer');
    if (!session) return;
    const { tenantId } = session;
    const usage = await pool.query<{ used_tokens: string }>(
      `SELECT coalesce(sum(total_tokens), 0)::text AS used_tokens FROM ai_token_usage
        WHERE tenant_id=$1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [tenantId],
    );
    const usedTokensToday = Number(usage.rows[0]?.used_tokens ?? '0');
    const unresolved = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM ai_request_journal WHERE tenant_id=$1 AND status='pending'", [tenantId]);
    return {
      enabled: isOpenAiConfigured(), provider: 'openai', model: config.OPENAI_MODEL,
      usedTokensToday, dailyTokenLimit: config.OPENAI_DAILY_TOKEN_LIMIT,
      remainingTokensToday: Math.max(0, config.OPENAI_DAILY_TOKEN_LIMIT - usedTokensToday),
      reservedInputTokens: config.OPENAI_RESERVED_INPUT_TOKENS,
      unresolvedRequests: unresolved.rows[0]?.count ?? 0,
    };
  });

  app.get('/v1/ai/unresolved', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const session = await requireTenantAdmin(request, reply, 'viewer');
    if (!session) return;
    const { tenantId } = session;
    const pending = await pool.query("SELECT id, provider_request_id AS \"providerRequestId\", created_at AS \"createdAt\" FROM ai_request_journal WHERE tenant_id=$1 AND status='pending' ORDER BY created_at", [tenantId]);
    return { requests: pending.rows };
  });

  app.post<{ Params: { id: string }; Body: ParsedJson }>('/v1/ai/unresolved/:id/reconcile', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const session = await requireTenantAdmin(request, reply, 'operator');
    if (!session) return;
    const { tenantId } = session;
    const id = z.string().uuid().safeParse(request.params.id);
    const data = z.object({
      providerRequestId: z.string().min(1).max(300), model: z.string().min(1).max(200),
      inputTokens: z.number().int().min(0).max(2147483647), outputTokens: z.number().int().min(0).max(2147483647),
      cachedInputTokens: z.number().int().min(0).max(2147483647), reasoningTokens: z.number().int().min(0).max(2147483647),
      totalTokens: z.number().int().min(0).max(2147483647), evidence: z.string().trim().min(10).max(500),
    }).strict().safeParse(request.body?.value);
    if (!id.success || !data.success) return reply.code(400).send({ error: 'invalid_reconciliation' });
    try {
      await reconcileAiUsage(pool, id.data, tenantId, { ...data.data, tenantId: tenantId, provider: 'openai', task: 'portfolio-token-meter-demo' }, data.data.evidence);
      return { status: 'reconciled' };
    } catch (error) {
      if (error instanceof Error && error.message === 'pending_request_not_found') return reply.code(404).send({ error: 'pending_request_not_found' });
      if (error instanceof Error && (error.name === 'ZodError' || error.message.startsWith('Provider token total'))) return reply.code(400).send({ error: 'invalid_usage' });
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') return reply.code(409).send({ error: 'provider_request_already_recorded' });
      request.log.error({ err: error }, 'AI reconciliation failed');
      return reply.code(503).send({ error: 'temporarily_unavailable' });
    }
  });

  app.post('/v1/ai/demo', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (request, reply) => {
    const session = await requireTenantAdmin(request, reply, 'operator');
    if (!session) return;
    const { tenantId } = session;
    if (!isOpenAiConfigured()) return reply.code(503).send({ error: 'ai_provider_not_configured' });
    try {
      const result = await runTokenMeterDemo(pool, tenantId);
      request.log.info({ provider: 'openai', model: result.model, requestId: result.requestId,
        ...result.usage, durationMs: result.durationMs }, 'AI token meter demo completed');
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown_error';
      if (reason === 'daily_token_limit_reached') return reply.code(429).send({ error: 'daily_token_limit_reached' });
      if (reason === 'ai_request_in_progress') return reply.code(429).send({ error: 'ai_request_in_progress' });
      if (reason === 'ai_usage_unresolved') return reply.code(409).send({ error: 'ai_usage_unresolved' });
      const status = typeof error === 'object' && error !== null && 'status' in error ? (error as { status?: number }).status : undefined;
      request.log.error({ provider: 'openai', status }, 'AI token meter demo failed');
      return reply.code(status && status >= 400 && status < 500 ? 502 : 503).send({ error: 'ai_provider_request_failed' });
    }
  });

  app.get<{ Querystring: { status?: string; limit?: string; cursor?: string } }>('/v1/operations/events', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const session = await requireTenantAdmin(request, reply, 'viewer');
    if (!session) return;
    const { tenantId } = session;
    const query = z.object({
      status: z.enum(['received', 'queued', 'processing', 'delivered', 'failed']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      cursor: z.string().uuid().optional(),
    }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });
    const result = await pool.query(
      `SELECT id, source, external_event_id AS "externalEventId", order_id AS "orderId",
              status, attempts, last_error AS "lastError", received_at AS "receivedAt", updated_at AS "updatedAt"
         FROM integration_events
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR status = $2)
          AND ($3::uuid IS NULL OR (received_at, id) < (SELECT received_at, id FROM integration_events WHERE id=$3 AND tenant_id=$1))
        ORDER BY received_at DESC, id DESC LIMIT $4`,
      [tenantId, query.data.status ?? null, query.data.cursor ?? null, query.data.limit + 1],
    );
    const hasMore = result.rows.length > query.data.limit;
    const events = result.rows.slice(0, query.data.limit);
    return { events, nextCursor: hasMore ? events.at(-1)?.id ?? null : null };
  });

  app.get<{ Querystring: { limit?: string } }>('/v1/operations/dead-letters', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const session = await requireTenantAdmin(request, reply, 'viewer');
    if (!session) return;
    const { tenantId } = session;
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_query' });
    const result = await pool.query(
      `SELECT d.id, d.integration_event_id AS "eventId", e.external_event_id AS "externalEventId",
              d.attempts, d.reason, d.failed_at AS "failedAt"
         FROM dead_letter_events d JOIN integration_events e ON e.id=d.integration_event_id
        WHERE e.tenant_id=$1 AND d.redriven_at IS NULL ORDER BY d.failed_at DESC LIMIT $2`,
      [tenantId, query.data.limit],
    );
    return { deadLetters: result.rows };
  });

  app.post<{ Params: { id: string } }>('/v1/operations/dead-letters/:id/redrive', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const session = await requireTenantAdmin(request, reply, 'operator');
    if (!session) return;
    const { tenantId } = session;
    const id = z.string().uuid().safeParse(request.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid_id' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const dead = await client.query<{ event_id: string; payload: unknown; tenant_id: string }>(
        `SELECT e.id AS event_id, e.payload, e.tenant_id
           FROM dead_letter_events d JOIN integration_events e ON e.id=d.integration_event_id
          WHERE d.id=$1 AND e.tenant_id=$2 AND d.redriven_at IS NULL FOR UPDATE OF d, e`,
        [id.data, tenantId],
      );
      const row = dead.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'dead_letter_not_found' });
      }
      const eventType = `order.redrive.${id.data}`;
      await client.query(
        `INSERT INTO outbox_events(integration_event_id,event_type,payload)
         VALUES($1,$2,$3::jsonb) ON CONFLICT(integration_event_id,event_type) DO NOTHING`,
        [row.event_id, eventType, JSON.stringify({ eventId: row.event_id, tenantId: row.tenant_id, order: row.payload })],
      );
      await client.query('UPDATE dead_letter_events SET redriven_at=now() WHERE id=$1', [id.data]);
      await client.query("UPDATE integration_events SET status='received', attempts=0, last_error=NULL, updated_at=now() WHERE id=$1", [row.event_id]);
      await client.query('COMMIT');
      return reply.code(202).send({ status: 'redrive_queued' });
    } catch (error) {
      await client.query('ROLLBACK');
      request.log.error({ err: error }, 'dead letter redrive failed');
      return reply.code(503).send({ error: 'temporarily_unavailable' });
    } finally {
      client.release();
    }
  });

  app.post<{ Body: ParsedJson }>('/v1/webhooks/orders', {
    config: { rateLimit: { max: config.WEBHOOK_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body: unknown = request.body;
    if (!isParsedJson(body)) {
      metrics.webhook('unsupported_media_type');
      return reply.code(415).send({ error: 'expected_application_json' });
    }
    const tenantId = header(request, 'x-tenant-id');
    const signature = header(request, 'x-webhook-signature');
    const keys = tenantId && TENANT_ID_PATTERN.test(tenantId)
      ? await activeWebhookSecrets(pool, masterKeys, tenantId)
      : [];
    const timestamp = parseWebhookTimestamp(header(request, 'x-webhook-timestamp'));
    // Unknown store, disabled store and wrong signature get the same answer,
    // so the endpoint does not reveal which store ids exist.
    if (!tenantId || timestamp === null || !keys.some((secret) => verifySignature(body.raw, signature, secret, timestamp))) {
      metrics.webhook('invalid_signature');
      return reply.code(401).send({ error: 'invalid_signature' });
    }
    // Checked after the signature, so only a valid sender learns about clock skew.
    // Inside the window, a replayed request is absorbed by the event-id dedupe.
    if (!isFreshTimestamp(timestamp, Date.now(), config.WEBHOOK_TOLERANCE_SECONDS)) {
      metrics.webhook('stale_timestamp');
      return reply.code(401).send({ error: 'timestamp_out_of_tolerance', toleranceSeconds: config.WEBHOOK_TOLERANCE_SECONDS });
    }

    const parsed = orderSchema.safeParse(body.value);
    if (!parsed.success) {
      metrics.webhook('invalid_order');
      return reply.code(400).send({ error: 'invalid_order', details: parsed.error.issues });
    }
    const order = parsed.data;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO integration_events (tenant_id, source, external_event_id, order_id, payload)
         VALUES ($1, 'demo-store', $2, $3, $4::jsonb)
         ON CONFLICT (tenant_id, source, external_event_id) DO NOTHING
         RETURNING id`,
        [tenantId, order.eventId, order.orderId, JSON.stringify(order)],
      );

      if (inserted.rowCount === 0) {
        await client.query('COMMIT');
        metrics.webhook('duplicate');
        return reply.code(200).send({ status: 'duplicate_ignored', eventId: order.eventId });
      }

      const eventId = inserted.rows[0]!.id;
      await client.query(
        `INSERT INTO outbox_events (integration_event_id, event_type, payload)
         VALUES ($1, 'order.received', $2::jsonb)`,
        [eventId, JSON.stringify({ eventId, tenantId: tenantId, order })],
      );
      await client.query('COMMIT');
      metrics.webhook('accepted');
      return reply.code(202).send({ status: 'accepted', eventId });
    } catch (error) {
      await client.query('ROLLBACK');
      request.log.error({ err: error }, 'order event persistence failed');
      metrics.webhook('unavailable');
      return reply.code(503).send({ error: 'temporarily_unavailable' });
    } finally {
      client.release();
    }
  });

  app.get<{ Querystring: { from?: string; to?: string } }>('/v1/usage/tokens', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const session = await requireTenantAdmin(request, reply, 'viewer');
    if (!session) return;
    const { tenantId } = session;

    const dates = request.query;
    const dateSchema = z.object({
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    });
    const dateRange = dateSchema.safeParse(dates);
    if (!dateRange.success) return reply.code(400).send({ error: 'invalid_date_range' });
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = dateRange.data.from?.toISOString() ?? defaultFrom.toISOString();
    const to = dateRange.data.to?.toISOString() ?? now.toISOString();
    if (Date.parse(from) > Date.parse(to) || Date.parse(to) - Date.parse(from) > 366 * 24 * 60 * 60 * 1000) {
      return reply.code(400).send({ error: 'invalid_date_range' });
    }

    const result = await pool.query(
      `SELECT provider, model, task,
              count(*)::int AS requests,
              sum(input_tokens)::bigint AS input_tokens,
              sum(output_tokens)::bigint AS output_tokens,
              sum(total_tokens)::bigint AS total_tokens,
              sum(cached_input_tokens)::bigint AS cached_input_tokens,
              sum(reasoning_tokens)::bigint AS reasoning_tokens
         FROM ai_token_usage
        WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
        GROUP BY provider, model, task ORDER BY total_tokens DESC`,
      [tenantId, from, to],
    );
    const totals = await pool.query(
      `SELECT coalesce(sum(total_tokens), 0)::bigint AS total_tokens
         FROM ai_token_usage WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
      [tenantId, from, to],
    );
    return { from, to, summary: totals.rows[0], usage: result.rows };
  });


  // --- Platform operations: manage stores and their credentials -------------
  // Secrets and tokens are returned exactly once, at creation; afterwards only
  // ids are visible. Responses are no-store so proxies and browsers keep no copy.

  const tenantParams = z.object({ tenantId: z.string().regex(TENANT_ID_PATTERN) });

  app.get('/v1/platform/queue', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    const outbox = await pool.query<{ count: number; age_seconds: number | null }>(
      `SELECT count(*)::int AS count, extract(epoch FROM (now()-min(created_at)))::float AS age_seconds
         FROM outbox_events WHERE published_at IS NULL`,
    );
    let redisPending = 0;
    try {
      const pendingInfo = await redis.call('XPENDING', config.REDIS_STREAM_KEY, config.REDIS_CONSUMER_GROUP) as [number, ...unknown[]];
      redisPending = pendingInfo[0] ?? 0;
    } catch {
      // The stream/group may not exist yet during first startup.
    }
    return { unpublishedOutbox: outbox.rows[0]?.count ?? 0, oldestOutboxAgeSeconds: outbox.rows[0]?.age_seconds ?? 0, redisPending };
  });

  app.post<{ Body: ParsedJson }>('/v1/platform/tenants', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    const data = z.object({ id: z.string().regex(TENANT_ID_PATTERN), name: z.string().trim().min(1).max(200) }).strict().safeParse(request.body?.value);
    if (!data.success) return reply.code(400).send({ error: 'invalid_tenant' });
    try {
      await createTenant(pool, data.data.id, data.data.name);
      return reply.code(201).send({ id: data.data.id, name: data.data.name });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') return reply.code(409).send({ error: 'tenant_already_exists' });
      throw error;
    }
  });

  app.post<{ Params: { tenantId: string }; Body: ParsedJson }>('/v1/platform/tenants/:tenantId/webhook-keys', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    const params = tenantParams.safeParse(request.params);
    const data = z.object({ graceHours: z.number().min(0).max(24 * 30).default(24) }).strict().safeParse(request.body?.value ?? {});
    if (!params.success || !data.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const key = await createWebhookKey(pool, masterKeys, params.data.tenantId, Math.round(data.data.graceHours * 3600));
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({ ...key, previousKeysValidForHours: data.data.graceHours });
    } catch (error) {
      if (error instanceof TenantNotFoundError) return reply.code(404).send({ error: 'tenant_not_found' });
      throw error;
    }
  });

  app.delete<{ Params: { tenantId: string; keyId: string } }>('/v1/platform/tenants/:tenantId/webhook-keys/:keyId', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    const params = tenantParams.extend({ keyId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const revoked = await revokeWebhookKey(pool, params.data.tenantId, params.data.keyId);
    return revoked ? reply.code(204).send() : reply.code(404).send({ error: 'key_not_found' });
  });

  app.post<{ Params: { tenantId: string }; Body: ParsedJson }>('/v1/platform/tenants/:tenantId/admin-tokens', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    const params = tenantParams.safeParse(request.params);
    const data = z.object({
      label: z.string().trim().max(100).default(''),
      role: z.enum(['viewer', 'operator']).default('operator'),
      expiresInDays: z.number().int().min(1).max(365).default(90),
    }).strict().safeParse(request.body?.value ?? {});
    if (!params.success || !data.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const token = await createAdminToken(pool, params.data.tenantId, data.data.label, data.data.role, data.data.expiresInDays);
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(token);
    } catch (error) {
      if (error instanceof TenantNotFoundError) return reply.code(404).send({ error: 'tenant_not_found' });
      throw error;
    }
  });

  app.get<{ Params: { tenantId: string } }>('/v1/platform/tenants/:tenantId/admin-tokens', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    const params = tenantParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    return { tokens: await listAdminTokens(pool, params.data.tenantId) };
  });

  app.delete<{ Params: { tenantId: string; tokenId: string } }>('/v1/platform/tenants/:tenantId/admin-tokens/:tokenId', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return;
    const params = tenantParams.extend({ tokenId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    const revoked = await revokeAdminToken(pool, params.data.tenantId, params.data.tokenId);
    return revoked ? reply.code(204).send() : reply.code(404).send({ error: 'token_not_found' });
  });

  return app;
}
