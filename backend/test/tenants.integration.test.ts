import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activeWebhookSecrets, createAdminToken, createTenant, createWebhookKey,
  reencryptWebhookKeys, resolveAdminToken, revokeAdminToken, revokeWebhookKey, TenantNotFoundError,
} from '../src/tenants.js';
import { createIsolatedDatabase } from './helpers/isolated-db.js';

const enabled = process.env.RUN_INTEGRATION_TESTS === 'true';
const suite = enabled ? describe : describe.skip;
const masterKey = { current: randomBytes(32), previous: [] as Buffer[] };
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

  it('accepts every unexpired key across more than five rotations', async () => {
    await createTenant(db.pool, 'loja-many', 'Many');
    const secrets = [];
    for (let i = 0; i < 6; i++) secrets.push((await createWebhookKey(db.pool, masterKey, 'loja-many', 3600)).secret);
    expect(new Set(await activeWebhookSecrets(db.pool, masterKey, 'loja-many'))).toEqual(new Set(secrets));
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
    expect(await resolveAdminToken(db.pool, a.token)).toMatchObject({ tenantId: 'loja-a', role: 'operator' });
    expect(await resolveAdminToken(db.pool, b.token)).toMatchObject({ tenantId: 'loja-b' });
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

  it('rotates the master key without losing any webhook secret', async () => {
    await createTenant(db.pool, 'loja-rot', 'Rotação');
    const oldRing = { current: randomBytes(32), previous: [] as Buffer[] };
    const kept = await createWebhookKey(db.pool, oldRing, 'loja-rot', 3600);
    const revoked = await createWebhookKey(db.pool, oldRing, 'loja-rot', 3600);
    await revokeWebhookKey(db.pool, 'loja-rot', revoked.keyId);

    // Step 1: new key is current, old one still decrypts.
    const transition = { current: randomBytes(32), previous: [oldRing.current] };
    expect(await activeWebhookSecrets(db.pool, transition, 'loja-rot')).toEqual([kept.secret]);
    const created = await createWebhookKey(db.pool, transition, 'loja-rot', 3600); // written with the new key

    // Step 2: re-encrypt; only the rows under the old key change (revoked ones too).
    // Other stores in this schema were encrypted under an unrelated key: they must
    // be reported as unreadable (and left alone), exactly those and nothing else.
    const others = await db.pool.query<{ id: string }>("SELECT id FROM tenant_webhook_keys WHERE tenant_id <> 'loja-rot' ORDER BY id");
    const first = await reencryptWebhookKeys(db.pool, transition, 1);
    expect(first.unreadable).toEqual(others.rows.map((row) => row.id));
    expect(first.reencrypted).toBe(2);
    expect(first.alreadyCurrent).toBe(1);
    const second = await reencryptWebhookKeys(db.pool, transition);
    expect(second.reencrypted).toBe(0);

    // Step 3: previous key removed; everything still verifies.
    const finalRing = { current: transition.current, previous: [] as Buffer[] };
    expect(new Set(await activeWebhookSecrets(db.pool, finalRing, 'loja-rot'))).toEqual(new Set([kept.secret, created.secret]));

    // With the wrong master key, unreadable keys are skipped, not a crash.
    expect(await activeWebhookSecrets(db.pool, { current: randomBytes(32), previous: [] }, 'loja-rot')).toEqual([]);

    // A wrong ring reports rows as unreadable and changes nothing.
    const wrong = await reencryptWebhookKeys(db.pool, { current: randomBytes(32), previous: [] });
    expect(wrong.reencrypted).toBe(0);
    expect(wrong.unreadable.length).toBeGreaterThanOrEqual(3);
    expect(new Set(await activeWebhookSecrets(db.pool, finalRing, 'loja-rot'))).toEqual(new Set([kept.secret, created.secret]));
  });

  it('issues expiring tokens with a role and stops accepting them after expiry', async () => {
    await createTenant(db.pool, 'loja-exp', 'Expira');
    const viewer = await createAdminToken(db.pool, 'loja-exp', 'leitura', 'viewer', 30);
    const session = await resolveAdminToken(db.pool, viewer.token);
    expect(session).toMatchObject({ tenantId: 'loja-exp', role: 'viewer' });
    const days = (session!.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);

    await db.pool.query("UPDATE tenant_admin_tokens SET expires_at = now() - interval '1 second' WHERE id=$1", [viewer.tokenId]);
    expect(await resolveAdminToken(db.pool, viewer.token)).toBeNull();
    await expect(createAdminToken(db.pool, 'loja-exp', 'x', 'operator', 0)).rejects.toThrow('invalid_expiry');
    await expect(createAdminToken(db.pool, 'loja-exp', 'x', 'operator', 366)).rejects.toThrow('invalid_expiry');
  });

  it('keeps tokens issued before expiry existed (NULL expiry) working', async () => {
    const legacy = await createAdminToken(db.pool, 'loja-exp', 'legado');
    await db.pool.query('UPDATE tenant_admin_tokens SET expires_at = NULL WHERE id=$1', [legacy.tokenId]);
    expect(await resolveAdminToken(db.pool, legacy.token)).toMatchObject({ tenantId: 'loja-exp', role: 'operator', expiresAt: null });
  });
});
