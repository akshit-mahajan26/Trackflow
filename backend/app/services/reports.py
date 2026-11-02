"""Agile reports computed from persisted issues and their change history.

Historical state is reconstructed by "rolling back" each issue's current value:
the value of a field at time t is the old value of the first change after t,
or the current value if nothing changed after t.
"""

import statistics
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import Issue, IssueHistory, Project, Sprint, WorkflowStatus

UTC = timezone.utc


def _end_of_day(d: date) -> datetime:
    return datetime.combine(d, time.max, tzinfo=UTC)


def _days(start: date, end: date) -> list[date]:
    n = (end - start).days
    return [start + timedelta(days=i) for i in range(max(n, 0) + 1)]


class Timeline:
    """Per-issue field history for point-in-time reconstruction."""

    def __init__(self, db: Session, issues: list[Issue], fields: tuple[str, ...]):
        self.issues = issues
        self.changes: dict[tuple[int, str], list[IssueHistory]] = defaultdict(list)
        ids = [i.id for i in issues]
        if ids:
            rows = db.scalars(
                select(IssueHistory)
                .where(IssueHistory.issue_id.in_(ids), IssueHistory.field.in_(fields))
                .order_by(IssueHistory.created_at, IssueHistory.id)
            )
            for h in rows:
                self.changes[(h.issue_id, h.field)].append(h)

    def value_at(self, issue: Issue, field: str, t: datetime, current, ref: bool = True):
        for h in self.changes.get((issue.id, field), ()):
            if h.created_at > t:
                if ref:
                    return h.old_ref
                return _num(h.old_value)
        return current

    def exists_at(self, issue: Issue, t: datetime) -> bool:
        return issue.created_at <= t


def _num(v: str | None) -> float | None:
    if v in (None, ""):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _status_categories(db: Session, project_id: int) -> dict[int, str]:
    return dict(db.execute(select(WorkflowStatus.id, WorkflowStatus.category).where(WorkflowStatus.project_id == project_id)).all())


def _sprint_window(sprint: Sprint) -> tuple[date, date]:
    start = sprint.start_date or (sprint.started_at.date() if sprint.started_at else date.today())
    planned_end = sprint.end_date or start + timedelta(days=14)
    end = sprint.completed_at.date() if sprint.completed_at else min(max(planned_end, start), max(date.today(), start))
    if sprint.state == "active":
        end = max(planned_end, start)
    return start, end


def _sprint_candidates(db: Session, sprint: Sprint) -> list[Issue]:
    touched = select(IssueHistory.issue_id).where(
        IssueHistory.field == "sprint", or_(IssueHistory.old_ref == sprint.id, IssueHistory.new_ref == sprint.id)
    )
    return list(db.scalars(select(Issue).where(or_(Issue.sprint_id == sprint.id, Issue.id.in_(touched)))))


def sprint_series(db: Session, sprint: Sprint) -> dict:
    """Daily scope / completed / remaining points for burndown + burnup."""
    issues = _sprint_candidates(db, sprint)
    cats = _status_categories(db, sprint.project_id)
    tl = Timeline(db, issues, ("sprint", "status", "story_points"))
    start, end = _sprint_window(sprint)
    today = date.today()
    days = _days(start, end)
    series = []
    for d in days:
        if d > today and sprint.state != "closed":
            series.append({"date": d.isoformat(), "remaining": None, "completed": None, "scope": None})
            continue
        t = _end_of_day(d)
        if sprint.completed_at and d == sprint.completed_at.date():
            t = sprint.completed_at - timedelta(microseconds=1)
        scope = completed = 0.0
        scope_count = done_count = 0
        for issue in issues:
            if not tl.exists_at(issue, t):
                continue
            if tl.value_at(issue, "sprint", t, issue.sprint_id) != sprint.id:
                continue
            pts = tl.value_at(issue, "story_points", t, issue.story_points, ref=False) or 0
            status_id = tl.value_at(issue, "status", t, issue.status_id)
            scope += pts
            scope_count += 1
            if cats.get(status_id) == "done":
                completed += pts
                done_count += 1
        series.append({
            "date": d.isoformat(), "scope": scope, "completed": completed, "remaining": scope - completed,
            "scope_count": scope_count, "done_count": done_count,
        })
    if sprint.committed_points is not None:
        initial = sprint.committed_points
    else:
        initial = (series[0]["scope"] or 0) if series else 0
    n = len(days) - 1
    for i, row in enumerate(series):
        row["ideal"] = round(initial - (initial * i / n), 2) if n > 0 else 0
    return {
        "sprint": {"id": sprint.id, "name": sprint.name, "state": sprint.state, "goal": sprint.goal,
                   "start_date": start.isoformat(), "end_date": end.isoformat()},
        "committed_points": sprint.committed_points,
        "series": series,
    }


def velocity(db: Session, project_id: int, limit: int = 10) -> list[dict]:
    sprints = db.scalars(
        select(Sprint).where(Sprint.project_id == project_id, Sprint.state == "closed")
        .order_by(Sprint.completed_at.desc()).limit(limit)
    ).all()
    return [
        {"sprint_id": s.id, "name": s.name, "committed": s.committed_points or 0, "completed": s.completed_points or 0,
         "completed_at": s.completed_at.isoformat() if s.completed_at else None}
        for s in reversed(sprints)
    ]


