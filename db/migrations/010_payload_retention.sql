-- Retention: payloads of delivered events are cleared after the retention
-- period; the identity row stays so event-id deduplication keeps working.
ALTER TABLE integration_events ADD COLUMN IF NOT EXISTS payload_redacted_at timestamptz;
ALTER TABLE erp_deliveries ADD COLUMN IF NOT EXISTS payload_redacted_at timestamptz;
CREATE INDEX IF NOT EXISTS integration_events_retention_idx
  ON integration_events (updated_at) WHERE status = 'delivered' AND payload_redacted_at IS NULL;
CREATE INDEX IF NOT EXISTS outbox_events_published_idx
  ON outbox_events (published_at) WHERE published_at IS NOT NULL;
