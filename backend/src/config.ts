import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';
import { resolveFileBackedEnv } from './env-files.js';
import { parseMasterKey } from './tenant-crypto.js';

if (process.env.NODE_ENV !== 'test') dotenv.config({ path: resolve(process.cwd(), '../.env') });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  // Number of reverse proxies in front of the API whose X-Forwarded-For is
  // trusted (0 = none). Set to 1 only when the API is reachable solely through
  // the proxy, otherwise clients could spoof their IP and dodge rate limits.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  // Server-side limits applied to every pooled connection: PostgreSQL cancels a
  // statement after DB_STATEMENT_TIMEOUT_MS and ends a session left idle inside
  // an open transaction (holding locks) after DB_IDLE_IN_TRANSACTION_TIMEOUT_MS.
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(10_000),
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
  // Per client IP (load tests raise it; one machine sends everything).
  WEBHOOK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(120),
  // Max distance between a webhook's signed timestamp and the server clock.
  WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  REDIS_STREAM_KEY: z.string().min(1).default('integration:orders'),
  REDIS_CONSUMER_GROUP: z.string().min(1).default('erp-simulator'),
  WORKER_CONSUMER: z.string().min(1).default('worker-local'),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  WORKER_CLAIM_IDLE_MS: z.coerce.number().int().min(1000).max(600000).default(30000),
  // Retention (maintenance service). Stream entries are trimmed only after being
  // acknowledged; payloads of delivered events are cleared after DATA_RETENTION_DAYS.
  STREAM_RETENTION_HOURS: z.coerce.number().int().min(1).max(24 * 365).default(72),
  DATA_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  MAINTENANCE_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
  DASHBOARD_ENABLED: z.enum(['true', 'false']).default('true'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().min(1).max(120).default('gpt-6-luna'),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(16).max(512).default(96),
  OPENAI_DAILY_TOKEN_LIMIT: z.coerce.number().int().min(16).max(1_000_000).default(5_000),
  OPENAI_RESERVED_INPUT_TOKENS: z.coerce.number().int().min(0).max(10_000).default(256),
});

const env = resolveFileBackedEnv(process.env);

export const config = schema.parse(env);

// Secrets only the HTTP API uses. Kept out of `config` so the relay and worker
// start without them and the Compose file does not have to hand them over.
const apiSecretsSchema = z.object({
  // Platform operator token: creates stores and issues their credentials.
  PLATFORM_ADMIN_TOKEN: z.string().min(32),
  // Encrypts stored webhook secrets; 32 random bytes in base64.
  TENANT_SECRETS_KEY: z.string().transform((value, context) => {
    try {
      return parseMasterKey(value);
    } catch (error) {
      context.addIssue({ code: 'custom', message: (error as Error).message });
      return z.NEVER;
    }
  }),
  // Bearer token Prometheus uses to scrape GET /metrics. Unset = endpoint off (404).
  METRICS_TOKEN: z.preprocess((value) => (value === '' ? undefined : value), z.string().min(32).optional()),
  // Only during a master-key rotation: old key(s), comma-separated, used to
  // decrypt until `rotate-master-key` has re-encrypted everything.
  TENANT_SECRETS_KEY_PREVIOUS: z.string().optional().transform((value, context) => {
    if (!value?.trim()) return [];
    try {
      return value.split(',').map((part) => parseMasterKey(part.trim()));
    } catch (error) {
      context.addIssue({ code: 'custom', message: `TENANT_SECRETS_KEY_PREVIOUS: ${(error as Error).message}` });
      return z.NEVER;
    }
  }),
});

export type ApiSecrets = z.infer<typeof apiSecretsSchema>;

export function loadApiSecrets(): ApiSecrets {
  return apiSecretsSchema.parse(env);
}
