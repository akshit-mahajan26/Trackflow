"""Issue business rules: creation, updates with history, hierarchy, ranking, notifications."""

from datetime import date, datetime, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.permissions import Action
from app.api.deps import can
from app.models import CustomField, Issue, IssueHistory, Project, ProjectMember, Sprint, User, WorkflowStatus
from app.services.notifications import add_watcher, extract_mentions, notify, watcher_ids
from app.services.projects import check_transition, initial_status
from app.services.realtime import queue_event

RANK_STEP = 1024.0


def now() -> datetime:
    return datetime.now(timezone.utc)


# ---------- permission helpers ----------


def is_own(issue: Issue, user: User) -> bool:
    return user.id in (issue.reporter_id, issue.assignee_id)


def can_edit(db: Session, user: User, issue: Issue) -> bool:
    return can(db, user, issue.project_id, Action.EDIT_ANY_ISSUE) or (
        is_own(issue, user) and can(db, user, issue.project_id, Action.EDIT_OWN_ISSUE)
    )


def can_transition(db: Session, user: User, issue: Issue) -> bool:
    return can(db, user, issue.project_id, Action.TRANSITION_ISSUE) or (
        is_own(issue, user) and can(db, user, issue.project_id, Action.EDIT_OWN_ISSUE)
    )


def ensure_edit(db: Session, user: User, issue: Issue) -> None:
    if not can_edit(db, user, issue):
        raise HTTPException(403, "You do not have permission to edit this issue")


# ---------- validation ----------


def _validate_assignee(db: Session, project_id: int, assignee_id: int | None) -> None:
    if assignee_id is None:
        return
    user = db.get(User, assignee_id)
    if not user or not user.is_active:
        raise HTTPException(422, "Assignee does not exist or is inactive")
    role = db.scalar(
        select(ProjectMember.role).where(ProjectMember.project_id == project_id, ProjectMember.user_id == assignee_id)
    )
    if role is None or role == "viewer":
        raise HTTPException(422, "Assignee must be a project member who can work on issues")


def _validate_status(db: Session, project_id: int, status_id: int) -> WorkflowStatus:
    status = db.get(WorkflowStatus, status_id)
    if not status or status.project_id != project_id:
        raise HTTPException(422, "Status does not belong to this project")
    return status


def _validate_sprint(db: Session, project_id: int, sprint_id: int | None) -> Sprint | None:
    if sprint_id is None:
        return None
    sprint = db.get(Sprint, sprint_id)
    if not sprint or sprint.project_id != project_id:
        raise HTTPException(422, "Sprint does not belong to this project")
    if sprint.state == "closed":
        raise HTTPException(422, "Cannot add issues to a closed sprint")
    return sprint


def _validate_parent(db: Session, issue_type: str, parent_id: int | None, project_id: int, issue_id: int | None) -> Issue | None:
    if issue_type == "epic":
        if parent_id is not None:
            raise HTTPException(422, "Epics cannot have a parent")
        return None
    if parent_id is None:
        if issue_type == "subtask":
            raise HTTPException(422, "A subtask requires a parent issue")
        return None
    parent = db.get(Issue, parent_id)
    if not parent or parent.project_id != project_id:
        raise HTTPException(422, "Parent issue must exist in the same project")
    if issue_id is not None and parent.id == issue_id:
        raise HTTPException(422, "An issue cannot be its own parent")
    if issue_type == "subtask":
        if parent.issue_type in ("epic", "subtask"):
            raise HTTPException(422, "A subtask's parent must be a story, task, bug or improvement")
    elif parent.issue_type != "epic":
        raise HTTPException(422, "Only epics can be the parent of a story, task, bug or improvement (use a subtask)")
    return parent


