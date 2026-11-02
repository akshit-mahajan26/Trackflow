# 01 — Architecture Overview

TrackFlow is a self-hosted, single-tenant issue tracker and Agile tool (a Jira alternative) for one internal team. It is a **modular monolith**:

- One FastAPI process serves the REST API, the WebSocket endpoint and the built React SPA, all on **one port** (default 8000).
- It is backed by one PostgreSQL database.

The target multi-tenant design lives in `docs/BLUEPRINT.md`. This build is the single-tenant edition; §7 of that file maps blueprint ↔ build.

## Repository layout

```
JIRA/
├── backend/                 FastAPI app (Python 3.12, venv at backend/.venv)
│   ├── app/
│   │   ├── main.py          app factory: lifespan, bootstrap admin, middleware, routers, SPA fallback
│   │   ├── models.py        ALL SQLAlchemy models (single file, by design)
│   │   ├── schemas.py       ALL Pydantic request/response models
│   │   ├── core/            config (env), database (engine/session), security (bcrypt+JWT), permissions (role matrix)
│   │   ├── api/             thin routers + deps.py (auth/permission guards) + serializers.py (bulk enrichment)
│   │   └── services/        business rules: issues, projects, sprints, reports, search, tql, dashboard,
│   │                        notifications, realtime, audit, settings, users
│   ├── alembic/versions/    migrations 0001 (schema), 0002 (one-active-sprint index)
│   ├── scripts/             seed.py (demo data via services), reset_db.py (guarded destructive reset)
│   └── tests/               pytest against a real Postgres DB (trackflow_test)
├── frontend/                React 19 + TS + Vite + Tailwind 4
│   ├── src/lib/             api client, types, auth/theme contexts, query hooks, realtime, formatting
│   ├── src/components/      ui kit, Layout (shell), IssueView, CreateIssueModal, charts, SprintDialogs
│   ├── src/pages/           one file per route (lazy loaded from App.tsx)
│   ├── src/test/            Vitest unit/component tests
│   └── e2e/                 Playwright specs (own DB: trackflow_e2e)
├── scripts/                 setup.sh, start.sh, backup.sh, restore.sh, _env.sh (shared env loader)
├── docs/                    BLUEPRINT.md (target design), STATUS.md (done / verified / known limits)
└── ai_guidelines/           these files
```

## Layering (backend)

```
HTTP / WS ──► api/<router>.py ──► api/deps.py (auth + permission guard)
                    │
                    ▼
              services/<domain>.py   ◄── all business rules, validation, history, notifications
                    │
                    ▼
              models.py (SQLAlchemy ORM) ──► PostgreSQL
                    │
   session "after_commit" hook ──► services/realtime.py ──► WebSocket clients
```

| Layer | Owns | Must not |
|---|---|---|
| `api/*` routers | Parsing input (Pydantic), calling deps guards, calling services, **committing**, audit logging, shaping output via `serializers.py` | Contain business rules beyond simple CRUD |
| `api/deps.py` | `get_current_user`, `require_admin`, `ensure()`, `can()`, `get_project_or_404`, `get_issue_or_404`, `accessible_project_ids` | — |
| `services/*` | Validation, hierarchy and workflow rules, history (`record`), notifications, ranking, reports, TQL | Commit (except `seed.py`); they `flush()` only |
| `core/permissions.py` | Single source of truth for which role can do which `Action` | — |
| `models.py` | Schema, constraints, indexes | Contain behaviour |

## Frontend architecture

- **Server state:** TanStack Query. Query keys are by domain (`["issues", …]`, `["board", key, qs]`, `["backlog", …]`, `["issue", key]`, `["project", key]`, `["sprints", …]`, `["dashboard", …]`, `["reports", …]`). After writes, call `useInvalidateIssues()` (in `lib/queries.ts`); it invalidates every view that shows issues.
- **Real-time:** `lib/realtime.ts` opens `/ws?token=…`. Server events only **invalidate** queries; the UI always refetches from the API and never trusts event payloads as data.
- **Auth:** the JWT lives in `localStorage` (`lib/api.ts`). A 401 triggers a global logout through `setUnauthorizedHandler`.
- **Routing:** `App.tsx` defines the routes; every authenticated route sits inside `Layout` (sidebar + top bar + quick-create + notifications).
- **Styling:** Tailwind 4 with semantic tokens defined as CSS variables in `index.css` (`bg-surface`, `text-muted`, `bg-primary`, `--series-1..8` for charts). Dark mode is the `.dark` class on `<html>`.

## Key domain concepts

- **Project:** has `key` (e.g. `WEB`), `board_type` (`scrum` | `kanban`), members with roles, and `settings` (JSONB: `enforce_transitions`, `kanban_done_days`).
- **WorkflowStatus:** a per-project status that is also a board column. Its `category` (`todo` / `in_progress` / `done`) drives resolution and all reports.
- **Issue hierarchy:** `epic` → `story` / `task` / `bug` / `improvement` → `subtask`, using `parent_id`.
- **Sprint:** states are `future` → `active` → `closed`. At most one active sprint per project, guaranteed by a DB partial unique index. Committed and completed snapshots are stored on the sprint row.
- **IssueHistory:** the append-only field changelog. It powers the activity feeds **and** every time-based report.
- **Roles:** a global `is_admin` flag, plus a per-project `ProjectMember.role` (`project_manager`, `scrum_master`, `developer`, `reporter`, `viewer`).

## Runtime topology

- **Single uvicorn worker.** WebSocket fan-out is in-process (`ConnectionManager`). More workers would need the Redis pub/sub bridge described in BLUEPRINT §5.
- **Local dev DB:** Homebrew Postgres 17 on **port 5434** (not 5432), role `trackflow`. Databases:

  | Database | Used by |
  |---|---|
  | `trackflow` | dev data |
  | `trackflow_test` | pytest |
  | `trackflow_e2e` | Playwright |

- **Attachments:** stored on disk in `UPLOAD_DIR` (default `backend/uploads`) under random names. Metadata lives in the `attachments` table.
