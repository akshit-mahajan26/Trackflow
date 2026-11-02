from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.permissions import Action, role_allows
from app.core.security import decode_access_token
from app.models import Issue, Project, ProjectMember, User

bearer = HTTPBearer(auto_error=False)

DB = Annotated[Session, Depends(get_db)]


def user_from_token(db: Session, token: str | None) -> User | None:
    if not token:
        return None
    payload = decode_access_token(token)
    if not payload:
        return None
    user = db.get(User, int(payload["sub"]))
    if not user or not user.is_active or user.token_version != payload.get("tv"):
        return None
    return user


def get_current_user(
    db: DB, creds: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]
) -> User:
    user = user_from_token(db, creds.credentials if creds else None)
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated", headers={"WWW-Authenticate": "Bearer"})
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_admin(user: CurrentUser) -> User:
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Administrator privileges required")
    return user


AdminUser = Annotated[User, Depends(require_admin)]


def client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def member_role(db: Session, project_id: int, user_id: int) -> str | None:
    return db.scalar(
        select(ProjectMember.role).where(ProjectMember.project_id == project_id, ProjectMember.user_id == user_id)
    )


def can(db: Session, user: User, project_id: int, action: Action) -> bool:
    if user.is_admin:
        return True
    return role_allows(member_role(db, project_id, user.id), action)


def ensure(db: Session, user: User, project_id: int, action: Action) -> None:
    if not can(db, user, project_id, action):
        # Hide project existence from non-members.
        if action == Action.VIEW_PROJECT:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"You do not have permission to {action.value.replace('_', ' ')}")


def get_project_or_404(db: Session, user: User, project_ref: str | int, action: Action = Action.VIEW_PROJECT) -> Project:
    if isinstance(project_ref, int) or str(project_ref).isdigit():
        project = db.get(Project, int(project_ref))
    else:
        project = db.scalar(select(Project).where(Project.key == str(project_ref).upper()))
    if not project:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    ensure(db, user, project.id, Action.VIEW_PROJECT)
    if action != Action.VIEW_PROJECT:
        ensure(db, user, project.id, action)
    return project


def get_issue_or_404(db: Session, user: User, issue_ref: str | int) -> Issue:
    if isinstance(issue_ref, int) or str(issue_ref).isdigit():
        issue = db.get(Issue, int(issue_ref))
    else:
        issue = db.scalar(select(Issue).where(Issue.key == str(issue_ref).upper()))
    if not issue:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Issue not found")
    ensure(db, user, issue.project_id, Action.VIEW_PROJECT)
    return issue


def accessible_project_ids(db: Session, user: User) -> list[int] | None:
    """None means 'all projects' (admin)."""
    if user.is_admin:
        return None
    return list(db.scalars(select(ProjectMember.project_id).where(ProjectMember.user_id == user.id)))
