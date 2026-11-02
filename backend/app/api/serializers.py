from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app import schemas
from app.models import Issue, IssueLink, Project, Sprint, User, Watcher, WorkflowStatus
from app.services.issues import can_edit, can_transition
from app.services.projects import allowed_targets

LINK_LABELS = {
    ("blocks", "outward"): "blocks",
    ("blocks", "inward"): "is blocked by",
    ("relates_to", "outward"): "relates to",
    ("relates_to", "inward"): "relates to",
    ("duplicates", "outward"): "duplicates",
    ("duplicates", "inward"): "is duplicated by",
}


def issue_list(db: Session, issues: list[Issue]) -> list[schemas.IssueListItem]:
    if not issues:
        return []
    ids = [i.id for i in issues]
    parent_ids = {i.parent_id for i in issues if i.parent_id}
    sprint_ids = {i.sprint_id for i in issues if i.sprint_id}
    project_ids = {i.project_id for i in issues}
    parents = {p.id: p for p in db.scalars(select(Issue).where(Issue.id.in_(parent_ids)))} if parent_ids else {}
    sprints = dict(db.execute(select(Sprint.id, Sprint.name).where(Sprint.id.in_(sprint_ids))).all()) if sprint_ids else {}
    keys = dict(db.execute(select(Project.id, Project.key).where(Project.id.in_(project_ids))).all())
    child_rows = db.execute(
        select(Issue.parent_id, func.count(Issue.id), func.count(Issue.id).filter(WorkflowStatus.category == "done"))
        .join(WorkflowStatus, Issue.status_id == WorkflowStatus.id)
        .where(Issue.parent_id.in_(ids))
        .group_by(Issue.parent_id)
    ).all()
    children = {r[0]: (r[1], r[2]) for r in child_rows}
    out = []
    for i in issues:
        item = schemas.IssueListItem.model_validate(i)
        if i.parent_id and i.parent_id in parents:
            item.parent_key = parents[i.parent_id].key
            item.parent_summary = parents[i.parent_id].summary
        item.sprint_name = sprints.get(i.sprint_id)
        item.project_key = keys.get(i.project_id)
        item.child_count, item.child_done_count = children.get(i.id, (0, 0))
        out.append(item)
    return out


def issue_detail(db: Session, issue: Issue, user: User) -> schemas.IssueDetail:
    base = issue_list(db, [issue])[0]
    links = []
    for link in db.scalars(select(IssueLink).where(or_(IssueLink.source_id == issue.id, IssueLink.target_id == issue.id))):
        outward = link.source_id == issue.id
        other = link.target if outward else link.source
        direction = "outward" if outward else "inward"
        links.append(schemas.LinkOut(id=link.id, link_type=link.link_type, direction=direction,
                                     label=LINK_LABELS[(link.link_type, direction)],
                                     issue=schemas.IssueRef.model_validate(other)))
    watchers = list(db.scalars(select(User).join(Watcher, Watcher.user_id == User.id).where(Watcher.issue_id == issue.id)))
    children = sorted(issue.children, key=lambda c: c.rank)
    project = db.get(Project, issue.project_id)
    return schemas.IssueDetail(
        **base.model_dump(),
        project=schemas.ProjectOut.model_validate(project),
        sprint=schemas.SprintOut.model_validate(issue.sprint) if issue.sprint else None,
        parent=schemas.IssueRef.model_validate(issue.parent) if issue.parent else None,
        children=[schemas.IssueRef.model_validate(c) for c in children],
        links=links,
        watchers=[schemas.UserBrief.model_validate(w) for w in watchers],
        is_watching=any(w.id == user.id for w in watchers),
        can_edit=can_edit(db, user, issue),
        available_transitions=[schemas.StatusOut.model_validate(s) for s in allowed_targets(db, project, issue.status_id)]
        if can_transition(db, user, issue) else [],
    )
