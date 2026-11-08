import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { decryptSecret, encryptSecret } from './tenant-crypto.js';

export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const ADMIN_TOKEN_PREFIX = 'hub_adm_';

export class TenantNotFoundError extends Error {
  constructor() { super('tenant_not_found'); }
}

const webhookKeyContext = (tenantId: string, keyId: string) => `webhook-key:${tenantId}:${keyId}`;
const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest();

export async function createTenant(pool: Pool, id: string, name: string): Promise<void> {
  if (!TENANT_ID_PATTERN.test(id)) throw new Error('invalid_tenant_id');
  await pool.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [id, name]);
}

/**
 * Issue a new webhook secret. Keys that are still valid stop being accepted after
 * `graceSeconds`, giving the store time to switch without rejected deliveries.
 * The plaintext secret is returned once and never stored unencrypted.
 */
export async function createWebhookKey(pool: Pool, masterKey: Buffer, tenantId: string, graceSeconds: number) {
  const keyId = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenant = await client.query('SELECT 1 FROM tenants WHERE id=$1 AND disabled_at IS NULL FOR UPDATE', [tenantId]);
    if (!tenant.rowCount) throw new TenantNotFoundError();
    await client.query(
      `UPDATE tenant_webhook_keys SET expires_at = now() + make_interval(secs => $2)
        WHERE tenant_id=$1 AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now() + make_interval(secs => $2))`,
      [tenantId, graceSeconds],
    );
    await client.query(
      'INSERT INTO tenant_webhook_keys (id, tenant_id, secret_ciphertext) VALUES ($1, $2, $3)',
      [keyId, tenantId, encryptSecret(masterKey, secret, webhookKeyContext(tenantId, keyId))],
    );
    await client.query('COMMIT');
    return { keyId, secret };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeWebhookKey(pool: Pool, tenantId: string, keyId: string): Promise<boolean> {
  const result = await pool.query(
    'UPDATE tenant_webhook_keys SET revoked_at=now() WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL', [keyId, tenantId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Secrets currently accepted for a tenant (empty for unknown or disabled tenants). */
export async function activeWebhookSecrets(pool: Pool, masterKey: Buffer, tenantId: string): Promise<string[]> {
  const result = await pool.query<{ id: string; secret_ciphertext: Buffer }>(
    `SELECT k.id, k.secret_ciphertext FROM tenant_webhook_keys k JOIN tenants t ON t.id = k.tenant_id
      WHERE k.tenant_id=$1 AND t.disabled_at IS NULL AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > now())
      ORDER BY k.created_at DESC LIMIT 5`,
    [tenantId],
  );
  return result.rows.map((row) => decryptSecret(masterKey, row.secret_ciphertext, webhookKeyContext(tenantId, row.id)));
}

/** Issue an admin token scoped to one tenant. Returned once; only its digest is stored. */
export async function createAdminToken(pool: Pool, tenantId: string, label: string) {
  const token = `${ADMIN_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO tenant_admin_tokens (tenant_id, token_sha256, label)
     SELECT id, $2, $3 FROM tenants WHERE id=$1 AND disabled_at IS NULL RETURNING id`,
    [tenantId, digest(token), label],
  );
  if (!result.rows[0]) throw new TenantNotFoundError();
  return { tokenId: result.rows[0].id, token };
}

export async function revokeAdminToken(pool: Pool, tenantId: string, tokenId: string): Promise<boolean> {
  const result = await pool.query(
    'UPDATE tenant_admin_tokens SET revoked_at=now() WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL', [tokenId, tenantId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Tenant that owns a valid admin token, or null. */
export async function resolveAdminToken(pool: Pool, token: string | undefined): Promise<string | null> {
  if (!token || !token.startsWith(ADMIN_TOKEN_PREFIX) || token.length > 200) return null;
  const result = await pool.query<{ tenant_id: string }>(
    `SELECT a.tenant_id FROM tenant_admin_tokens a JOIN tenants t ON t.id = a.tenant_id
      WHERE a.token_sha256=$1 AND a.revoked_at IS NULL AND t.disabled_at IS NULL`,
    [digest(token)],
  );
  return result.rows[0]?.tenant_id ?? null;
}
