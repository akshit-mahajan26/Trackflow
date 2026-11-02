"""Permanent removal of a person who has left (offboarding)."""

from fastapi import HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.models import Issue, IssueHistory, Notification, Project, ProjectMember, User, WorkflowStatus

FORMER_USER = "Former user"


def sole_manager_projects(db: Session, user_id: int) -> list[str]:
    """Projects where this user is the only Project Manager."""
    mine = select(ProjectMember.project_id).where(ProjectMember.user_id == user_id, ProjectMember.role == "project_manager")
    rows = db.execute(
        select(Project.key)
        .join(ProjectMember, ProjectMember.project_id == Project.id)
        .where(Project.id.in_(mine), ProjectMember.role == "project_manager")
        .group_by(Project.key)
        .having(func.count() == 1)
    ).scalars()
    return sorted(rows)


def delete_user(db: Session, actor: User, target: User) -> dict:
    """Remove the account and every place its name is shown; keep the team's work.

    Foreign keys do most of the work: memberships, watchers, notifications and saved filters cascade;
    comments, attachments, history and issues keep their rows with the person set to NULL ("Former user").
    """
    if target.id == actor.id:
        raise HTTPException(422, "You cannot delete your own account")
    if blocked := sole_manager_projects(db, target.id):
        raise HTTPException(422, f"{target.full_name} is the only Project Manager of {', '.join(blocked)}. "
                                 "Make someone else Project Manager there first.")

    open_assigned = db.scalars(
        select(Issue).join(WorkflowStatus, Issue.status_id == WorkflowStatus.id)
        .where(Issue.assignee_id == target.id, WorkflowStatus.category != "done")
    ).all()
    for issue in open_assigned:
        db.add(IssueHistory(issue_id=issue.id, project_id=issue.project_id, actor_id=actor.id, field="assignee",
                            old_value=FORMER_USER, new_value=None))

    # Scrub the name from history entries that recorded this person as an assignee value.
    db.execute(update(IssueHistory).where(IssueHistory.field == "assignee", IssueHistory.old_ref == target.id)
               .values(old_value=FORMER_USER, old_ref=None))
    db.execute(update(IssueHistory).where(IssueHistory.field == "assignee", IssueHistory.new_ref == target.id)
               .values(new_value=FORMER_USER, new_ref=None))
    # Notifications other people received mention the name in their text.
    db.execute(update(Notification).where(Notification.actor_id == target.id)
               .values(message=func.replace(Notification.message, target.full_name, FORMER_USER)))

    summary = {"unassigned_open_issues": len(open_assigned),
               "projects_left": db.scalar(select(func.count()).where(ProjectMember.user_id == target.id)) or 0}
    db.execute(delete(ProjectMember).where(ProjectMember.user_id == target.id))
    db.delete(target)  # FK rules null out authorship and assignment everywhere else
    db.flush()
    return summary

