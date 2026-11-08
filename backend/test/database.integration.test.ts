import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { createPool, isTransientDatabaseError } from '../src/database.js';

const enabled = process.env.RUN_INTEGRATION_TESTS === 'true';
const suite = enabled ? describe : describe.skip;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

suite('database session limits', () => {
  it('applies the configured timeouts to every pooled connection', async () => {
    const pool = createPool('test', { connectionString: config.DATABASE_URL });
    try {
      const statement = await pool.query<{ statement_timeout: string }>('SHOW statement_timeout');
      const idle = await pool.query<{ idle_in_transaction_session_timeout: string }>('SHOW idle_in_transaction_session_timeout');
      expect(statement.rows[0]?.statement_timeout).toBe(`${config.DB_STATEMENT_TIMEOUT_MS / 1000}s`);
      expect(idle.rows[0]?.idle_in_transaction_session_timeout).toBe(`${config.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS / 1000}s`);
    } finally {
      await pool.end();
    }
  });

  it('cancels a statement that runs past the limit, as a transient error', async () => {
    const pool = createPool('test', { connectionString: config.DATABASE_URL, statement_timeout: 200 });
    try {
      const failure = await pool.query('SELECT pg_sleep(2)').then(() => null, (error: unknown) => error);
      expect(failure).toMatchObject({ code: '57014' });
      expect(isTransientDatabaseError(failure)).toBe(true);
      // The connection stays usable after the cancel.
      expect((await pool.query('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 });
    } finally {
      await pool.end();
    }
  });

  it('ends a session left idle inside a transaction, without crashing the process', async () => {
    const pool = createPool('test', { connectionString: config.DATABASE_URL, idle_in_transaction_session_timeout: 300 });
    try {
      const client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT 1');
      await sleep(800);
      // No listener added here: createPool's own handler must absorb the error
      // events (an unhandled one would fail this run as an uncaught error).
      await expect(client.query('SELECT 1')).rejects.toThrow();
      client.release(true);
      // The pool hands out a fresh, working connection.
      expect((await pool.query('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 });
    } finally {
      await pool.end();
    }
  });
});
