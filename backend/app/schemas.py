import re
from datetime import date, datetime
from typing import Any, Literal

from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator

ProjectRole = Literal["project_manager", "scrum_master", "developer", "reporter", "viewer"]
IssueType = Literal["epic", "story", "task", "bug", "improvement", "subtask"]
Priority = Literal["highest", "high", "medium", "low", "lowest"]
StatusCategory = Literal["todo", "in_progress", "done"]
LinkType = Literal["blocks", "relates_to", "duplicates"]
CustomFieldType = Literal["text", "number", "date", "select"]

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _email(v: str) -> str:
    v = v.strip().lower()
    if len(v) > 255 or not _EMAIL_RE.match(v):
        raise ValueError("Invalid email address")
    return v


EmailStr = Annotated[str, AfterValidator(_email)]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------- Auth / users ----------


class LoginIn(BaseModel):
    username: str = Field(min_length=1, description="Username or email")
    password: str = Field(min_length=1)


class RegisterIn(BaseModel):
    email: EmailStr
    username: str = Field(min_length=3, max_length=50, pattern=r"^[a-zA-Z0-9_.-]+$")
    full_name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=8, max_length=128)


class UserBrief(ORM):
    id: int
    username: str
    full_name: str
    avatar_color: str


class UserOut(UserBrief):
    email: str
    is_admin: bool
    is_active: bool
    job_title: str | None
    theme: str
    created_at: datetime
    last_login_at: datetime | None


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class UserCreate(RegisterIn):
    is_admin: bool = False
    job_title: str | None = None


class UserAdminUpdate(BaseModel):
    full_name: str | None = Field(None, min_length=1, max_length=120)
    email: EmailStr | None = None
    is_admin: bool | None = None
    is_active: bool | None = None
    job_title: str | None = None
    password: str | None = Field(None, min_length=8, max_length=128)


class ProfileUpdate(BaseModel):
    full_name: str | None = Field(None, min_length=1, max_length=120)
    job_title: str | None = None
    avatar_color: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    theme: Literal["light", "dark", "system"] | None = None


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)


# ---------- Projects ----------


class StatusOut(ORM):
    id: int
    name: str
    category: StatusCategory
    position: int
    wip_limit: int | None


class StatusIn(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    category: StatusCategory = "todo"
    wip_limit: int | None = Field(None, ge=1)


class StatusUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=50)
    category: StatusCategory | None = None
    wip_limit: int | None = Field(None, ge=0)


class StatusReorder(BaseModel):
    status_ids: list[int]


class TransitionIn(BaseModel):
    from_status_id: int
    to_status_id: int


class TransitionOut(ORM):
    id: int
    from_status_id: int
    to_status_id: int


class ProjectCreate(BaseModel):
    key: str = Field(min_length=2, max_length=10, pattern=r"^[A-Za-z][A-Za-z0-9]*$")
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    board_type: Literal["scrum", "kanban"] = "scrum"
    priority: Priority = "medium"
    lead_id: int | None = None
    start_date: date | None = None
    due_date: date | None = None

    @field_validator("key")
    @classmethod
    def upper_key(cls, v: str) -> str:
        return v.upper()


class ProjectUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    description: str | None = None
    board_type: Literal["scrum", "kanban"] | None = None
    priority: Priority | None = None
    status: Literal["active", "archived"] | None = None
    lead_id: int | None = None
    start_date: date | None = None
    due_date: date | None = None
    settings: dict[str, Any] | None = None


class ProjectOut(ORM):
    id: int
    key: str
    name: str
    description: str
    board_type: str
    priority: str
    status: str
    lead: UserBrief | None
    start_date: date | None
    due_date: date | None
    settings: dict
    created_at: datetime


class ProjectSummary(ProjectOut):
    issue_count: int = 0
    done_count: int = 0
    member_count: int = 0
    my_role: str | None = None


class ProjectDetail(ProjectOut):
    statuses: list[StatusOut]
    my_role: str | None
    permissions: list[str]


class MemberIn(BaseModel):
    user_id: int
    role: ProjectRole = "developer"


class MemberUpdate(BaseModel):
    role: ProjectRole


class MemberOut(ORM):
    id: int
    role: str
    joined_at: datetime
    user: UserBrief


# ---------- Custom fields ----------


class CustomFieldIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    field_type: CustomFieldType
    options: list[str] = []
    required: bool = False


class CustomFieldOut(ORM):
    id: int
    name: str
    field_type: str
    options: list
    required: bool
    position: int


# ---------- Sprints ----------


class SprintCreate(BaseModel):
    name: str | None = Field(None, max_length=120)
    goal: str = ""
    start_date: date | None = None
    end_date: date | None = None


class SprintUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    goal: str | None = None
    start_date: date | None = None
    end_date: date | None = None


class SprintStart(BaseModel):
    start_date: date | None = None
    end_date: date | None = None
    goal: str | None = None


class SprintComplete(BaseModel):
    # Where to move incomplete issues: a future sprint id, or null for the backlog.
    move_incomplete_to: int | None = None


