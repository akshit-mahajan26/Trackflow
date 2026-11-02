import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select, text
from sqlalchemy.orm.exc import StaleDataError

from app.api import admin, auth, boards, collab, issues, projects, reports, sprints, users, ws
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.core.security import hash_password
from app.models import User

settings = get_settings()
log = logging.getLogger("trackflow")


def bootstrap_admin() -> None:
    """Create the first administrator on an empty database."""
    with SessionLocal() as db:
        if db.scalar(select(func.count(User.id))):
            return
        db.add(User(email=settings.bootstrap_admin_email, username="admin", full_name="Administrator", is_admin=True,
                    password_hash=hash_password(settings.bootstrap_admin_password)))
        db.commit()
        log.warning("Created bootstrap admin '%s' — change its password after first login.", settings.bootstrap_admin_email)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.services.realtime import manager

    manager.loop = asyncio.get_running_loop()
    if settings.environment != "test":
        if settings.secret_key == "change-me-in-production" and settings.environment == "production":
            raise RuntimeError("SECRET_KEY must be set in production")
        bootstrap_admin()
    yield
    manager.loop = None


app = FastAPI(title=settings.app_name, version="1.0.0", lifespan=lifespan, docs_url="/api/docs",
              openapi_url="/api/openapi.json")
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origin_list, allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(StaleDataError)
async def stale_data_handler(request: Request, exc: StaleDataError):
    return JSONResponse({"detail": "This item was modified by someone else. Reload and try again."}, status_code=409)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


api = APIRouter(prefix="/api")
for module in (auth, users, projects, issues, sprints, boards, reports, collab, admin):
    api.include_router(module.router)


@api.get("/health", tags=["health"])
def health():
    try:
        with SessionLocal() as db:
            db.execute(text("SELECT 1"))
            revision = db.execute(text("SELECT version_num FROM alembic_version")).scalar()
        return {"status": "ok", "database": "ok", "migration": revision}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"status": "degraded", "database": "error", "detail": str(e)[:200]}, status_code=503)


app.include_router(api)
app.include_router(ws.router)


# Serve the built frontend (single port for LAN deployment). Unknown non-API paths fall back to index.html.
if (settings.frontend_dist / "index.html").is_file():
    app.mount("/assets", StaticFiles(directory=settings.frontend_dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith(("api/", "ws")):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        candidate = (settings.frontend_dist / path).resolve()
        if path and candidate.is_file() and settings.frontend_dist.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(settings.frontend_dist / "index.html")
