from datetime import date, timedelta

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Issue, Project, Sprint, User, WorkflowStatus
from app.services.issues import record
from app.services.realtime import queue_event


def tx_now(db: Session):
    """Transaction timestamp — the same clock that stamps issue_history rows written in this transaction,
    so reports can order sprint start/completion exactly against the field changes it causes."""
    return db.scalar(select(func.now()))


def sprint_issues(db: Session, sprint_id: int) -> list[Issue]:
    return list(db.scalars(select(Issue).where(Issue.sprint_id == sprint_id).order_by(Issue.rank)))


def _is_done(issue: Issue) -> bool:
    return issue.status.category == "done"


def create_sprint(db: Session, project: Project, data: dict) -> Sprint:
    if not data.get("name"):
        count = db.scalar(select(func.count(Sprint.id)).where(Sprint.project_id == project.id)) or 0
        data["name"] = f"{project.key} Sprint {count + 1}"
    _check_dates(data.get("start_date"), data.get("end_date"))
    sprint = Sprint(project_id=project.id, state="future", **data)
    db.add(sprint)
    db.flush()
    queue_event(db, "sprint_changed", project_id=project.id, sprint_id=sprint.id)
    return sprint


def _check_dates(start: date | None, end: date | None) -> None:
    if start and end and end < start:
        raise HTTPException(422, "Sprint end date must be on or after the start date")


def update_sprint(db: Session, sprint: Sprint, data: dict) -> Sprint:
    if sprint.state == "closed":
        raise HTTPException(422, "Closed sprints cannot be edited")
    for k, v in data.items():
        if k == "name" and v is None:
            continue
        setattr(sprint, k, v)
    _check_dates(sprint.start_date, sprint.end_date)
    queue_event(db, "sprint_changed", project_id=sprint.project_id, sprint_id=sprint.id)
    return sprint


def start_sprint(db: Session, user: User, sprint: Sprint, data: dict) -> Sprint:
    if sprint.state != "future":
        raise HTTPException(422, "Only future sprints can be started")
    # Lock the project row so two managers cannot start sprints at the same time.
    db.scalar(select(Project).where(Project.id == sprint.project_id).with_for_update()
              .execution_options(populate_existing=True))
    active = db.scalar(select(Sprint.id).where(Sprint.project_id == sprint.project_id, Sprint.state == "active"))
    if active:
        raise HTTPException(409, "Another sprint is already active in this project. Complete it first.")
    issues = sprint_issues(db, sprint.id)
    if not issues:
        raise HTTPException(422, "Add at least one issue to the sprint before starting it")
    sprint.start_date = data.get("start_date") or sprint.start_date or date.today()
    sprint.end_date = data.get("end_date") or sprint.end_date or (sprint.start_date + timedelta(days=14))
    if data.get("goal") is not None:
        sprint.goal = data["goal"]
    _check_dates(sprint.start_date, sprint.end_date)
    sprint.state = "active"
    sprint.started_at = tx_now(db)
    sprint.committed_points = sum(i.story_points or 0 for i in issues)
    sprint.committed_issue_ids = [i.id for i in issues]
    queue_event(db, "sprint_changed", project_id=sprint.project_id, sprint_id=sprint.id, state="active")
    return sprint


def complete_sprint(db: Session, user: User, sprint: Sprint, move_to: int | None) -> dict:
    if sprint.state != "active":
        raise HTTPException(422, "Only the active sprint can be completed")
    target = None
    if move_to is not None:
        target = db.get(Sprint, move_to)
        if not target or target.project_id != sprint.project_id or target.state != "future":
            raise HTTPException(422, "Incomplete issues can only move to a future sprint in this project")
    issues = sprint_issues(db, sprint.id)
    done = [i for i in issues if _is_done(i)]
    incomplete = [i for i in issues if not _is_done(i)]
    for issue in incomplete:
        record(db, issue, user, "sprint_id", sprint.id, target.id if target else None)
        issue.sprint_id = target.id if target else None
    sprint.state = "closed"
    sprint.completed_at = tx_now(db)
    sprint.completed_points = sum(i.story_points or 0 for i in done)
    sprint.completed_issue_ids = [i.id for i in done]
    db.flush()
    queue_event(db, "sprint_changed", project_id=sprint.project_id, sprint_id=sprint.id, state="closed")
    return {"completed": len(done), "incomplete": len(incomplete), "moved_to": target.id if target else None}


def delete_sprint(db: Session, user: User, sprint: Sprint) -> None:
    if sprint.state != "future":
        raise HTTPException(422, "Only future sprints can be deleted")
    for issue in sprint_issues(db, sprint.id):
        record(db, issue, user, "sprint_id", sprint.id, None)
        issue.sprint_id = None
    queue_event(db, "sprint_changed", project_id=sprint.project_id, sprint_id=sprint.id)
    db.delete(sprint)


def sprint_stats(db: Session, sprint: Sprint) -> dict:
    rows = db.execute(
        select(WorkflowStatus.category, func.count(Issue.id), func.coalesce(func.sum(Issue.story_points), 0))
        .join(WorkflowStatus, Issue.status_id == WorkflowStatus.id)
        .where(Issue.sprint_id == sprint.id)
        .group_by(WorkflowStatus.category)
    ).all()
    total = sum(r[1] for r in rows)
    pts = sum(float(r[2]) for r in rows)
    done = next(((r[1], float(r[2])) for r in rows if r[0] == "done"), (0, 0.0))
    return {"issue_count": total, "done_count": done[0], "total_points": pts, "done_points": done[1]}
