# CLAUDE.md

TrackFlow: a self-hosted, single-tenant Jira alternative for one internal team. FastAPI + SQLAlchemy 2 + PostgreSQL backend; React 19 + TypeScript + Vite + Tailwind 4 frontend. Both are served from one port.

Read the relevant guideline **before** changing code in that area:

| File | Read when |
|---|---|
| `ai_guidelines/01-architecture-overview.md` | Orienting yourself: layout, layers, domain concepts |
| `ai_guidelines/02-main-request-flow.md` | Adding or changing any endpoint, mutation or realtime behaviour |
| `ai_guidelines/03-test-and-verification-pipeline.md` | Writing tests; before saying anything is done |
| `ai_guidelines/04-data-and-schemas.md` | Touching models, migrations, schemas, `types.ts`, history or reports |
| `ai_guidelines/05-operational-decisions.md` | Deployment, auth, permissions, user offboarding, backups, environments |
| `ai_guidelines/06-conventions-and-gotchas.md` | **Always.** Real bugs this codebase has already had |
| `ai_guidelines/07-python-guidelines.md` | Writing any backend Python |

Also: `docs/BLUEPRINT.md` (target multi-tenant design), `docs/STATUS.md` (what is done, verified and limited), `README.md` (operator guide).

## Commands

```bash
# Backend (from backend/, always via the venv)
.venv/bin/python -m pytest -q                      # full suite, real Postgres (trackflow_test), ~2 min
.venv/bin/python -m pytest -q tests/test_issues.py -k rank
.venv/bin/alembic revision --autogenerate -m "msg" --rev-id 0003   # then READ the file
.venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --reload            # API on :8000
.venv/bin/python -m scripts.seed                   # demo data (refuses if projects exist)

# Frontend (from frontend/)
npm run dev          # :5173, proxies /api and /ws to :8000
npx tsc -b           # strict typecheck
npm test             # Vitest
npm run test:e2e     # Playwright: builds, resets+seeds trackflow_e2e, serves on :8011

# Whole app (from repo root)
./scripts/start.sh   # build UI if stale, migrate, serve on 0.0.0.0:8000 (single worker)
./scripts/backup.sh  # DB + uploads → backups/*.tar.gz
```

## Environment facts

- **Postgres runs on port 5434** (Homebrew `postgresql@17`), role `trackflow` / `trackflow_dev_pw`. There is no `postgres` database; use `template1` for admin SQL.
- Databases:

  | Database | Used for | Notes |
  |---|---|---|
  | `trackflow` | dev data | **don't wipe** |
  | `trackflow_test` | pytest | |
  | `trackflow_e2e` | Playwright | |

- Config comes from `backend/.env` (template: `.env.example`).
- Demo logins: `admin` / `admin12345`; `priya`, `marco`, `lena`, `sam`, `ken`, `ana`, `omar` / `demo12345`.
- The running server doesn't auto-reload. Restart it after backend changes, and rebuild the UI after frontend changes (`start.sh` does both).

## Non-negotiable rules

1. **Layers:** routers are thin and **commit**; services hold the business rules and only `flush()`; all permissions go through `core/permissions.py` `Action`s via `ensure()` / `can()` / `get_*_or_404`. The UI hiding a button is not authorization.
2. **Non-members get 404**, members lacking a permission get 403. Scope every list, search and event by `accessible_project_ids`.
3. **Issue changes go through `services/issues.update_issue` / `record()`.** Any change to status, sprint or story points without an `IssueHistory` row corrupts the reports.
4. **Realtime only via `queue_event()`.** It publishes after commit. Clients only invalidate queries on events.
5. **Locks:** `with_for_update()` must be paired with `.execution_options(populate_existing=True)`. Sessions don't autoflush: `flush()` after `add()` if a later query in the same request must see the row. Timestamps compared against history must use the DB transaction clock (`sprints.tx_now`), never `datetime.now()`.
6. **No SQL built from user input**, and never concatenate TQL strings. Compile, then add `.where()`.
7. **Schema changes:** update `models.py`, add a new Alembic migration (never edit an applied one), and update `schemas.py` **and** `frontend/src/lib/types.ts` together.
8. **Frontend:** wrap form controls in `Field`; get chart colors from `useChartColors()`; every chart gets a table view; use `import type`; no enums. Optimistic mutations must snapshot, roll back on error, and invalidate.
9. **Destructive operations:** never `rm` with globs or variables; never run `reset_db.py` or `restore.sh` against `trackflow`; keep the typed confirmations on delete endpoints.
10. **Done means verified.** Run every relevant suite (and the full backend suite for backend changes). Add a regression test for every bug fixed. Record **actual** test counts and any unverified items in `docs/STATUS.md`. Never claim Docker works; it has not been build-tested.
