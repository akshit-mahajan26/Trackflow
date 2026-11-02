# TrackFlow — Implementation Status

Last updated: 2026-11-02. "Verified" means covered by an automated test that passed, or checked by hand in a browser, as noted.

## Test results (latest run)

| Suite | Result |
|---|---|
| Backend pytest (`backend/tests`) | **55 passed**: database URL formats, auth, user offboarding, role matrix, issues, hierarchy, workflow, custom fields, links, attachments, notifications, filters, bulk updates, CSV, agile, reports, TQL, concurrency, WebSockets, health |
| Frontend Vitest (`frontend/src/test`) | **18 passed** |
| Playwright E2E (`frontend/e2e`) | **11 passed**, run in Chromium against a freshly seeded `trackflow_e2e` database |
| TypeScript (`tsc -b`) | Clean |
| Manual browser pass | 14 screens checked in light and dark themes with no console errors; LAN access checked from the host's LAN IP |
| Backup → restore round trip | Dev DB backed up and restored into a scratch DB; counts of issues, history and users and the migration revision all matched |

## Completed and verified

- **Foundation**
  - PostgreSQL schema with constraints, indexes and a GIN index on labels; Alembic migrations 0001 and 0002.
  - Environment-based configuration; health endpoint.
  - The server serves the UI and API on one port.
- **Auth**
  - Login by username or email, using bcrypt and JWT.
  - Tokens are revoked on password change, admin password reset and deactivation (via `token_version`).
  - Optional self-registration (admin setting); every login, including failed ones, is written to the audit log.
- **Permissions**
  - Server-side role matrix: Admin, Project Manager, Scrum Master, Developer, Reporter, Viewer.
  - Non-members get 404. Search, dashboards and WebSocket events are scoped to the projects a user can access.
  - The last Project Manager of a project cannot be removed or demoted.
- **Projects**
  - Create, edit, archive and delete (deleting requires typing the key); members and roles.
- **Workflow**
  - Per-project statuses, which are also the board columns: categories, ordering and WIP limits.
  - Deleting a status migrates its issues to another status and records that in history.
  - An optional allowed-transition matrix, enforced by the server.
- **Issues**
  - Epic → Story/Task/Bug/Improvement → Subtask, with hierarchy rules enforced by the server.
  - Fields: description, labels, story points, estimate and time logged, start and due dates.
  - Custom fields with type validation and required flags.
  - Links (blocks, relates to, duplicates) with cycle detection for "blocks".
  - Attachments with an extension allow-list, a size limit and randomised file names on disk; served as downloads with `nosniff`.
  - Watchers; complete field-level history; optimistic locking (`version` → 409 Conflict).
  - Gapless per-project keys under concurrent creation, tested with 40 parallel creates.
- **Collaboration**
  - Comments with @mentions (only project members can be mentioned).
  - Notifications for assignment, status changes, comments and mentions; notification centre; live updates over WebSockets.
- **Agile**
  - Backlog with drag-and-drop ranking between sprints and the backlog.
  - Sprint create, edit, start (commitment snapshot) and complete (incomplete issues move to the backlog or a future sprint), plus delete.
  - At most one active sprint per project, guaranteed by a DB-level partial unique index.
  - Scrum and Kanban boards: drag-and-drop status changes and reordering, optimistic UI with rollback on error, WIP warnings, swimlanes (assignee, epic, priority), quick filters.
- **Reports** (all computed from `issue_history` and stored sprint snapshots)
  - Burndown and burnup, including mid-sprint scope changes.
  - Velocity, cumulative flow, resolution time (by type and priority, distribution, weekly).
  - Project completion with an epic breakdown and a throughput-based forecast.
  - Every report has a table view and a CSV export.
- **Dashboards**
  - Global and per-project: counts, created vs resolved, active sprints, distributions, workload, my issues, overdue, upcoming deadlines, recent activity.
- **Search**
  - Global search across issues, projects, epics, sprints and people.
  - Structured filters; the **TQL query language** (parser → AST → whitelisted SQL compiler, values always bound as parameters).
  - Saved and shared filters; bulk change with per-issue results; CSV export.
