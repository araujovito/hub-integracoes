import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { config, loadApiSecrets } from './config.js';
import { runMigrations } from './migrations.js';
import { buildApp } from './app.js';

const secrets = loadApiSecrets();
const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10, idleTimeoutMillis: 30_000 });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });

await runMigrations(pool);
const app = await buildApp({ pool, redis, secrets });

app.addHook('onClose', async () => {
  await Promise.all([pool.end(), redis.quit()]);
});

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
