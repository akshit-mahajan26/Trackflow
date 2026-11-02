from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import func, or_, select

from app import schemas
from app.api.deps import DB, CurrentUser, client_ip
from app.core.security import create_access_token, hash_password, verify_password
from app.models import User
from app.services.audit import audit
from app.services.issues import now
from app.services.settings import get_setting

router = APIRouter(prefix="/auth", tags=["auth"])

COLORS = ["#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#4f46e5"]


def pick_color(seed: str) -> str:
    return COLORS[sum(map(ord, seed)) % len(COLORS)]


def ensure_unique(db, email: str, username: str, exclude_id: int | None = None) -> None:
    q = select(User).where(or_(func.lower(User.email) == email.lower(), func.lower(User.username) == username.lower()))
    if exclude_id:
        q = q.where(User.id != exclude_id)
    if db.scalar(q):
        raise HTTPException(409, "A user with this email or username already exists")


@router.post("/login", response_model=schemas.TokenOut)
def login(body: schemas.LoginIn, db: DB, request: Request):
    ident = body.username.strip().lower()
    user = db.scalar(select(User).where(or_(func.lower(User.username) == ident, func.lower(User.email) == ident)))
    if not user or not verify_password(body.password, user.password_hash):
        audit(db, user, "auth.login_failed", "user", user.id if user else None, {"username": ident}, client_ip(request))
        db.commit()
        raise HTTPException(401, "Invalid username or password")
    if not user.is_active:
        raise HTTPException(403, "This account has been deactivated")
    user.last_login_at = now()
    audit(db, user, "auth.login", "user", user.id, ip=client_ip(request))
    db.commit()
    return schemas.TokenOut(access_token=create_access_token(user.id, user.token_version), user=user)


@router.post("/register", response_model=schemas.TokenOut, status_code=201)
def register(body: schemas.RegisterIn, db: DB, request: Request):
    if not get_setting(db, "allow_registration"):
        raise HTTPException(403, "Self-registration is disabled. Ask an administrator for an account.")
    ensure_unique(db, body.email, body.username)
    user = User(email=body.email, username=body.username, full_name=body.full_name,
                password_hash=hash_password(body.password), avatar_color=pick_color(body.username))
    db.add(user)
    db.flush()
    audit(db, user, "user.register", "user", user.id, ip=client_ip(request))
    db.commit()
    return schemas.TokenOut(access_token=create_access_token(user.id, user.token_version), user=user)


@router.get("/config")
def public_config(db: DB):
    return {"allow_registration": bool(get_setting(db, "allow_registration")), "site_name": get_setting(db, "site_name")}


@router.get("/me", response_model=schemas.UserOut)
def me(user: CurrentUser):
    return user


@router.patch("/me", response_model=schemas.UserOut)
def update_me(body: schemas.ProfileUpdate, user: CurrentUser, db: DB):
    for k, v in body.model_dump(exclude_unset=True).items():
        if v is not None:
            setattr(user, k, v)
    db.commit()
    return user


@router.post("/me/password", status_code=204)
def change_password(body: schemas.PasswordChange, user: CurrentUser, db: DB, request: Request):
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(400, "Current password is incorrect")
    user.password_hash = hash_password(body.new_password)
    user.token_version += 1
    audit(db, user, "auth.password_changed", "user", user.id, ip=client_ip(request))
    db.commit()
