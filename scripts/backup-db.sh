#!/bin/bash
# Dump the cepi Postgres DB to a timestamped .sql.gz under backups/.
# Run it manually or wire to a cron / Windows scheduled task.
#
# Usage:
#   bash scripts/backup-db.sh              # default DB cepi, host localhost
#   DB_NAME=other bash scripts/backup-db.sh
#
# Restore:
#   gunzip -c backups/<file>.sql.gz | psql -h localhost -U postgres -d cepi
set -e

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-cepi}"
DB_PASS="${DB_PASSWORD:-cerebro}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="$ROOT/backups"
mkdir -p "$OUTDIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTFILE="$OUTDIR/cepi_${STAMP}.sql.gz"

echo "[backup-db] dumping $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME → $OUTFILE"
PGPASSWORD="$DB_PASS" pg_dump \
  --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USER" --dbname="$DB_NAME" \
  --format=plain --no-owner --no-privileges \
  | gzip > "$OUTFILE"

ls -lh "$OUTFILE"

# Optional: prune backups older than 14 days.
if [ "${BACKUP_PRUNE_DAYS:-14}" -gt 0 ]; then
  find "$OUTDIR" -type f -name 'cepi_*.sql.gz' -mtime "+${BACKUP_PRUNE_DAYS:-14}" -print -delete || true
fi

echo "[backup-db] done."
