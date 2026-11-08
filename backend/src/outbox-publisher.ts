import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

/** Publish one bounded outbox batch; a Redis failure rolls the DB claim back for retry. */
export async function publishOutboxBatch(pool: Pool, redis: Redis, streamKey: string, batchSize = 25): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pending = await client.query<{
      id: string; integration_event_id: string; event_type: string; payload: unknown;
    }>(
      `SELECT id, integration_event_id, event_type, payload
         FROM outbox_events
        WHERE published_at IS NULL
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [batchSize],
    );

    for (const event of pending.rows) {
      const streamId = await redis.xadd(
        streamKey, '*',
        'outboxId', event.id,
        'eventId', event.integration_event_id,
        'eventType', event.event_type,
        'payload', JSON.stringify(event.payload),
      );
      await client.query(
        'UPDATE outbox_events SET published_at=now(), redis_stream_id=$2 WHERE id=$1',
        [event.id, streamId],
      );
      await client.query(
        "UPDATE integration_events SET status='queued', updated_at=now() WHERE id=$1 AND status='received'",
        [event.integration_event_id],
      );
    }
    await client.query('COMMIT');
    return pending.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
