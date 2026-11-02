from datetime import datetime

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import func, select, text

from app import schemas
from app.api.deps import DB, AdminUser, client_ip
from app.models import Attachment, AuditLog, Issue, Project, User
from app.services.audit import audit
from app.services.realtime import manager
from app.services.settings import DEFAULTS, all_settings, set_setting

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/settings")
def get_settings_(db: DB, admin: AdminUser):
    return all_settings(db)


@router.put("/settings")
def put_settings(body: dict, db: DB, admin: AdminUser, request: Request):
    unknown = set(body) - set(DEFAULTS)
    if unknown:
        raise HTTPException(422, f"Unknown settings: {', '.join(sorted(unknown))}")
    for k, v in body.items():
        if type(v) is not type(DEFAULTS[k]):
            raise HTTPException(422, f"Setting '{k}' must be of type {type(DEFAULTS[k]).__name__}")
        set_setting(db, k, v)
    audit(db, admin, "admin.settings", "settings", None, body, client_ip(request))
    db.commit()
    return all_settings(db)


@router.get("/audit", response_model=schemas.Page[schemas.AuditOut])
def audit_log(db: DB, admin: AdminUser, page: int = 1, page_size: int = 50, action: str | None = None,
              actor_id: int | None = None, entity_type: str | None = None):
    q = select(AuditLog)
    if action:
        q = q.where(AuditLog.action.ilike(f"{action}%"))
    if actor_id:
        q = q.where(AuditLog.actor_id == actor_id)
    if entity_type:
        q = q.where(AuditLog.entity_type == entity_type)
    total = db.scalar(select(func.count()).select_from(q.subquery()))
    page_size = min(page_size, 200)
    items = db.scalars(q.order_by(AuditLog.created_at.desc()).offset((max(page, 1) - 1) * page_size).limit(page_size)).all()
    return schemas.Page(items=items, total=total or 0, page=page, page_size=page_size)


@router.get("/stats")
def system_stats(db: DB, admin: AdminUser):
    db_size = db.scalar(text("SELECT pg_database_size(current_database())"))
    return {
        "users": db.scalar(select(func.count(User.id))),
        "active_users": db.scalar(select(func.count(User.id)).where(User.is_active.is_(True))),
        "projects": db.scalar(select(func.count(Project.id))),
        "issues": db.scalar(select(func.count(Issue.id))),
        "attachments": db.scalar(select(func.count(Attachment.id))),
        "attachment_bytes": db.scalar(select(func.coalesce(func.sum(Attachment.size_bytes), 0))),
        "database_bytes": db_size,
        "websocket_connections": manager.connection_count,
        "server_time": datetime.now().isoformat(),
    }
