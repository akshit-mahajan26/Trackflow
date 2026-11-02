import os

os.environ["ENVIRONMENT"] = "test"
# The suite DROPS the schema of its database. Never inherit DATABASE_URL (it may point at real data, e.g. a cloud DB);
# use a dedicated variable and refuse anything not named *_test.
TEST_DB = os.environ.get("TEST_DATABASE_URL", "postgresql+psycopg://trackflow:trackflow_dev_pw@localhost:5434/trackflow_test")
if not TEST_DB.split("?")[0].rsplit("/", 1)[-1].endswith("_test"):
    raise SystemExit(f"Refusing to run tests: database '{TEST_DB.split('@')[-1]}' is not a *_test database.")
os.environ["DATABASE_URL"] = TEST_DB
os.environ["UPLOAD_DIR"] = os.path.join(os.path.dirname(__file__), ".uploads")
os.environ["SECRET_KEY"] = "test-secret-key-for-pytest-only-0123456789"

import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.core.database import Base, SessionLocal, engine  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.main import app  # noqa: E402
from app.models import User  # noqa: E402

BACKEND = os.path.dirname(os.path.dirname(__file__))


@pytest.fixture(scope="session", autouse=True)
def migrated_db():
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"))
    cfg = Config(os.path.join(BACKEND, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(BACKEND, "alembic"))
    command.upgrade(cfg, "head")
    yield


@pytest.fixture(autouse=True)
def clean_tables():
    yield
    tables = ", ".join(t.name for t in Base.metadata.sorted_tables)
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def make_user(username: str, *, admin: bool = False, password: str = "password123") -> User:
    with SessionLocal() as db:
        u = User(email=f"{username}@example.com", username=username, full_name=username.title(),
                 password_hash=hash_password(password), is_admin=admin)
        db.add(u)
        db.commit()
        return u


def login(client: TestClient, username: str, password: str = "password123") -> dict:
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


class Ctx:
    """Common scenario: admin, a project manager who owns project 'APP', and a developer/reporter/viewer."""

    def __init__(self, client: TestClient):
        self.c = client
        self.admin_user = make_user("admin", admin=True)
        self.pm_user = make_user("paula")
        self.dev_user = make_user("dave")
        self.rep_user = make_user("rita")
        self.view_user = make_user("victor")
        self.outsider_user = make_user("olga")
        self.admin = login(client, "admin")
        self.pm = login(client, "paula")
        self.dev = login(client, "dave")
        self.rep = login(client, "rita")
        self.viewer = login(client, "victor")
        self.outsider = login(client, "olga")
        r = client.post("/api/projects", json={"key": "APP", "name": "Application"}, headers=self.pm)
        assert r.status_code == 201, r.text
        self.project = r.json()
        self.pid = self.project["id"]
        self.statuses = {s["name"]: s["id"] for s in self.project["statuses"]}
        for u, role in ((self.dev_user, "developer"), (self.rep_user, "reporter"), (self.view_user, "viewer")):
            r = client.post("/api/projects/APP/members", json={"user_id": u.id, "role": role}, headers=self.pm)
            assert r.status_code == 201, r.text

    def issue(self, headers=None, **kw) -> dict:
        body = {"project_id": self.pid, "summary": kw.pop("summary", "An issue"), **kw}
        r = self.c.post("/api/issues", json=body, headers=headers or self.pm)
        assert r.status_code == 201, r.text
        return r.json()


@pytest.fixture
def ctx(client) -> Ctx:
    return Ctx(client)
