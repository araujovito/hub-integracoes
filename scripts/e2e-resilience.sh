#!/usr/bin/env bash
# End-to-end resilience test under sustained load.
#
# Starts a separate Compose project (own name, ports and volumes; never touches
# the local development stack), drives signed orders through the full pipeline
# and, while the load runs:
#   1. kills the worker with SIGKILL mid-flight and starts it again;
#   2. stops PostgreSQL and starts it again.
# Then checks that every accepted order was delivered exactly once, with no
# dead letters and nothing stuck in the outbox. Tears everything down at the end.
#
# Usage: scripts/e2e-resilience.sh [duration_seconds] [rate_per_second]
set -euo pipefail

PROJECT=hub-e2e
DURATION=${1:-90}
RATE=${2:-20}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
ENV_FILE="$WORK/e2e.env"

umask 077
cat > "$ENV_FILE" <<ENV
POSTGRES_USER=hub_e2e
POSTGRES_PASSWORD=$(openssl rand -hex 16)
POSTGRES_DB=hub_e2e
REDIS_PASSWORD=$(openssl rand -hex 16)
PLATFORM_ADMIN_TOKEN=$(openssl rand -hex 24)
TENANT_SECRETS_KEY=$(openssl rand -base64 32)
API_HOST_PORT=13000
POSTGRES_HOST_PORT=15433
REDIS_HOST_PORT=16380
WORKER_CLAIM_IDLE_MS=5000
WEBHOOK_RATE_LIMIT_PER_MINUTE=1000000
NODE_ENV=production
ENV

compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$ROOT/compose.yaml" "$@"; }
cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
log() { printf '[%s] %s\n' "$(date +%T)" "$*"; }

log "starting isolated stack ($PROJECT)"
compose up -d --build --wait --wait-timeout 180 postgres redis api relay worker >/dev/null

BASE=http://127.0.0.1:13000
set -a; . "$ENV_FILE"; set +a

log "load: ${DURATION}s at ${RATE} req/s"
(cd "$ROOT/backend" && npx --no-install tsx scripts/load-test.ts --base "$BASE" --duration "$DURATION" --rate "$RATE" \
  --tenant-file "$WORK/tenant" --drain-timeout 240 > "$WORK/report.json" 2> "$WORK/load.err") &
LOAD_PID=$!

at() { sleep "$1"; }
at $((DURATION * 20 / 100)); log "chaos: SIGKILL worker";      compose kill -s SIGKILL worker >/dev/null
at $((DURATION * 10 / 100)); log "chaos: start worker";        compose start worker >/dev/null
at $((DURATION * 15 / 100)); log "chaos: stop postgres";       compose stop postgres >/dev/null
at $((DURATION * 15 / 100)); log "chaos: start postgres";      compose start postgres >/dev/null

set +e; wait "$LOAD_PID"; LOAD_STATUS=$?; set -e
cat "$WORK/report.json"; [ -s "$WORK/load.err" ] && cat "$WORK/load.err" >&2

TENANT=$(cat "$WORK/tenant")
sql() { compose exec -T postgres psql -U hub_e2e -d hub_e2e -tAc "$1"; }
DELIVERIES=$(sql "SELECT count(*) FROM erp_deliveries WHERE tenant_id='$TENANT'")
DELIVERED=$(sql "SELECT count(*) FROM integration_events WHERE tenant_id='$TENANT' AND status='delivered'")
NOT_DELIVERED=$(sql "SELECT count(*) FROM integration_events WHERE tenant_id='$TENANT' AND status<>'delivered'")
DEAD=$(sql "SELECT count(*) FROM dead_letter_events d JOIN integration_events e ON e.id=d.integration_event_id WHERE e.tenant_id='$TENANT'")
UNPUBLISHED=$(sql "SELECT count(*) FROM outbox_events WHERE published_at IS NULL")
ACCEPTED=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["uniqueEventsAccepted"])' "$WORK/report.json")
RESTARTS=$(docker inspect -f '{{.RestartCount}}' "$(compose ps -q api)" "$(compose ps -q relay)" "$(compose ps -q worker)" | paste -sd' ')

log "accepted=$ACCEPTED delivered=$DELIVERED erp_deliveries=$DELIVERIES not_delivered=$NOT_DELIVERED dead_letters=$DEAD unpublished_outbox=$UNPUBLISHED restarts(api relay worker)=$RESTARTS"

FAIL=0
[ "$LOAD_STATUS" -eq 0 ] || { log "FAIL: load client reported loss"; FAIL=1; }
[ "$DELIVERED" -eq "$ACCEPTED" ] || { log "FAIL: delivered != accepted"; FAIL=1; }
[ "$DELIVERIES" -eq "$ACCEPTED" ] || { log "FAIL: ERP deliveries != accepted (duplicate or missing effect)"; FAIL=1; }
[ "$NOT_DELIVERED" -eq 0 ] || { log "FAIL: events left undelivered"; FAIL=1; }
[ "$DEAD" -eq 0 ] || { log "FAIL: dead letters during transient outages"; FAIL=1; }
[ "$UNPUBLISHED" -eq 0 ] || { log "FAIL: outbox not drained"; FAIL=1; }
if [ "$FAIL" -ne 0 ]; then
  log "service logs (last 40 lines each):"
  for service in api relay worker; do compose logs --tail 40 "$service" 2>&1 | cut -c1-240; done
  exit 1
fi
log "PASS: every accepted order delivered exactly once"
