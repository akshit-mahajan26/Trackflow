#!/usr/bin/env bash
# Production-style start: build the UI if needed, migrate, serve UI + API on one port.
#   ./scripts/start.sh            (HOST=0.0.0.0 PORT=8000 by default — reachable from the LAN)
set -euo pipefail
. "$(dirname "$0")/_env.sh"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
if [ ! -f "$ROOT/frontend/dist/index.html" ] || [ -n "$(find "$ROOT/frontend/src" -newer "$ROOT/frontend/dist/index.html" -type f | head -1)" ]; then
  echo "Building frontend…"
  (cd "$ROOT/frontend" && npm run build)
fi
cd "$BACKEND"
echo "Applying database migrations…"
.venv/bin/alembic upgrade head
LAN_IP="$( (ipconfig getifaddr en0 || hostname -I | awk '{print $1}') 2>/dev/null || true)"
echo "TrackFlow: http://localhost:$PORT${LAN_IP:+  |  LAN: http://$LAN_IP:$PORT}"
# Single worker: real-time WebSocket fan-out is in-process (see docs/STATUS.md).
exec .venv/bin/uvicorn app.main:app --host "$HOST" --port "$PORT" --proxy-headers --workers 1
