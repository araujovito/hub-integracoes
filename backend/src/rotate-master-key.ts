/**
 * Re-encrypt stored webhook secrets under the current TENANT_SECRETS_KEY.
 *
 * Rotation procedure (no downtime):
 *   1. set the new key as TENANT_SECRETS_KEY and the old one as
 *      TENANT_SECRETS_KEY_PREVIOUS; restart the API (it now reads both);
 *   2. run this command (in the API container: `node dist/rotate-master-key.js`);
 *   3. when it reports `"unreadable": []` and `"reencrypted"` stays 0 on a second
 *      run, remove TENANT_SECRETS_KEY_PREVIOUS and restart the API.
 * Exit code 1 if any row cannot be decrypted with the configured keys.
 */
import { config, loadApiSecrets } from './config.js';
import { createPool } from './database.js';
import { reencryptWebhookKeys } from './tenants.js';

const secrets = loadApiSecrets();
const pool = createPool('rotate-master-key', { connectionString: config.DATABASE_URL, max: 2 });
try {
  const result = await reencryptWebhookKeys(pool, { current: secrets.TENANT_SECRETS_KEY, previous: secrets.TENANT_SECRETS_KEY_PREVIOUS });
  console.log(JSON.stringify({ service: 'rotate-master-key', previousKeysConfigured: secrets.TENANT_SECRETS_KEY_PREVIOUS.length, ...result }));
  if (result.unreadable.length > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
