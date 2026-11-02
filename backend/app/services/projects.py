from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Issue, IssueHistory, Project, ProjectMember, User, WorkflowStatus, WorkflowTransition

DEFAULT_STATUSES = [
    ("To Do", "todo"),
    ("In Progress", "in_progress"),
    ("In Review", "in_progress"),
    ("Done", "done"),
]


def create_project(db: Session, creator: User, data: dict) -> Project:
    if db.scalar(select(Project.id).where(Project.key == data["key"])):
        raise HTTPException(409, f"Project key '{data['key']}' is already in use")
    lead_id = data.get("lead_id") or creator.id
    if not db.get(User, lead_id):
        raise HTTPException(422, "Lead user does not exist")
    project = Project(**{**data, "lead_id": lead_id}, settings={"enforce_transitions": False})
    db.add(project)
    db.flush()
    for pos, (name, cat) in enumerate(DEFAULT_STATUSES):
        db.add(WorkflowStatus(project_id=project.id, name=name, category=cat, position=pos))
    db.add(ProjectMember(project_id=project.id, user_id=creator.id, role="project_manager"))
    if lead_id != creator.id:
        db.add(ProjectMember(project_id=project.id, user_id=lead_id, role="project_manager"))
    db.flush()
    return project


def ordered_statuses(db: Session, project_id: int) -> list[WorkflowStatus]:
    return list(
        db.scalars(
            select(WorkflowStatus).where(WorkflowStatus.project_id == project_id).order_by(WorkflowStatus.position)
        )
    )


def initial_status(db: Session, project_id: int) -> WorkflowStatus:
    statuses = ordered_statuses(db, project_id)
    if not statuses:
        raise HTTPException(409, "Project has no workflow statuses")
    return next((s for s in statuses if s.category == "todo"), statuses[0])


def allowed_targets(db: Session, project: Project, from_status_id: int) -> list[WorkflowStatus]:
    statuses = ordered_statuses(db, project.id)
    if not (project.settings or {}).get("enforce_transitions"):
        return [s for s in statuses if s.id != from_status_id]
    allowed = set(
        db.scalars(
            select(WorkflowTransition.to_status_id).where(
                WorkflowTransition.project_id == project.id, WorkflowTransition.from_status_id == from_status_id
            )
        )
    )
    return [s for s in statuses if s.id in allowed]


def check_transition(db: Session, project: Project, from_status_id: int, to_status_id: int) -> None:
    if from_status_id == to_status_id:
        return
    if to_status_id not in {s.id for s in allowed_targets(db, project, from_status_id)}:
        raise HTTPException(422, "This status transition is not allowed by the project workflow")


def delete_status(db: Session, status: WorkflowStatus, fallback_id: int | None, actor: User | None = None) -> None:
    in_use = db.scalar(select(func.count(Issue.id)).where(Issue.status_id == status.id))
    remaining = [s for s in ordered_statuses(db, status.project_id) if s.id != status.id]
    if not remaining:
        raise HTTPException(422, "A project must keep at least one status")
    if in_use:
        target = next((s for s in remaining if s.id == fallback_id), None)
        if not target:
            raise HTTPException(422, f"{in_use} issue(s) use this status; choose a status to move them to")
        for issue in db.scalars(select(Issue).where(Issue.status_id == status.id)):
            issue.status_id = target.id
            db.add(
                IssueHistory(
                    issue_id=issue.id, project_id=issue.project_id, actor_id=actor.id if actor else None,
                    field="status", old_value=status.name, new_value=target.name,
                    old_ref=status.id, new_ref=target.id,
                )
            )
        db.flush()
    db.delete(status)
    db.flush()
    for pos, s in enumerate(remaining):
        s.position = pos
