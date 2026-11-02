# 05 — Operational Decisions

Decisions about how TrackFlow is run, secured and maintained, with the reasoning behind each. Don't reverse one without understanding why it was made, and record any change here and in `docs/STATUS.md`.

## Deployment model

| Decision | Reason | Revisit when |
|---|---|---|
| **One port serves UI + API + WebSocket** (`main.py` mounts `frontend/dist` with an SPA fallback) | The simplest LAN deployment: no CORS, no reverse proxy required | You put a CDN or separate static host in front |
| **Single uvicorn worker** (`start.sh` passes `--workers 1`) | WebSocket fan-out is in-process (`ConnectionManager`); a second worker wouldn't see the first one's events | The team outgrows one process. Then implement the Redis pub/sub bridge in `realtime.publish` (Redis is installed locally; see BLUEPRINT §5) |
| **Sync SQLAlchemy in FastAPI's threadpool** | Simple, correct transactional code; enough for a team-sized install | Profiling shows threadpool saturation |
| **Native scripts are the supported path**; Docker files are provided but were **not build-tested** | The Docker daemon was unavailable during development | Someone builds and runs `docker compose up`. Then mark it verified in STATUS.md |
| **`start.sh` rebuilds the UI only if `frontend/src` is newer than `dist`**, then runs `alembic upgrade head` | A restart is always enough to deploy new code and migrations | — |

## Environments and databases

- Configuration is env-only via `pydantic-settings` (`core/config.py`), read from `backend/.env` or the process environment. Real environment variables override `.env`.
- Local Postgres runs on **port 5434** (Homebrew `postgresql@17`), role `trackflow`, password `trackflow_dev_pw`. These are dev credentials only.
- Databases:

  | Database | Owner | Lifecycle |
  |---|---|---|
  | `trackflow` | dev / demo | Persistent; seeded with `scripts.seed` |
  | `trackflow_test` | pytest | Schema dropped and migrated at session start, truncated after each test |
  | `trackflow_e2e` | Playwright | Dropped, migrated and seeded on every E2E run |

- `scripts/reset_db.py` **refuses** any database not named `*_test` or `*_e2e` unless `--i-know-this-deletes-everything` is passed. Keep that guard. Never point the test suites at `trackflow`.
- With `ENVIRONMENT=production`, startup refuses the default `SECRET_KEY`.

## Identity and access

- **Accounts are admin-created by default.** Self-registration is an admin setting (`allow_registration`), off by default, because anyone on the network could otherwise sign up.
- **Bootstrap admin:** created only when the `users` table is empty, from `BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` (username `admin`). The first login should change the password.
- **JWT access tokens** (HS256, 12 h by default) carry `sub` (user id) and `tv` (token version). Every request reloads the user and compares `tv` with `users.token_version`. A password change, an admin password reset or deactivation bumps `token_version`, which **revokes all of that user's sessions immediately**. There are no refresh tokens.
- **Tokens live in `localStorage`.** Accepted for an internal SPA because React escapes all output and there is no `dangerouslySetInnerHTML`. Hardening option: an httpOnly cookie plus CSRF protection.
- **Authorization is server-side only.** `core/permissions.py` maps each role to a set of `Action`s; routers guard with `ensure()` / `get_*_or_404`. The UI hides controls using `project.permissions` from `GET /projects/{key}`, purely for UX.
- **Non-members get 404** for project resources, so a project's existence isn't revealed. Search, dashboards, saved filters and WebSocket events are all scoped by `accessible_project_ids`.
- **Every project keeps at least one Project Manager.** `_guard_last_manager` blocks demoting or removing the last one; user deletion is refused while the user is a sole PM.

## People leaving: deactivate vs delete

| Action | Endpoint | Effect | Reversible |
|---|---|---|---|
| Remove from project | `DELETE /projects/{key}/members/{id}` | Loses access to that project; their issues stay assigned | Re-add them |
| Deactivate | `PATCH /users/{id} {"is_active": false}` | Cannot log in; sessions revoked; hidden from pickers and the Team page | Yes |
| **Delete** (person left the company) | `DELETE /users/{id}?confirm=<username>` → `services/users.py::delete_user` | Account and memberships removed; open issues unassigned; name scrubbed from assignee history and notification text; work kept as "Former user"; audit entry written | **No** |

The audit log deliberately keeps the deleted username and the acting admin, for accountability. Free text typed by others (e.g. an @mention in a comment body) is not rewritten.

## Data protection

- **Uploads** use an extension allow-list (`ALLOWED_UPLOAD_EXTENSIONS`) and a size cap (`MAX_UPLOAD_MB`, streamed in 1 MB chunks). Files are stored under a random `secrets.token_hex` name, so the client's filename is never used on disk; the original name is kept only as metadata. Files are served with `Content-Disposition: attachment` and `nosniff`; only non-SVG images may be served inline.
- **No raw SQL with user input.** TQL compiles to SQLAlchemy expressions over a field whitelist with bound parameters, and LIKE wildcards are escaped. See 06 for the gotchas.
- **Destructive operations need typed confirmation:** project delete (`confirm_key`), user delete (`confirm`), restore (type the DB name, or `--yes`).
- **Security headers:** `X-Content-Type-Options`, `X-Frame-Options: DENY` and `Referrer-Policy` are added by middleware.

## Audit and history

- **`audit_logs`** records admin and security events: login success and failure, user create/update/delete, project create/update/delete, member changes, workflow and field changes, sprint start/complete, issue delete, CSV export, settings changes.
- **`issue_history`** records every issue field change (the "who changed what" for normal work).
- Keep the two separate: don't put routine issue edits into the audit log, and don't put admin actions into issue history.

## Backup and restore

- `scripts/backup.sh` → `backups/trackflow-<timestamp>.tar.gz` containing `pg_dump -Fc`, the full uploads directory and a `MANIFEST` with the migration revision. It keeps the newest 30. Schedule it nightly with cron and copy the folder off the machine.
- `scripts/restore.sh <archive>` **replaces** everything:
  1. Drops the schema.
  2. Runs `pg_restore`.
  3. Replaces the uploads.
  4. Runs `alembic upgrade head`, so older backups are brought forward.

  Stop the server first.
- A round trip was verified: a backup of `trackflow` restored into `trackflow_e2e` with identical counts and revision. Re-verify after any schema change that affects the dump.

## Network access

- `start.sh` binds `0.0.0.0:8000` and prints the LAN URL. Teammates use `http://<server-ip>:8000`.
- On macOS, allow incoming connections for Python in the firewall; on Linux, `ufw allow 8000/tcp`.
- For anything beyond a trusted LAN: put Caddy or nginx in front for HTTPS (forward `/` and `/ws` with WebSocket upgrade) and add login rate limiting at the proxy. The app does not throttle logins itself.

## Known limitations

Kept current in `docs/STATUS.md`:
- No email delivery.
- No login rate limiting.
- Plain-text descriptions.
- Float ranks (LexoRank is specified, not wired in).
- Touch drag-and-drop untested.
- Docker unverified.
- Not implemented: multi-tenancy, webhooks, components/versions, worklogs, workflow validators/post-functions.
