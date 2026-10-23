#!/usr/bin/env bash
# =====================================================================
# Backs up the Fixer database to backups/<db>-<UTC timestamp>.sql.gz
# with a .sha256 next to it.
#
#   npm run db:backup                      # uses DB_* from .env / env
#   BACKUP_DIR=/mnt/backups npm run db:backup
#
# --single-transaction gives a consistent snapshot of InnoDB tables
# without locking the live site. Keep copies off the server (e.g. the
# GitHub Actions artifact, S3, Google Drive) — see docs/OPERATIONS.md.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

# Load .env if present (only DB_* lines).
if [[ -f .env ]]; then
  set -a; source <(grep -E '^DB_[A-Z_]+=' .env); set +a
fi

: "${DB_HOST:?DB_HOST is required}"
: "${DB_USER:?DB_USER is required}"
: "${DB_NAME:?DB_NAME is required}"
DB_PORT="${DB_PORT:-3306}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
mkdir -p "$BACKUP_DIR"

DUMP=$(command -v mysqldump || command -v mariadb-dump)
SSL_ARGS=()
if [[ "${DB_SSL:-true}" != "false" ]]; then
  # MySQL 8 client: --ssl-mode; MariaDB client: --ssl
  if "$DUMP" --help 2>/dev/null | grep -q -- '--ssl-mode'; then SSL_ARGS=(--ssl-mode=REQUIRED); else SSL_ARGS=(--ssl); fi
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$BACKUP_DIR/${DB_NAME}-${STAMP}.sql.gz"

MYSQL_PWD="${DB_PASSWORD:-}" "$DUMP" \
  -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "${SSL_ARGS[@]}" \
  --single-transaction --quick --routines --triggers --events \
  --set-gtid-purged=OFF --no-tablespaces "$DB_NAME" 2>/dev/null \
  | gzip -9 > "$FILE" \
  || MYSQL_PWD="${DB_PASSWORD:-}" "$DUMP" \
       -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "${SSL_ARGS[@]}" \
       --single-transaction --quick --routines --triggers \
       --no-tablespaces "$DB_NAME" | gzip -9 > "$FILE"

# A dump that stops early has no completion marker — treat it as failed.
if ! gzip -dc "$FILE" | tail -n 3 | grep -q "Dump completed"; then
  echo "Backup looks incomplete: $FILE" >&2
  exit 1
fi

sha256sum "$FILE" > "$FILE.sha256"
echo "$FILE"
