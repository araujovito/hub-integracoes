ALTER TABLE ai_token_usage
  DROP CONSTRAINT IF EXISTS ai_token_usage_cost_nonnegative,
  DROP CONSTRAINT IF EXISTS ai_token_usage_pricing_complete,
  DROP COLUMN IF EXISTS estimated_cost_usd,
  DROP COLUMN IF EXISTS input_usd_per_million,
  DROP COLUMN IF EXISTS output_usd_per_million,
  DROP COLUMN IF EXISTS cached_input_usd_per_million,
  DROP COLUMN IF EXISTS pricing_source,
  DROP COLUMN IF EXISTS pricing_effective_at;
