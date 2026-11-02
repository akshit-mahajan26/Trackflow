#!/usr/bin/env bash
# First-time setup on a machine with Python 3.12+, Node 20+ and PostgreSQL 15+ available.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/backend"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
if [ ! -f .env ]; then
  cp .env.example .env
  KEY="$(.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(48))')"
  sed -i.bak "s|^SECRET_KEY=.*|SECRET_KEY=$KEY|" .env && rm -f .env.bak
  echo "Created backend/.env — review DATABASE_URL and BOOTSTRAP_ADMIN_PASSWORD."
fi
.venv/bin/alembic upgrade head
cd "$ROOT/frontend"
npm ci
npm run build
echo "Setup complete. Run ./scripts/start.sh"
