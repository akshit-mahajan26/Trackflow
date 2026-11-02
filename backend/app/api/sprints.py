from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app import schemas
from app.api.deps import DB, CurrentUser, client_ip, ensure, get_project_or_404
from app.core.permissions import Action
from app.models import Sprint
from app.services import sprints as svc
from app.services.audit import audit

router = APIRouter(tags=["sprints"])


def _with_stats(db, s: Sprint) -> schemas.SprintWithStats:
    return schemas.SprintWithStats(**schemas.SprintOut.model_validate(s).model_dump(), **svc.sprint_stats(db, s))


def _get(db, user, sprint_id: int, action: Action = Action.VIEW_PROJECT) -> Sprint:
    s = db.get(Sprint, sprint_id)
    if not s:
        raise HTTPException(404, "Sprint not found")
    ensure(db, user, s.project_id, Action.VIEW_PROJECT)
    if action != Action.VIEW_PROJECT:
        ensure(db, user, s.project_id, action)
    return s


@router.get("/projects/{ref}/sprints", response_model=list[schemas.SprintWithStats])
def list_sprints(ref: str, db: DB, user: CurrentUser, state: str | None = None):
    project = get_project_or_404(db, user, ref)
    q = select(Sprint).where(Sprint.project_id == project.id)
    if state:
        q = q.where(Sprint.state.in_(state.split(",")))
    sprints = db.scalars(q.order_by(Sprint.state != "active", Sprint.state == "closed", Sprint.start_date.nulls_last(), Sprint.id)).all()
    return [_with_stats(db, s) for s in sprints]


@router.post("/projects/{ref}/sprints", response_model=schemas.SprintWithStats, status_code=201)
def create_sprint(ref: str, body: schemas.SprintCreate, db: DB, user: CurrentUser):
    project = get_project_or_404(db, user, ref, Action.MANAGE_SPRINTS)
    s = svc.create_sprint(db, project, body.model_dump())
    db.commit()
    return _with_stats(db, s)


@router.get("/sprints/{sprint_id}", response_model=schemas.SprintWithStats)
def get_sprint(sprint_id: int, db: DB, user: CurrentUser):
    return _with_stats(db, _get(db, user, sprint_id))


@router.patch("/sprints/{sprint_id}", response_model=schemas.SprintWithStats)
def update_sprint(sprint_id: int, body: schemas.SprintUpdate, db: DB, user: CurrentUser):
    s = _get(db, user, sprint_id, Action.MANAGE_SPRINTS)
    svc.update_sprint(db, s, body.model_dump(exclude_unset=True))
    db.commit()
    return _with_stats(db, s)


@router.post("/sprints/{sprint_id}/start", response_model=schemas.SprintWithStats)
def start_sprint(sprint_id: int, body: schemas.SprintStart, db: DB, user: CurrentUser, request: Request):
    s = _get(db, user, sprint_id, Action.MANAGE_SPRINTS)
    svc.start_sprint(db, user, s, body.model_dump(exclude_unset=True))
    audit(db, user, "sprint.start", "sprint", s.id, {"name": s.name, "committed_points": s.committed_points}, client_ip(request))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Another sprint is already active in this project. Complete it first.") from None
    return _with_stats(db, s)


@router.post("/sprints/{sprint_id}/complete")
def complete_sprint(sprint_id: int, body: schemas.SprintComplete, db: DB, user: CurrentUser, request: Request):
    s = _get(db, user, sprint_id, Action.MANAGE_SPRINTS)
    result = svc.complete_sprint(db, user, s, body.move_incomplete_to)
    audit(db, user, "sprint.complete", "sprint", s.id, {"name": s.name, **result}, client_ip(request))
    db.commit()
    return {"sprint": _with_stats(db, s), **result}


@router.delete("/sprints/{sprint_id}", status_code=204)
def delete_sprint(sprint_id: int, db: DB, user: CurrentUser):
    s = _get(db, user, sprint_id, Action.MANAGE_SPRINTS)
    svc.delete_sprint(db, user, s)
    db.commit()
