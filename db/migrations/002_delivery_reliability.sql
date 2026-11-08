ALTER TABLE integration_events
  ADD COLUMN IF NOT EXISTS last_error text;

CREATE TABLE IF NOT EXISTS erp_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  integration_event_id uuid NOT NULL REFERENCES integration_events(id),
  order_id text NOT NULL,
  payload jsonb NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, integration_event_id)
);

CREATE INDEX IF NOT EXISTS erp_deliveries_tenant_delivered_idx
  ON erp_deliveries (tenant_id, delivered_at DESC);

CREATE TABLE IF NOT EXISTS dead_letter_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_event_id uuid NOT NULL REFERENCES integration_events(id),
  stream_id text NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  reason text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  redriven_at timestamptz,
  UNIQUE (stream_id)
);
