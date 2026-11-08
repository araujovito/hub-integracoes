import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activeWebhookSecrets, createAdminToken, createTenant, createWebhookKey,
  resolveAdminToken, revokeAdminToken, revokeWebhookKey, TenantNotFoundError,
} from '../src/tenants.js';
import { createIsolatedDatabase } from './helpers/isolated-db.js';

const enabled = process.env.RUN_INTEGRATION_TESTS === 'true';
const suite = enabled ? describe : describe.skip;
const masterKey = randomBytes(32);
let db: Awaited<ReturnType<typeof createIsolatedDatabase>>;

beforeAll(async () => { if (enabled) db = await createIsolatedDatabase(); });
afterAll(async () => { if (enabled) await db.drop(); });

suite('tenant store', () => {
  it('validates tenant ids', async () => {
    await expect(createTenant(db.pool, 'Loja Com Espaço', 'x')).rejects.toThrow('invalid_tenant_id');
    await createTenant(db.pool, 'loja-a', 'Loja A');
    await createTenant(db.pool, 'loja-b', 'Loja B');
  });

  it('stores webhook secrets encrypted and returns them only to the owning tenant', async () => {
    const { secret } = await createWebhookKey(db.pool, masterKey, 'loja-a', 3600);
    const raw = await db.pool.query("SELECT secret_ciphertext FROM tenant_webhook_keys WHERE tenant_id='loja-a'");
    expect(raw.rows[0].secret_ciphertext.toString('utf8')).not.toContain(secret);
    expect(await activeWebhookSecrets(db.pool, masterKey, 'loja-a')).toEqual([secret]);
    expect(await activeWebhookSecrets(db.pool, masterKey, 'loja-b')).toEqual([]);
    expect(await activeWebhookSecrets(db.pool, masterKey, 'nao-existe')).toEqual([]);
  });

  it('keeps the previous key during the grace period and drops it afterwards', async () => {
    const old = await createWebhookKey(db.pool, masterKey, 'loja-b', 3600);
    const rotated = await createWebhookKey(db.pool, masterKey, 'loja-b', 3600);
    expect(new Set(await activeWebhookSecrets(db.pool, masterKey, 'loja-b'))).toEqual(new Set([old.secret, rotated.secret]));
    const immediate = await createWebhookKey(db.pool, masterKey, 'loja-b', 0);
    expect(await activeWebhookSecrets(db.pool, masterKey, 'loja-b')).toEqual([immediate.secret]);
  });

  it('revokes a webhook key only within its own tenant', async () => {
    const key = await createWebhookKey(db.pool, masterKey, 'loja-a', 0);
    expect(await revokeWebhookKey(db.pool, 'loja-b', key.keyId)).toBe(false);
    expect(await revokeWebhookKey(db.pool, 'loja-a', key.keyId)).toBe(true);
    expect(await activeWebhookSecrets(db.pool, masterKey, 'loja-a')).toEqual([]);
  });

  it('resolves admin tokens to their tenant and stops after revocation or disabling', async () => {
    const a = await createAdminToken(db.pool, 'loja-a', 'operador');
    const b = await createAdminToken(db.pool, 'loja-b', 'operador');
    const stored = await db.pool.query('SELECT count(*)::int AS count FROM tenant_admin_tokens WHERE token_sha256::text LIKE $1', [`%${a.token}%`]);
    expect(stored.rows[0].count).toBe(0);
    expect(await resolveAdminToken(db.pool, a.token)).toBe('loja-a');
    expect(await resolveAdminToken(db.pool, b.token)).toBe('loja-b');
    expect(await resolveAdminToken(db.pool, `${a.token}x`)).toBeNull();
    expect(await resolveAdminToken(db.pool, undefined)).toBeNull();

    expect(await revokeAdminToken(db.pool, 'loja-b', a.tokenId)).toBe(false);
    expect(await revokeAdminToken(db.pool, 'loja-a', a.tokenId)).toBe(true);
    expect(await resolveAdminToken(db.pool, a.token)).toBeNull();

    await db.pool.query("UPDATE tenants SET disabled_at=now() WHERE id='loja-b'");
    expect(await resolveAdminToken(db.pool, b.token)).toBeNull();
    await expect(createAdminToken(db.pool, 'loja-b', 'x')).rejects.toBeInstanceOf(TenantNotFoundError);
    await expect(createWebhookKey(db.pool, masterKey, 'loja-b', 0)).rejects.toBeInstanceOf(TenantNotFoundError);
  });
});
