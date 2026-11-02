import csv
import io
import mimetypes
import secrets
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import or_, select
from sqlalchemy.orm.exc import StaleDataError

from app import schemas
from app.api.deps import DB, CurrentUser, accessible_project_ids, can, client_ip, ensure, get_issue_or_404, get_project_or_404
from app.api.serializers import issue_detail, issue_list
from app.core.config import get_settings
from app.core.permissions import Action
from app.models import Attachment, Comment, CustomField, Issue, IssueHistory, IssueLink, Watcher
from app.services import issues as svc
from app.services.audit import audit
from app.services.notifications import add_watcher, extract_mentions, notify, watcher_ids
from app.services.realtime import queue_event
from app.services.search import build_issue_query, run_issue_query
from app.services.tql import compile_tql

router = APIRouter(prefix="/issues", tags=["issues"])
settings = get_settings()

FILTER_KEYS = ("project_ids", "issue_types", "status_ids", "status_categories", "priorities", "assignee_ids",
               "reporter_ids", "sprint_ids", "parent_id", "epic_id", "labels", "text", "due_from", "due_to", "overdue",
               "created_from", "created_to", "resolved", "sort", "order")


def _filters_from_request(request: Request) -> dict:
    qp = request.query_params
    f: dict = {}
    for key in FILTER_KEYS:
        vals = qp.getlist(key)
        if not vals:
            continue
        f[key] = vals if len(vals) > 1 or key.endswith("_ids") or key in ("issue_types", "status_categories", "priorities", "labels") else vals[0]
    return f


def _query(request: Request, db, user):
    accessible = accessible_project_ids(db, user)
    if tql := request.query_params.get("tql"):
        q = compile_tql(db, user, accessible, tql)
        # Optional scope applied outside the user's query (e.g. the project issues page).
        if scope := [int(p) for p in request.query_params.getlist("project_ids") if p.isdigit()]:
            q = q.where(Issue.project_id.in_(scope))
        return q
    return build_issue_query(_filters_from_request(request), user, accessible)


def _commit(db) -> None:
    try:
        db.commit()
    except StaleDataError:
        db.rollback()
        raise HTTPException(409, "This issue was modified concurrently. Reload and try again.") from None


@router.get("", response_model=schemas.Page[schemas.IssueListItem])
def list_issues(request: Request, db: DB, user: CurrentUser, page: int = Query(1, ge=1),
                page_size: int = Query(50, ge=1, le=500), tql: str | None = None):
    """Structured filters via query params, or a TQL string via ?tql= (e.g. `assignee = currentUser()`)."""
    items, total = run_issue_query(db, _query(request, db, user), page, page_size)
    return schemas.Page(items=issue_list(db, items), total=total, page=page, page_size=page_size)


@router.post("/search", response_model=schemas.Page[schemas.IssueListItem])
def search_issues(body: dict, db: DB, user: CurrentUser, page: int = Query(1, ge=1),
                  page_size: int = Query(50, ge=1, le=500)):
    q = build_issue_query(body, user, accessible_project_ids(db, user))
    items, total = run_issue_query(db, q, page, page_size)
    return schemas.Page(items=issue_list(db, items), total=total, page=page, page_size=page_size)


@router.get("/export.csv")
def export_csv(request: Request, db: DB, user: CurrentUser):
    f = _filters_from_request(request) | ({"tql": request.query_params["tql"]} if "tql" in request.query_params else {})
    items, _ = run_issue_query(db, _query(request, db, user), 1, 10000)
    rows = issue_list(db, items)
    fields: dict[str, str] = {}
    pids = {i.project_id for i in items}
    if pids:
        fields = {str(cf.id): cf.name for cf in db.scalars(select(CustomField).where(CustomField.project_id.in_(pids)))}
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Key", "Type", "Summary", "Status", "Status Category", "Priority", "Assignee", "Reporter", "Parent",
                "Sprint", "Story Points", "Estimate (h)", "Time Spent (h)", "Labels", "Start", "Due", "Created",
                "Updated", "Resolved", *fields.values()])
    for r in rows:
        w.writerow([r.key, r.issue_type, r.summary, r.status.name, r.status.category, r.priority,
                    r.assignee.full_name if r.assignee else "", r.reporter.full_name if r.reporter else "",
                    r.parent_key or "", r.sprint_name or "", r.story_points if r.story_points is not None else "",
                    r.original_estimate_hours or "", r.time_spent_hours or "", ";".join(r.labels),
                    r.start_date or "", r.due_date or "", r.created_at.isoformat(), r.updated_at.isoformat(),
                    r.resolved_at.isoformat() if r.resolved_at else "",
                    *[(r.custom_fields or {}).get(fid, "") or "" for fid in fields]])
    audit(db, user, "issues.export", "issue", None, {"count": len(rows), "filters": f}, client_ip(request))
    db.commit()
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": 'attachment; filename="issues.csv"'})


