from fastapi import APIRouter, HTTPException, Query, Request
from sqlalchemy import func, or_, select

from app import schemas
from app.api.auth import ensure_unique, pick_color
from app.api.deps import DB, AdminUser, CurrentUser, client_ip
from app.core.security import hash_password
from app.models import Issue, ProjectMember, User, WorkflowStatus
from app.services.audit import audit
from app.services.realtime import manager
from app.services.users import delete_user

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[schemas.UserOut])
def list_users(db: DB, user: CurrentUser, q: str | None = None, include_inactive: bool = False,
               project_id: int | None = None):
    query = select(User).order_by(User.full_name)
    if not include_inactive or not user.is_admin:
        query = query.where(User.is_active.is_(True))
    if q:
        like = f"%{q.strip()}%"
        query = query.where(or_(User.full_name.ilike(like), User.username.ilike(like), User.email.ilike(like)))
    if project_id:
        query = query.join(ProjectMember, ProjectMember.user_id == User.id).where(ProjectMember.project_id == project_id)
    return db.scalars(query.limit(500)).all()


@router.get("/{user_id}")
def get_user(user_id: int, db: DB, user: CurrentUser):
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    memberships = db.execute(
        select(ProjectMember.project_id, ProjectMember.role).where(ProjectMember.user_id == user_id)
    ).all()
    open_count = db.scalar(
        select(func.count(Issue.id)).join(WorkflowStatus, Issue.status_id == WorkflowStatus.id)
        .where(Issue.assignee_id == user_id, WorkflowStatus.category != "done")
    )
    return {
        "user": schemas.UserOut.model_validate(target),
        "memberships": [{"project_id": p, "role": r} for p, r in memberships],
        "open_issues": open_count or 0,
    }


@router.post("", response_model=schemas.UserOut, status_code=201)
def create_user(body: schemas.UserCreate, db: DB, admin: AdminUser, request: Request):
    ensure_unique(db, body.email, body.username)
    user = User(email=body.email, username=body.username, full_name=body.full_name, is_admin=body.is_admin,
                job_title=body.job_title, password_hash=hash_password(body.password),
                avatar_color=pick_color(body.username))
    db.add(user)
    db.flush()
    audit(db, admin, "user.create", "user", user.id, {"username": user.username, "is_admin": user.is_admin}, client_ip(request))
    db.commit()
    return user


@router.patch("/{user_id}", response_model=schemas.UserOut)
def update_user(user_id: int, body: schemas.UserAdminUpdate, db: DB, admin: AdminUser, request: Request):
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    data = body.model_dump(exclude_unset=True)
    if target.id == admin.id and (data.get("is_admin") is False or data.get("is_active") is False):
        raise HTTPException(422, "You cannot remove your own administrator access or deactivate yourself")
    if "email" in data and data["email"]:
        ensure_unique(db, data["email"], target.username, exclude_id=target.id)
    if password := data.pop("password", None):
        target.password_hash = hash_password(password)
        target.token_version += 1
    if data.get("is_active") is False and target.is_active:
        target.token_version += 1
    for k, v in data.items():
        if v is not None:
            setattr(target, k, v)
    audit(db, admin, "user.update", "user", target.id,
          {k: v for k, v in body.model_dump(exclude_unset=True).items() if k != "password"} |
          ({"password_reset": True} if password else {}), client_ip(request))
    db.commit()
    if not target.is_active:
        manager.update_access(target.id, set())
    return target


@router.delete("/{user_id}")
def remove_user(user_id: int, db: DB, admin: AdminUser, request: Request, confirm: str = Query(..., description="The user's username")):
    """Permanently delete a person who has left. Their work stays; their name is replaced by "Former user"."""
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    if confirm.strip().lower() != target.username.lower():
        raise HTTPException(422, "Type the user's username to confirm deletion")
    summary = delete_user(db, admin, target)
    # Kept for accountability (admins only): who removed which account, and when.
    audit(db, admin, "user.delete", "user", user_id, {"username": target.username, **summary}, client_ip(request))
    db.commit()
    manager.update_access(user_id, set())
    return summary
