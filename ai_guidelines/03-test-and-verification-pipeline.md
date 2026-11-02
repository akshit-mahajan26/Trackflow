# 03 — Test and Verification Pipeline

Nothing is "done" until it is covered by an automated test that passed, or was checked by hand in the running app, and `docs/STATUS.md` says which. Run the relevant suites after every change, and run **all of them** before claiming a feature is complete.

## The suites

| Suite | Command (from) | DB | Time | Covers |
|---|---|---|---|---|
| Backend pytest | `.venv/bin/python -m pytest -q` (`backend/`) | `trackflow_test` | ~2 min | API, permissions, business rules, reports, TQL, concurrency, WebSockets, health |
| Frontend unit | `npm test` (`frontend/`) | none | ~1 s | `resolveDrop`, `filterToQuery`, formatting, `Field` / `ConfirmDialog` / `ChartCard` |
| Typecheck | `npx tsc -b` (`frontend/`) | none | ~5 s | Strict TS (`noUnusedLocals`, `verbatimModuleSyntax`, `erasableSyntaxOnly`) |
| E2E | `npm run test:e2e` (`frontend/`) | `trackflow_e2e` | ~20 s + build | Real Chromium against a real server on port 8011 |

Run a single backend test with `-k`, for example `.venv/bin/python -m pytest -q tests/test_issues.py -k rank`.

## Backend test harness (`backend/tests/conftest.py`)

- Environment variables are set **before** importing the app: `ENVIRONMENT=test` skips the bootstrap admin; uploads go to `tests/.uploads`. The database comes **only** from `TEST_DATABASE_URL` (default: local `trackflow_test`) and is force-assigned to `DATABASE_URL`. The suite refuses any database not named `*_test`, because it drops the schema and `backend/.env` may point at real or cloud data. Never weaken this guard.
- Session fixture `migrated_db`: drops the `public` schema and runs **Alembic `upgrade head`**. Migrations are therefore exercised on every run; never create tables with `metadata.create_all` in tests.
- Autouse fixture `clean_tables`: `TRUNCATE … RESTART IDENTITY CASCADE` after every test. Ids restart at 1, and tests may rely on that (`APP-1`).
- The `ctx` fixture (`Ctx` class) gives a standard cast:

  | Login | Username | Role |
  |---|---|---|
  | `admin` | `admin` | global admin |
  | `pm` | `paula` | Project Manager; creates project `APP` |
  | `dev` | `dave` | developer |
  | `rep` | `rita` | reporter |
  | `viewer` | `victor` | viewer |
  | `outsider` | `olga` | not a member |

  Use `ctx.issue(headers=…, **fields)` to create issues, `ctx.statuses["Done"]` for status ids, and `ctx.pid` for the project id.
- Tests use `TestClient` against the real app and the real Postgres, with no mocking of the DB or services. Assert on HTTP status codes **and** on persisted state (re-GET the resource).

## What every feature test should cover

1. Happy path, with the persisted result re-read through the API.
2. **Authorization matrix:** the allowed role succeeds; a lower role gets 403; a non-member gets 404; non-admins hitting admin endpoints get 403.
3. **Validation:** 422 with a meaningful `detail` for each business rule.
4. **History / notifications / audit:** when the feature should produce them, assert they exist.
5. **Regression test for every bug fixed.** Name it after the behaviour, e.g. `test_self_assigned_issue_creation`, `test_completion_day_counts_scope_before_carry_over`.

## Concurrency and stress tests (`tests/test_concurrency_realtime.py`)

These use a `ThreadPoolExecutor` against the TestClient, so each request gets its own DB session and connection, which matches production. Existing guarantees:

| Test | Guarantee |
|---|---|
| `test_concurrent_issue_creation_yields_unique_gapless_keys` | 40 parallel creates → keys 1..40 with no gaps or duplicates (row lock on `projects`) |
| `test_concurrent_edits_one_wins_other_gets_conflict` | 6 parallel edits sharing one `version` → exactly one 200 and five 409s |
| `test_concurrent_sprint_start_only_one_active` | 4 parallel starts → exactly one 200 and three 409s (app lock + DB partial unique index) |
| WebSocket tests | Events delivered to members; nothing leaks to outsiders; bad token closes the socket |

Any new code path that allocates sequence numbers, enforces "only one of X", or edits shared rows needs a parallel test like these. If you add a stress scenario, keep it deterministic: assert on counts and invariants, never on timing.

## Report tests: history-driven, so backdate deliberately

Reports read `IssueHistory.created_at`. To test multi-day behaviour, create data through the API and then rewrite timestamps with SQL. Use the `_backdate` helper in `tests/test_agile_reports.py` as the pattern. Remember to backdate **all** rows that matter (`issues.created_at`, the history rows, `sprints.started_at`/`start_date`). Forgetting one makes an issue "not exist yet" on early days.

## E2E pipeline (`frontend/playwright.config.ts`)

The `webServer` command:
1. `npm run build`
2. `scripts.reset_db` against `trackflow_e2e`: drop schema → migrate → bootstrap admin → **seed demo data**.
3. Start uvicorn on **port 8011**.

Consequences:
- Specs can rely on the seed: users `priya`, `marco`, `lena`, `sam`, `ken`, `ana`, `omar` with password `demo12345`; admin `admin` / `admin12345`; projects WEB (Scrum) and OPS (Kanban); issue keys like `WEB-25`.
- Tests run **serially** (`workers: 1`) and share one database. Later specs see earlier specs' changes; the user-delete spec deletes `ken`, so keep that spec last or avoid relying on `ken` after it.
- Prefer accessible locators (`getByRole`, `getByLabel`). If a locator can't be written, that usually means an accessibility bug in the component; fix the component, not the test.
- Lists use `keepPreviousData`, so after changing a filter **wait for the new result** (`expect.poll`) before asserting.
- dnd-kit drags need a real pointer sequence: `mouse.down` → a small move (≥5px activation) → move with `steps` → `mouse.up`.
- Verify through the API too (`request.post('/api/auth/login')` → token → GET the resource), not only the DOM.

## Manual verification

For UI work, also look at the result:
- Run `./scripts/start.sh` (port 8000, dev DB) or use the Vite dev server.
- Check both the light and dark themes.
- Check that the browser console has no errors.
- Charts animate on load, so wait about 1.5 s before judging a screenshot.

## Before declaring done

```bash
cd backend  && .venv/bin/python -m pytest -q
cd frontend && npx tsc -b && npm test && npm run test:e2e
```

Then update `docs/STATUS.md`: the test counts (copied from the actual output, never estimated), new features under "Completed and verified", and anything untested under "Not verified / known limitations".
