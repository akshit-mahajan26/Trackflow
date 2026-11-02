#!/usr/bin/env bash
# Restore a backup created by backup.sh. REPLACES all current data.
#   ./scripts/restore.sh backups/trackflow-YYYYmmdd-HHMMSS.tar.gz [--yes]
# Stop the TrackFlow server first so no one writes during the restore.
set -euo pipefail
. "$(dirname "$0")/_env.sh"
ARCHIVE="${1:?usage: restore.sh <backup.tar.gz> [--yes]}"
[ -f "$ARCHIVE" ] || { echo "No such file: $ARCHIVE"; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$ARCHIVE" -C "$WORK"
[ -f "$WORK/database.dump" ] || { echo "Archive has no database.dump"; exit 1; }
cat "$WORK/MANIFEST" 2>/dev/null || true
DB_NAME="${PG_URL##*/}"
if [ "${2:-}" != "--yes" ]; then
  read -r -p "This will REPLACE all data in database '$DB_NAME' and $UPLOADS. Type the database name to continue: " ans
  [ "$ans" = "$DB_NAME" ] || { echo "Aborted."; exit 1; }
fi
echo "Restoring database…"
psql "$PG_URL" -q -v ON_ERROR_STOP=1 -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$PG_URL" "$WORK/database.dump"
echo "Restoring attachments…"
mkdir -p "$UPLOADS"
find "$UPLOADS" -mindepth 1 -maxdepth 1 -type f -delete
cp -R "$WORK/uploads/." "$UPLOADS/" 2>/dev/null || true
echo "Applying any newer migrations…"
(cd "$BACKEND" && .venv/bin/alembic upgrade head)
echo "Restore complete. Start the server again."
