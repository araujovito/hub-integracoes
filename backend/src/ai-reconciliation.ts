import type { Pool } from 'pg';
import { normalizeTokenUsage, type TokenUsageInput } from './token-usage.js';

/** Reconcile only with externally verified provider data, preserving request time and uniqueness. */
export async function reconcileAiUsage(pool: Pool, journalId: string, tenantId: string, input: TokenUsageInput, note: string): Promise<void> {
  const usage = normalizeTokenUsage(input);
  if (!usage.providerRequestId) throw new Error('provider_request_id_required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize with the same admission lock used by live provider calls.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ai-token-budget:${tenantId}`]);
    const pending = await client.query<{ created_at: Date; provider_request_id: string | null }>(
      "SELECT created_at, provider_request_id FROM ai_request_journal WHERE id=$1 AND tenant_id=$2 AND status='pending' FOR UPDATE", [journalId, tenantId],
    );
    if (!pending.rows[0]) throw new Error('pending_request_not_found');
    if (pending.rows[0].provider_request_id && pending.rows[0].provider_request_id !== usage.providerRequestId) throw new Error('provider_request_id_mismatch');
    await client.query(
      `INSERT INTO ai_token_usage (tenant_id, task, provider, model, provider_request_id, input_tokens, output_tokens, total_tokens, cached_input_tokens, reasoning_tokens, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [tenantId, usage.task, usage.provider, usage.model, usage.providerRequestId, usage.inputTokens, usage.outputTokens,
        usage.totalTokens, usage.cachedInputTokens, usage.reasoningTokens, pending.rows[0].created_at],
    );
    await client.query("UPDATE ai_request_journal SET status='recorded', provider_request_id=$2, reconciliation_note=$3, recorded_at=now() WHERE id=$1", [journalId, usage.providerRequestId, note]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
