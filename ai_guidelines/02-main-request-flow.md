# 02 — Main Request Flow

How one mutating request travels through the system, end to end. Every new write endpoint should follow the same shape. The worked example is **"move a card on the board"** (`POST /api/issues/{key}/move`).

## 1. Browser

1. `pages/Board.tsx` → `onDragEnd` uses `resolveDrop()` (a pure, unit-tested function) to work out the target status and the neighbours `above_id` / `below_id` in the target column/lane.
2. `useMutation`:
   - `onMutate` cancels the board query, snapshots it, and **optimistically** rewrites the cached board.
   - `onError` restores the snapshot and shows a toast.
   - `onSettled` calls `useInvalidateIssues()(key)` so every issue view refetches.
3. `lib/api.ts` → `request()` adds `Authorization: Bearer <jwt>`, sends JSON and turns non-2xx responses into `ApiError(status, detail)`. A 401 on an authenticated request logs the user out globally.

## 2. API router (`api/issues.py`)

```python
@router.post("/{ref}/move", response_model=schemas.IssueDetail)
def move_issue(ref: str, body: schemas.IssueMove, db: DB, user: CurrentUser):
    issue = get_issue_or_404(db, user, ref)        # 404 if missing OR user can't view the project
    svc.move_issue(db, user, issue, **body.model_dump())
    _commit(db)                                   # maps StaleDataError → 409
    return issue_detail(db, issue, user)          # serializer builds the full detail DTO
```

Router rules:
- Load the entity with `get_issue_or_404` / `get_project_or_404(db, user, ref, Action.X)`. These resolve ids **or** keys (`WEB-12`, `WEB`) and enforce project visibility. Non-members get **404**, not 403, so the project's existence isn't leaked.
- The **router commits**. Services only `flush()`.
- Call `audit(...)` for administrative or security-relevant actions before committing. Normal issue edits are recorded in `IssueHistory` instead.

## 3. Service (`services/issues.py`)

`move_issue` → `update_issue(db, user, issue, changes)`:

1. **Concurrency check:** if the client sent `version` and it differs from `issue.version`, return 409. The model also has `version_id_col`, so a race between two flushes raises `StaleDataError`. That is mapped to 409 by `_commit()` and by the global handler in `main.py`.
2. **Permission:**
   - A status-only change needs `can_transition` (TRANSITION_ISSUE, or EDIT_OWN_ISSUE on your own issue).
   - Any other field needs `ensure_edit` (EDIT_ANY_ISSUE, or EDIT_OWN_ISSUE on your own issue).
   - Changing the sprint additionally needs RANK_BACKLOG or MANAGE_SPRINTS.
3. **Validation:** `_validate_assignee` (must be a non-viewer member), `_validate_parent` (hierarchy rules), `_validate_sprint` (same project, not closed), `_validate_status` + `check_transition` (workflow matrix when `settings.enforce_transitions`), `_validate_custom_fields`.
4. **Diff + history:** for each field in `TRACKED_FIELDS` that changed, `setattr` it and call `record()`. `record` writes an `IssueHistory` row with a human-readable `old_value`/`new_value` **and** machine refs (`old_ref`/`new_ref` = status, assignee, sprint or parent ids) that the reports use.
5. **Resolution:** entering a `done`-category status sets `resolved_at`; leaving it clears `resolved_at`.
6. **Watchers and notifications:** `add_watcher` for the new assignee; `notify(...)` writes `Notification` rows (never to the actor) and queues a per-user realtime event. @mentions in descriptions or comments go through `extract_mentions` (project members only).
7. **Realtime:** `queue_event(db, "issue_updated", project_id=…, …)` appends to `db.info["pending_events"]`.
8. **Rank:** `compute_rank(above_id, below_id)` gives a float midpoint. If the gap falls below 1e-6, `rebalance()` renumbers the project's ranks first.

## 4. Commit and fan-out (`services/realtime.py`)

- SQLAlchemy `after_commit` → `_flush_events` → `manager.publish(evt)`, scheduled onto the event loop with `run_coroutine_threadsafe`, because sync routes run in the threadpool.
- `after_rollback` drops the pending events, so clients never hear about writes that failed.
- **Event routing:**
  - Events with `user_id` go only to that user's sockets (notifications).
  - Events with `project_id` go to sockets whose access set includes that project (admins get everything).
  - When membership changes, call `manager.update_access(user_id, …)` (see `projects.py::_refresh_ws_access`).

## 5. Other browsers

`lib/realtime.ts` receives `{type, project_id, key, actor_id, …}`. Events caused by the same user are ignored (that user's mutation already invalidated). Everything else invalidates `issues`, `board`, `backlog`, `dashboard` and `["issue", key]`. TanStack Query refetches the views that are on screen.

## Read flows worth knowing

- **Lists and filters:** `GET /api/issues` → `_query()`. A `?tql=` parameter goes to `services/tql.py::compile_tql` (with optional `project_ids` scope applied *outside* the TQL). Anything else goes to `services/search.py::build_issue_query` (structured filters). Both return a `Select` that `run_issue_query` paginates. `serializers.issue_list` enriches in bulk (parent keys, sprint names, child counts) with no N+1 queries.
- **Boards and backlog:** `api/boards.py` reuses `build_issue_query` and then adds the sprint / Kanban-age constraints.
- **Reports:** `api/reports.py` → `services/reports.py`. These reconstruct point-in-time state from `IssueHistory`; see 04 for the algorithm.
- **WebSocket:** `GET /ws?token=<jwt>`. The token is passed as a query parameter because browsers cannot set headers on WS. Close code `4401` means unauthenticated.

## Checklist for a new mutating endpoint

1. Pydantic input schema in `schemas.py`, with `Field` constraints.
2. Router: guard with `get_*_or_404(..., Action.X)` or `ensure()`. Never rely on the UI hiding a button.
3. Business logic in a service: validate, mutate, `record()` history for issue fields, `notify()` if people care, `queue_event()` for live views.
4. Router: `audit()` if it's admin- or security-relevant; then commit (`_commit` for issue writes).
5. Frontend: call it from a `useMutation`, then `useInvalidateIssues()` or invalidate the specific keys; show errors with `toast.error(errorMessage(e))`.
6. Tests: a happy path, a forbidden role, a non-member (404), and validation failures. See 03.
