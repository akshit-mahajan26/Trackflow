# Shared helpers: load backend/.env and derive a libpq URL from DATABASE_URL.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
if [ -f "$BACKEND/.env" ] && [ -z "${DATABASE_URL:-}" ]; then
  set -a; . "$BACKEND/.env"; set +a
fi
: "${DATABASE_URL:?DATABASE_URL is not set (backend/.env)}"
PG_URL="${DATABASE_URL/postgresql+psycopg:/postgresql:}"
UPLOADS="${UPLOAD_DIR:-$BACKEND/uploads}"
case "$UPLOADS" in /*) ;; *) UPLOADS="$BACKEND/${UPLOADS#./}" ;; esac
