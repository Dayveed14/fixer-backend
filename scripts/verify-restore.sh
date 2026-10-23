#!/usr/bin/env bash
# =====================================================================
# Proves backups can actually be restored: takes a fresh backup,
# restores it into a scratch database, then compares every table's
# row count and CHECKSUM TABLE with the source. Exits non-zero on any
# difference. Run it monthly (and before risky deploys).
#
#   npm run db:verify-restore
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a; source <(grep -E '^DB_[A-Z_]+=' .env); set +a
fi
: "${DB_HOST:?}"; : "${DB_USER:?}"; : "${DB_NAME:?}"
DB_PORT="${DB_PORT:-3306}"
SCRATCH="${DB_NAME}_verify_$$"

CLIENT=$(command -v mysql || command -v mariadb)
SSL_ARGS=()
if [[ "${DB_SSL:-true}" != "false" ]]; then
  if "$CLIENT" --help 2>/dev/null | grep -q -- '--ssl-mode'; then SSL_ARGS=(--ssl-mode=REQUIRED); else SSL_ARGS=(--ssl); fi
fi
run() { MYSQL_PWD="${DB_PASSWORD:-}" "$CLIENT" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "${SSL_ARGS[@]}" -N -B "$@"; }
cleanup() { run -e "DROP DATABASE IF EXISTS \`$SCRATCH\`" || true; }
trap cleanup EXIT

FILE=$(BACKUP_DIR="${BACKUP_DIR:-backups}" bash scripts/backup-db.sh)
echo "Backup:   $FILE ($(du -h "$FILE" | cut -f1))"
bash scripts/restore-db.sh "$FILE" "$SCRATCH" >/dev/null
echo "Restored into scratch database $SCRATCH"

fingerprint() {
  local db=$1
  for t in $(run -e "SELECT table_name FROM information_schema.tables WHERE table_schema='$db' AND table_type='BASE TABLE' ORDER BY table_name"); do
    local n c
    n=$(run -e "SELECT COUNT(*) FROM \`$db\`.\`$t\`")
    c=$(run -e "CHECKSUM TABLE \`$db\`.\`$t\`" | awk '{print $2}')
    echo "$t rows=$n checksum=$c"
  done
}

diff <(fingerprint "$DB_NAME") <(fingerprint "$SCRATCH") > /tmp/fixer-verify-diff.$$ && STATUS=0 || STATUS=1
TABLES=$(fingerprint "$SCRATCH" | wc -l)
if [[ $STATUS -eq 0 ]]; then
  echo "OK: all $TABLES tables match (row counts and checksums)."
else
  echo "MISMATCH between live and restored data:" >&2
  cat /tmp/fixer-verify-diff.$$ >&2
fi
rm -f /tmp/fixer-verify-diff.$$
exit $STATUS
