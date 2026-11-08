import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export async function runMigrations(pool: Pool): Promise<void> {
  const directory = resolve(process.cwd(), '../db/migrations');
  const files = (await readdir(directory)).filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file)).sort();
  const client = await pool.connect();
  try {
    // Migrations may legitimately run long (index builds, backfills) and the lock
    // waits for another instance; the pool's statement_timeout does not apply here.
    await client.query('SET statement_timeout = 0');
    await client.query("SELECT pg_advisory_lock(hashtextextended('hub-integracoes:migrations', 0))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files) {
      const sql = await readFile(resolve(directory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name=$1', [file]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Migration changed after application: ${file}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name, checksum) VALUES($1,$2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    const unlocked = await client.query("SELECT pg_advisory_unlock(hashtextextended('hub-integracoes:migrations', 0))")
      .then(() => client.query('RESET statement_timeout'))
      .then(() => true, () => false);
    client.release(!unlocked);
  }
}
