import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Layout: version(1) | iv(12) | auth tag(16) | ciphertext. The version byte
// leaves room for a future master-key rotation scheme.
const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** TENANT_SECRETS_KEY is 32 random bytes, base64-encoded (e.g. `openssl rand -base64 32`). */
export function parseMasterKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('TENANT_SECRETS_KEY must be 32 bytes encoded as base64');
  return key;
}

/**
 * Encrypt with AES-256-GCM. `context` is bound as additional authenticated data,
 * so a ciphertext copied to another tenant or key row fails to decrypt.
 */
export function encryptSecret(masterKey: Buffer, plaintext: string, context: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(masterKey: Buffer, sealed: Buffer, context: string): string {
  if (sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== FORMAT_VERSION) throw new Error('unsupported_secret_format');
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}

/** Current key encrypts; previous keys only decrypt, during a master-key rotation. */
export type MasterKeys = { current: Buffer; previous: Buffer[] };

/**
 * Decrypt with the current key, falling back to previous ones. AES-GCM fails
 * authentication with the wrong key, so trying keys in order is safe.
 */
export function decryptWithKeyRing(keys: MasterKeys, sealed: Buffer, context: string): { plaintext: string; current: boolean } {
  try {
    return { plaintext: decryptSecret(keys.current, sealed, context), current: true };
  } catch (error) {
    for (const key of keys.previous) {
      try {
        return { plaintext: decryptSecret(key, sealed, context), current: false };
      } catch {
        // try the next key
      }
    }
    throw error;
  }
}
