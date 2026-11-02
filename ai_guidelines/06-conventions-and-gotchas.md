# 06 — Conventions and Gotchas

Every gotcha below caused a real bug during development, and each fix has a regression test. Read this before touching sessions, timestamps, ranking, TQL, the board or the UI kit.

## Backend gotchas

### 1. `SELECT … FOR UPDATE` can return a stale cached object
The SQLAlchemy identity map returns an already-loaded instance **without refreshing it**, even though the row lock is acquired. Two concurrent issue creations then read the same `issue_seq` and produce duplicate keys.

```python
# WRONG
project = db.scalar(select(Project).where(Project.id == pid).with_for_update())
# RIGHT
project = db.scalar(select(Project).where(Project.id == pid).with_for_update()
                    .execution_options(populate_existing=True))
```

Applies to every lock-then-read (`issues._next_number`, `sprints.start_sprint`). Test: `test_concurrent_issue_creation_yields_unique_gapless_keys`.

### 2. Sessions have `autoflush=False`
A query does not see objects you `db.add()`-ed earlier in the same request. An "exists?" check followed by `add` twice in one request (reporter == assignee) inserted duplicate watchers → 500. Fix: `db.flush()` after `add` when a later query in the same request must see the row (see `notifications.add_watcher`). Test: `test_self_assigned_issue_creation`.

### 3. Optimistic-lock conflicts surface at **flush**, not commit
`Issue.version` is a `version_id_col`. A lost race raises `StaleDataError` during `flush()`, which can happen inside a service. It is mapped to **409** by:
- the global `@app.exception_handler(StaleDataError)` in `main.py`, and
- `_commit()` in `api/issues.py`.

Don't catch and swallow it in services. Test: `test_concurrent_edits_one_wins_other_gets_conflict`.

### 4. One clock per transaction
`server_default=func.now()` stamps rows with the **transaction start time**. Python `datetime.now()` is later. Mixing them broke the burndown on sprint-completion day: the carry-over history rows appeared to happen *before* `completed_at`.
- Anything compared against `issue_history.created_at` must use `sprints.tx_now(db)` (`SELECT now()`).
- In `scripts/seed.py`, the phase marker uses `SELECT now()`, **not** `clock_timestamp()`.

Test: `test_completion_day_counts_scope_before_carry_over`.

### 5. Every change to status / sprint / points must write history
Reports reconstruct the past from `issue_history` (see 04). A bulk SQL `UPDATE issues SET status_id = …` without matching history rows silently corrupts burndown and CFD. Use `update_issue()` / `record()`, or write `IssueHistory` rows yourself (as `delete_status` and `complete_sprint` do).

### 6. Publish realtime events only through `queue_event`
Never call `manager.publish()` from a request. `queue_event` defers publishing to `after_commit`, and `after_rollback` drops the events. Publishing directly can announce a write that later rolls back.

### 7. Don't build TQL by string concatenation
Scoping a user query by wrapping it (`project = X AND (<user tql>)`) breaks on `ORDER BY` and is injection-shaped. Apply extra constraints to the compiled `Select` instead. `api/issues.py::_query` applies `project_ids` with `.where()` after `compile_tql`. New TQL fields go in the `Compiler.clause` whitelist with bound values only. Test: `test_tql_end_to_end` (the ORDER BY scope assertions).

### 8. Statuses are referenced with RESTRICT
You can't delete a status (or a project) while issues point at it. Use `services/projects.delete_status(..., fallback_id, actor)`, which migrates issues and writes history. Project deletion deletes issues first.

### 9. Permissions live in exactly one place
Add new capabilities as an `Action` in `core/permissions.py`, grant them to roles in `ROLE_PERMISSIONS`, and check them with `ensure()` / `can()`. Don't sprinkle `if member.role == "developer"` checks around the code. The frontend reads the resulting list from `project.permissions`.

### 10. Non-members get 404, members without permission get 403
`get_project_or_404` / `ensure(..., Action.VIEW_PROJECT)` already do this. Keep it consistent in new endpoints, and test both cases.

### 11. Priority ordering is inverted between APIs
In `services/search.py`, `SORTS["priority"]` is the ordinal with `highest = 1` (so ascending puts the most urgent first, as the Issues table expects). TQL follows Jira semantics, where `ORDER BY priority DESC` puts the most urgent first, so `tql.py` negates the ordinal. Don't "fix" one to match the other.

## Frontend gotchas

### 12. `Field` must wrap its control
`<Field label="…">` renders a wrapping `<label>`, which associates the text with the input for screen readers, click-to-focus and Playwright's `getByLabel`. Don't change it back to a sibling `<label>`. Raw inputs outside `Field` need `aria-label`. Don't set an `aria-label` on a heading that differs from its visible text: it replaces the accessible name.