def _validate_custom_fields(db: Session, project_id: int, values: dict[str, Any], creating: bool) -> dict[str, Any]:
    fields = {str(f.id): f for f in db.scalars(select(CustomField).where(CustomField.project_id == project_id))}
    clean: dict[str, Any] = {}
    for fid, value in values.items():
        field = fields.get(str(fid))
        if not field:
            raise HTTPException(422, f"Unknown custom field {fid}")
        if value in (None, ""):
            clean[str(fid)] = None
            continue
        if field.field_type == "number":
            try:
                value = float(value)
            except (TypeError, ValueError):
                raise HTTPException(422, f"'{field.name}' must be a number") from None
        elif field.field_type == "date":
            try:
                value = date.fromisoformat(str(value)).isoformat()
            except ValueError:
                raise HTTPException(422, f"'{field.name}' must be a date (YYYY-MM-DD)") from None
        elif field.field_type == "select":
            if value not in field.options:
                raise HTTPException(422, f"'{field.name}' must be one of: {', '.join(field.options)}")
        else:
            value = str(value)[:2000]
        clean[str(fid)] = value
    if creating:
        for fid, field in fields.items():
            if field.required and clean.get(fid) in (None, ""):
                raise HTTPException(422, f"'{field.name}' is required")
    return clean


def _clean_labels(labels: list[str]) -> list[str]:
    out: list[str] = []
    for label in labels:
        label = label.strip().lower().replace(" ", "-")[:40]
        if label and label not in out:
            out.append(label)
    return out[:20]


# ---------- history ----------


def _display(db: Session, field: str, value: Any) -> tuple[str | None, int | None]:
    """Human-readable value and machine ref id for a history entry."""
    if value is None:
        return None, None
    if field == "status_id":
        s = db.get(WorkflowStatus, value)
        return (s.name if s else str(value)), value
    if field == "assignee_id":
        u = db.get(User, value)
        return (u.full_name if u else str(value)), value
    if field == "sprint_id":
        sp = db.get(Sprint, value)
        return (sp.name if sp else str(value)), value
    if field == "parent_id":
        p = db.get(Issue, value)
        return (p.key if p else str(value)), value
    if isinstance(value, list):
        return ", ".join(value), None
    if isinstance(value, dict):
        return ", ".join(f"{k}={v}" for k, v in value.items()), None
    if isinstance(value, float) and value.is_integer():
        return str(int(value)), None
    return str(value), None


FIELD_NAMES = {
    "status_id": "status",
    "assignee_id": "assignee",
    "sprint_id": "sprint",
    "parent_id": "parent",
}


def record(db: Session, issue: Issue, actor: User | None, field: str, old: Any, new: Any) -> None:
    old_v, old_ref = _display(db, field, old)
    new_v, new_ref = _display(db, field, new)
    if field == "description":
        old_v, new_v = None, None  # long text; the change itself is what matters
    db.add(
        IssueHistory(
            issue_id=issue.id,
            project_id=issue.project_id,
            actor_id=actor.id if actor else None,
            field=FIELD_NAMES.get(field, field),
            old_value=old_v,
            new_value=new_v,
            old_ref=old_ref,
            new_ref=new_ref,
        )
    )


# ---------- ranking ----------


def _bottom_rank(db: Session, project_id: int) -> float:
    current = db.scalar(select(func.max(Issue.rank)).where(Issue.project_id == project_id))
    return (current or 0) + RANK_STEP


def rebalance(db: Session, project_id: int) -> None:
    ids = db.scalars(select(Issue.id).where(Issue.project_id == project_id).order_by(Issue.rank, Issue.id)).all()
    for i, iid in enumerate(ids, start=1):
        db.execute(update(Issue).where(Issue.id == iid).values(rank=i * RANK_STEP).execution_options(synchronize_session=False))
    db.expire_all()


def compute_rank(db: Session, project_id: int, above_id: int | None, below_id: int | None) -> float:
    above = db.get(Issue, above_id) if above_id else None
    below = db.get(Issue, below_id) if below_id else None
    for n in (above, below):
        if n is not None and n.project_id != project_id:
            raise HTTPException(422, "Rank neighbours must belong to the same project")
    if above and below:
        if below.rank - above.rank < 1e-6:
            rebalance(db, project_id)
            above, below = db.get(Issue, above_id), db.get(Issue, below_id)
        return (above.rank + below.rank) / 2
    if above:
        return above.rank + RANK_STEP
    if below:
        return below.rank - RANK_STEP
    return _bottom_rank(db, project_id)


# ---------- create / update ----------


def _next_number(db: Session, project_id: int) -> tuple[Project, int]:
    # Row lock serialises concurrent creation so issue keys are unique and gapless.
    project = db.scalar(
        select(Project).where(Project.id == project_id).with_for_update().execution_options(populate_existing=True)
    )
    project.issue_seq += 1
    return project, project.issue_seq


