# 04 — Data and Schemas

Three layers must stay in sync whenever the data shape changes:

1. `backend/app/models.py`: SQLAlchemy ORM. This is the source of truth for the schema.
2. `backend/app/schemas.py`: Pydantic request/response models, which form the API contract.
3. `frontend/src/lib/types.ts`: TypeScript mirrors of the response models.

Plus a migration in `backend/alembic/versions/`.

## Tables

| Table | Purpose | Notable constraints / indexes |
|---|---|---|
| `users` | Accounts | unique `email`, `username`; `token_version` (bump = revoke all sessions); `is_admin`, `is_active` |
| `projects` | Projects | unique `key`; CHECKs on `board_type`, `priority`, `status`; `issue_seq` = last issue number; `settings` JSONB |
| `project_members` | User ↔ project role | unique (project, user); CHECK role ∈ 5 roles; cascades on project/user delete |
| `workflow_statuses` | Statuses = board columns | unique (project, name); `category` ∈ todo/in_progress/done; `position`; `wip_limit` nullable |
| `workflow_transitions` | Allowed status moves | unique (from, to); enforced only if `projects.settings.enforce_transitions` |
| `sprints` | Sprints | CHECK state; **partial unique index `ux_one_active_sprint` on (project_id) WHERE state='active'**; commitment snapshot columns |
| `issues` | Issues | unique (project, number); unique `key`; CHECKs on type/priority/points ≥ 0; `version` (optimistic lock, `version_id_col`); `rank` float; `labels` JSONB (GIN index); `custom_fields` JSONB |
| `issue_links` | Directed links | unique (source, target, type); CHECK source ≠ target |
| `comments`, `attachments`, `watchers` | Collaboration | `attachments.stored_name` unique random filename; unique (issue, user) watcher |
| `issue_history` | Field-level changelog | index (issue_id, created_at); `old_ref`/`new_ref` machine ids |
| `notifications` | In-app notifications | index (user_id, is_read) |
| `saved_filters` | Saved queries | `query` JSONB (structured filter dict or `{tql: …}`) |
| `custom_fields` | Per-project field definitions | unique (project, name); type ∈ text/number/date/select |
| `audit_logs` | Admin / security audit | `details` JSONB; `ip_address` |
| `app_settings` | Workspace key/value settings | keys whitelisted by `services/settings.py::DEFAULTS` |

### Foreign-key delete behaviour (it matters)

- **CASCADE** (child rows disappear):
  - project → members, statuses, transitions, sprints, custom fields, history, notifications;
  - issue → comments, attachments, watchers, history, links;
  - user → memberships, watchers, own notifications, own saved filters.
- **SET NULL** (rows stay, the person is gone): `issues.assignee_id` / `reporter_id`, `comments.author_id`, `attachments.uploader_id`, `issue_history.actor_id`, `audit_logs.actor_id`, `projects.lead_id`. The UI renders NULL people as **"Former user"** (`FORMER_USER` in `lib/format.ts`).
- **RESTRICT:** `issues.status_id` → `workflow_statuses`. Statuses can't be deleted while in use; `services/projects.py::delete_status` moves the issues first. Project deletion deletes issues explicitly before the project.
- `issues.sprint_id` and `issues.parent_id` → SET NULL. Deleting a parent **story** deletes its subtasks in the service; deleting an epic only detaches its children.

## Enumerations

Enumerations are stored as `String` + `CheckConstraint` (built with the `_in()` helper), **not** native PG enums, so adding a value is a one-line migration. The allowed values are defined once in `models.py` (`PROJECT_ROLES`, `ISSUE_TYPES`, `PRIORITIES`, `STATUS_CATEGORIES`, `SPRINT_STATES`, `LINK_TYPES`, `CUSTOM_FIELD_TYPES`) and mirrored as `Literal[...]` in `schemas.py` and as union types in `types.ts`. Change all three together.

## JSONB fields

| Column | Shape | Notes |
|---|---|---|
| `issues.labels` | `["backend","tech-debt"]` | Normalised by `_clean_labels`: lowercase, spaces → `-`, deduped, max 20 × 40 chars. Filter with `labels @> '["x"]'`, using the GIN index |
| `issues.custom_fields` | `{"<field_id>": value}` | Keys are **stringified** field ids. Values are validated per type (number → float, date → ISO string, select ∈ options). Updates **merge**; they don't replace |
| `projects.settings` | `{"enforce_transitions": bool, "kanban_done_days": int}` | PATCH merges into the existing dict |
| `sprints.committed_issue_ids` / `completed_issue_ids` | `[int]` | Snapshots taken at start/complete |
| `saved_filters.query` | Filter dict (see `services/search.py` docstring) or `{"tql": "..."}` | Stored exactly as the UI sends it |

