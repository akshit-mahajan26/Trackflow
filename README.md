# TrackFlow

TrackFlow is a self-hosted, multi-user project management and issue tracker for software teams. It runs on your own machine or an internal server and needs no paid services.

- **Projects:** each project has members, roles, a lead, dates and a priority.
- **Issues:** Epics → Stories, Tasks, Bugs and Improvements → Subtasks. Issues support comments, @mentions, attachments, links and dependencies, watchers, labels, custom fields and a full change history.
- **Agile:** a backlog with drag-and-drop ranking, sprint planning (start and complete sprints, with carry-over), Scrum and Kanban boards, WIP limits, swimlanes and configurable workflows.
- **Reporting:** dashboards, burndown, burnup, velocity, cumulative flow, resolution time and project completion with a forecast. Every report is calculated from recorded history and can be exported to CSV.
- **Search:** global search, structured filters, **TQL** (a JQL-style query language), saved and shared filters, a calendar and a timeline.
- **Administration:** users and role-based access control, workspace settings, an audit log, system health, and backup and restore.

Changes made by teammates appear live (via WebSockets), and the UI supports light and dark themes.

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4, TanStack Query, dnd-kit, Recharts |
| Backend | Python 3.12, FastAPI, SQLAlchemy 2, Alembic, Pydantic 2, JWT auth (bcrypt) |
| Database | PostgreSQL 15+ |
| Tests | Pytest (API, permissions, concurrency, reports, TQL), Vitest, Playwright end-to-end tests |

Architecture and design rationale: [docs/BLUEPRINT.md](docs/BLUEPRINT.md) · What is done and verified: [docs/STATUS.md](docs/STATUS.md)

---

## 1. Install

You need **Python 3.12+**, **Node.js 20+** and **PostgreSQL 15+**.

### 1.1 Create the database

```bash
psql -d postgres -c "CREATE ROLE trackflow LOGIN PASSWORD 'choose-a-strong-password';"
createdb -O trackflow trackflow
```

### 1.2 Run setup

```bash
./scripts/setup.sh
```

This script:
1. Creates `backend/.venv` and installs the Python packages.
2. Creates `backend/.env` from `.env.example` with a random `SECRET_KEY`.
3. Runs the database migrations.
4. Installs and builds the frontend.

**Edit `backend/.env` before the first start:**

```ini
DATABASE_URL=postgresql+psycopg://trackflow:choose-a-strong-password@localhost:5432/trackflow
SECRET_KEY=<generated>                 # keep it secret; changing it logs everyone out
BOOTSTRAP_ADMIN_EMAIL=admin@yourcompany.local
BOOTSTRAP_ADMIN_PASSWORD=<initial admin password>
```

### 1.3 Configuration reference

All settings can be set in `backend/.env` or as environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | local dev URL | Database address. Accepts the forms providers hand out (`postgres://…`, `postgresql://…`) as well as `postgresql+psycopg://…`; query options such as `?sslmode=require` are kept |
| `SECRET_KEY` | *(must set)* | Signs login tokens. The server refuses to start with the default value when `ENVIRONMENT=production` |
| `ENVIRONMENT` | `development` | `production` enables the secret-key check |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `720` | Session length |
| `UPLOAD_DIR` | `backend/uploads` | Where attachments are stored on disk |
| `MAX_UPLOAD_MB` | `25` | Maximum size of one attachment |
| `ALLOWED_UPLOAD_EXTENSIONS` | images, pdf, office, text, archives | Extension allow-list for uploads |
| `CORS_ORIGINS` | Vite dev server | Only needed when the UI is served from a different origin |
| `BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` | `admin@trackflow.local` / `admin12345` | First administrator, created only when the database has no users |

---

## 2. Start

```bash
./scripts/start.sh
```

This builds the UI if its sources changed, applies migrations, and serves the **UI and API on one port**: `0.0.0.0:8000`. The command prints both the local URL and the LAN URL.

- **Health check:** `GET /api/health` returns database status and the migration revision.
- **API docs:** `/api/docs` (OpenAPI).

To run it as a service, point systemd, launchd or pm2 at `scripts/start.sh`. Example `/etc/systemd/system/trackflow.service`:

```ini
[Unit]
Description=TrackFlow
After=network.target postgresql.service

[Service]
User=trackflow
WorkingDirectory=/opt/trackflow
ExecStart=/opt/trackflow/scripts/start.sh
Restart=always

[Install]
WantedBy=multi-user.target
```

### Docker (alternative)

```bash
cat > .env <<EOF
POSTGRES_PASSWORD=change-me
SECRET_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
BOOTSTRAP_ADMIN_PASSWORD=change-me-too
EOF
docker compose up -d --build
```

> The Docker files are provided but were **not build-tested** in the development environment, because the Docker daemon was not running. The native setup above is the verified path.

---

## 3. First login and users

1. Open the app and log in as the bootstrap admin (`admin` or the configured email).
2. **Change that password immediately** under *Profile → Change password*.
3. Create accounts under **Administration → Users → Create user**. Share the initial password with each person and ask them to change it.
   - To let people sign themselves up instead, turn on **Administration → Settings → Allow self-registration**. Anyone who can reach the server can then create an account, so only enable this on a trusted network.
4. Create a project (**Projects → New project**). You become its Project Manager. Then add members under **Project settings → Members & roles**.

### When someone leaves or is away

| Situation | Action | Effect |
|---|---|---|
| Moves off one project | Project **Settings → Members & roles** → trash icon | Loses access to that project only |
| Temporary absence | **Administration → Users → Deactivate** | Cannot log in; fully reversible with **Reactivate** |
| Leaves the company | **Administration → Users → Delete…** (type their username to confirm) | Details below |

