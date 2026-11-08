ALTER TABLE ai_token_usage
  ADD COLUMN IF NOT EXISTS estimated_cost_usd numeric(20, 12),
  ADD COLUMN IF NOT EXISTS input_usd_per_million numeric(20, 8),
  ADD COLUMN IF NOT EXISTS output_usd_per_million numeric(20, 8),
  ADD COLUMN IF NOT EXISTS cached_input_usd_per_million numeric(20, 8),
  ADD COLUMN IF NOT EXISTS pricing_source text,
  ADD COLUMN IF NOT EXISTS pricing_effective_at timestamptz;

ALTER TABLE ai_token_usage
  DROP CONSTRAINT IF EXISTS ai_token_usage_cost_nonnegative,
  ADD CONSTRAINT ai_token_usage_cost_nonnegative CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
  DROP CONSTRAINT IF EXISTS ai_token_usage_pricing_complete,
  ADD CONSTRAINT ai_token_usage_pricing_complete CHECK (
    (estimated_cost_usd IS NULL AND input_usd_per_million IS NULL AND output_usd_per_million IS NULL AND pricing_source IS NULL AND pricing_effective_at IS NULL)
    OR (estimated_cost_usd IS NOT NULL AND input_usd_per_million IS NOT NULL AND output_usd_per_million IS NOT NULL AND pricing_source IS NOT NULL AND pricing_effective_at IS NOT NULL)
  );
