#!/usr/bin/env bash
# Logical backup of the PostgreSQL database of a running Compose stack.
#
# Usage: scripts/backup.sh [output_dir]            (default: ./backups)
#   COMPOSE_ARGS  extra docker compose arguments, e.g. "-f compose.prod.yaml"
#   BACKUP_KEEP   how many dumps to keep in output_dir (default 14)
#
# Writes hub-<UTC timestamp>.dump (pg_dump custom format, consistent snapshot)
# plus a .sha256 file, both 0600. Dumps contain order data, encrypted webhook
# keys and admin-token digests: store them encrypted and off the server.
# TENANT_SECRETS_KEY is NOT in the dump and must be backed up separately.
set -euo pipefail
OUT=${1:-./backups}
KEEP=${BACKUP_KEEP:-14}
read -r -a EXTRA <<<"${COMPOSE_ARGS:-}"
compose() { docker compose "${EXTRA[@]}" "$@"; }

mkdir -p "$OUT"; chmod 700 "$OUT"; umask 077
FILE="$OUT/hub-$(date -u +%Y%m%dT%H%M%SZ).dump"
compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6' > "$FILE.partial"
# A truncated dump fails this check (pg_restore reads the table of contents).
compose exec -T postgres pg_restore --list < "$FILE.partial" > /dev/null
mv "$FILE.partial" "$FILE"
(cd "$OUT" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256")
echo "backup: $FILE ($(du -h "$FILE" | cut -f1))"

# Rotation: keep the newest $KEEP dumps (names sort chronologically).
mapfile -t OLD < <(ls -1 "$OUT"/hub-*.dump 2>/dev/null | sort | head -n -"$KEEP")
for old in "${OLD[@]}"; do rm -f "$old" "$old.sha256"; echo "rotated out: $old"; done
