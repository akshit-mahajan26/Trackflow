"""Drop and recreate the schema of the configured database, migrate, create the admin and seed demo data.

DESTRUCTIVE. Used by the E2E test server; refuses to run unless DATABASE_URL names a *_e2e or *_test database
(or --i-know-this-deletes-everything is passed).
"""

import argparse
import os
import sys

from alembic import command
from alembic.config import Config
from sqlalchemy import text

from app.core.config import get_settings
from app.core.database import engine

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--i-know-this-deletes-everything", action="store_true", dest="force")
    ap.add_argument("--no-seed", action="store_true")
    args = ap.parse_args()
    db_name = get_settings().database_url.rsplit("/", 1)[-1]
    if not (db_name.endswith("_e2e") or db_name.endswith("_test") or args.force):
        sys.exit(f"Refusing to reset database '{db_name}'.")
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"))
    cfg = Config(os.path.join(BACKEND, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(BACKEND, "alembic"))
    command.upgrade(cfg, "head")
    from app.main import bootstrap_admin
    bootstrap_admin()
    if not args.no_seed:
        from scripts.seed import main as seed
        seed(force=False)
    print(f"Database '{db_name}' reset.")
