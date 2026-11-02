"""Global search, dashboard, saved filters and notifications."""

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import false, func, or_, select, update

from app import schemas
from app.api.deps import DB, CurrentUser, accessible_project_ids, ensure
from app.core.permissions import Action
from app.models import Issue, Notification, Project, SavedFilter, Sprint, User
from app.services.dashboard import dashboard

router = APIRouter(tags=["collaboration"])


@router.get("/dashboard")
def global_dashboard(db: DB, user: CurrentUser):
    return dashboard(db, user, accessible_project_ids(db, user))


@router.get("/search")
def global_search(db: DB, user: CurrentUser, q: str = Query(min_length=1, max_length=200), limit: int = 8):
    ids = accessible_project_ids(db, user)
    like = f"%{q.strip()}%"
    limit = min(limit, 25)

    def scoped(stmt, col):
        return stmt if ids is None else stmt.where(col.in_(ids) if ids else false())

    projects = db.scalars(scoped(select(Project).where(or_(Project.name.ilike(like), Project.key.ilike(like))), Project.id).limit(limit)).all()
    issue_q = select(Issue).where(or_(Issue.key.ilike(like), Issue.summary.ilike(like), Issue.description.ilike(like)))
    exact = q.strip().upper()
    issues = db.scalars(scoped(issue_q, Issue.project_id).order_by((Issue.key == exact).desc(), Issue.updated_at.desc()).limit(limit)).all()
    epics = [i for i in issues if i.issue_type == "epic"]
    sprints = db.scalars(scoped(select(Sprint).where(Sprint.name.ilike(like)), Sprint.project_id).limit(limit)).all()
    users = db.scalars(select(User).where(User.is_active.is_(True), or_(User.full_name.ilike(like), User.username.ilike(like)))
                       .limit(limit)).all()
    keys = dict(db.execute(select(Project.id, Project.key)).all())
    return {
        "projects": [{"id": p.id, "key": p.key, "name": p.name} for p in projects],
        "issues": [{"id": i.id, "key": i.key, "summary": i.summary, "issue_type": i.issue_type, "status": i.status.name,
                    "status_category": i.status.category} for i in issues],
        "epics": [{"id": e.id, "key": e.key, "summary": e.summary} for e in epics],
        "sprints": [{"id": s.id, "name": s.name, "state": s.state, "project_key": keys.get(s.project_id)} for s in sprints],
        "users": [{"id": u.id, "full_name": u.full_name, "username": u.username, "avatar_color": u.avatar_color} for u in users],
    }


# ---------- saved filters ----------


@router.get("/filters", response_model=list[schemas.SavedFilterOut])
def list_filters(db: DB, user: CurrentUser, project_id: int | None = None):
    q = select(SavedFilter).where(or_(SavedFilter.owner_id == user.id, SavedFilter.is_shared.is_(True)))
    if project_id is not None:
        q = q.where(or_(SavedFilter.project_id == project_id, SavedFilter.project_id.is_(None)))
    ids = accessible_project_ids(db, user)
    if ids is not None:
        q = q.where(or_(SavedFilter.project_id.is_(None), SavedFilter.project_id.in_(ids)))
    return db.scalars(q.order_by(SavedFilter.name)).all()


@router.post("/filters", response_model=schemas.SavedFilterOut, status_code=201)
def create_filter(body: schemas.SavedFilterIn, db: DB, user: CurrentUser):
    if body.project_id:
        ensure(db, user, body.project_id, Action.VIEW_PROJECT)
    f = SavedFilter(owner_id=user.id, **body.model_dump())
    db.add(f)
    db.commit()
    return f


def _own_filter(db, user, filter_id: int) -> SavedFilter:
    f = db.get(SavedFilter, filter_id)
    if not f or (f.owner_id != user.id and not f.is_shared):
        raise HTTPException(404, "Filter not found")
    if f.owner_id != user.id and not user.is_admin:
        raise HTTPException(403, "Only the owner can modify this filter")
    return f


@router.put("/filters/{filter_id}", response_model=schemas.SavedFilterOut)
def update_filter(filter_id: int, body: schemas.SavedFilterIn, db: DB, user: CurrentUser):
    f = _own_filter(db, user, filter_id)
    for k, v in body.model_dump().items():
        setattr(f, k, v)
    db.commit()
    return f


@router.delete("/filters/{filter_id}", status_code=204)
def delete_filter(filter_id: int, db: DB, user: CurrentUser):
    db.delete(_own_filter(db, user, filter_id))
    db.commit()


# ---------- notifications ----------


@router.get("/notifications")
def list_notifications(db: DB, user: CurrentUser, unread_only: bool = False, limit: int = 50):
    q = select(Notification).where(Notification.user_id == user.id)
    if unread_only:
        q = q.where(Notification.is_read.is_(False))
    items = db.scalars(q.order_by(Notification.created_at.desc()).limit(min(limit, 200))).all()
    unread = db.scalar(select(func.count()).where(Notification.user_id == user.id, Notification.is_read.is_(False)))
    out = []
    for n in items:
        item = schemas.NotificationOut.model_validate(n)
        item.issue_key = n.issue.key if n.issue else None
        out.append(item)
    return {"items": out, "unread": unread or 0}


@router.post("/notifications/{notification_id}/read", status_code=204)
def mark_read(notification_id: int, db: DB, user: CurrentUser):
    n = db.get(Notification, notification_id)
    if not n or n.user_id != user.id:
        raise HTTPException(404, "Notification not found")
    n.is_read = True
    db.commit()


@router.post("/notifications/read-all", status_code=204)
def mark_all_read(db: DB, user: CurrentUser):
    db.execute(update(Notification).where(Notification.user_id == user.id, Notification.is_read.is_(False)).values(is_read=True))
    db.commit()