def cumulative_flow(db: Session, project_id: int, start: date, end: date) -> dict:
    statuses = db.scalars(select(WorkflowStatus).where(WorkflowStatus.project_id == project_id).order_by(WorkflowStatus.position)).all()
    issues = list(db.scalars(select(Issue).where(Issue.project_id == project_id, Issue.issue_type != "epic",
                                                Issue.created_at <= _end_of_day(end))))
    tl = Timeline(db, issues, ("status",))
    names = {s.id: s.name for s in statuses}
    series = []
    for d in _days(start, end):
        t = _end_of_day(d)
        counts = {s.name: 0 for s in statuses}
        for issue in issues:
            if not tl.exists_at(issue, t):
                continue
            sid = tl.value_at(issue, "status", t, issue.status_id)
            if sid in names:
                counts[names[sid]] += 1
        series.append({"date": d.isoformat(), **counts})
    return {"statuses": [{"name": s.name, "category": s.category} for s in statuses], "series": series}


def resolution_time(db: Session, project_id: int, start: date, end: date) -> dict:
    issues = db.scalars(
        select(Issue).where(
            Issue.project_id == project_id, Issue.resolved_at.is_not(None),
            Issue.resolved_at >= datetime.combine(start, time.min, tzinfo=UTC), Issue.resolved_at <= _end_of_day(end),
        )
    ).all()

    def hours(i: Issue) -> float:
        return max((i.resolved_at - i.created_at).total_seconds() / 3600, 0)

    def summarize(group: list[Issue]) -> dict:
        hs = [hours(i) for i in group]
        return {"count": len(hs), "avg_hours": round(statistics.fmean(hs), 1) if hs else 0,
                "median_hours": round(statistics.median(hs), 1) if hs else 0}

    by_type: dict[str, list[Issue]] = defaultdict(list)
    by_priority: dict[str, list[Issue]] = defaultdict(list)
    for i in issues:
        by_type[i.issue_type].append(i)
        by_priority[i.priority].append(i)
    buckets = [("< 1 day", 24), ("1-3 days", 72), ("3-7 days", 168), ("1-2 weeks", 336), ("2-4 weeks", 672), ("> 4 weeks", None)]
    dist = []
    lower = 0.0
    for label, upper in buckets:
        dist.append({"bucket": label, "count": sum(1 for i in issues if hours(i) >= lower and (upper is None or hours(i) < upper))})
        lower = upper or lower
    weekly: dict[str, list[float]] = defaultdict(list)
    for i in issues:
        wk = (i.resolved_at.date() - timedelta(days=i.resolved_at.weekday())).isoformat()
        weekly[wk].append(hours(i))
    return {
        "overall": summarize(list(issues)),
        "by_type": [{"key": k, **summarize(v)} for k, v in sorted(by_type.items())],
        "by_priority": [{"key": k, **summarize(v)} for k, v in by_priority.items()],
        "distribution": dist,
        "weekly": [{"week": k, "avg_hours": round(statistics.fmean(v), 1), "count": len(v)} for k, v in sorted(weekly.items())],
    }


def project_completion(db: Session, project: Project) -> dict:
    rows = db.execute(
        select(WorkflowStatus.category, func.count(Issue.id), func.coalesce(func.sum(Issue.story_points), 0))
        .join(WorkflowStatus, Issue.status_id == WorkflowStatus.id)
        .where(Issue.project_id == project.id, Issue.issue_type != "epic")
        .group_by(WorkflowStatus.category)
    ).all()
    by_cat = {r[0]: {"count": r[1], "points": float(r[2])} for r in rows}
    total = sum(v["count"] for v in by_cat.values())
    done = by_cat.get("done", {}).get("count", 0)
    total_pts = sum(v["points"] for v in by_cat.values())
    done_pts = by_cat.get("done", {}).get("points", 0)

    epics = db.scalars(select(Issue).where(Issue.project_id == project.id, Issue.issue_type == "epic").order_by(Issue.rank)).all()
    epic_rows = []
    for e in epics:
        child = db.execute(
            select(func.count(Issue.id), func.count(Issue.id).filter(WorkflowStatus.category == "done"),
                   func.coalesce(func.sum(Issue.story_points), 0),
                   func.coalesce(func.sum(Issue.story_points).filter(WorkflowStatus.category == "done"), 0))
            .join(WorkflowStatus, Issue.status_id == WorkflowStatus.id)
            .where(Issue.parent_id == e.id)
        ).one()
        epic_rows.append({"id": e.id, "key": e.key, "summary": e.summary, "total": child[0], "done": child[1],
                          "points": float(child[2]), "done_points": float(child[3]),
                          "due_date": e.due_date.isoformat() if e.due_date else None})

    # Weekly created vs resolved for the last 12 weeks, and a throughput-based forecast.
    since = date.today() - timedelta(weeks=12)
    since_dt = datetime.combine(since, time.min, tzinfo=UTC)
    week = func.date_trunc("week", Issue.created_at)
    created = dict(db.execute(select(week, func.count()).where(Issue.project_id == project.id, Issue.created_at >= since_dt)
                              .group_by(week)).all())
    rweek = func.date_trunc("week", Issue.resolved_at)
    resolved = dict(db.execute(select(rweek, func.count()).where(Issue.project_id == project.id, Issue.resolved_at >= since_dt)
                               .group_by(rweek)).all())
    weeks = sorted(set(created) | set(resolved))
    trend = [{"week": w.date().isoformat(), "created": created.get(w, 0), "resolved": resolved.get(w, 0)} for w in weeks]
    throughput = sum(resolved.values()) / 12
    remaining = total - done
    forecast = (date.today() + timedelta(weeks=remaining / throughput)).isoformat() if throughput > 0 and remaining > 0 else None

    return {
        "total_issues": total, "done_issues": done, "total_points": total_pts, "done_points": done_pts,
        "percent_complete": round(done * 100 / total, 1) if total else 0,
        "by_category": by_cat, "epics": epic_rows, "trend": trend,
        "weekly_throughput": round(throughput, 2), "forecast_completion": forecast,
        "due_date": project.due_date.isoformat() if project.due_date else None,
    }
