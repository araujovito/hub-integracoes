import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, parseMasterKey } from '../src/tenant-crypto.js';

const key = randomBytes(32);

describe('tenant secret encryption', () => {
  it('round-trips a secret and produces a different ciphertext each time', () => {
    const first = encryptSecret(key, 'segredo', 'webhook-key:loja-a:1');
    const second = encryptSecret(key, 'segredo', 'webhook-key:loja-a:1');
    expect(first.equals(second)).toBe(false);
    expect(decryptSecret(key, first, 'webhook-key:loja-a:1')).toBe('segredo');
  });

  it('refuses a ciphertext moved to another tenant or key row', () => {
    const sealed = encryptSecret(key, 'segredo', 'webhook-key:loja-a:1');
    expect(() => decryptSecret(key, sealed, 'webhook-key:loja-b:1')).toThrow();
  });

  it('refuses tampered ciphertext and the wrong master key', () => {
    const sealed = encryptSecret(key, 'segredo', 'ctx');
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => decryptSecret(key, tampered, 'ctx')).toThrow();
    expect(() => decryptSecret(randomBytes(32), sealed, 'ctx')).toThrow();
  });

  it('accepts only 32-byte base64 master keys', () => {
    expect(parseMasterKey(randomBytes(32).toString('base64')).length).toBe(32);
    expect(() => parseMasterKey(randomBytes(16).toString('base64'))).toThrow('32 bytes');
  });
});

describe('master key ring', async () => {
  const { decryptWithKeyRing } = await import('../src/tenant-crypto.js');
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);

  it('decrypts with the current key first and reports which key worked', () => {
    const underNew = encryptSecret(newKey, 's', 'ctx');
    const underOld = encryptSecret(oldKey, 's', 'ctx');
    expect(decryptWithKeyRing({ current: newKey, previous: [oldKey] }, underNew, 'ctx')).toEqual({ plaintext: 's', current: true });
    expect(decryptWithKeyRing({ current: newKey, previous: [oldKey] }, underOld, 'ctx')).toEqual({ plaintext: 's', current: false });
  });

  it('fails when no configured key opens the secret', () => {
    const underOld = encryptSecret(oldKey, 's', 'ctx');
    expect(() => decryptWithKeyRing({ current: newKey, previous: [] }, underOld, 'ctx')).toThrow();
  });
});
