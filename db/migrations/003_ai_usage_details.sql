ALTER TABLE ai_token_usage
  ADD COLUMN IF NOT EXISTS cached_input_tokens integer NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  ADD COLUMN IF NOT EXISTS reasoning_tokens integer NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0);

ALTER TABLE ai_token_usage
  DROP CONSTRAINT IF EXISTS ai_token_usage_cached_input_tokens_check,
  ADD CONSTRAINT ai_token_usage_cached_input_tokens_check CHECK (cached_input_tokens >= 0 AND cached_input_tokens <= input_tokens),
  DROP CONSTRAINT IF EXISTS ai_token_usage_reasoning_tokens_check,
  ADD CONSTRAINT ai_token_usage_reasoning_tokens_check CHECK (reasoning_tokens >= 0 AND reasoning_tokens <= output_tokens);
