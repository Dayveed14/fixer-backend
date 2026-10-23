#!/usr/bin/env bash
# =====================================================================
# Restores a backup made by backup-db.sh.
#
#   scripts/restore-db.sh backups/fixer-20261023T020000Z.sql.gz [target_db]
#
# The target defaults to "<DB_NAME>_restore" so you can inspect it
# before switching the app over. Restoring over the live database
# needs RESTORE_INTO_LIVE=yes as well as naming it explicitly.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a; source <(grep -E '^DB_[A-Z_]+=' .env); set +a
fi

FILE="${1:?usage: restore-db.sh <backup.sql.gz> [target_db]}"
: "${DB_HOST:?}"; : "${DB_USER:?}"; : "${DB_NAME:?}"
DB_PORT="${DB_PORT:-3306}"
TARGET="${2:-${DB_NAME}_restore}"

[[ "$TARGET" =~ ^[A-Za-z0-9_]+$ ]] || { echo "Bad database name: $TARGET" >&2; exit 1; }

if [[ "$TARGET" == "$DB_NAME" && "${RESTORE_INTO_LIVE:-}" != "yes" ]]; then
  echo "Refusing to overwrite the live database '$DB_NAME'." >&2
  echo "Restore to a new name first, or set RESTORE_INTO_LIVE=yes." >&2
  exit 1
fi

if [[ -f "$FILE.sha256" ]]; then
  sha256sum -c "$FILE.sha256" >/dev/null || { echo "Checksum mismatch: $FILE" >&2; exit 1; }
fi

CLIENT=$(command -v mysql || command -v mariadb)
SSL_ARGS=()
if [[ "${DB_SSL:-true}" != "false" ]]; then
  if "$CLIENT" --help 2>/dev/null | grep -q -- '--ssl-mode'; then SSL_ARGS=(--ssl-mode=REQUIRED); else SSL_ARGS=(--ssl); fi
fi
run() { MYSQL_PWD="${DB_PASSWORD:-}" "$CLIENT" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "${SSL_ARGS[@]}" "$@"; }

run -e "CREATE DATABASE IF NOT EXISTS \`$TARGET\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
gzip -dc "$FILE" | run "$TARGET"
echo "Restored $FILE into $TARGET"