@router.post("", response_model=schemas.IssueDetail, status_code=201)
def create_issue(body: schemas.IssueCreate, db: DB, user: CurrentUser):
    get_project_or_404(db, user, body.project_id, Action.CREATE_ISSUE)
    issue = svc.create_issue(db, user, body.model_dump())
    db.commit()
    return issue_detail(db, issue, user)


@router.post("/bulk")
def bulk_update(body: schemas.BulkUpdate, db: DB, user: CurrentUser):
    results = []
    for iid in body.issue_ids:
        issue = db.get(Issue, iid)
        if not issue or not can(db, user, issue.project_id, Action.VIEW_PROJECT):
            results.append({"id": iid, "ok": False, "error": "Not found"})
            continue
        changes: dict = {}
        if body.status_id is not None:
            changes["status_id"] = body.status_id
        if body.priority is not None:
            changes["priority"] = body.priority
        if body.set_assignee:
            changes["assignee_id"] = body.assignee_id
        if body.set_sprint:
            changes["sprint_id"] = body.sprint_id
        sp = db.begin_nested()
        try:
            svc.update_issue(db, user, issue, changes)
            db.flush()
            sp.commit()
            results.append({"id": iid, "key": issue.key, "ok": True})
        except HTTPException as e:
            sp.rollback()
            results.append({"id": iid, "key": issue.key, "ok": False, "error": e.detail})
    _commit(db)
    return {"results": results, "updated": sum(r["ok"] for r in results)}


@router.get("/{ref}", response_model=schemas.IssueDetail)
def get_issue(ref: str, db: DB, user: CurrentUser):
    return issue_detail(db, get_issue_or_404(db, user, ref), user)


@router.patch("/{ref}", response_model=schemas.IssueDetail)
def update_issue(ref: str, body: schemas.IssueUpdate, db: DB, user: CurrentUser):
    issue = get_issue_or_404(db, user, ref)
    svc.update_issue(db, user, issue, body.model_dump(exclude_unset=True))
    _commit(db)
    return issue_detail(db, issue, user)


@router.post("/{ref}/move", response_model=schemas.IssueDetail)
def move_issue(ref: str, body: schemas.IssueMove, db: DB, user: CurrentUser):
    issue = get_issue_or_404(db, user, ref)
    svc.move_issue(db, user, issue, **body.model_dump())
    _commit(db)
    return issue_detail(db, issue, user)


@router.delete("/{ref}", status_code=204)
def delete_issue(ref: str, db: DB, user: CurrentUser, request: Request):
    issue = get_issue_or_404(db, user, ref)
    files = [a.stored_name for a in db.scalars(select(Attachment).where(
        Attachment.issue_id.in_([issue.id, *[c.id for c in issue.children if c.issue_type == "subtask"]])))]
    audit(db, user, "issue.delete", "issue", issue.id, {"key": issue.key, "summary": issue.summary}, client_ip(request))
    svc.delete_issue(db, user, issue)
    _commit(db)
    for name in files:
        (settings.upload_dir / name).unlink(missing_ok=True)


@router.get("/{ref}/history", response_model=list[schemas.HistoryOut])
def issue_history(ref: str, db: DB, user: CurrentUser):
    issue = get_issue_or_404(db, user, ref)
    return db.scalars(select(IssueHistory).where(IssueHistory.issue_id == issue.id)
                      .order_by(IssueHistory.created_at.desc(), IssueHistory.id.desc())).all()


# ---------- comments ----------


@router.get("/{ref}/comments", response_model=list[schemas.CommentOut])
def list_comments(ref: str, db: DB, user: CurrentUser):
    issue = get_issue_or_404(db, user, ref)
    return db.scalars(select(Comment).where(Comment.issue_id == issue.id).order_by(Comment.created_at)).all()


