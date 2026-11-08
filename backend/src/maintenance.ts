import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

type StreamId = { ms: bigint; seq: bigint };

function parseStreamId(id: string): StreamId {
  const [ms, seq = '0'] = id.split('-');
  return { ms: BigInt(ms ?? '0'), seq: BigInt(seq) };
}

function compareStreamIds(a: string, b: string): number {
  const x = parseStreamId(a);
  const y = parseStreamId(b);
  if (x.ms !== y.ms) return x.ms < y.ms ? -1 : 1;
  if (x.seq !== y.seq) return x.seq < y.seq ? -1 : 1;
  return 0;
}

/**
 * Lowest stream id that may still be needed: the oldest pending (read, not acked)
 * entry and anything after the group's last-delivered id (not read yet).
 * Entries below the returned id are safe to trim once older than the cutoff.
 */
export function safeTrimId(cutoffId: string, lastDeliveredId: string, oldestPendingId: string | null): string {
  // Everything up to and including last-delivered was handed to a consumer, so
  // the first id that may be unread is the one right after it.
  const last = parseStreamId(lastDeliveredId);
  const firstUnread = `${last.ms}-${last.seq + 1n}`;
  let floor = cutoffId;
  for (const candidate of [firstUnread, oldestPendingId]) {
    if (candidate && compareStreamIds(candidate, floor) < 0) floor = candidate;
  }
  return floor;
}

/** Remove acknowledged entries older than the retention window from the stream. */
export async function trimStream(redis: Redis, streamKey: string, group: string, retentionMs: number, nowMs = Date.now()): Promise<number> {
  let groups: unknown[];
  try {
    groups = await redis.call('XINFO', 'GROUPS', streamKey) as unknown[];
  } catch {
    return 0; // stream does not exist yet
  }
  const info = groups
    .map((entry) => {
      const fields = entry as unknown[];
      const record: Record<string, unknown> = {};
      for (let i = 0; i < fields.length; i += 2) record[String(fields[i])] = fields[i + 1];
      return record;
    })
    .find((record) => record.name === group);
  // Without the consumer group nothing is known about what was processed: keep all.
  if (!info) return 0;
  const pending = await redis.call('XPENDING', streamKey, group) as [number, string | null, string | null, unknown];
  const oldestPending = pending[0] > 0 ? pending[1] : null;
  const minId = safeTrimId(`${nowMs - retentionMs}-0`, String(info['last-delivered-id']), oldestPending);
  return Number(await redis.call('XTRIM', streamKey, 'MINID', minId));
}

export type RetentionResult = { redactedEvents: number; redactedDeliveries: number; deletedOutbox: number };

/**
 * Data retention in bounded batches (short locks, no long transactions):
 * - payloads of delivered events and ERP deliveries older than `days` are
 *   replaced by `{}`; identity, status and timestamps stay for dedupe and audit;
 * - published outbox rows older than `days` are deleted.
 * Failed events keep their payload: a dead letter must stay redrivable.
 */
export async function applyRetention(pool: Pool, days: number, batchSize = 1000): Promise<RetentionResult> {
  const result: RetentionResult = { redactedEvents: 0, redactedDeliveries: 0, deletedOutbox: 0 };
  const run = async (sql: string) => {
    let total = 0;
    for (;;) {
      const batch = await pool.query(sql, [days, batchSize]);
      total += batch.rowCount ?? 0;
      if ((batch.rowCount ?? 0) < batchSize) return total;
    }
  };
  result.redactedEvents = await run(
    `UPDATE integration_events SET payload='{}'::jsonb, payload_redacted_at=now()
      WHERE id IN (SELECT id FROM integration_events
                    WHERE status='delivered' AND payload_redacted_at IS NULL
                      AND updated_at < now() - make_interval(days => $1)
                    LIMIT $2 FOR UPDATE SKIP LOCKED)`,
  );
  result.redactedDeliveries = await run(
    `UPDATE erp_deliveries SET payload='{}'::jsonb, payload_redacted_at=now()
      WHERE id IN (SELECT id FROM erp_deliveries
                    WHERE payload_redacted_at IS NULL AND delivered_at < now() - make_interval(days => $1)
                    LIMIT $2 FOR UPDATE SKIP LOCKED)`,
  );
  result.deletedOutbox = await run(
    `DELETE FROM outbox_events
      WHERE id IN (SELECT id FROM outbox_events
                    WHERE published_at IS NOT NULL AND published_at < now() - make_interval(days => $1)
                    LIMIT $2 FOR UPDATE SKIP LOCKED)`,
  );
  return result;
}
