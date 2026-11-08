import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { config } from '../../src/config.js';
import { runMigrations } from '../../src/migrations.js';

/**
 * A throwaway PostgreSQL schema with all migrations applied. Each test file gets
 * its own, so integration suites never touch local data or each other.
 */
export async function createIsolatedDatabase() {
  const schemaName = `integration_test_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new Pool({ connectionString: config.DATABASE_URL });
  await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
  const pool = new Pool({ connectionString: config.DATABASE_URL, options: `-c search_path=${schemaName}` });
  await runMigrations(pool);
  return {
    pool,
    async drop() {
      await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await adminPool.end();
    },
  };
}