def create_issue(db: Session, user: User, data: dict) -> Issue:
    project_id = data["project_id"]
    project = db.get(Project, project_id)
    if project.status == "archived":
        raise HTTPException(422, "Cannot create issues in an archived project")
    _validate_assignee(db, project_id, data.get("assignee_id"))
    _validate_parent(db, data["issue_type"], data.get("parent_id"), project_id, None)
    if data.get("issue_type") == "epic":
        data["sprint_id"] = None
    _validate_sprint(db, project_id, data.get("sprint_id"))
    status = _validate_status(db, project_id, data["status_id"]) if data.get("status_id") else initial_status(db, project_id)
    custom = _validate_custom_fields(db, project_id, data.get("custom_fields") or {}, creating=True)

    project, number = _next_number(db, project_id)
    issue = Issue(
        **{k: v for k, v in data.items() if k not in ("status_id", "custom_fields", "labels")},
        number=number,
        key=f"{project.key}-{number}",
        status_id=status.id,
        reporter_id=user.id,
        labels=_clean_labels(data.get("labels") or []),
        custom_fields=custom,
        rank=_bottom_rank(db, project_id),
        resolved_at=now() if status.category == "done" else None,
    )
    db.add(issue)
    db.flush()
    db.add(IssueHistory(issue_id=issue.id, project_id=project_id, actor_id=user.id, field="created",
                        new_value=issue.key, new_ref=status.id))
    if issue.sprint_id:
        record(db, issue, user, "sprint_id", None, issue.sprint_id)
    add_watcher(db, issue.id, user.id)
    add_watcher(db, issue.id, issue.assignee_id)
    if issue.assignee_id:
        notify(db, [issue.assignee_id], "assigned", f"{user.full_name} assigned {issue.key} to you: {issue.summary}",
               actor=user, issue=issue)
    mentioned = extract_mentions(db, issue.description, project_id)
    notify(db, [u.id for u in mentioned], "mention", f"{user.full_name} mentioned you in {issue.key}",
           actor=user, issue=issue)
    queue_event(db, "issue_created", project_id=project_id, issue_id=issue.id, key=issue.key, actor_id=user.id)
    return issue


TRACKED_FIELDS = (
    "issue_type", "summary", "description", "priority", "assignee_id", "parent_id", "sprint_id", "status_id",
    "story_points", "original_estimate_hours", "time_spent_hours", "start_date", "due_date", "labels",
    "custom_fields",
)


