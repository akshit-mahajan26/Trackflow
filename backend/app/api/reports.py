import csv
import io
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select

from app.api.deps import DB, CurrentUser, ensure, get_project_or_404
from app.core.permissions import Action
from app.models import Sprint
from app.services import reports as svc

router = APIRouter(tags=["reports"])


def _range(start: date | None, end: date | None, default_days: int = 30) -> tuple[date, date]:
    end = end or date.today()
    start = start or end - timedelta(days=default_days - 1)
    if start > end:
        raise HTTPException(422, "start must be before end")
    if (end - start).days > 366:
        raise HTTPException(422, "Date range is limited to one year")
    return start, end


def _sprint(db, user, sprint_id: int) -> Sprint:
    s = db.get(Sprint, sprint_id)
    if not s:
        raise HTTPException(404, "Sprint not found")
    ensure(db, user, s.project_id, Action.VIEW_PROJECT)
    return s


@router.get("/sprints/{sprint_id}/report")
def sprint_report(sprint_id: int, db: DB, user: CurrentUser):
    """Burndown and burnup share the same series (scope / completed / remaining / ideal)."""
    return svc.sprint_series(db, _sprint(db, user, sprint_id))


@router.get("/projects/{ref}/reports/velocity")
def velocity(ref: str, db: DB, user: CurrentUser, limit: int = 10):
    project = get_project_or_404(db, user, ref)
    return svc.velocity(db, project.id, min(limit, 50))


@router.get("/projects/{ref}/reports/cumulative-flow")
def cumulative_flow(ref: str, db: DB, user: CurrentUser, start: date | None = None, end: date | None = None):
    project = get_project_or_404(db, user, ref)
    return svc.cumulative_flow(db, project.id, *_range(start, end))


@router.get("/projects/{ref}/reports/resolution-time")
def resolution_time(ref: str, db: DB, user: CurrentUser, start: date | None = None, end: date | None = None):
    project = get_project_or_404(db, user, ref)
    return svc.resolution_time(db, project.id, *_range(start, end, 90))


@router.get("/projects/{ref}/reports/completion")
def completion(ref: str, db: DB, user: CurrentUser):
    return svc.project_completion(db, get_project_or_404(db, user, ref))


def _csv(rows: list[dict], filename: str) -> StreamingResponse:
    buf = io.StringIO()
    if rows:
        w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.get("/projects/{ref}/reports/{kind}.csv")
def report_csv(ref: str, kind: str, db: DB, user: CurrentUser, sprint_id: int | None = None,
               start: date | None = None, end: date | None = None):
    project = get_project_or_404(db, user, ref)
    if kind in ("burndown", "burnup"):
        sprint = _sprint(db, user, sprint_id) if sprint_id else db.scalar(
            select(Sprint).where(Sprint.project_id == project.id, Sprint.state == "active"))
        if not sprint or sprint.project_id != project.id:
            raise HTTPException(422, "sprint_id is required")
        return _csv(svc.sprint_series(db, sprint)["series"], f"{project.key}-{kind}-{sprint.id}.csv")
    if kind == "velocity":
        return _csv(svc.velocity(db, project.id, 50), f"{project.key}-velocity.csv")
    if kind == "cumulative-flow":
        return _csv(svc.cumulative_flow(db, project.id, *_range(start, end))["series"], f"{project.key}-cfd.csv")
    if kind == "resolution-time":
        data = svc.resolution_time(db, project.id, *_range(start, end, 90))
        rows = [{"group": "type", **r} for r in data["by_type"]] + [{"group": "priority", **r} for r in data["by_priority"]]
        return _csv(rows, f"{project.key}-resolution-time.csv")
    if kind == "completion":
        return _csv(svc.project_completion(db, project)["epics"], f"{project.key}-epic-completion.csv")
    raise HTTPException(404, "Unknown report")
