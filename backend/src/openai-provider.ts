import OpenAI from 'openai';
import type { Pool } from 'pg';
import { config } from './config.js';
import { recordTokenUsage } from './token-usage.js';

export type AiDemoResult = {
  text: string;
  model: string;
  requestId: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number; reasoningTokens: number };
  durationMs: number;
};

export function isOpenAiConfigured(): boolean {
  return Boolean(config.OPENAI_API_KEY?.trim());
}

export function allowedOutputTokens(usedToday: number, dailyLimit: number, maxOutputTokens: number, reservedInputTokens: number): number {
  const allowance = dailyLimit - usedToday - reservedInputTokens;
  if (allowance < 16) throw new Error('daily_token_limit_reached');
  return Math.min(maxOutputTokens, allowance);
}

export function mapOpenAiUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens_details: { reasoning_tokens: number };
}) {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cachedInputTokens: usage.input_tokens_details.cached_tokens,
    reasoningTokens: usage.output_tokens_details.reasoning_tokens,
  };
}

/**
 * HTTP statuses with which the provider refuses a request before generating
 * anything (bad request, auth, permission, unknown model, validation, rate or
 * quota limit). Treated as "no tokens consumed". Timeouts, connection errors and
 * 5xx stay ambiguous: the request may have run, so usage remains unknown.
 */
const REJECTED_BEFORE_GENERATION = new Set([400, 401, 403, 404, 422, 429]);

export type ProviderRejection = { status: number; requestId: string | null };

/** Classify a provider error as a definitive rejection, or null when usage is unknown. */
export function classifyProviderRejection(error: unknown): ProviderRejection | null {
  if (typeof error !== 'object' || error === null) return null;
  const { status, requestID } = error as { status?: unknown; requestID?: unknown };
  if (typeof status !== 'number' || !REJECTED_BEFORE_GENERATION.has(status)) return null;
  return { status, requestId: typeof requestID === 'string' && requestID ? requestID.slice(0, 300) : null };
}

/** One fixed, short demo prompt; caller-provided data is never sent to the model. */
export async function runTokenMeterDemo(pool: Pool): Promise<AiDemoResult> {
  if (!isOpenAiConfigured()) throw new Error('openai_not_configured');
  const databaseClient = await pool.connect();
  let budgetLockAcquired = false;
  try {
    const lock = await databaseClient.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [`ai-token-budget:${config.DEMO_TENANT_ID}`],
    );
    budgetLockAcquired = lock.rows[0]?.acquired === true;
    if (!budgetLockAcquired) throw new Error('ai_request_in_progress');

    const unresolved = await databaseClient.query('SELECT 1 FROM ai_request_journal WHERE tenant_id=$1 AND status=$2 LIMIT 1', [config.DEMO_TENANT_ID, 'pending']);
    if (unresolved.rowCount) throw new Error('ai_usage_unresolved');

    const usedResult = await databaseClient.query<{ used_tokens: string }>(
      `SELECT coalesce(sum(total_tokens), 0)::text AS used_tokens FROM ai_token_usage
        WHERE tenant_id=$1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [config.DEMO_TENANT_ID],
    );
    const usedToday = Number(usedResult.rows[0]?.used_tokens ?? '0');
    const maxOutputTokens = allowedOutputTokens(
      usedToday, config.OPENAI_DAILY_TOKEN_LIMIT,
      config.OPENAI_MAX_OUTPUT_TOKENS, config.OPENAI_RESERVED_INPUT_TOKENS,
    );
    const openAiClient = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      timeout: 30_000,
      maxRetries: 0,
    });
    // Commit the intent before the provider call. A crash or ambiguous network error
    // leaves an unresolved entry and blocks further calls until reconciliation.
    const journal = await databaseClient.query<{ id: string }>(
      'INSERT INTO ai_request_journal (tenant_id) VALUES ($1) RETURNING id', [config.DEMO_TENANT_ID],
    );
    const journalId = journal.rows[0]!.id;
    const startedAt = Date.now();
    let response: OpenAI.Responses.Response;
    try {
      response = await openAiClient.responses.create({
        model: config.OPENAI_MODEL,
        input: 'Explique em uma frase curta, em português, o que uma outbox transacional resolve em uma integração de pedidos.',
        max_output_tokens: maxOutputTokens,
        store: false,
      });
    } catch (error) {
      const rejection = classifyProviderRejection(error);
      if (rejection) {
        // Definitive refusal: close the intent so it does not block later calls.
        // If this update fails, the entry stays pending (the safe default).
        await databaseClient.query(
          "UPDATE ai_request_journal SET status='rejected', provider_status=$2, provider_request_id=$3, recorded_at=now() WHERE id=$1",
          [journalId, rejection.status, rejection.requestId],
        );
      }
      throw error;
    }
    // Keep the provider ID on the intent as soon as it is known, so an entry that
    // stays pending (e.g. usage missing or the ledger write failing) can be reconciled.
    await databaseClient.query('UPDATE ai_request_journal SET provider_request_id=$2 WHERE id=$1', [journalId, response.id]);
    const usage = response.usage;
    if (!usage) throw new Error('provider_usage_unavailable');

    const counts = mapOpenAiUsage(usage);
    await databaseClient.query('BEGIN');
    try {
      await recordTokenUsage(databaseClient, {
      tenantId: config.DEMO_TENANT_ID,
      task: 'portfolio-token-meter-demo',
      provider: 'openai',
      model: response.model,
      providerRequestId: response.id,
      ...counts,
      });
      await databaseClient.query("UPDATE ai_request_journal SET status='recorded', provider_request_id=$2, recorded_at=now() WHERE id=$1", [journalId, response.id]);
      await databaseClient.query('COMMIT');
    } catch (error) {
      await databaseClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    return {
      text: response.output_text.slice(0, 1200),
      model: response.model,
      requestId: response.id,
      usage: counts,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    let releaseWithError = false;
    if (budgetLockAcquired) {
      releaseWithError = !(await databaseClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`ai-token-budget:${config.DEMO_TENANT_ID}`]).then(() => true, () => false));
    }
    databaseClient.release(releaseWithError);
  }
}
