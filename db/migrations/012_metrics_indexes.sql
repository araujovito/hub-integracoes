-- Metrics are collected on every Prometheus scrape: keep those queries off
-- full scans. Undelivered events are few; delivered ones grow forever.
CREATE INDEX IF NOT EXISTS integration_events_backlog_idx
  ON integration_events (status) WHERE status <> 'delivered';
CREATE INDEX IF NOT EXISTS erp_deliveries_delivered_at_idx
  ON erp_deliveries (delivered_at);
CREATE INDEX IF NOT EXISTS dead_letter_events_pending_idx
  ON dead_letter_events (failed_at) WHERE redriven_at IS NULL;
