import type { Pool } from 'pg';

export type FailureResult = { attempts: number; terminal: boolean; ignored: boolean };

/** Count one failed processing attempt and atomically move terminal failures to the dead-letter table. */
export async function recordDeliveryFailure(
  pool: Pool, eventId: string, streamId: string, reason: string, maxAttempts: number,
): Promise<FailureResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ attempts: number; status: string }>(
      'SELECT attempts, status FROM integration_events WHERE id=$1 FOR UPDATE', [eventId],
    );
    const row = current.rows[0];
    if (!row || row.status === 'delivered' || row.status === 'failed') {
      await client.query('COMMIT');
      return { attempts: row?.attempts ?? 0, terminal: false, ignored: true };
    }
    const attempts = row.attempts + 1;
    const terminal = attempts >= maxAttempts;
    await client.query(
      `UPDATE integration_events SET attempts=$2, last_error=$3, status=$4, updated_at=now() WHERE id=$1`,
      [eventId, attempts, reason, terminal ? 'failed' : 'processing'],
    );
    if (terminal) {
      await client.query(
        `INSERT INTO dead_letter_events (integration_event_id,stream_id,attempts,reason)
         VALUES ($1,$2,$3,$4) ON CONFLICT (stream_id) DO NOTHING`,
        [eventId, streamId, attempts, reason],
      );
    }
    await client.query('COMMIT');
    return { attempts, terminal, ignored: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
