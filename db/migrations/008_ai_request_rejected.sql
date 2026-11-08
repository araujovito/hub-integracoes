-- A provider rejection (e.g. invalid key or unknown model) is a definitive
-- outcome with no token usage: it must not stay 'pending' and block the demo.
ALTER TABLE ai_request_journal
  ADD COLUMN IF NOT EXISTS provider_status integer,
  DROP CONSTRAINT IF EXISTS ai_request_journal_status_check,
  ADD CONSTRAINT ai_request_journal_status_check CHECK (status IN ('pending', 'recorded', 'rejected'));
