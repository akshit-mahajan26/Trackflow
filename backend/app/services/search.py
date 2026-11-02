"""Issue filter engine shared by list views, saved filters, CSV export and dashboards.

A filter is a plain dict (so it can be stored in SavedFilter.query) with keys:
  project_ids, issue_types, status_ids, status_categories, priorities,
  assignee_ids (ints or "me" / "none"), reporter_ids, sprint_ids (ints or "none" / "active"),
  parent_id, epic_id, labels, text, due_from, due_to, overdue, created_from, created_to,
  resolved (bool), sort, order
"""

from datetime import date, datetime, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import Select, and_, asc, cast, desc, false, func, or_, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session, joinedload

from app.models import Issue, Sprint, User, WorkflowStatus

SORTS = {
    "rank": Issue.rank,
    "created": Issue.created_at,
    "updated": Issue.updated_at,
    "due": Issue.due_date,
    "priority": func.array_position(func.string_to_array("highest,high,medium,low,lowest", ","), Issue.priority),
    "key": Issue.number,
    "points": Issue.story_points,
    "summary": Issue.summary,
}


def _as_list(v: Any) -> list:
    if v is None or v == "":
        return []
    if isinstance(v, list | tuple | set):
        return [x for x in v if x not in (None, "")]
    if isinstance(v, str) and "," in v:
        return [x for x in v.split(",") if x]
    return [v]


def _ints(values: list) -> list[int]:
    out = []
    for v in values:
        try:
            out.append(int(v))
        except (TypeError, ValueError):
            continue
    return out


def _date(v: Any) -> date | None:
    if not v:
        return None
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        raise HTTPException(422, f"Invalid date: {v}") from None


def build_issue_query(f: dict, user: User, accessible: list[int] | None) -> Select:
    q = select(Issue).join(WorkflowStatus, Issue.status_id == WorkflowStatus.id)
    if accessible is not None:
        q = q.where(Issue.project_id.in_(accessible) if accessible else false())

    if pids := _ints(_as_list(f.get("project_ids"))):
        q = q.where(Issue.project_id.in_(pids))
    if types := _as_list(f.get("issue_types")):
        q = q.where(Issue.issue_type.in_(types))
    if sids := _ints(_as_list(f.get("status_ids"))):
        q = q.where(Issue.status_id.in_(sids))
    if cats := _as_list(f.get("status_categories")):
        q = q.where(WorkflowStatus.category.in_(cats))
    if prios := _as_list(f.get("priorities")):
        q = q.where(Issue.priority.in_(prios))

    for col, key in ((Issue.assignee_id, "assignee_ids"), (Issue.reporter_id, "reporter_ids")):
        vals = _as_list(f.get(key))
        if vals:
            ids = _ints([user.id if v == "me" else v for v in vals])
            conds = [col.in_(ids)] if ids else []
            if "none" in vals:
                conds.append(col.is_(None))
            q = q.where(or_(*conds) if conds else false())

    if sprints := _as_list(f.get("sprint_ids")):
        conds = []
        if ids := _ints(sprints):
            conds.append(Issue.sprint_id.in_(ids))
        if "none" in sprints:
            conds.append(Issue.sprint_id.is_(None))
        if "active" in sprints:
            conds.append(Issue.sprint_id.in_(select(Sprint.id).where(Sprint.state == "active")))
        q = q.where(or_(*conds) if conds else false())

    if f.get("parent_id"):
        q = q.where(Issue.parent_id == int(f["parent_id"]))
    if f.get("epic_id"):
        epic_id = int(f["epic_id"])
        children = select(Issue.id).where(Issue.parent_id == epic_id)
        q = q.where(or_(Issue.parent_id == epic_id, Issue.parent_id.in_(children)))
    if labels := _as_list(f.get("labels")):
        q = q.where(or_(*[Issue.labels.op("@>")(cast([lbl], JSONB)) for lbl in labels]))
    if text := (f.get("text") or "").strip():
        like = f"%{text.replace('%', r'\%').replace('_', r'\_')}%"
        q = q.where(or_(Issue.summary.ilike(like), Issue.description.ilike(like), Issue.key.ilike(like)))

    if d := _date(f.get("due_from")):
        q = q.where(Issue.due_date >= d)
    if d := _date(f.get("due_to")):
        q = q.where(Issue.due_date <= d)
    if f.get("overdue") in (True, "true", "1", 1):
        q = q.where(and_(Issue.due_date < date.today(), WorkflowStatus.category != "done"))
    if d := _date(f.get("created_from")):
        q = q.where(Issue.created_at >= datetime.combine(d, datetime.min.time()))
    if d := _date(f.get("created_to")):
        q = q.where(Issue.created_at < datetime.combine(d + timedelta(days=1), datetime.min.time()))
    resolved = f.get("resolved")
    if resolved in (True, "true", "1", 1):
        q = q.where(WorkflowStatus.category == "done")
    elif resolved in (False, "false", "0", 0):
        q = q.where(WorkflowStatus.category != "done")

    sort_col = SORTS.get(f.get("sort") or "rank", Issue.rank)
    direction = desc if (f.get("order") or "asc") == "desc" else asc
    return q.order_by(direction(sort_col).nulls_last(), Issue.id)


def run_issue_query(db: Session, q: Select, page: int, page_size: int) -> tuple[list[Issue], int]:
    total = db.scalar(select(func.count()).select_from(q.order_by(None).subquery()))
    items = db.scalars(
        q.options(joinedload(Issue.status), joinedload(Issue.assignee), joinedload(Issue.reporter))
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).unique().all()
    return list(items), total or 0
