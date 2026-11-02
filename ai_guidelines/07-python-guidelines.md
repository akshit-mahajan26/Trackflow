# 07 — Python Guidelines

The rules for writing backend code in this repository. Match the surrounding code: if a pattern already exists, reuse it rather than inventing a parallel one.

## Environment

- Python **3.12**, using the virtualenv at `backend/.venv`. Always call tools through it: `.venv/bin/python`, `.venv/bin/pytest`, `.venv/bin/alembic`, `.venv/bin/uvicorn`.
- Dependencies are pinned in `backend/requirements.txt`. Add a package only when the standard library or an existing dependency can't do the job; pin its exact version and check it installs into a clean venv.
- Run commands from `backend/` so `app.` and `scripts.` imports resolve. Run scripts as modules (`python -m scripts.seed`).

## Language features

- Modern typing everywhere: `list[int]`, `dict[str, Any]`, `X | None`. `Annotated` is used for dependency aliases. PEP 695 generics are fine (`class Page[T](BaseModel)`).
- f-strings, including PEP 701 nested quotes (allowed on 3.12).
- `StrEnum` for internal enumerations (`Action`). Persisted enumerations are strings with CHECK constraints (see 04).
- The walrus operator for "compute and test" is used in routers (`if tql := request.query_params.get("tql"):`). Fine, but don't nest it.

## SQLAlchemy 2.x

- Declarative models with `Mapped[...]` + `mapped_column(...)`. Every model goes in `app/models.py`.
- Use 2.0-style queries only: `select(...)`, `db.scalar(...)`, `db.scalars(...).all()`, `db.execute(...)`. Never `db.query(...)`.
- Use `db.get(Model, id)` for primary-key lookups.
- Prefer set-based queries for aggregates (`func.count().filter(...)`, `group_by`), and enrich lists in bulk (see `serializers.issue_list`). No per-row queries inside loops over result sets, except tiny bounded ones (dashboard activity, 20 rows).
- Eager-load relationships that a list will touch: `.options(joinedload(Issue.status), joinedload(Issue.assignee), …)` followed by `.unique()`.
- Bulk `update()` / `delete()` statements bypass ORM events and history. Use them only when you also handle history and realtime events yourself (see `services/users.delete_user`).
- Row locking: `.with_for_update().execution_options(populate_existing=True)` (gotcha 1 in 06).
- **Transactions:** services `flush()`; routers `commit()`. Use `db.begin_nested()` (a savepoint) for per-item isolation inside one request (see `bulk_update`).
- JSONB: `models.py` aliases `JSONB as JSON`. Reassign the whole value (`issue.custom_fields = {...}`) rather than mutating it in place, because plain JSONB columns don't track in-place mutation.

## FastAPI

- Routers are thin (see 02). Inject dependencies with the aliases from `api/deps.py`: `DB`, `CurrentUser`, `AdminUser`.
- Sync `def` endpoints are the norm; they run in the threadpool. Use `async def` only for genuinely async work (WebSocket, streamed uploads in `upload_attachment`), and then don't make blocking DB calls in the hot loop.
- Request bodies are Pydantic models from `schemas.py`, constrained with `Field(...)`. Use `model_dump(exclude_unset=True)` for PATCH semantics.
- Declare `response_model` on endpoints that return schema objects, so output is filtered (e.g. no `password_hash`).
- Raise `HTTPException(status, "Human sentence.")`. Status codes follow the table in 04.
- Register routers in `main.py`'s `for module in (...)` tuple. All API routes live under `/api`.
- Use `client_ip(request)` when writing audit entries.

## Business logic

- Validation lives in services as `_validate_*` helpers; they raise 422 with actionable messages.
- Check permissions with `ensure()` / `can()` and an `Action`, never with role-string comparisons outside `core/permissions.py`.
- Record side effects explicitly and in this order: mutate → `record()` history → `notify()` → `queue_event()`. Let the router commit.
- Don't let a service import from a router module. `services/issues.py` imports `can` from `api/deps.py`, the one sanctioned exception, because `deps.py` has no router state. Don't add more cross-layer imports.

## Security rules

- Never interpolate user input into SQL. The only f-string SQL in the codebase interpolates **table and column names from constants** (`conftest.py`, `seed.py`); keep it that way.
- Escape `%` and `_` in user text used in `ILIKE` (see `search.py` and `tql.py`).
- Hash passwords only with `core/security.hash_password` (bcrypt), and verify with `verify_password`. Bump `token_version` whenever credentials or access change.
- Never trust client filenames or paths. Derive storage names with `secrets.token_hex`, and use `Path(name).name` for display names.
- Secrets come from settings or environment variables. Never commit `.env`; `.env.example` documents the variables.

## Style

- Formatting: 4-space indent, roughly 120-character lines (the codebase is consistently ~120), double quotes. Keep imports grouped stdlib / third-party / `app.` (isort order).
- Comment density: low. Module docstrings explain *why* a module exists. Comments explain non-obvious decisions (locks, clocks, security), never restate the code.
- Names: `snake_case` functions, `PascalCase` classes, `UPPER_CASE` module constants. Private helpers start with `_`.
- Keep functions focused; extract a helper once logic repeats or a function stops fitting on a screen. Don't create abstractions for a single use.
- No `print` in app code; use `logging.getLogger(__name__)`. Scripts may `print`.
- Prefer early returns and guard clauses over nesting.

## Tests (pytest)

- Tests go in `backend/tests/test_<area>.py`, using the `ctx` / `client` fixtures from `conftest.py`. Test through the HTTP API against real Postgres; don't mock the DB.
- One behaviour per test, named after the rule. Cover the role matrix and 404-for-non-members for new endpoints.
- For time-dependent logic, backdate rows with SQL after creating them through the API (the `_backdate` pattern), and keep assertions date-relative (`date.today() - timedelta(...)`).
- For concurrency, use `ThreadPoolExecutor` with assertions on invariants (counts, uniqueness), never on timing.
- Pure-logic modules (e.g. TQL parsing) also get direct unit tests without HTTP (`test_parser_*`).

## Definition of done (backend change)

1. Code in the right layer (router / service / model).
2. A migration, if the schema changed, reviewed by hand.
3. `schemas.py` and `frontend/src/lib/types.ts` updated together.
4. Tests added; `.venv/bin/python -m pytest -q` passes in full.
5. If behaviour is user-visible, the UI updated and `npx tsc -b && npm test && npm run test:e2e` all pass.
6. `docs/STATUS.md` (and the README, if operators are affected) updated with **actual** test counts.