`models.py` imports `JSONB as JSON`, so a plain `JSON` in that file *is* JSONB. Keep it that way.

## IssueHistory: the event log behind reports

Every tracked change writes one row: `field`, human `old_value`/`new_value`, and for reference fields **`old_ref`/`new_ref`** (ids):

| `field` | `*_value` | `*_ref` |
|---|---|---|
| `created` | new = issue key | new_ref = initial status id |
| `status` | status names | status ids |
| `assignee` | full names (or "Former user") | user ids (NULLed when the user is deleted) |
| `sprint` | sprint names | sprint ids |
| `parent` | issue key | issue id |
| `story_points` etc. | stringified numbers | — |
| `description` | NULL (the fact of the change is enough) | — |
| `comment`, `attachment`, `link` | short text | — |

**Point-in-time reconstruction** (`services/reports.py::Timeline.value_at`): the value of a field at time *t* is the **old** value of the first change after *t*, or the current value if nothing changed after *t*. An issue exists at *t* if `created_at <= t`. Burndown, burnup and CFD all use this. Two consequences:
- Any code that changes `status_id`, `sprint_id` or `story_points` **must** write a history row (normally via `record()`), or the reports become wrong.
- Timestamps written in one transaction must come from the **same clock**. History rows use the DB `now()` (transaction start). Sprint `started_at`/`completed_at` use `sprints.tx_now(db)`, which is the same value. Don't use Python `datetime.now()` for anything that is compared against history.

## API schema conventions (`schemas.py`)

- Responses derive from `ORM` (`from_attributes=True`) and are built with `Model.model_validate(orm_obj)`.
- Partial updates: request models make every field optional, and routers use `body.model_dump(exclude_unset=True)`. That distinguishes "not sent" from "set to null" (e.g. unassigning: `{"assignee_id": null}`).
- Issue updates carry an optional `version` for optimistic concurrency.
- Pagination: `Page[T]` = `{items, total, page, page_size}`; the `page_size` maximum is 500.
- Emails use a permissive regex (`EmailStr` alias) rather than `email-validator`, because internal `.local` domains must work.
- Errors: FastAPI `{"detail": "..."}` for business errors, or a list of validation errors for 422. The frontend's `detailMessage()` handles both.
- Status codes used consistently:

  | Code | Meaning |
  |---|---|
  | 401 | Not authenticated |
  | 403 | Member lacks permission |
  | 404 | Missing, or not visible to the user |
  | 409 | Conflict (duplicate, version mismatch, active sprint exists) |
  | 413 | Upload too large |
  | 415 | Upload file type not allowed |
  | 422 | Business rule or validation failure |

## Migrations (Alembic)

```bash
cd backend
# 1. edit app/models.py
.venv/bin/alembic revision --autogenerate -m "short description" --rev-id 0003
# 2. READ the generated file: autogenerate misses CHECK-constraint changes, server defaults and data migrations
.venv/bin/alembic upgrade head
.venv/bin/python -m pytest -q      # tests run migrations from scratch
```

- Use sequential `--rev-id` values (`0001`, `0002`, …). `/api/health` reports the current revision, and the E2E/STATUS docs reference it.
- Never edit an applied migration; add a new one.
- `alembic/env.py` reads `DATABASE_URL` from app settings. `sqlalchemy.url` in `alembic.ini` is intentionally blank.
- Partial and GIN indexes are declared on the model (`Index(..., postgresql_where=..., postgresql_using="gin")`) so autogenerate sees them.

## Frontend types (`src/lib/types.ts`)

- These are hand-maintained mirrors of `schemas.py`. When a response model gains a field, add it here; `tsc -b` will flag consumers.
- `IssueFilter` mirrors the filter dict accepted by `build_issue_query` (plus `tql`). `filterToQuery()` serialises arrays as repeated params (`?status_ids=1&status_ids=2`), which is what the backend's `_filters_from_request` expects.
