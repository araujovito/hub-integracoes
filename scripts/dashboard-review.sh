#!/usr/bin/env bash
# Review the dashboard in real browsers against an isolated stack with demo data.
#
# Usage: scripts/dashboard-review.sh [--screenshots]
#   BROWSERS  comma-separated (default chromium,firefox,webkit)
# Starts its own Compose project (hub-review, own ports/volumes/secrets), seeds a
# demo store through the API, simulates two ERP failures (dead letters, so the
# dead-letter table has rows to review), runs backend/scripts/dashboard-review.ts
# and tears everything down. With --screenshots, writes docs/img/*.png.
set -euo pipefail
PROJECT=hub-review
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
ENV_FILE="$WORK/review.env"
SHOTS=()
[ "${1:-}" = "--screenshots" ] && SHOTS=(--screenshots "$ROOT/docs/img")

umask 077
cat > "$ENV_FILE" <<ENV
POSTGRES_USER=hub_review
POSTGRES_PASSWORD=$(openssl rand -hex 16)
POSTGRES_DB=hub_review
REDIS_PASSWORD=$(openssl rand -hex 16)
PLATFORM_ADMIN_TOKEN=$(openssl rand -hex 24)
TENANT_SECRETS_KEY=$(openssl rand -base64 32)
API_HOST_PORT=14000
POSTGRES_HOST_PORT=15434
REDIS_HOST_PORT=16381
ENV
compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$ROOT/compose.yaml" "$@"; }
trap 'compose down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

compose up -d --build --wait --wait-timeout 180 postgres redis api relay worker >/dev/null
set -a; . "$ENV_FILE"; set +a
BASE=http://127.0.0.1:14000
(cd "$ROOT/backend" && npx --no-install tsx scripts/seed-demo.ts --base "$BASE" --out "$WORK/demo.json")

# Two simulated ERP failures: the simulated ERP never fails on its own.
compose exec -T postgres psql -q -U hub_review -d hub_review -c "
  WITH picked AS (SELECT id FROM integration_events WHERE tenant_id='loja-aurora' ORDER BY received_at DESC LIMIT 2),
  failed AS (UPDATE integration_events e SET status='failed', attempts=5, last_error='erp_timeout: ERP não respondeu em 10 s'
               FROM picked WHERE e.id=picked.id RETURNING e.id)
  INSERT INTO dead_letter_events (integration_event_id, stream_id, attempts, reason)
  SELECT id, 'review-' || id, 5, 'erp_timeout: ERP não respondeu em 10 s' FROM failed;
  DELETE FROM erp_deliveries WHERE integration_event_id IN (SELECT integration_event_id FROM dead_letter_events);"

(cd "$ROOT/backend" && npx --no-install tsx scripts/dashboard-review.ts --base "$BASE" --demo "$WORK/demo.json" \
  --browsers "${BROWSERS:-chromium,firefox,webkit}" "${SHOTS[@]}")