- **Views**
  - Calendar (by due date, quick-create on a day).
  - Timeline (epics and issues; issues without dates fall back to their sprint's window).
- **Administration**
  - Users (create, edit, reset password, deactivate, **delete departed users**: removes the account, memberships and name; work kept as "Former user"; refuses to remove a project's only PM); workspace settings (site name, registration, project creation).
  - Audit log with filters; system stats.
- **Operations**
  - `setup.sh`, `start.sh`, `backup.sh`, `restore.sh`; demo seeder that runs through the real services.
  - Guarded `reset_db.py`, which only acts on `*_e2e` and `*_test` databases.

## Defects found and fixed during verification

1. **Duplicate issue numbers under concurrent creation.** `SELECT … FOR UPDATE` returned a stale object cached in the session. Fixed with `populate_existing`; covered by a concurrency test.
2. **Concurrent edits returned 500 instead of 409.** The stale-data error was raised at flush time. Fixed with a global handler; tested.
3. **Self-assigned issue creation failed with 500** (duplicate watcher row). Fixed with an explicit flush; regression test added.
4. **Burndown on the completion day undercounted scope.** Sprint timestamps came from the app clock while history rows used the DB transaction clock. Both now use the transaction clock; regression test added.
5. **TQL with ORDER BY broke on project pages.** The query was being string-wrapped with a project clause. Project scope is now applied server-side; tested.
6. **Dialogs stole focus while typing.** An inline `onClose` re-ran the modal's focus effect on every keystroke, moving focus to the close button. Fixed: `onClose` is held in a ref, the effect runs only on open, and initial focus goes to the first body field (never ✕). Covered by a Vitest regression test and an E2E per-key typing test.
7. **Cloud database URLs were rejected.** Providers such as Aiven give `postgres://…`, which SQLAlchemy 2 no longer accepts. Settings now normalise `postgres://` and `postgresql://` to the psycopg driver; tested.
8. **The test suite could inherit a real `DATABASE_URL`.** `conftest.py` used `setdefault`, so a `DATABASE_URL` exported in the shell would have been wiped by the suite. Tests now use `TEST_DATABASE_URL` only and refuse any database not named `*_test`.
9. **Accessibility:** form labels were not associated with their inputs, and the issue summary heading had the wrong accessible name. Both fixed and covered by the E2E tests.

## Not verified / known limitations

- **Docker:** `Dockerfile` and `docker-compose.yml` are written but were **not built or run**, because the Docker daemon was unavailable. Use the native scripts, or build-test the containers before relying on them.
- **Single process for real-time updates:** WebSocket fan-out is in-process, so run one uvicorn worker. That comfortably serves a team-sized install. For more workers, replace `ConnectionManager.publish` with Redis pub/sub (see BLUEPRINT §5).
- **Tokens live in `localStorage`:** standard for an internal SPA, but an XSS bug could expose them. React escapes all rendered content and nothing uses `dangerouslySetInnerHTML`. Moving to an httpOnly cookie plus CSRF protection is a hardening option.
- **No email delivery:** notifications are in-app and real-time only. An SMTP digest would be a straightforward addition.
- **No login rate limiting:** failed logins are audited but not throttled. Add a reverse-proxy rate limit if the server is reachable beyond a trusted LAN.
- **Rich text:** descriptions and comments are plain text with @mention highlighting. There is no Markdown or WYSIWYG editor.
- **Rank column:** ranking uses a float midpoint with automatic rebalancing. LexoRank (BLUEPRINT §3.3) is specified and property-tested as a standalone algorithm but not wired into the schema.
- **Mobile:** layouts work at phone width (collapsible sidebar, scrollable boards). Drag-and-drop on touch devices was not tested.
- **Not implemented (in the blueprint only):** multi-tenancy, components and versions, worklog entries (only total time logged is tracked), webhooks, workflow validators and post-functions.

## Key technical decisions

| Decision | Why |
|---|---|
| Fresh build on the requested stack | The `JIRA/` folder was empty; there was nothing to reuse |
| Sync SQLAlchemy in FastAPI's threadpool | Simple and correct transactional code; enough throughput for a team install |
| String + CHECK constraints instead of PG enums | Adding a value is a one-line migration |
| JSONB for labels and custom field values | Single-row reads; GIN containment queries for filtering (see BLUEPRINT §1.6) |
| `issue_history` with display values plus ref ids | One table drives the activity feed, audit trail and every time-based report |
| Events queued on the session and published after commit | Clients never see rolled-back changes |
| One port for UI and API | Simplest LAN deployment, with no CORS or proxy needed |
