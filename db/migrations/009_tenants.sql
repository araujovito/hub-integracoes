-- Tenants (stores) with their own webhook keys and admin tokens.
CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

-- HMAC secrets must be usable in plaintext to verify signatures, so they are
-- stored encrypted (AES-256-GCM under TENANT_SECRETS_KEY), never hashed.
-- Rotation: a new key is created and older ones get expires_at (grace period);
-- during the overlap any non-expired, non-revoked key is accepted.
CREATE TABLE IF NOT EXISTS tenant_webhook_keys (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  secret_ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS tenant_webhook_keys_active_idx
  ON tenant_webhook_keys (tenant_id) WHERE revoked_at IS NULL;

-- Admin tokens are random 256-bit values: a SHA-256 digest is enough to store
-- them (no password-style stretching needed) and allows lookup by digest.
CREATE TABLE IF NOT EXISTS tenant_admin_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id),
  token_sha256 bytea NOT NULL UNIQUE,
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- Existing single-tenant data keeps working: register every tenant id already in use.
INSERT INTO tenants (id, name)
SELECT DISTINCT tenant_id, tenant_id FROM (
  SELECT tenant_id FROM integration_events
  UNION SELECT tenant_id FROM erp_deliveries
  UNION SELECT tenant_id FROM ai_token_usage
  UNION SELECT tenant_id FROM ai_request_journal
) existing
ON CONFLICT (id) DO NOTHING;

-- Referential integrity for tenant-scoped tables (validated after the backfill).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'integration_events_tenant_fk') THEN
    ALTER TABLE integration_events ADD CONSTRAINT integration_events_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) NOT VALID;
    ALTER TABLE integration_events VALIDATE CONSTRAINT integration_events_tenant_fk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'erp_deliveries_tenant_fk') THEN
    ALTER TABLE erp_deliveries ADD CONSTRAINT erp_deliveries_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) NOT VALID;
    ALTER TABLE erp_deliveries VALIDATE CONSTRAINT erp_deliveries_tenant_fk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_token_usage_tenant_fk') THEN
    ALTER TABLE ai_token_usage ADD CONSTRAINT ai_token_usage_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) NOT VALID;
    ALTER TABLE ai_token_usage VALIDATE CONSTRAINT ai_token_usage_tenant_fk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_request_journal_tenant_fk') THEN
    ALTER TABLE ai_request_journal ADD CONSTRAINT ai_request_journal_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) NOT VALID;
    ALTER TABLE ai_request_journal VALIDATE CONSTRAINT ai_request_journal_tenant_fk;
  END IF;
END $$;
