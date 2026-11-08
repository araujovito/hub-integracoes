-- Store admin tokens get a role and an expiry. Existing tokens keep
-- role 'operator' and no expiry (NULL) so nobody is locked out by the upgrade;
-- tokens issued from now on always expire (enforced in the application).
ALTER TABLE tenant_admin_tokens
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'operator',
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE tenant_admin_tokens
  DROP CONSTRAINT IF EXISTS tenant_admin_tokens_role_check,
  ADD CONSTRAINT tenant_admin_tokens_role_check CHECK (role IN ('viewer', 'operator'));