### 13. Effects must not depend on inline callback props
Parents pass `onClose={() => setX(null)}`, a new function on every render. `Modal` once had `useEffect(..., [open, onClose])`, which re-ran the "focus first element" step on every keystroke and moved focus to the ✕ button. Hold such callbacks in a ref (`onCloseRef.current = onClose`) and key effects on real state (`[open]`). The same applies to any new hook that takes a callback prop. Tests: `Modal focus` in `src/test/components.test.tsx` and the per-key typing E2E.

### 13b. Width classes on inputs
`Input`, `Select` and `Textarea` default to `w-full` **unless** you pass a `w-*` / `max-w-*` class (see the `width()` helper in `ui.tsx`). Two width classes conflict unpredictably in Tailwind, so use the prop pattern rather than adding `!important`.

### 14. Charts need resolved colors, not `var(--x)`
SVG presentation attributes in Recharts don't reliably resolve CSS variables. Use `useChartColors()` from `components/charts.tsx`, which reads the computed `--series-N`, grid, axis and surface values and re-resolves on theme change. Chart color rules (validated palette, fixed slot order, never cycle colors past 8):
- fold extra series into "Other";
- a legend for two or more series;
- a table view on every chart (`ChartCard`).

### 15. Optimistic updates must snapshot and roll back
Board and backlog moves use the `onMutate` → `setQueryData` → `onError` restore → `onSettled` invalidate pattern. Keep all four steps. The server may reject a move (workflow enforcement, permissions), and the UI must snap back.

### 16. Lists keep previous data while refetching
`IssuesPage` uses `placeholderData: keepPreviousData`. In tests, and in any logic that reads the rendered rows, wait for the new result; don't assume the DOM updated synchronously after a filter change.

### 17. Realtime events only invalidate
Never write event payloads into the cache. Invalidate the matching query keys and let the API be the source of truth. Ignore events whose `actor_id` is the current user, except `sprint_changed`.

### 18. TypeScript is strict
`verbatimModuleSyntax` means type-only imports must use `import type`. `erasableSyntaxOnly` means no `enum`s and no parameter properties; use union types and `as const`. `noUnusedLocals` / `noUnusedParameters` fail the build.

## Ops gotchas

- **`backend/.env` may point at a real or cloud database** (it currently points at an Aiven PostgreSQL 18 instance). Anything destructive (tests, `reset_db.py`, `restore.sh`) must target an explicitly named `*_test` or `*_e2e` database. Providers' `postgres://` URLs are normalised in `core/config.py`.
- **Client-tool versions:** `pg_dump` / `pg_restore` must be ≥ the server's major version. The local Homebrew tools are 17; a PostgreSQL 18 server needs `libpq` 18+.

- **Postgres listens on 5434**, not 5432. `pg_isready` with no arguments reports "no response"; use `-p 5434`.
- **The default `postgres` database doesn't exist** on this machine. Connect to `template1` for admin SQL.
- **The server must be restarted to pick up backend changes** (`start.sh` runs no `--reload`). Frontend changes need `npm run build` (or run `start.sh`, which rebuilds when sources are newer).
- **`npm` blocks install scripts** by policy. Only `fsevents` is pending, and it is optional, so leave it.
- **Destructive commands:** never `rm` with globs or variables; delete specific known paths. Never run `reset_db.py` or `restore.sh` against `trackflow` unless that is explicitly the goal.

## Naming and style conventions

| Thing | Convention |
|---|---|
| Issue / project refs in URLs | Accept id **or** key (`/issues/WEB-12`, `/projects/WEB`). Keys are uppercase |
| Router function names | Verb + noun (`add_member`, `remove_status`, `complete_sprint`) |
| Services | Plain functions taking `(db, actor, entity, …)`; raise `HTTPException` with user-facing messages |
| Error messages | Full sentences that say what to do ("Make someone else Project Manager there first.") |
| History field names | `status`, `assignee`, `sprint`, `parent` (mapped from `*_id` by `FIELD_NAMES`); other fields keep their column name |
| Audit actions | `domain.verb` (`user.delete`, `project.member_add`, `sprint.start`, `auth.login_failed`) |
| Query keys (frontend) | `[domain, …params]`; the first segment must match what `useInvalidateIssues` / `realtime.ts` invalidate |
| Frontend files | `pages/` = routes (default export); `components/` = reusable (named exports); `lib/` = non-UI logic |
| Tests | `test_<behaviour>` describing the rule, not the function |
