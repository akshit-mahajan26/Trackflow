from datetime import timedelta

from fastapi import APIRouter, Request
from sqlalchemy import or_, select
from sqlalchemy.orm import joinedload

from app import schemas
from app.api.deps import DB, CurrentUser, get_project_or_404
from app.api.issues import _filters_from_request
from app.api.serializers import issue_list
from app.models import Issue, Sprint, WorkflowStatus
from app.services.issues import now
from app.services.projects import ordered_statuses
from app.services.search import build_issue_query
from app.services.sprints import sprint_stats

router = APIRouter(prefix="/projects/{ref}", tags=["boards"])


@router.get("/board")
def board(ref: str, request: Request, db: DB, user: CurrentUser, sprint_id: int | None = None):
    """Scrum board = issues of the active (or given) sprint. Kanban board = all non-epic issues,
    hiding items resolved more than `done_days` ago."""
    project = get_project_or_404(db, user, ref)
    f = _filters_from_request(request)
    f["project_ids"] = [project.id]
    q = build_issue_query(f, user, None).where(Issue.issue_type != "epic")
    sprint = None
    if project.board_type == "scrum":
        sprint = db.get(Sprint, sprint_id) if sprint_id else db.scalar(
            select(Sprint).where(Sprint.project_id == project.id, Sprint.state == "active"))
        if not sprint or sprint.project_id != project.id:
            return {"project_id": project.id, "board_type": "scrum", "sprint": None,
                    "columns": [schemas.StatusOut.model_validate(s) for s in ordered_statuses(db, project.id)], "issues": []}
        q = q.where(Issue.sprint_id == sprint.id)
    else:
        done_days = int((project.settings or {}).get("kanban_done_days", 14))
        q = q.where(or_(Issue.resolved_at.is_(None), Issue.resolved_at >= now() - timedelta(days=done_days)))
    issues = db.scalars(q.options(joinedload(Issue.status), joinedload(Issue.assignee), joinedload(Issue.reporter))).unique().all()
    return {
        "project_id": project.id,
        "board_type": project.board_type,
        "sprint": ({**schemas.SprintOut.model_validate(sprint).model_dump(mode="json"), **sprint_stats(db, sprint)}
                   if sprint else None),
        "columns": [schemas.StatusOut.model_validate(s) for s in ordered_statuses(db, project.id)],
        "issues": issue_list(db, list(issues)),
    }


@router.get("/backlog")
def backlog(ref: str, request: Request, db: DB, user: CurrentUser):
    """Backlog view: active + future sprints with their issues, then unplanned backlog issues (rank order)."""
    project = get_project_or_404(db, user, ref)
    f = _filters_from_request(request)
    f["project_ids"] = [project.id]
    base = build_issue_query(f, user, None).where(Issue.issue_type.not_in(["epic", "subtask"]))
    sprints = db.scalars(select(Sprint).where(Sprint.project_id == project.id, Sprint.state != "closed")
                         .order_by(Sprint.state != "active", Sprint.id)).all()
    opts = (joinedload(Issue.status), joinedload(Issue.assignee), joinedload(Issue.reporter))
    out_sprints = []
    for s in sprints:
        items = db.scalars(base.where(Issue.sprint_id == s.id).options(*opts)).unique().all()
        out_sprints.append({**schemas.SprintOut.model_validate(s).model_dump(mode="json"), **sprint_stats(db, s),
                            "issues": issue_list(db, list(items))})
    backlog_items = db.scalars(base.where(Issue.sprint_id.is_(None)).options(*opts)).unique().all()
    epics = db.scalars(select(Issue).where(Issue.project_id == project.id, Issue.issue_type == "epic")
                       .join(WorkflowStatus, Issue.status_id == WorkflowStatus.id).order_by(Issue.rank)).all()
    return {"sprints": out_sprints, "backlog": issue_list(db, list(backlog_items)), "epics": issue_list(db, list(epics))}
