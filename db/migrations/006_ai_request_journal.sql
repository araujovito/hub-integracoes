CREATE TABLE IF NOT EXISTS ai_request_journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'recorded')),
  provider_request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz
);
CREATE INDEX IF NOT EXISTS ai_request_journal_pending_idx ON ai_request_journal (tenant_id) WHERE status = 'pending';
