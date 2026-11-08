import { describe, expect, it } from 'vitest';
import { normalizeTokenUsage } from '../src/token-usage.js';
import { allowedOutputTokens, classifyProviderRejection, mapOpenAiUsage } from '../src/openai-provider.js';

describe('token usage ledger normalization', () => {
  const base = {
    tenantId: 'demo', task: 'normalize-order', provider: 'example', model: 'example-small',
    inputTokens: 120, outputTokens: 35,
  };

  it('stores the provider-reported input, output, and total token counts', () => {
    expect(normalizeTokenUsage(base)).toMatchObject({ inputTokens: 120, outputTokens: 35, totalTokens: 155 });
  });

  it('rejects inconsistent totals and negative usage', () => {
    expect(() => normalizeTokenUsage({ ...base, totalTokens: 156 })).toThrow(/does not match/);
    expect(() => normalizeTokenUsage({ ...base, inputTokens: -1 })).toThrow();
  });

  it('maps official Responses usage, including cached and reasoning breakdowns', () => {
    expect(mapOpenAiUsage({
      input_tokens: 120,
      output_tokens: 35,
      total_tokens: 155,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens_details: { reasoning_tokens: 8 },
    })).toEqual({ inputTokens: 120, outputTokens: 35, totalTokens: 155, cachedInputTokens: 20, reasoningTokens: 8 });
  });

  it('tracks cached tokens as a subset of input without currency conversion', () => {
    expect(normalizeTokenUsage({ ...base, cachedInputTokens: 20 })).toMatchObject({
      inputTokens: 120, cachedInputTokens: 20, outputTokens: 35, totalTokens: 155,
    });
  });

  it('caps output tokens against the remaining daily token allowance and refuses exhausted budgets', () => {
    expect(allowedOutputTokens(1_000, 5_000, 96, 256)).toBe(96);
    expect(allowedOutputTokens(4_700, 5_000, 96, 256)).toBe(44);
    expect(() => allowedOutputTokens(4_800, 5_000, 96, 256)).toThrow('daily_token_limit_reached');
  });

  it('treats provider refusals as definitive and leaves ambiguous failures unresolved', () => {
    expect(classifyProviderRejection({ status: 401, requestID: 'req_abc' })).toEqual({ status: 401, requestId: 'req_abc' });
    expect(classifyProviderRejection({ status: 404 })).toEqual({ status: 404, requestId: null });
    // Timeouts, connection failures (no status) and 5xx may have consumed tokens.
    expect(classifyProviderRejection({ status: 500, requestID: 'req_x' })).toBeNull();
    expect(classifyProviderRejection({ status: undefined })).toBeNull();
    expect(classifyProviderRejection(new Error('Request timed out.'))).toBeNull();
    expect(classifyProviderRejection(undefined)).toBeNull();
  });
});
