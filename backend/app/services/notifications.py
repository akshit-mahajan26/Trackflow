import re
from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Issue, Notification, ProjectMember, User, Watcher
from app.services.realtime import queue_event

MENTION_RE = re.compile(r"(?<![\w@])@([a-zA-Z0-9_.-]{3,50})")


def extract_mentions(db: Session, text: str, project_id: int) -> list[User]:
    """Resolve @username mentions to users who are members of the project (or admins)."""
    names = {m.lower().rstrip(".") for m in MENTION_RE.findall(text or "")}
    if not names:
        return []
    users = db.scalars(select(User).where(User.username.in_(names), User.is_active.is_(True))).all()
    member_ids = set(db.scalars(select(ProjectMember.user_id).where(ProjectMember.project_id == project_id)))
    return [u for u in users if u.id in member_ids or u.is_admin]


def watcher_ids(db: Session, issue_id: int) -> set[int]:
    return set(db.scalars(select(Watcher.user_id).where(Watcher.issue_id == issue_id)))


def add_watcher(db: Session, issue_id: int, user_id: int | None) -> None:
    if user_id is None:
        return
    exists = db.scalar(select(Watcher.id).where(Watcher.issue_id == issue_id, Watcher.user_id == user_id))
    if not exists:
        db.add(Watcher(issue_id=issue_id, user_id=user_id))
        db.flush()  # sessions don't autoflush; make the row visible to the next existence check


def notify(
    db: Session,
    recipients: Iterable[int | None],
    kind: str,
    message: str,
    *,
    actor: User | None,
    issue: Issue | None = None,
    project_id: int | None = None,
) -> None:
    actor_id = actor.id if actor else None
    project_id = project_id or (issue.project_id if issue else None)
    for uid in {r for r in recipients if r is not None and r != actor_id}:
        db.add(
            Notification(
                user_id=uid,
                actor_id=actor_id,
                kind=kind,
                message=message[:500],
                issue_id=issue.id if issue else None,
                project_id=project_id,
            )
        )
        queue_event(db, "notification", user_id=uid, kind=kind, message=message[:500],
                    issue_key=issue.key if issue else None)
