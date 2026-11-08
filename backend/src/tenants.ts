import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { decryptWithKeyRing, encryptSecret, type MasterKeys } from './tenant-crypto.js';

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
export async function createWebhookKey(pool: Pool, keys: MasterKeys, tenantId: string, graceSeconds: number) {
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
      [keyId, tenantId, encryptSecret(keys.current, secret, webhookKeyContext(tenantId, keyId))],
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

/**
 * Secrets currently accepted for a tenant (empty for unknown or disabled tenants).
 * A row no configured master key can open (wrong or lost TENANT_SECRETS_KEY) is
 * skipped with a warning instead of failing the whole request: the store's other
 * keys keep working and the problem shows up in the logs.
 */
export async function activeWebhookSecrets(pool: Pool, keys: MasterKeys, tenantId: string): Promise<string[]> {
  const result = await pool.query<{ id: string; secret_ciphertext: Buffer }>(
    `SELECT k.id, k.secret_ciphertext FROM tenant_webhook_keys k JOIN tenants t ON t.id = k.tenant_id
      WHERE k.tenant_id=$1 AND t.disabled_at IS NULL AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > now())
      ORDER BY k.created_at DESC LIMIT 5`,
    [tenantId],
  );
  const secrets: string[] = [];
  for (const row of result.rows) {
    try {
      secrets.push(decryptWithKeyRing(keys, row.secret_ciphertext, webhookKeyContext(tenantId, row.id)).plaintext);
    } catch {
      console.warn(JSON.stringify({ service: 'api', status: 'webhook_key_unreadable', tenantId, keyId: row.id }));
    }
  }
  return secrets;
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

export type ReencryptionResult = { reencrypted: number; alreadyCurrent: number; unreadable: string[] };

/**
 * Master-key rotation step: re-encrypt every stored webhook secret (revoked ones
 * included) under the current key. Rows only readable with a previous key are
 * rewritten; rows readable with no configured key are reported, never touched.
 * Safe to run repeatedly and while the API serves traffic (row locks, batches).
 */
export async function reencryptWebhookKeys(pool: Pool, keys: MasterKeys, batchSize = 200): Promise<ReencryptionResult> {
  const result: ReencryptionResult = { reencrypted: 0, alreadyCurrent: 0, unreadable: [] };
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const rows = await client.query<{ id: string; tenant_id: string; secret_ciphertext: Buffer }>(
        'SELECT id, tenant_id, secret_ciphertext FROM tenant_webhook_keys WHERE id > $1 ORDER BY id LIMIT $2 FOR UPDATE',
        [after, batchSize],
      );
      for (const row of rows.rows) {
        const context = webhookKeyContext(row.tenant_id, row.id);
        let opened: { plaintext: string; current: boolean };
        try {
          opened = decryptWithKeyRing(keys, row.secret_ciphertext, context);
        } catch {
          result.unreadable.push(row.id);
          continue;
        }
        if (opened.current) {
          result.alreadyCurrent += 1;
          continue;
        }
        await client.query('UPDATE tenant_webhook_keys SET secret_ciphertext=$2 WHERE id=$1', [row.id, encryptSecret(keys.current, opened.plaintext, context)]);
        result.reencrypted += 1;
      }
      await client.query('COMMIT');
      if (rows.rows.length < batchSize) return result;
      after = rows.rows.at(-1)!.id;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
