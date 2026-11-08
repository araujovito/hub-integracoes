import type { Pool } from 'pg';

/**
 * What happened to one stream message. Only `delivered` means this call wrote the
 * ERP effect; the others acknowledge a duplicate without changing anything.
 */
export type DeliveryOutcome = 'delivered' | 'already_delivered' | 'skipped_failed';

/** Persist the simulated ERP side effect and source status in one idempotent transaction. */
export async function deliverEvent(pool: Pool, eventId: string): Promise<DeliveryOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const event = await client.query<{ tenant_id: string; order_id: string; payload: unknown; status: string }>(
      'SELECT tenant_id, order_id, payload, status FROM integration_events WHERE id=$1 FOR UPDATE', [eventId],
    );
    const row = event.rows[0];
    if (!row) throw new Error('integration_event_not_found');
    if (row.status === 'failed' || row.status === 'delivered') {
      await client.query('COMMIT');
      return row.status === 'failed' ? 'skipped_failed' : 'already_delivered';
    }

    await client.query(
      `INSERT INTO erp_deliveries (tenant_id, integration_event_id, order_id, payload)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (tenant_id,integration_event_id) DO NOTHING`,
      [row.tenant_id, eventId, row.order_id, JSON.stringify(row.payload)],
    );
    await client.query(
      `UPDATE integration_events SET status='delivered', last_error=NULL, updated_at=now() WHERE id=$1`, [eventId],
    );
    await client.query('COMMIT');
    return 'delivered';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