class SprintOut(ORM):
    id: int
    project_id: int
    name: str
    goal: str
    state: str
    start_date: date | None
    end_date: date | None
    started_at: datetime | None
    completed_at: datetime | None
    committed_points: float | None
    completed_points: float | None


class SprintWithStats(SprintOut):
    issue_count: int = 0
    done_count: int = 0
    total_points: float = 0
    done_points: float = 0


# ---------- Issues ----------


class IssueCreate(BaseModel):
    project_id: int
    issue_type: IssueType = "task"
    summary: str = Field(min_length=1, max_length=255)
    description: str = ""
    priority: Priority = "medium"
    assignee_id: int | None = None
    parent_id: int | None = None
    sprint_id: int | None = None
    status_id: int | None = None
    story_points: float | None = Field(None, ge=0, le=1000)
    original_estimate_hours: float | None = Field(None, ge=0)
    start_date: date | None = None
    due_date: date | None = None
    labels: list[str] = []
    custom_fields: dict[str, Any] = {}


class IssueUpdate(BaseModel):
    version: int | None = Field(None, description="Optimistic concurrency token; 409 on mismatch")
    issue_type: IssueType | None = None
    summary: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    priority: Priority | None = None
    assignee_id: int | None = None
    parent_id: int | None = None
    sprint_id: int | None = None
    status_id: int | None = None
    story_points: float | None = Field(None, ge=0, le=1000)
    original_estimate_hours: float | None = Field(None, ge=0)
    time_spent_hours: float | None = Field(None, ge=0)
    start_date: date | None = None
    due_date: date | None = None
    labels: list[str] | None = None
    custom_fields: dict[str, Any] | None = None


class IssueMove(BaseModel):
    """Board / backlog drag-and-drop move."""

    status_id: int | None = None
    sprint_id: int | None = None
    move_sprint: bool = False  # when true, sprint_id (incl. null = backlog) is applied
    above_id: int | None = None  # neighbour that ends up directly above the moved issue
    below_id: int | None = None  # neighbour that ends up directly below the moved issue


class IssueRef(ORM):
    id: int
    key: str
    summary: str
    issue_type: str
    priority: str
    status: StatusOut
    assignee: UserBrief | None


class IssueOut(ORM):
    id: int
    key: str
    number: int
    project_id: int
    issue_type: str
    summary: str
    description: str
    status: StatusOut
    priority: str
    assignee: UserBrief | None
    reporter: UserBrief | None
    parent_id: int | None
    sprint_id: int | None
    story_points: float | None
    original_estimate_hours: float | None
    time_spent_hours: float
    start_date: date | None
    due_date: date | None
    resolved_at: datetime | None
    rank: float
    labels: list[str]
    custom_fields: dict
    version: int
    created_at: datetime
    updated_at: datetime


class IssueListItem(IssueOut):
    parent_key: str | None = None
    parent_summary: str | None = None
    sprint_name: str | None = None
    project_key: str | None = None
    child_count: int = 0
    child_done_count: int = 0


class LinkOut(BaseModel):
    id: int
    link_type: str
    direction: Literal["outward", "inward"]
    label: str
    issue: IssueRef


class IssueDetail(IssueListItem):
    project: ProjectOut
    sprint: SprintOut | None
    parent: IssueRef | None
    children: list[IssueRef]
    links: list[LinkOut]
    watchers: list[UserBrief]
    is_watching: bool
    can_edit: bool
    available_transitions: list[StatusOut]


class LinkIn(BaseModel):
    target_id: int
    link_type: LinkType


class CommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=20000)


class CommentOut(ORM):
    id: int
    issue_id: int
    author: UserBrief | None
    body: str
    created_at: datetime
    updated_at: datetime


class AttachmentOut(ORM):
    id: int
    issue_id: int
    filename: str
    content_type: str
    size_bytes: int
    uploader: UserBrief | None
    created_at: datetime


class HistoryOut(ORM):
    id: int
    issue_id: int
    actor: UserBrief | None
    field: str
    old_value: str | None
    new_value: str | None
    created_at: datetime


class ActivityOut(HistoryOut):
    issue_key: str
    issue_summary: str
    project_key: str


class BulkUpdate(BaseModel):
    issue_ids: list[int] = Field(min_length=1, max_length=500)
    status_id: int | None = None
    assignee_id: int | None = None
    sprint_id: int | None = None
    priority: Priority | None = None
    set_assignee: bool = False
    set_sprint: bool = False


# ---------- Collaboration ----------


class NotificationOut(ORM):
    id: int
    kind: str
    message: str
    issue_id: int | None
    project_id: int | None
    is_read: bool
    actor: UserBrief | None
    created_at: datetime
    issue_key: str | None = None


class SavedFilterIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    project_id: int | None = None
    query: dict[str, Any]
    is_shared: bool = False


class SavedFilterOut(ORM):
    id: int
    name: str
    project_id: int | None
    query: dict
    is_shared: bool
    owner: UserBrief
    created_at: datetime


class AuditOut(ORM):
    id: int
    actor: UserBrief | None
    action: str
    entity_type: str
    entity_id: int | None
    details: dict
    ip_address: str | None
    created_at: datetime


class Page[T](BaseModel):
    items: list[T]
    total: int
    page: int
    page_size: int
