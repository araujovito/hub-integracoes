#!/usr/bin/env bash
# Prove that a backup can be restored and used by the application.
#
# Usage: scripts/restore-test.sh <dump file>
#
# 1. verifies the .sha256 next to the dump (if present);
# 2. restores into a throwaway PostgreSQL (same image as production) with
#    --exit-on-error, so any error fails the test;
# 3. runs the application image against the restored database: migrations
#    must match by checksum (or apply cleanly if the backup predates newer
#    ones), then prints row counts of the main tables.
# Nothing touches the running stack; everything is removed at the end.
set -euo pipefail
DUMP=${1:?usage: restore-test.sh <dump file>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PG_IMAGE=$(sed -n 's/^ *image: \(postgres:[^ ]*\)$/\1/p' "$ROOT/compose.prod.yaml" | head -1)
ID=restore-test-$$-$RANDOM
NET=$ID-net
APP_IMAGE=hub-integracoes-restore-check
cleanup() { docker rm -f "$ID" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
log() { printf '[restore-test] %s\n' "$*"; }

if [ -f "$DUMP.sha256" ]; then
  (cd "$(dirname "$DUMP")" && sha256sum --quiet -c "$(basename "$DUMP").sha256") && log "checksum ok"
else
  log "warning: no $DUMP.sha256, integrity not verified"
fi

docker network create "$NET" >/dev/null
PASSWORD=$(openssl rand -hex 16)
docker run -d --rm --name "$ID" --network "$NET" -e POSTGRES_USER=restore -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=restore "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$ID" pg_isready -U restore -d restore >/dev/null 2>&1 && break; sleep 1; done
sleep 1
docker exec -i "$ID" pg_restore -U restore -d restore --no-owner --no-privileges --exit-on-error < "$DUMP"
log "pg_restore ok ($PG_IMAGE)"

docker build -q -f "$ROOT/backend/Dockerfile" -t "$APP_IMAGE" "$ROOT" >/dev/null
docker run --rm --network "$NET" -e DATABASE_URL="postgres://restore:$PASSWORD@$ID:5432/restore" "$APP_IMAGE" node --input-type=module -e "
  const { runMigrations } = await import('./dist/migrations.js');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const before = (await pool.query('SELECT count(*)::int AS c FROM schema_migrations')).rows[0].c;
  await runMigrations(pool); // throws if an applied migration's checksum differs from the code
  const after = (await pool.query('SELECT count(*)::int AS c FROM schema_migrations')).rows[0].c;
  const counts = {};
  for (const table of ['tenants', 'integration_events', 'erp_deliveries', 'dead_letter_events', 'outbox_events', 'ai_token_usage']) {
    counts[table] = (await pool.query('SELECT count(*)::int AS c FROM ' + table)).rows[0].c;
  }
  console.log(JSON.stringify({ migrationsInBackup: before, migrationsAfterUpgrade: after, rows: counts }));
  await pool.end();
"
log "PASS: backup restored and accepted by the application"
