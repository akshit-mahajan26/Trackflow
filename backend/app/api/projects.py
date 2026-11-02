from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import delete, func, select

from app import schemas
from app.api.deps import DB, CurrentUser, accessible_project_ids, client_ip, ensure, get_project_or_404, member_role
from app.core.permissions import ROLE_LABELS, Action, permissions_for
from app.models import (
    CustomField,
    Issue,
    IssueHistory,
    Project,
    ProjectMember,
    User,
    WorkflowStatus,
    WorkflowTransition,
)
from app.services import projects as svc
from app.services.audit import audit
from app.services.dashboard import dashboard
from app.services.realtime import manager, queue_event
from app.services.settings import get_setting

router = APIRouter(prefix="/projects", tags=["projects"])


def _refresh_ws_access(db, user_id: int) -> None:
    user = db.get(User, user_id)
    manager.update_access(user_id, None if user and user.is_admin else set(accessible_project_ids(db, user)))


@router.get("/roles")
def roles():
    return [{"value": k, "label": v} for k, v in ROLE_LABELS.items()]


@router.get("", response_model=list[schemas.ProjectSummary])
def list_projects(db: DB, user: CurrentUser, include_archived: bool = False):
    ids = accessible_project_ids(db, user)
    q = select(Project).order_by(Project.name)
    if ids is not None:
        q = q.where(Project.id.in_(ids))
    if not include_archived:
        q = q.where(Project.status == "active")
    projects = db.scalars(q).all()
    pids = [p.id for p in projects]
    counts = dict(db.execute(select(Issue.project_id, func.count()).where(Issue.project_id.in_(pids)).group_by(Issue.project_id)).all())
    done = dict(db.execute(
        select(Issue.project_id, func.count()).join(WorkflowStatus, Issue.status_id == WorkflowStatus.id)
        .where(Issue.project_id.in_(pids), WorkflowStatus.category == "done").group_by(Issue.project_id)).all())
    members = dict(db.execute(select(ProjectMember.project_id, func.count()).where(ProjectMember.project_id.in_(pids))
                              .group_by(ProjectMember.project_id)).all())
    roles = dict(db.execute(select(ProjectMember.project_id, ProjectMember.role).where(ProjectMember.user_id == user.id)).all())
    out = []
    for p in projects:
        item = schemas.ProjectSummary.model_validate(p)
        item.issue_count, item.done_count = counts.get(p.id, 0), done.get(p.id, 0)
        item.member_count, item.my_role = members.get(p.id, 0), roles.get(p.id)
        out.append(item)
    return out


@router.post("", response_model=schemas.ProjectDetail, status_code=201)
def create_project(body: schemas.ProjectCreate, db: DB, user: CurrentUser, request: Request):
    if not user.is_admin and not get_setting(db, "allow_project_creation"):
        raise HTTPException(403, "Only administrators can create projects")
    project = svc.create_project(db, user, body.model_dump())
    audit(db, user, "project.create", "project", project.id, {"key": project.key}, client_ip(request))
    db.commit()
    _refresh_ws_access(db, user.id)
    return get_project(project.key, db, user)


@router.get("/{ref}", response_model=schemas.ProjectDetail)
def get_project(ref: str, db: DB, user: CurrentUser):
    project = get_project_or_404(db, user, ref)
    role = member_role(db, project.id, user.id)
    return schemas.ProjectDetail(
        **schemas.ProjectOut.model_validate(project).model_dump(),
        statuses=[schemas.StatusOut.model_validate(s) for s in svc.ordered_statuses(db, project.id)],
        my_role=role,
        permissions=permissions_for(role, user.is_admin),
    )


@router.patch("/{ref}", response_model=schemas.ProjectDetail)
def update_project(ref: str, body: schemas.ProjectUpdate, db: DB, user: CurrentUser, request: Request):
    project = get_project_or_404(db, user, ref, Action.EDIT_PROJECT)
    data = body.model_dump(exclude_unset=True)
    if "lead_id" in data and data["lead_id"] is not None:
        if not member_role(db, project.id, data["lead_id"]):
            raise HTTPException(422, "Project lead must be a project member")
    if "settings" in data:
        data["settings"] = {**(project.settings or {}), **(data["settings"] or {})}
    for k, v in data.items():
        if k in ("name", "board_type", "priority", "status") and v is None:
            continue
        setattr(project, k, v)
    audit(db, user, "project.update", "project", project.id, {k: str(v) for k, v in data.items()}, client_ip(request))
    queue_event(db, "project_updated", project_id=project.id)
    db.commit()
    return get_project(project.key, db, user)


