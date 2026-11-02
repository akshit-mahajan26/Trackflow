from datetime import date, timedelta

from sqlalchemy import false, func, select
from sqlalchemy.orm import Session

from app.models import Issue, IssueHistory, Project, Sprint, User, WorkflowStatus
from app.services.sprints import sprint_stats


def _scope(q, project_ids: list[int] | None):
    if project_ids is None:
        return q
    return q.where(Issue.project_id.in_(project_ids) if project_ids else false())


def dashboard(db: Session, user: User, project_ids: list[int] | None) -> dict:
    """Aggregate metrics over the given projects (None = all projects)."""
    today = date.today()
    base = select(func.count(Issue.id)).join(WorkflowStatus, Issue.status_id == WorkflowStatus.id).where(Issue.issue_type != "epic")
    base = _scope(base, project_ids)
    open_ = WorkflowStatus.category != "done"

    counts = {
        "total": db.scalar(base) or 0,
        "open": db.scalar(base.where(open_)) or 0,
        "in_progress": db.scalar(base.where(WorkflowStatus.category == "in_progress")) or 0,
        "done": db.scalar(base.where(WorkflowStatus.category == "done")) or 0,
        "overdue": db.scalar(base.where(open_, Issue.due_date < today)) or 0,
        "due_this_week": db.scalar(base.where(open_, Issue.due_date >= today, Issue.due_date <= today + timedelta(days=7))) or 0,
        "assigned_to_me": db.scalar(base.where(open_, Issue.assignee_id == user.id)) or 0,
        "unassigned": db.scalar(base.where(open_, Issue.assignee_id.is_(None))) or 0,
    }

    def group(col):
        q = select(col, func.count(Issue.id)).join(WorkflowStatus, Issue.status_id == WorkflowStatus.id).where(Issue.issue_type != "epic")
        return [{"key": k, "count": c} for k, c in db.execute(_scope(q, project_ids).group_by(col)).all()]

    by_category = group(WorkflowStatus.category)
    by_type = group(Issue.issue_type)
    by_priority = group(Issue.priority)
    workload_q = (
        select(User.id, User.full_name, User.avatar_color, func.count(Issue.id), func.coalesce(func.sum(Issue.story_points), 0))
        .join(Issue, Issue.assignee_id == User.id)
        .join(WorkflowStatus, Issue.status_id == WorkflowStatus.id)
        .where(open_)
        .group_by(User.id)
        .order_by(func.count(Issue.id).desc())
    )
    workload = [
        {"user_id": r[0], "name": r[1], "avatar_color": r[2], "open_issues": r[3], "open_points": float(r[4])}
        for r in db.execute(_scope(workload_q, project_ids)).all()
    ]

    sprint_q = select(Sprint).where(Sprint.state == "active")
    if project_ids is not None:
        sprint_q = sprint_q.where(Sprint.project_id.in_(project_ids) if project_ids else false())
    keys = dict(db.execute(select(Project.id, Project.key)).all())
    active_sprints = []
    for s in db.scalars(sprint_q.order_by(Sprint.end_date)):
        stats = sprint_stats(db, s)
        active_sprints.append({"id": s.id, "name": s.name, "project_id": s.project_id, "project_key": keys.get(s.project_id),
                               "goal": s.goal, "end_date": s.end_date.isoformat() if s.end_date else None,
                               "days_left": (s.end_date - today).days if s.end_date else None, **stats})

    def issue_rows(q, limit=10):
        rows = db.scalars(_scope(q, project_ids).limit(limit)).all()
        return [{"id": i.id, "key": i.key, "summary": i.summary, "issue_type": i.issue_type, "priority": i.priority,
                 "status": i.status.name, "status_category": i.status.category,
                 "due_date": i.due_date.isoformat() if i.due_date else None,
                 "assignee": i.assignee.full_name if i.assignee else None} for i in rows]

    issue_base = select(Issue).join(WorkflowStatus, Issue.status_id == WorkflowStatus.id).where(open_)
    upcoming = issue_rows(issue_base.where(Issue.due_date >= today).order_by(Issue.due_date))
    overdue = issue_rows(issue_base.where(Issue.due_date < today).order_by(Issue.due_date))
    mine = issue_rows(issue_base.where(Issue.assignee_id == user.id).order_by(Issue.due_date.asc().nulls_last(), Issue.rank), 15)

    # Created vs resolved per day over the last 14 days.
    since = today - timedelta(days=13)
    day_c = func.date(Issue.created_at)
    day_r = func.date(Issue.resolved_at)
    created = dict(db.execute(_scope(select(day_c, func.count()).where(day_c >= since), project_ids).group_by(day_c)).all())
    resolved = dict(db.execute(_scope(select(day_r, func.count()).where(day_r >= since), project_ids).group_by(day_r)).all())
    trend = [{"date": (since + timedelta(days=i)).isoformat(),
              "created": created.get(since + timedelta(days=i), 0),
              "resolved": resolved.get(since + timedelta(days=i), 0)} for i in range(14)]

    hist_q = select(IssueHistory).order_by(IssueHistory.created_at.desc()).limit(20)
    if project_ids is not None:
        hist_q = hist_q.where(IssueHistory.project_id.in_(project_ids) if project_ids else false())
    activity = []
    for h in db.scalars(hist_q):
        issue = db.get(Issue, h.issue_id)
        activity.append({"id": h.id, "issue_key": issue.key, "issue_summary": issue.summary, "field": h.field,
                         "old_value": h.old_value, "new_value": h.new_value,
                         "actor": h.actor.full_name if h.actor else None, "created_at": h.created_at.isoformat()})

    return {"counts": counts, "by_category": by_category, "by_type": by_type, "by_priority": by_priority,
            "workload": workload, "active_sprints": active_sprints, "upcoming": upcoming, "overdue": overdue,
            "my_issues": mine, "trend": trend, "activity": activity}
