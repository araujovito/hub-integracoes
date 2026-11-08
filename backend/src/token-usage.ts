import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';

const usageSchema = z.object({
  tenantId: z.string().min(1).max(100),
  task: z.string().min(1).max(100),
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  providerRequestId: z.string().max(300).optional(),
  inputTokens: z.number().int().nonnegative().safe(),
  outputTokens: z.number().int().nonnegative().safe(),
  cachedInputTokens: z.number().int().nonnegative().safe().default(0),
  reasoningTokens: z.number().int().nonnegative().safe().default(0),
  totalTokens: z.number().int().nonnegative().safe().optional(),
}).superRefine((usage, context) => {
  if (usage.cachedInputTokens > usage.inputTokens) context.addIssue({ code: 'custom', path: ['cachedInputTokens'], message: 'Cached input cannot exceed input tokens' });
  if (usage.reasoningTokens > usage.outputTokens) context.addIssue({ code: 'custom', path: ['reasoningTokens'], message: 'Reasoning tokens cannot exceed output tokens' });
});

export type TokenUsageInput = z.input<typeof usageSchema>;
export type TokenUsage = z.output<typeof usageSchema> & { totalTokens: number };

/** Accept only provider-reported usage; never estimate tokens from text here. */
export function normalizeTokenUsage(input: TokenUsageInput): TokenUsage {
  const parsed = usageSchema.parse(input);
  const totalTokens = parsed.totalTokens ?? parsed.inputTokens + parsed.outputTokens;
  if (!Number.isSafeInteger(totalTokens)) throw new Error('Provider token total is outside the safe integer range');
  if (totalTokens !== parsed.inputTokens + parsed.outputTokens) {
    throw new Error('Provider token total does not match input + output tokens');
  }
  return { ...parsed, totalTokens };
}

/** Call immediately after an AI provider returns usage metadata. Prompt/response text is never stored. */
export async function recordTokenUsage(pool: Pool | PoolClient, input: TokenUsageInput): Promise<void> {
  const usage = normalizeTokenUsage(input);
  await pool.query(
    `INSERT INTO ai_token_usage
       (tenant_id, task, provider, model, provider_request_id, input_tokens, output_tokens, total_tokens, cached_input_tokens, reasoning_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (provider, provider_request_id) WHERE provider_request_id IS NOT NULL DO NOTHING`,
    [usage.tenantId, usage.task, usage.provider, usage.model,
      usage.providerRequestId ?? null, usage.inputTokens, usage.outputTokens, usage.totalTokens,
      usage.cachedInputTokens, usage.reasoningTokens],
  );
}