@router.delete("/{ref}", status_code=204)
def delete_project(ref: str, db: DB, user: CurrentUser, request: Request, confirm_key: str):
    project = get_project_or_404(db, user, ref, Action.DELETE_PROJECT)
    if confirm_key.upper() != project.key:
        raise HTTPException(422, "Type the project key to confirm deletion")
    audit(db, user, "project.delete", "project", project.id, {"key": project.key, "name": project.name}, client_ip(request))
    # Issues reference statuses with RESTRICT; remove issues first.
    db.execute(delete(Issue).where(Issue.project_id == project.id))
    db.delete(project)
    db.commit()


@router.get("/{ref}/dashboard")
def project_dashboard(ref: str, db: DB, user: CurrentUser):
    project = get_project_or_404(db, user, ref)
    return dashboard(db, user, [project.id])


@router.get("/{ref}/activity", response_model=list[schemas.ActivityOut])
def project_activity(ref: str, db: DB, user: CurrentUser, limit: int = 50):
    project = get_project_or_404(db, user, ref)
    rows = db.execute(
        select(IssueHistory, Issue.key, Issue.summary)
        .join(Issue, Issue.id == IssueHistory.issue_id)
        .where(IssueHistory.project_id == project.id)
        .order_by(IssueHistory.created_at.desc())
        .limit(min(limit, 200))
    ).all()
    return [schemas.ActivityOut(**schemas.HistoryOut.model_validate(h).model_dump(), issue_key=k, issue_summary=s,
                                project_key=project.key) for h, k, s in rows]


@router.get("/{ref}/labels")
def project_labels(ref: str, db: DB, user: CurrentUser):
    project = get_project_or_404(db, user, ref)
    rows = db.execute(
        select(func.jsonb_array_elements_text(Issue.labels).label("l")).where(Issue.project_id == project.id)
    ).scalars().all()
    return sorted(set(rows))


# ---------- members ----------


@router.get("/{ref}/members", response_model=list[schemas.MemberOut])
def list_members(ref: str, db: DB, user: CurrentUser):
    project = get_project_or_404(db, user, ref)
    return db.scalars(
        select(ProjectMember).join(User).where(ProjectMember.project_id == project.id).order_by(User.full_name)
    ).all()


@router.post("/{ref}/members", response_model=schemas.MemberOut, status_code=201)
def add_member(ref: str, body: schemas.MemberIn, db: DB, user: CurrentUser, request: Request):
    project = get_project_or_404(db, user, ref, Action.MANAGE_MEMBERS)
    target = db.get(User, body.user_id)
    if not target or not target.is_active:
        raise HTTPException(422, "User does not exist or is inactive")
    if member_role(db, project.id, body.user_id):
        raise HTTPException(409, "User is already a member of this project")
    m = ProjectMember(project_id=project.id, user_id=body.user_id, role=body.role)
    db.add(m)
    audit(db, user, "project.member_add", "project", project.id, {"user_id": body.user_id, "role": body.role}, client_ip(request))
    from app.services.notifications import notify
    notify(db, [body.user_id], "project", f"{user.full_name} added you to {project.name} as {ROLE_LABELS[body.role]}",
           actor=user, project_id=project.id)
    db.commit()
    _refresh_ws_access(db, body.user_id)
    return m


def _guard_last_manager(db, project_id: int, member: ProjectMember, new_role: str | None) -> None:
    if member.role != "project_manager" or new_role == "project_manager":
        return
    managers = db.scalar(select(func.count()).where(ProjectMember.project_id == project_id,
                                                     ProjectMember.role == "project_manager"))
    if managers <= 1:
        raise HTTPException(422, "A project must keep at least one Project Manager")