@router.post("/{ref}/comments", response_model=schemas.CommentOut, status_code=201)
def add_comment(ref: str, body: schemas.CommentIn, db: DB, user: CurrentUser):
    issue = get_issue_or_404(db, user, ref)
    ensure(db, user, issue.project_id, Action.COMMENT)
    c = Comment(issue_id=issue.id, author_id=user.id, body=body.body)
    db.add(c)
    db.flush()
    db.add(IssueHistory(issue_id=issue.id, project_id=issue.project_id, actor_id=user.id, field="comment",
                        new_value=body.body[:200]))
    mentioned = {u.id for u in extract_mentions(db, body.body, issue.project_id)}
    notify(db, mentioned, "mention", f"{user.full_name} mentioned you on {issue.key}: {body.body[:120]}", actor=user, issue=issue)
    notify(db, watcher_ids(db, issue.id) - mentioned, "comment", f"{user.full_name} commented on {issue.key}: {body.body[:120]}",
           actor=user, issue=issue)
    add_watcher(db, issue.id, user.id)
    queue_event(db, "comment_added", project_id=issue.project_id, issue_id=issue.id, key=issue.key, actor_id=user.id)
    db.commit()
    return c


def _own_comment(db, user, ref: str, comment_id: int) -> tuple[Issue, Comment]:
    issue = get_issue_or_404(db, user, ref)
    c = db.get(Comment, comment_id)
    if not c or c.issue_id != issue.id:
        raise HTTPException(404, "Comment not found")
    return issue, c


@router.patch("/{ref}/comments/{comment_id}", response_model=schemas.CommentOut)
def edit_comment(ref: str, comment_id: int, body: schemas.CommentIn, db: DB, user: CurrentUser):
    issue, c = _own_comment(db, user, ref, comment_id)
    if c.author_id != user.id:
        raise HTTPException(403, "You can only edit your own comments")
    c.body = body.body
    queue_event(db, "comment_added", project_id=issue.project_id, issue_id=issue.id, key=issue.key, actor_id=user.id)
    db.commit()
    return c


@router.delete("/{ref}/comments/{comment_id}", status_code=204)
def delete_comment(ref: str, comment_id: int, db: DB, user: CurrentUser):
    issue, c = _own_comment(db, user, ref, comment_id)
    if c.author_id != user.id and not can(db, user, issue.project_id, Action.DELETE_ISSUE):
        raise HTTPException(403, "You cannot delete this comment")
    db.delete(c)
    queue_event(db, "comment_added", project_id=issue.project_id, issue_id=issue.id, key=issue.key, actor_id=user.id)
    db.commit()


# ---------- attachments ----------


@router.get("/{ref}/attachments", response_model=list[schemas.AttachmentOut])
def list_attachments(ref: str, db: DB, user: CurrentUser):
    issue = get_issue_or_404(db, user, ref)
    return db.scalars(select(Attachment).where(Attachment.issue_id == issue.id).order_by(Attachment.created_at)).all()


@router.post("/{ref}/attachments", response_model=schemas.AttachmentOut, status_code=201)
async def upload_attachment(ref: str, db: DB, user: CurrentUser, file: UploadFile = File(...)):
    issue = get_issue_or_404(db, user, ref)
    ensure(db, user, issue.project_id, Action.ATTACH)
    original = Path(file.filename or "file").name[:200]
    ext = original.rsplit(".", 1)[-1].lower() if "." in original else ""
    if ext not in settings.allowed_extensions:
        raise HTTPException(415, f"File type '.{ext}' is not allowed")
    limit = settings.max_upload_mb * 1024 * 1024
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    stored = f"{secrets.token_hex(16)}.{ext}"  # never trust the client filename on disk
    path = settings.upload_dir / stored
    size = 0
    try:
        with path.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(413, f"File exceeds the {settings.max_upload_mb} MB limit")
                out.write(chunk)
    except HTTPException:
        path.unlink(missing_ok=True)
        raise
    content_type = mimetypes.guess_type(original)[0] or "application/octet-stream"
    a = Attachment(issue_id=issue.id, uploader_id=user.id, filename=original, stored_name=stored,
                   content_type=content_type, size_bytes=size)
    db.add(a)
    db.add(IssueHistory(issue_id=issue.id, project_id=issue.project_id, actor_id=user.id, field="attachment",
                        new_value=original))
    queue_event(db, "issue_updated", project_id=issue.project_id, issue_id=issue.id, key=issue.key,
                fields=["attachment"], actor_id=user.id)
    db.commit()
    return a


@router.get("/{ref}/attachments/{attachment_id}")
def download_attachment(ref: str, attachment_id: int, db: DB, user: CurrentUser, inline: bool = False):
    issue = get_issue_or_404(db, user, ref)
    a = db.get(Attachment, attachment_id)
    if not a or a.issue_id != issue.id:
        raise HTTPException(404, "Attachment not found")
    path = settings.upload_dir / a.stored_name
    if not path.is_file():
        raise HTTPException(410, "Attachment file is missing on the server")
    safe_inline = inline and a.content_type.startswith("image/") and a.content_type != "image/svg+xml"
    return FileResponse(path, media_type=a.content_type, filename=a.filename,
                        content_disposition_type="inline" if safe_inline else "attachment",
                        headers={"X-Content-Type-Options": "nosniff"})