Deleting someone who has left:
- Removes the account and ends every active session immediately.
- Takes them out of all projects and user lists.
- Unassigns their open issues.
- Keeps their comments, attachments and history, labelled **"Former user"**. Their name is also removed from past assignee changes and from notification text.
- Records the deletion in the audit log (who deleted which account, and when).

Before deleting someone who is a project's only Project Manager, make someone else Project Manager of that project.

### Roles

Roles are enforced by the server on every request, not just hidden in the UI.

| Role | Can do |
|---|---|
| **Administrator** (global) | Everything, in every project; manage users, settings, audit log |
| **Project Manager** | Everything in the project, including members, settings, archive and delete |
| **Scrum Master** | Manage sprints, workflow, custom fields, all issues |
| **Developer** | Create, edit and transition any issue; rank the backlog; comment; attach |
| **Reporter** | Create issues, comment and attach; edit only their own issues |
| **Viewer** | Read-only |

People who are not members of a project cannot see it: it returns 404, and it never appears in search, dashboards or real-time events.

### Demo data (optional)

```bash
cd backend && .venv/bin/python -m scripts.seed
```

The seeder creates two projects (WEB uses Scrum, with two sprints of real history; OPS uses Kanban) and seven users (`priya`, `marco`, `lena`, `sam`, `ken`, `ana`, `omar`). All demo users have the password `demo12345`. The data is created through the same services the API uses. The seeder refuses to run if projects already exist, unless you pass `--force`.

---

## 4. Access from your internal network

1. `start.sh` binds to `0.0.0.0:8000`. Teammates open `http://<server-LAN-IP>:8000`.
2. Allow inbound TCP 8000 in the host firewall:
   - macOS: *System Settings → Network → Firewall → Options*, allow `python3`.
   - Linux: `sudo ufw allow 8000/tcp`.
3. Give the server a fixed IP (a DHCP reservation) or a local DNS name.
4. Optional, but recommended for anything beyond a trusted LAN: put **Caddy** or **nginx** in front for HTTPS. Forward `/` and `/ws` to `127.0.0.1:8000` and enable WebSocket upgrades. Example Caddyfile:

   ```
   trackflow.internal {
     tls internal
     reverse_proxy 127.0.0.1:8000
   }
   ```

Run a **single** uvicorn worker. Real-time updates are fanned out in-process; see `docs/STATUS.md` for how to scale beyond that.

---

## 5. Backup and restore

> **Cloud databases (Aiven, etc.):** `pg_dump` must be the same major version as the server or newer. For a PostgreSQL 18 server, install the current client tools (`brew install libpq`, then put `$(brew --prefix libpq)/bin` first on your `PATH`). Managed providers also take their own automatic backups; check your plan.

```bash
./scripts/backup.sh                  # → backups/trackflow-YYYYmmdd-HHMMSS.tar.gz (keeps the 30 newest)
./scripts/restore.sh backups/trackflow-20261102-120347.tar.gz
```

- **What a backup contains:** a `pg_dump` (custom format) of the database, every attachment, and a manifest recording the migration revision.
- **What restore does:** it **replaces** all current data. It asks you to type the database name to confirm, then applies any newer migrations afterwards. Stop the server before restoring.
- **Nightly backups:** schedule them with cron and copy the `backups/` folder to another machine.

  ```
  0 2 * * * /opt/trackflow/scripts/backup.sh >> /var/log/trackflow-backup.log 2>&1
  ```

---

## 6. Development

```bash
# API with auto-reload (port 8000)
cd backend && .venv/bin/uvicorn app.main:app --reload
# UI with hot reload (port 5173; proxies /api and /ws to :8000)
cd frontend && npm run dev
```

- **Schema change:** edit `backend/app/models.py`, then run `.venv/bin/alembic revision --autogenerate -m "describe change"`. Review the generated file, then run `alembic upgrade head`.

### Tests

Run these from the `backend/` and `frontend/` folders respectively.

| Command | What it covers |
|---|---|
| `.venv/bin/python -m pytest -q` | API, auth, role matrix, workflow rules, history, reports from history, TQL, concurrency (parallel creates, edits, sprint starts), WebSockets |
| `npm test` | Drag-and-drop placement logic, filter serialisation, formatting, UI components |
| `npm run test:e2e` | Browser workflows (login, create/edit, board drag, comments, roles, TQL/export/saved filters, sprints, theme) |

The backend tests use the `trackflow_test` database. The end-to-end tests use `trackflow_e2e`, which is wiped and reseeded on every run.

### TQL quick reference

```
assignee = currentUser() AND statusCategory != done ORDER BY priority DESC
project = WEB AND sprint IN openSprints() AND type IN (bug, task)
labels = payments AND due < "-1d"          # overdue by more than a day
epic = WEB-2 AND storyPoints >= 5
summary ~ "checkout" OR text ~ "timeout"
```

| Element | Supported values |
|---|---|
| Fields | project, type, status, statusCategory, priority, assignee, reporter, sprint, labels, epic, parent, key, summary, description, text, storyPoints, due, start, created, updated, resolved |
| Functions | `currentUser()`, `activeSprint()`, `openSprints()`, `futureSprints()`, `closedSprints()`, `now()`, `startOfDay(n)`, `startOfWeek(n)`, `startOfMonth(n)` |
| Operators | `= != > >= < <= IN, NOT IN, IS [NOT] EMPTY, ~ !~, AND OR NOT, ( ), ORDER BY` |