def update_issue(db: Session, user: User, issue: Issue, changes: dict) -> Issue:
    """Apply a partial update. `changes` contains only fields explicitly sent by the client."""
    version = changes.pop("version", None)
    if version is not None and version != issue.version:
        raise HTTPException(409, "This issue was modified by someone else. Reload to see the latest version.")

    project = db.get(Project, issue.project_id)
    only_status = set(changes) <= {"status_id"}
    if only_status:
        if not can_transition(db, user, issue):
            raise HTTPException(403, "You do not have permission to transition this issue")
    else:
        ensure_edit(db, user, issue)

    if "labels" in changes and changes["labels"] is not None:
        changes["labels"] = _clean_labels(changes["labels"])
    if "custom_fields" in changes and changes["custom_fields"] is not None:
        merged = {**(issue.custom_fields or {}), **_validate_custom_fields(db, issue.project_id, changes["custom_fields"], False)}
        changes["custom_fields"] = merged
    for required in ("summary", "issue_type", "priority", "status_id", "labels", "custom_fields"):
        if required in changes and changes[required] is None:
            changes.pop(required)

    new_type = changes.get("issue_type", issue.issue_type)
    if "issue_type" in changes or "parent_id" in changes:
        _validate_parent(db, new_type, changes.get("parent_id", issue.parent_id), issue.project_id, issue.id)
        if new_type == "epic" and db.scalar(select(func.count(Issue.id)).where(Issue.parent_id == issue.id, Issue.issue_type == "subtask")):
            raise HTTPException(422, "An issue with subtasks cannot become an epic")
        if issue.issue_type == "epic" and new_type != "epic" and issue.children:
            raise HTTPException(422, "Remove child issues before changing the type of an epic")
    if new_type == "epic" and changes.get("sprint_id"):
        raise HTTPException(422, "Epics cannot be added to sprints")
    if "assignee_id" in changes:
        _validate_assignee(db, issue.project_id, changes["assignee_id"])
    if "sprint_id" in changes:
        _validate_sprint(db, issue.project_id, changes["sprint_id"])
    status_changed = "status_id" in changes and changes["status_id"] != issue.status_id
    if status_changed:
        new_status = _validate_status(db, issue.project_id, changes["status_id"])
        check_transition(db, project, issue.status_id, new_status.id)

    diffs: list[tuple[str, Any, Any]] = []
    for field in TRACKED_FIELDS:
        if field in changes and changes[field] != getattr(issue, field):
            diffs.append((field, getattr(issue, field), changes[field]))
    if not diffs:
        return issue

    old_assignee, old_status = issue.assignee_id, issue.status
    for field, old, new in diffs:
        setattr(issue, field, new)
        record(db, issue, user, field, old, new)

    if status_changed:
        new_status = db.get(WorkflowStatus, issue.status_id)
        if new_status.category == "done" and old_status.category != "done":
            issue.resolved_at = now()
        elif new_status.category != "done":
            issue.resolved_at = None
    db.flush()

    watchers = watcher_ids(db, issue.id)
    if "assignee_id" in changes and issue.assignee_id != old_assignee:
        add_watcher(db, issue.id, issue.assignee_id)
        if issue.assignee_id:
            notify(db, [issue.assignee_id], "assigned", f"{user.full_name} assigned {issue.key} to you: {issue.summary}",
                   actor=user, issue=issue)
    if status_changed:
        notify(db, watchers, "status", f"{user.full_name} moved {issue.key} to {issue.status.name}", actor=user, issue=issue)
    elif any(f not in ("assignee_id",) for f, _, _ in diffs):
        changed = ", ".join(FIELD_NAMES.get(f, f).replace("_", " ") for f, _, _ in diffs)
        notify(db, watchers - {issue.assignee_id}, "updated", f"{user.full_name} updated {issue.key} ({changed})",
               actor=user, issue=issue)
    if "description" in changes:
        mentioned = extract_mentions(db, issue.description, issue.project_id)
        notify(db, [u.id for u in mentioned], "mention", f"{user.full_name} mentioned you in {issue.key}",
               actor=user, issue=issue)

    queue_event(db, "issue_updated", project_id=issue.project_id, issue_id=issue.id, key=issue.key,
                fields=[FIELD_NAMES.get(f, f) for f, _, _ in diffs], actor_id=user.id)
    return issue


def move_issue(db: Session, user: User, issue: Issue, *, status_id: int | None, sprint_id: int | None,
               move_sprint: bool, above_id: int | None, below_id: int | None) -> Issue:
    changes: dict[str, Any] = {}
    if status_id is not None and status_id != issue.status_id:
        changes["status_id"] = status_id
    if move_sprint and sprint_id != issue.sprint_id:
        if not (can(db, user, issue.project_id, Action.RANK_BACKLOG) or can(db, user, issue.project_id, Action.MANAGE_SPRINTS)):
            raise HTTPException(403, "You do not have permission to plan sprints")
        changes["sprint_id"] = sprint_id
    if changes:
        update_issue(db, user, issue, changes)
    if above_id or below_id:
        if not can(db, user, issue.project_id, Action.RANK_BACKLOG):
            raise HTTPException(403, "You do not have permission to rank issues")
        issue.rank = compute_rank(db, issue.project_id, above_id, below_id)
        queue_event(db, "issue_ranked", project_id=issue.project_id, issue_id=issue.id, actor_id=user.id)
    db.flush()
    return issue


def delete_issue(db: Session, user: User, issue: Issue) -> None:
    if not can(db, user, issue.project_id, Action.DELETE_ISSUE):
        raise HTTPException(403, "You do not have permission to delete issues")
    # Subtasks are deleted with their parent; epic children are detached (FK SET NULL).
    for child in list(issue.children):
        if child.issue_type == "subtask":
            db.delete(child)
    queue_event(db, "issue_deleted", project_id=issue.project_id, issue_id=issue.id, key=issue.key, actor_id=user.id)
    db.delete(issue)
    db.flush()