@router.delete("/{ref}/attachments/{attachment_id}", status_code=204)
def delete_attachment(ref: str, attachment_id: int, db: DB, user: CurrentUser):
    issue = get_issue_or_404(db, user, ref)
    a = db.get(Attachment, attachment_id)
    if not a or a.issue_id != issue.id:
        raise HTTPException(404, "Attachment not found")
    if a.uploader_id != user.id and not svc.can_edit(db, user, issue):
        raise HTTPException(403, "You cannot delete this attachment")
    db.add(IssueHistory(issue_id=issue.id, project_id=issue.project_id, actor_id=user.id, field="attachment",
                        old_value=a.filename))
    name = a.stored_name
    db.delete(a)
    db.commit()
    (settings.upload_dir / name).unlink(missing_ok=True)


# ---------- links ----------


@router.post("/{ref}/links", response_model=schemas.IssueDetail, status_code=201)
def add_link(ref: str, body: schemas.LinkIn, db: DB, user: CurrentUser):
    issue = get_issue_or_404(db, user, ref)
    svc.ensure_edit(db, user, issue)
    target = get_issue_or_404(db, user, body.target_id)
    if target.id == issue.id:
        raise HTTPException(422, "An issue cannot link to itself")
    exists = db.scalar(select(IssueLink.id).where(or_(
        (IssueLink.source_id == issue.id) & (IssueLink.target_id == target.id),
        (IssueLink.source_id == target.id) & (IssueLink.target_id == issue.id)), IssueLink.link_type == body.link_type))
    if exists:
        raise HTTPException(409, "These issues are already linked this way")
    if body.link_type == "blocks" and _creates_cycle(db, issue.id, target.id):
        raise HTTPException(422, f"{target.key} already (transitively) blocks {issue.key}; this would create a cycle")
    db.add(IssueLink(source_id=issue.id, target_id=target.id, link_type=body.link_type, created_by_id=user.id))
    for a, b in ((issue, target), (target, issue)):
        db.add(IssueHistory(issue_id=a.id, project_id=a.project_id, actor_id=user.id, field="link",
                            new_value=f"{body.link_type.replace('_', ' ')} {b.key}"))
    queue_event(db, "issue_updated", project_id=issue.project_id, issue_id=issue.id, key=issue.key, fields=["link"],
                actor_id=user.id)
    db.commit()
    return issue_detail(db, issue, user)


def _creates_cycle(db, source_id: int, target_id: int) -> bool:
    """Would source→blocks→target close a loop? True if target already reaches source."""
    frontier, seen = {target_id}, set()
    for _ in range(50):
        if source_id in frontier:
            return True
        seen |= frontier
        frontier = set(db.scalars(select(IssueLink.target_id).where(
            IssueLink.source_id.in_(frontier), IssueLink.link_type == "blocks"))) - seen
        if not frontier:
            return False
    return False


@router.delete("/{ref}/links/{link_id}", status_code=204)
def remove_link(ref: str, link_id: int, db: DB, user: CurrentUser):
    issue = get_issue_or_404(db, user, ref)
    svc.ensure_edit(db, user, issue)
    link = db.get(IssueLink, link_id)
    if not link or issue.id not in (link.source_id, link.target_id):
        raise HTTPException(404, "Link not found")
    other = link.target if link.source_id == issue.id else link.source
    db.add(IssueHistory(issue_id=issue.id, project_id=issue.project_id, actor_id=user.id, field="link",
                        old_value=f"{link.link_type.replace('_', ' ')} {other.key}"))
    db.delete(link)
    queue_event(db, "issue_updated", project_id=issue.project_id, issue_id=issue.id, key=issue.key, fields=["link"],
                actor_id=user.id)
    db.commit()


# ---------- watchers ----------


@router.post("/{ref}/watch", status_code=204)
def watch(ref: str, db: DB, user: CurrentUser):
    issue = get_issue_or_404(db, user, ref)
    add_watcher(db, issue.id, user.id)
    db.commit()


@router.delete("/{ref}/watch", status_code=204)
def unwatch(ref: str, db: DB, user: CurrentUser):
    issue = get_issue_or_404(db, user, ref)
    w = db.scalar(select(Watcher).where(Watcher.issue_id == issue.id, Watcher.user_id == user.id))
    if w:
        db.delete(w)
        db.commit()
