"""SQLAlchemy ORM models.

String columns with CHECK constraints are used instead of native PG enums so that
adding a value later is a simple constraint migration.
"""

from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB as JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

PROJECT_ROLES = ("project_manager", "scrum_master", "developer", "reporter", "viewer")
ISSUE_TYPES = ("epic", "story", "task", "bug", "improvement", "subtask")
PRIORITIES = ("highest", "high", "medium", "low", "lowest")
STATUS_CATEGORIES = ("todo", "in_progress", "done")
SPRINT_STATES = ("future", "active", "closed")
LINK_TYPES = ("blocks", "relates_to", "duplicates")
CUSTOM_FIELD_TYPES = ("text", "number", "date", "select")


def _in(col: str, values: tuple[str, ...]) -> str:
    return f"{col} IN ({', '.join(repr(v) for v in values)})"


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Incremented on password change / deactivation to invalidate existing tokens.
    token_version: Mapped[int] = mapped_column(Integer, default=0)
    avatar_color: Mapped[str] = mapped_column(String(20), default="#2563eb")
    job_title: Mapped[str | None] = mapped_column(String(120))
    theme: Mapped[str] = mapped_column(String(10), default="system")
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    memberships: Mapped[list["ProjectMember"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Project(TimestampMixin, Base):
    __tablename__ = "projects"
    __table_args__ = (
        CheckConstraint("board_type IN ('scrum', 'kanban')", name="ck_project_board_type"),
        CheckConstraint(_in("priority", PRIORITIES), name="ck_project_priority"),
        CheckConstraint("status IN ('active', 'archived')", name="ck_project_status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(10), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    board_type: Mapped[str] = mapped_column(String(10), default="scrum")
    priority: Mapped[str] = mapped_column(String(10), default="medium")
    status: Mapped[str] = mapped_column(String(10), default="active")
    lead_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    start_date: Mapped[date | None] = mapped_column(Date)
    due_date: Mapped[date | None] = mapped_column(Date)
    issue_seq: Mapped[int] = mapped_column(Integer, default=0)
    # Board configuration: e.g. {"swimlanes": "none", "enforce_transitions": false}
    settings: Mapped[dict] = mapped_column(JSON, default=dict)

    lead: Mapped[User | None] = relationship()
    members: Mapped[list["ProjectMember"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    statuses: Mapped[list["WorkflowStatus"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", order_by="WorkflowStatus.position"
    )


class ProjectMember(Base):
    __tablename__ = "project_members"
    __table_args__ = (
        UniqueConstraint("project_id", "user_id", name="uq_project_member"),
        CheckConstraint(_in("role", PROJECT_ROLES), name="ck_member_role"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(20), default="developer")
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    project: Mapped[Project] = relationship(back_populates="members")
    user: Mapped[User] = relationship(back_populates="memberships")


class WorkflowStatus(Base):
    """A workflow status; also a board column."""

    __tablename__ = "workflow_statuses"
    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_status_name"),
        CheckConstraint(_in("category", STATUS_CATEGORIES), name="ck_status_category"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(50))
    category: Mapped[str] = mapped_column(String(20), default="todo")
    position: Mapped[int] = mapped_column(Integer, default=0)
    wip_limit: Mapped[int | None] = mapped_column(Integer)

    project: Mapped[Project] = relationship(back_populates="statuses")


class WorkflowTransition(Base):
    """Allowed transition. Only enforced when project.settings.enforce_transitions is true."""

    __tablename__ = "workflow_transitions"
    __table_args__ = (UniqueConstraint("from_status_id", "to_status_id", name="uq_transition"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    from_status_id: Mapped[int] = mapped_column(ForeignKey("workflow_statuses.id", ondelete="CASCADE"))
    to_status_id: Mapped[int] = mapped_column(ForeignKey("workflow_statuses.id", ondelete="CASCADE"))


class Sprint(TimestampMixin, Base):
    __tablename__ = "sprints"
    __table_args__ = (
        CheckConstraint(_in("state", SPRINT_STATES), name="ck_sprint_state"),
        # DB-level guarantee: at most one active sprint per project, even under concurrent starts.
        Index("ux_one_active_sprint", "project_id", unique=True, postgresql_where="state = 'active'"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    goal: Mapped[str] = mapped_column(Text, default="")
    state: Mapped[str] = mapped_column(String(10), default="future")
    start_date: Mapped[date | None] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    committed_points: Mapped[float | None] = mapped_column(Float)
    completed_points: Mapped[float | None] = mapped_column(Float)
    committed_issue_ids: Mapped[list | None] = mapped_column(JSON)
    completed_issue_ids: Mapped[list | None] = mapped_column(JSON)


class Issue(TimestampMixin, Base):
    __tablename__ = "issues"
    __table_args__ = (
        UniqueConstraint("project_id", "number", name="uq_issue_number"),
        CheckConstraint(_in("issue_type", ISSUE_TYPES), name="ck_issue_type"),
        CheckConstraint(_in("priority", PRIORITIES), name="ck_issue_priority"),
        CheckConstraint("story_points IS NULL OR story_points >= 0", name="ck_issue_points"),
        Index("ix_issue_project_status", "project_id", "status_id"),
        Index("ix_issue_project_sprint", "project_id", "sprint_id"),
        Index("ix_issue_labels", "labels", postgresql_using="gin"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    key: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    issue_type: Mapped[str] = mapped_column(String(20), default="task")
    summary: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    status_id: Mapped[int] = mapped_column(ForeignKey("workflow_statuses.id", ondelete="RESTRICT"))
    priority: Mapped[str] = mapped_column(String(10), default="medium")
    assignee_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    reporter_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("issues.id", ondelete="SET NULL"), index=True)
    sprint_id: Mapped[int | None] = mapped_column(ForeignKey("sprints.id", ondelete="SET NULL"), index=True)
    story_points: Mapped[float | None] = mapped_column(Float)
    original_estimate_hours: Mapped[float | None] = mapped_column(Float)
    time_spent_hours: Mapped[float] = mapped_column(Float, default=0)
    start_date: Mapped[date | None] = mapped_column(Date)
    due_date: Mapped[date | None] = mapped_column(Date, index=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rank: Mapped[float] = mapped_column(Float, default=0, index=True)
    labels: Mapped[list] = mapped_column(JSON, default=list)
    custom_fields: Mapped[dict] = mapped_column(JSON, default=dict)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    __mapper_args__ = {"version_id_col": version}

    project: Mapped[Project] = relationship()
    status: Mapped[WorkflowStatus] = relationship()
    assignee: Mapped[User | None] = relationship(foreign_keys=[assignee_id])
    reporter: Mapped[User | None] = relationship(foreign_keys=[reporter_id])
    sprint: Mapped[Sprint | None] = relationship()
    parent: Mapped["Issue | None"] = relationship(remote_side="Issue.id", back_populates="children")
    children: Mapped[list["Issue"]] = relationship(back_populates="parent")


class IssueLink(Base):
    __tablename__ = "issue_links"
    __table_args__ = (
        UniqueConstraint("source_id", "target_id", "link_type", name="uq_issue_link"),
        CheckConstraint(_in("link_type", LINK_TYPES), name="ck_link_type"),
        CheckConstraint("source_id <> target_id", name="ck_link_not_self"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), index=True)
    target_id: Mapped[int] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), index=True)
    link_type: Mapped[str] = mapped_column(String(20))
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    source: Mapped[Issue] = relationship(foreign_keys=[source_id])
    target: Mapped[Issue] = relationship(foreign_keys=[target_id])


class Comment(TimestampMixin, Base):
    __tablename__ = "comments"

    id: Mapped[int] = mapped_column(primary_key=True)
    issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    body: Mapped[str] = mapped_column(Text)

    author: Mapped[User | None] = relationship()


class Attachment(Base):
    __tablename__ = "attachments"

    id: Mapped[int] = mapped_column(primary_key=True)
    issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), index=True)
    uploader_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    filename: Mapped[str] = mapped_column(String(255))
    stored_name: Mapped[str] = mapped_column(String(255), unique=True)
    content_type: Mapped[str] = mapped_column(String(120))
    size_bytes: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    uploader: Mapped[User | None] = relationship()


class Watcher(Base):
    __tablename__ = "watchers"
    __table_args__ = (UniqueConstraint("issue_id", "user_id", name="uq_watcher"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)

    user: Mapped[User] = relationship()


class IssueHistory(Base):
    """Field-level change log for an issue. Source of truth for activity feeds and reports."""

    __tablename__ = "issue_history"
    __table_args__ = (Index("ix_history_issue_created", "issue_id", "created_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    issue_id: Mapped[int] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"))
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    field: Mapped[str] = mapped_column(String(50))
    old_value: Mapped[str | None] = mapped_column(Text)
    new_value: Mapped[str | None] = mapped_column(Text)
    # Machine-readable ids (e.g. status ids / sprint ids) for report computation.
    old_ref: Mapped[int | None] = mapped_column(Integer)
    new_ref: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)

    actor: Mapped[User | None] = relationship()


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (Index("ix_notification_user_read", "user_id", "is_read"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(30))
    message: Mapped[str] = mapped_column(String(500))
    issue_id: Mapped[int | None] = mapped_column(ForeignKey("issues.id", ondelete="CASCADE"))
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    actor: Mapped[User | None] = relationship(foreign_keys=[actor_id])
    issue: Mapped[Issue | None] = relationship()


class SavedFilter(TimestampMixin, Base):
    __tablename__ = "saved_filters"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(120))
    query: Mapped[dict] = mapped_column(JSON, default=dict)
    is_shared: Mapped[bool] = mapped_column(Boolean, default=False)

    owner: Mapped[User] = relationship()


class CustomField(Base):
    __tablename__ = "custom_fields"
    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_custom_field_name"),
        CheckConstraint(_in("field_type", CUSTOM_FIELD_TYPES), name="ck_custom_field_type"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    field_type: Mapped[str] = mapped_column(String(10))
    options: Mapped[list] = mapped_column(JSON, default=list)
    required: Mapped[bool] = mapped_column(Boolean, default=False)
    position: Mapped[int] = mapped_column(Integer, default=0)


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    action: Mapped[str] = mapped_column(String(60), index=True)
    entity_type: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[int | None] = mapped_column(Integer)
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    ip_address: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)

    actor: Mapped[User | None] = relationship()


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[dict | str | int | bool | None] = mapped_column(JSON)
