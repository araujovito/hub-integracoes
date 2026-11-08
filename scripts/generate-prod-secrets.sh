#!/usr/bin/env bash
# Generate the secret files used by compose.prod.yaml.
#
# Usage: scripts/generate-prod-secrets.sh [directory]   (default: ./secrets)
#
# Never overwrites: rotating PostgreSQL/Redis passwords or TENANT_SECRETS_KEY
# requires a planned procedure (a new TENANT_SECRETS_KEY makes every stored
# webhook key unreadable). The directory is 0700; files are 0444 because each
# one is bind-mounted into containers that run as non-root users (postgres,
# redis, node) and must be able to read it. Protection comes from the directory.
set -euo pipefail
DIR=${1:-./secrets}
if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  echo "refusing to overwrite: $DIR is not empty" >&2
  exit 1
fi
mkdir -p "$DIR"
chmod 700 "$DIR"
umask 077

PG_PASSWORD=$(openssl rand -hex 32)
REDIS_PASSWORD=$(openssl rand -hex 32)
printf '%s' "$PG_PASSWORD" > "$DIR/postgres_password"
printf '%s' "$REDIS_PASSWORD" > "$DIR/redis_password"
printf 'requirepass %s\nappendonly yes\n' "$REDIS_PASSWORD" > "$DIR/redis.conf"
printf 'postgres://hub:%s@postgres:5432/hub_integracoes' "$PG_PASSWORD" > "$DIR/database_url"
printf 'redis://:%s@redis:6379' "$REDIS_PASSWORD" > "$DIR/redis_url"
printf '%s' "$(openssl rand -hex 32)" > "$DIR/platform_admin_token"
printf '%s' "$(openssl rand -base64 32)" > "$DIR/tenant_secrets_key"
printf '%s' "$(openssl rand -hex 32)" > "$DIR/metrics_token"
chmod 444 "$DIR"/*

echo "secrets written to $DIR (keep them out of Git; back up tenant_secrets_key separately from database backups)"