@router.patch("/{ref}/members/{member_id}", response_model=schemas.MemberOut)
def update_member(ref: str, member_id: int, body: schemas.MemberUpdate, db: DB, user: CurrentUser, request: Request):
    project = get_project_or_404(db, user, ref, Action.MANAGE_MEMBERS)
    m = db.get(ProjectMember, member_id)
    if not m or m.project_id != project.id:
        raise HTTPException(404, "Member not found")
    _guard_last_manager(db, project.id, m, body.role)
    audit(db, user, "project.member_role", "project", project.id, {"user_id": m.user_id, "from": m.role, "to": body.role},
          client_ip(request))
    m.role = body.role
    db.commit()
    return m


@router.delete("/{ref}/members/{member_id}", status_code=204)
def remove_member(ref: str, member_id: int, db: DB, user: CurrentUser, request: Request):
    project = get_project_or_404(db, user, ref, Action.MANAGE_MEMBERS)
    m = db.get(ProjectMember, member_id)
    if not m or m.project_id != project.id:
        raise HTTPException(404, "Member not found")
    _guard_last_manager(db, project.id, m, None)
    uid = m.user_id
    audit(db, user, "project.member_remove", "project", project.id, {"user_id": uid}, client_ip(request))
    db.delete(m)
    db.commit()
    _refresh_ws_access(db, uid)


# ---------- workflow ----------


@router.post("/{ref}/statuses", response_model=schemas.StatusOut, status_code=201)
def add_status(ref: str, body: schemas.StatusIn, db: DB, user: CurrentUser):
    project = get_project_or_404(db, user, ref, Action.MANAGE_WORKFLOW)
    if db.scalar(select(WorkflowStatus.id).where(WorkflowStatus.project_id == project.id,
                                                 func.lower(WorkflowStatus.name) == body.name.lower())):
        raise HTTPException(409, "A status with this name already exists")
    pos = len(svc.ordered_statuses(db, project.id))
    s = WorkflowStatus(project_id=project.id, position=pos, **body.model_dump())
    db.add(s)
    audit(db, user, "workflow.status_add", "project", project.id, {"name": body.name})
    queue_event(db, "project_updated", project_id=project.id)
    db.commit()
    return s


@router.patch("/{ref}/statuses/{status_id}", response_model=schemas.StatusOut)
def update_status(ref: str, status_id: int, body: schemas.StatusUpdate, db: DB, user: CurrentUser):
    project = get_project_or_404(db, user, ref, Action.MANAGE_WORKFLOW)
    s = db.get(WorkflowStatus, status_id)
    if not s or s.project_id != project.id:
        raise HTTPException(404, "Status not found")
    data = body.model_dump(exclude_unset=True)
    if "wip_limit" in data and data["wip_limit"] == 0:
        data["wip_limit"] = None
    for k, v in data.items():
        if k in ("name", "category") and v is None:
            continue
        setattr(s, k, v)
    audit(db, user, "workflow.status_update", "project", project.id, {"status_id": s.id, **{k: str(v) for k, v in data.items()}})
    queue_event(db, "project_updated", project_id=project.id)
    db.commit()
    return s


@router.put("/{ref}/statuses/order", response_model=list[schemas.StatusOut])
def reorder_statuses(ref: str, body: schemas.StatusReorder, db: DB, user: CurrentUser):
    project = get_project_or_404(db, user, ref, Action.MANAGE_WORKFLOW)
    statuses = {s.id: s for s in svc.ordered_statuses(db, project.id)}
    if set(body.status_ids) != set(statuses):
        raise HTTPException(422, "status_ids must contain every status of the project exactly once")
    for pos, sid in enumerate(body.status_ids):
        statuses[sid].position = pos
    queue_event(db, "project_updated", project_id=project.id)
    db.commit()
    return svc.ordered_statuses(db, project.id)


@router.delete("/{ref}/statuses/{status_id}", status_code=204)
def remove_status(ref: str, status_id: int, db: DB, user: CurrentUser, move_to: int | None = None):
    project = get_project_or_404(db, user, ref, Action.MANAGE_WORKFLOW)
    s = db.get(WorkflowStatus, status_id)
    if not s or s.project_id != project.id:
        raise HTTPException(404, "Status not found")
    svc.delete_status(db, s, move_to, user)
    audit(db, user, "workflow.status_delete", "project", project.id, {"name": s.name, "moved_to": move_to})
    queue_event(db, "project_updated", project_id=project.id)
    db.commit()


