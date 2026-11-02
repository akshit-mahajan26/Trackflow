#!/usr/bin/env bash
# Back up the database and uploaded attachments into one archive.
#   ./scripts/backup.sh [output-dir]      (default: ./backups)
# Schedule nightly, e.g. crontab:  0 2 * * * /path/to/JIRA/scripts/backup.sh >> /var/log/trackflow-backup.log 2>&1
set -euo pipefail
. "$(dirname "$0")/_env.sh"
OUT_DIR="${1:-$ROOT/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$OUT_DIR"
echo "Dumping database…"
pg_dump --format=custom --no-owner --no-privileges --dbname="$PG_URL" --file="$WORK/database.dump"
echo "Copying attachments from $UPLOADS…"
mkdir -p "$WORK/uploads"
[ -d "$UPLOADS" ] && cp -R "$UPLOADS/." "$WORK/uploads/" 2>/dev/null || true
cat > "$WORK/MANIFEST" <<MANIFEST
created=$STAMP
migration=$(psql "$PG_URL" -Atc "select version_num from alembic_version" 2>/dev/null || echo unknown)
attachments=$(find "$WORK/uploads" -type f | wc -l | tr -d ' ')
MANIFEST
ARCHIVE="$OUT_DIR/trackflow-$STAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$WORK" database.dump uploads MANIFEST
echo "Backup written: $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
# Keep the 30 most recent backups.
ls -1t "$OUT_DIR"/trackflow-*.tar.gz 2>/dev/null | tail -n +31 | while read -r old; do rm -f -- "$old"; done
