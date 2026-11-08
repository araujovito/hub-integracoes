import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';
import { resolveFileBackedEnv } from './env-files.js';

if (process.env.NODE_ENV !== 'test') dotenv.config({ path: resolve(process.cwd(), '../.env') });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  DEMO_TENANT_ID: z.string().min(1).max(100).default('demo'),
  REDIS_STREAM_KEY: z.string().min(1).default('integration:orders'),
  REDIS_CONSUMER_GROUP: z.string().min(1).default('erp-simulator'),
  WORKER_CONSUMER: z.string().min(1).default('worker-local'),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  WORKER_CLAIM_IDLE_MS: z.coerce.number().int().min(1000).max(600000).default(30000),
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
  WEBHOOK_SECRET: z.string().min(32),
  ADMIN_API_TOKEN: z.string().min(32),
});

export type ApiSecrets = z.infer<typeof apiSecretsSchema>;

export function loadApiSecrets(): ApiSecrets {
  return apiSecretsSchema.parse(env);
}