@router.get("/{ref}/transitions", response_model=list[schemas.TransitionOut])
def list_transitions(ref: str, db: DB, user: CurrentUser):
    project = get_project_or_404(db, user, ref)
    return db.scalars(select(WorkflowTransition).where(WorkflowTransition.project_id == project.id)).all()


@router.put("/{ref}/transitions", response_model=list[schemas.TransitionOut])
def replace_transitions(ref: str, body: list[schemas.TransitionIn], db: DB, user: CurrentUser):
    """Replace the allowed-transition matrix. Enforcement is toggled via settings.enforce_transitions."""
    project = get_project_or_404(db, user, ref, Action.MANAGE_WORKFLOW)
    valid = {s.id for s in svc.ordered_statuses(db, project.id)}
    pairs = {(t.from_status_id, t.to_status_id) for t in body if t.from_status_id != t.to_status_id}
    if any(a not in valid or b not in valid for a, b in pairs):
        raise HTTPException(422, "Transitions must reference statuses of this project")
    db.execute(delete(WorkflowTransition).where(WorkflowTransition.project_id == project.id))
    for a, b in sorted(pairs):
        db.add(WorkflowTransition(project_id=project.id, from_status_id=a, to_status_id=b))
    audit(db, user, "workflow.transitions_replace", "project", project.id, {"count": len(pairs)})
    db.commit()
    return db.scalars(select(WorkflowTransition).where(WorkflowTransition.project_id == project.id)).all()


# ---------- custom fields ----------


@router.get("/{ref}/fields", response_model=list[schemas.CustomFieldOut])
def list_fields(ref: str, db: DB, user: CurrentUser):
    project = get_project_or_404(db, user, ref)
    return db.scalars(select(CustomField).where(CustomField.project_id == project.id).order_by(CustomField.position)).all()


@router.post("/{ref}/fields", response_model=schemas.CustomFieldOut, status_code=201)
def add_field(ref: str, body: schemas.CustomFieldIn, db: DB, user: CurrentUser):
    project = get_project_or_404(db, user, ref, Action.MANAGE_WORKFLOW)
    if body.field_type == "select" and not body.options:
        raise HTTPException(422, "Select fields need at least one option")
    if db.scalar(select(CustomField.id).where(CustomField.project_id == project.id, CustomField.name == body.name)):
        raise HTTPException(409, "A field with this name already exists")
    pos = db.scalar(select(func.count()).where(CustomField.project_id == project.id)) or 0
    f = CustomField(project_id=project.id, position=pos, **body.model_dump())
    db.add(f)
    audit(db, user, "field.create", "project", project.id, {"name": body.name, "type": body.field_type})
    db.commit()
    return f


@router.patch("/{ref}/fields/{field_id}", response_model=schemas.CustomFieldOut)
def update_field(ref: str, field_id: int, body: schemas.CustomFieldIn, db: DB, user: CurrentUser):
    project = get_project_or_404(db, user, ref, Action.MANAGE_WORKFLOW)
    f = db.get(CustomField, field_id)
    if not f or f.project_id != project.id:
        raise HTTPException(404, "Field not found")
    if body.field_type != f.field_type:
        raise HTTPException(422, "A field's type cannot be changed; create a new field instead")
    f.name, f.options, f.required = body.name, body.options, body.required
    db.commit()
    return f


@router.delete("/{ref}/fields/{field_id}", status_code=204)
def delete_field(ref: str, field_id: int, db: DB, user: CurrentUser):
    project = get_project_or_404(db, user, ref, Action.MANAGE_WORKFLOW)
    f = db.get(CustomField, field_id)
    if not f or f.project_id != project.id:
        raise HTTPException(404, "Field not found")
    for issue in db.scalars(select(Issue).where(Issue.project_id == project.id, Issue.custom_fields.has_key(str(f.id)))):
        issue.custom_fields = {k: v for k, v in issue.custom_fields.items() if k != str(f.id)}
    audit(db, user, "field.delete", "project", project.id, {"name": f.name})
    db.delete(f)
    db.commit()
