"""Role-based permission matrix.

Global administrators can perform every action. Everyone else is authorised by
their role in the project (ProjectMember.role).
"""

from enum import StrEnum


class Action(StrEnum):
    VIEW_PROJECT = "view_project"
    EDIT_PROJECT = "edit_project"
    DELETE_PROJECT = "delete_project"
    MANAGE_MEMBERS = "manage_members"
    MANAGE_WORKFLOW = "manage_workflow"
    MANAGE_SPRINTS = "manage_sprints"
    RANK_BACKLOG = "rank_backlog"
    CREATE_ISSUE = "create_issue"
    EDIT_ANY_ISSUE = "edit_any_issue"
    EDIT_OWN_ISSUE = "edit_own_issue"
    TRANSITION_ISSUE = "transition_issue"
    DELETE_ISSUE = "delete_issue"
    COMMENT = "comment"
    ATTACH = "attach"


_ALL = set(Action)

ROLE_PERMISSIONS: dict[str, set[Action]] = {
    "project_manager": _ALL,
    "scrum_master": _ALL - {Action.DELETE_PROJECT, Action.MANAGE_MEMBERS, Action.EDIT_PROJECT},
    "developer": {
        Action.VIEW_PROJECT,
        Action.CREATE_ISSUE,
        Action.EDIT_ANY_ISSUE,
        Action.EDIT_OWN_ISSUE,
        Action.TRANSITION_ISSUE,
        Action.RANK_BACKLOG,
        Action.COMMENT,
        Action.ATTACH,
    },
    "reporter": {Action.VIEW_PROJECT, Action.CREATE_ISSUE, Action.EDIT_OWN_ISSUE, Action.COMMENT, Action.ATTACH},
    "viewer": {Action.VIEW_PROJECT},
}

ROLE_LABELS = {
    "project_manager": "Project Manager",
    "scrum_master": "Scrum Master",
    "developer": "Developer",
    "reporter": "Reporter",
    "viewer": "Viewer",
}


def role_allows(role: str | None, action: Action) -> bool:
    if role is None:
        return False
    return action in ROLE_PERMISSIONS.get(role, set())


def permissions_for(role: str | None, is_admin: bool) -> list[str]:
    if is_admin:
        return sorted(a.value for a in _ALL)
    if role is None:
        return []
    return sorted(a.value for a in ROLE_PERMISSIONS.get(role, set()))
