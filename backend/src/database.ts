import { Pool, type PoolConfig } from 'pg';
import { config } from './config.js';
import { runMigrations } from './migrations.js';

/**
 * A pg Pool that survives database restarts. When PostgreSQL terminates an idle
 * connection, the pool emits 'error'; without a listener Node treats it as an
 * unhandled error event and kills the process. The pool already discards the
 * broken client, so logging is all that is needed.
 */
export function createPool(service: string, options: PoolConfig): Pool {
  const pool = new Pool({
    connectionTimeoutMillis: 5_000,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: config.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    ...options,
  });
  pool.on('error', (error) => {
    console.error(JSON.stringify({ service, status: 'idle_db_client_error', error: error.message }));
  });
  // A client that is checked out but has no query running (e.g. the relay
  // waiting on Redis mid-transaction) emits 'error' on itself when the server
  // ends the session, for instance after idle_in_transaction_session_timeout.
  // The pool listener above does not cover it. The next query on that client
  // fails normally and the pool discards it on release.
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      console.error(JSON.stringify({ service, status: 'checked_out_db_client_error', error: error.message }));
    });
  });
  return pool;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run migrations, waiting for the database instead of exiting when it is not
 * reachable yet (startup during an outage would otherwise crash-loop).
 * `shouldStop` lets SIGTERM interrupt the wait.
 */
export async function migrateWhenReady(pool: Pool, service: string, shouldStop: () => boolean = () => false): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runMigrations(pool);
      return;
    } catch (error) {
      if (!isTransientDatabaseError(error) || shouldStop()) throw error;
      const delayMs = Math.min(10_000, 250 * 2 ** Math.min(attempt, 6));
      console.error(JSON.stringify({ service, status: 'waiting_for_database', attempt, delayMs, error: (error as Error).message }));
      await sleep(delayMs);
    }
  }
}

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE',
  '57P01', '57P02', '57P03', // admin_shutdown, crash_shutdown, cannot_connect_now
  '57014', // query_canceled: statement_timeout hit, the database is overloaded or blocked
  '08000', '08001', '08003', '08004', '08006', // connection exceptions
]);

/** Errors that mean "dependency unavailable right now" rather than a bug. */
export function isTransientDatabaseError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /Connection terminated|timeout exceeded when trying to connect|Connection is closed/i.test(message);
}
