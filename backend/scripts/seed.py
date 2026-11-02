"""Seed demonstration data through the real service layer.

    python -m scripts.seed            # refuses if projects already exist
    python -m scripts.seed --force    # add demo data anyway

All records are created via the same services the API uses, so history, notifications and
reports are genuine. To give reports a past, the script runs in "phases" and afterwards shifts
the timestamps of rows written during each phase back by N days.
"""

import argparse
import random
import sys
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select, text

from app.core.database import SessionLocal
from app.core.security import hash_password
from app.models import Comment, CustomField, Issue, IssueHistory, IssueLink, Project, ProjectMember, User, WorkflowStatus
from app.services import issues as issue_svc
from app.services import projects as project_svc
from app.services import sprints as sprint_svc
from app.services.notifications import add_watcher

DEMO_PASSWORD = "demo12345"
random.seed(42)

PEOPLE = [
    ("priya", "Priya Raman", "Engineering Manager"),
    ("marco", "Marco Bianchi", "Scrum Master"),
    ("lena", "Lena Fischer", "Senior Backend Engineer"),
    ("sam", "Sam Okafor", "Frontend Engineer"),
    ("ken", "Ken Watanabe", "Full-stack Engineer"),
    ("ana", "Ana Souza", "QA Engineer"),
    ("omar", "Omar Haddad", "Product Owner"),
]
ROLES = {"priya": "project_manager", "marco": "scrum_master", "lena": "developer", "sam": "developer",
         "ken": "developer", "ana": "reporter", "omar": "viewer"}

TABLES_CREATED = ["issues", "issue_history", "comments", "notifications", "sprints", "audit_logs", "issue_links", "attachments"]


class Phase:
    """Shift every row written inside the `with` block back by `days_ago` days."""

    def __init__(self, db, days_ago: int):
        self.db, self.days = db, days_ago

    def __enter__(self):
        self.db.commit()
        # now() = transaction start, the same value server defaults stamp on rows written in this phase
        self.t0 = self.db.scalar(text("SELECT now()"))
        return self

    def __exit__(self, *exc):
        if exc[0]:
            return False
        self.db.commit()
        if self.days == 0:
            return False
        p = {"t0": self.t0, "d": timedelta(days=self.days)}
        for t in TABLES_CREATED:
            self.db.execute(text(f"UPDATE {t} SET created_at = created_at - :d WHERE created_at >= :t0"), p)
        for col in ("updated_at", "resolved_at"):
            self.db.execute(text(f"UPDATE issues SET {col} = {col} - :d WHERE {col} >= :t0"), p)
        for col in ("started_at", "completed_at", "updated_at"):
            self.db.execute(text(f"UPDATE sprints SET {col} = {col} - :d WHERE {col} >= :t0"), p)
        self.db.commit()
        self.db.expire_all()
        return False


def user(db, username: str) -> User:
    return db.scalar(select(User).where(User.username == username))


def status(db, project: Project, name: str) -> int:
    return db.scalar(select(WorkflowStatus.id).where(WorkflowStatus.project_id == project.id, WorkflowStatus.name == name))


def mk(db, actor: User, project: Project, summary: str, **kw) -> Issue:
    kw.setdefault("issue_type", "story")
    kw.setdefault("priority", "medium")
    return issue_svc.create_issue(db, actor, {"project_id": project.id, "summary": summary, "description": kw.pop("description", ""), **kw})


def move(db, actor: User, issue: Issue, status_name: str):
    issue_svc.update_issue(db, actor, issue, {"status_id": status(db, db.get(Project, issue.project_id), status_name)})


def comment(db, actor: User, issue: Issue, body: str):
    db.add(Comment(issue_id=issue.id, author_id=actor.id, body=body))
    db.add(IssueHistory(issue_id=issue.id, project_id=issue.project_id, actor_id=actor.id, field="comment", new_value=body[:200]))
    add_watcher(db, issue.id, actor.id)


def main(force: bool) -> None:
    db = SessionLocal()
    if db.scalar(select(func.count(Project.id))) and not force:
        print("Projects already exist; refusing to seed. Use --force to add demo data anyway.")
        sys.exit(1)

    admin = db.scalar(select(User).where(User.is_admin.is_(True)).order_by(User.id))
    if not admin:
        print("No administrator found. Start the server once (it creates the bootstrap admin) and retry.")
        sys.exit(1)

    colors = ["#7c3aed", "#0891b2", "#db2777", "#16a34a", "#ea580c", "#ca8a04", "#4f46e5"]
    for (username, name, title), color in zip(PEOPLE, colors):
        if not user(db, username):
            db.add(User(username=username, email=f"{username}@trackflow.local", full_name=name, job_title=title,
                        avatar_color=color, password_hash=hash_password(DEMO_PASSWORD)))
    db.commit()
    u = {name: user(db, name) for name, *_ in PEOPLE}
    pm, sm, lena, sam, ken, ana = u["priya"], u["marco"], u["lena"], u["sam"], u["ken"], u["ana"]
    today = date.today()

    # ---------------- Phase A: 22 days ago — set up projects, epics, backlog, sprint 1 ----------------
    with Phase(db, 22):
        web = project_svc.create_project(db, pm, {
            "key": "WEB", "name": "Customer Web App", "board_type": "scrum", "priority": "high",
            "description": "The customer-facing web application: authentication, checkout and account management.",
            "start_date": today - timedelta(days=30), "due_date": today + timedelta(days=60)})
        ops = project_svc.create_project(db, lena, {
            "key": "OPS", "name": "Platform Operations", "board_type": "kanban", "priority": "medium",
            "description": "Infrastructure, CI/CD and on-call work for the platform team."})
        db.flush()
        for name, role in ROLES.items():
            for proj in (web, ops):
                if not db.scalar(select(ProjectMember.id).where(ProjectMember.project_id == proj.id, ProjectMember.user_id == u[name].id)):
                    db.add(ProjectMember(project_id=proj.id, user_id=u[name].id, role=role if proj is web else
                                         ("project_manager" if name == "lena" else "developer" if role in ("developer", "scrum_master") else role)))
        db.flush()
        qa = db.get(WorkflowStatus, status(db, web, "In Review"))
        qa.wip_limit = 3
        env = CustomField(project_id=web.id, name="Environment", field_type="select", options=["production", "staging", "development"], position=0)
        db.add(env)
        db.flush()

        auth = mk(db, pm, web, "Accounts & authentication", issue_type="epic", priority="high",
                  start_date=today - timedelta(days=22), due_date=today + timedelta(days=10),
                  description="Everything needed for customers to sign up, sign in and manage their sessions securely.")
        checkout = mk(db, pm, web, "Checkout redesign", issue_type="epic", priority="highest",
                      start_date=today - timedelta(days=8), due_date=today + timedelta(days=35),
                      description="Reduce checkout abandonment with a single-page flow and saved payment methods.")
        perf = mk(db, pm, web, "Performance & reliability", issue_type="epic",
                  start_date=today + timedelta(days=5), due_date=today + timedelta(days=50))

        s1_items = [
            ("Email + password sign-up", auth, lena, 5, "story"),
            ("Login form with validation", auth, sam, 3, "story"),
            ("Password reset via email link", auth, lena, 5, "story"),
            ("Session timeout logs users out mid-form", auth, ken, 2, "bug"),
            ("Remember-me checkbox", auth, sam, 2, "story"),
            ("Rate-limit login attempts", auth, ken, 3, "task"),
            ("Add 2FA with TOTP apps", auth, lena, 8, "story"),
        ]
        sprint1 = sprint_svc.create_sprint(db, web, {"name": "WEB Sprint 1", "goal": "Customers can sign up and log in",
                                                     "start_date": today - timedelta(days=22), "end_date": today - timedelta(days=9)})
        s1 = []
        for summary, epic, who, pts, typ in s1_items:
            s1.append(mk(db, sm, web, summary, issue_type=typ, parent_id=epic.id, assignee_id=who.id, story_points=pts,
                         sprint_id=sprint1.id, labels=["auth"], priority="high" if typ == "bug" else "medium",
                         custom_fields={str(env.id): "production"} if typ == "bug" else {}))
        backlog_items = [
            ("Single-page checkout layout", checkout, 8, "story", ["frontend"]),
            ("Saved payment methods", checkout, 8, "story", ["payments"]),
            ("Apple Pay / Google Pay buttons", checkout, 5, "story", ["payments"]),
            ("Address autocomplete", checkout, 3, "story", ["frontend"]),
            ("Order summary sidebar", checkout, 3, "story", ["frontend"]),
            ("Coupon code validation API", checkout, 3, "task", ["backend"]),
            ("Card declined error is not shown", checkout, 2, "bug", ["payments"]),
            ("Tax calculation off by one cent", checkout, 2, "bug", ["backend"]),
            ("Lazy-load product images", perf, 3, "improvement", ["frontend", "performance"]),
            ("Add database indexes for order history", perf, 2, "task", ["backend", "performance"]),
            ("Set up synthetic uptime checks", perf, 2, "task", ["ops"]),
            ("Cache product catalogue responses", perf, 5, "improvement", ["backend", "performance"]),
            ("Dark mode for account pages", None, 3, "improvement", ["frontend"]),
            ("Export order history to CSV", None, 3, "story", []),
        ]
        backlog = []
        for summary, epic, pts, typ, labels in backlog_items:
            backlog.append(mk(db, pm, web, summary, issue_type=typ, parent_id=epic.id if epic else None,
                              story_points=pts, labels=labels, priority=random.choice(["high", "medium", "medium", "low"])))
        sprint_svc.start_sprint(db, sm, sprint1, {"start_date": today - timedelta(days=22), "end_date": today - timedelta(days=9)})

        ops_items = [
            ("Upgrade PostgreSQL to 17", "task", lena, "high"), ("Rotate TLS certificates", "task", ken, "highest"),
            ("CI pipeline takes 25 minutes", "improvement", ken, "medium"), ("Disk alert on worker-3", "bug", lena, "high"),
            ("Terraform state locking", "task", ken, "medium"), ("Nightly backup verification job", "task", lena, "high"),
        ]
        ops_issues = [mk(db, lena, ops, s, issue_type=t, assignee_id=a.id, priority=p, labels=["infra"]) for s, t, a, p in ops_items]

    # ---------------- Sprint 1 progress ----------------
    with Phase(db, 20):
        move(db, lena, s1[0], "In Progress"); move(db, sam, s1[1], "In Progress"); move(db, ken, s1[3], "In Progress")
        move(db, lena, ops_issues[0], "In Progress")
    with Phase(db, 18):
        move(db, sam, s1[1], "In Review"); move(db, ken, s1[3], "Done")
        comment(db, ana, s1[3], "Verified on staging — sessions now extend while the user is typing. @ken nice fix!")
        move(db, ken, ops_issues[1], "In Progress")
    with Phase(db, 16):
        move(db, lena, s1[0], "In Review"); move(db, sam, s1[1], "Done"); move(db, ken, s1[5], "In Progress")
        move(db, ken, ops_issues[1], "Done")
    with Phase(db, 14):
        move(db, lena, s1[0], "Done"); move(db, lena, s1[2], "In Progress"); move(db, sam, s1[4], "In Progress")
        # scope added mid-sprint
        late = mk(db, sm, web, "Show password strength meter", issue_type="story", parent_id=auth.id,
                  assignee_id=sam.id, story_points=2, labels=["auth", "frontend"])
        issue_svc.move_issue(db, sm, late, status_id=None, sprint_id=sprint1.id, move_sprint=True, above_id=None, below_id=None)
        move(db, ken, ops_issues[2], "In Progress")
    with Phase(db, 11):
        move(db, ken, s1[5], "Done"); move(db, sam, s1[4], "Done"); move(db, lena, s1[2], "In Review")
        comment(db, lena, s1[2], "Reset tokens expire after 30 minutes and are single-use. @marco can we pull 2FA into next sprint?")
        move(db, lena, ops_issues[0], "Done")

    # ---------------- Close sprint 1, start sprint 2 ----------------
    with Phase(db, 9):
        sprint2 = sprint_svc.create_sprint(db, web, {"name": "WEB Sprint 2", "goal": "Finish auth and start the new checkout",
                                                     "start_date": today - timedelta(days=8), "end_date": today + timedelta(days=5)})
        sprint_svc.complete_sprint(db, sm, sprint1, sprint2.id)
        for i in backlog[:4] + [backlog[6]]:
            issue_svc.move_issue(db, sm, i, status_id=None, sprint_id=sprint2.id, move_sprint=True, above_id=None, below_id=None)
        db.flush()
        for i, who in zip(backlog[:4] + [backlog[6]], [sam, lena, ken, sam, ken]):
            issue_svc.update_issue(db, sm, i, {"assignee_id": who.id, "due_date": today + timedelta(days=random.randint(-2, 6))})
        sprint_svc.start_sprint(db, sm, sprint2, {"start_date": today - timedelta(days=8), "end_date": today + timedelta(days=5)})

    with Phase(db, 7):
        move(db, lena, s1[2], "Done"); move(db, sam, backlog[0], "In Progress"); move(db, ken, backlog[6], "In Progress")
        issue_svc.create_issue(db, sam, {"project_id": web.id, "summary": "Build step layout component", "issue_type": "subtask",
                                         "parent_id": backlog[0].id, "assignee_id": sam.id, "sprint_id": sprint2.id})
        db.flush()
        issue_svc.create_issue(db, sam, {"project_id": web.id, "summary": "Wire form state to API", "issue_type": "subtask",
                                         "parent_id": backlog[0].id, "assignee_id": sam.id, "sprint_id": sprint2.id})
    with Phase(db, 5):
        move(db, ken, backlog[6], "In Review"); move(db, lena, backlog[1], "In Progress"); move(db, lena, s1[6], "In Progress")
        db.add(IssueLink(source_id=backlog[1].id, target_id=backlog[2].id, link_type="blocks", created_by_id=lena.id))
        comment(db, ana, backlog[6], "Repro: use test card 4000 0000 0000 0002. The spinner never stops.")
        move(db, ken, ops_issues[2], "In Review"); move(db, lena, ops_issues[3], "In Progress")
    with Phase(db, 3):
        move(db, ken, backlog[6], "Done"); move(db, sam, backlog[3], "In Progress")
        mk(db, ana, web, "Checkout button misaligned on Safari 17", issue_type="bug", priority="high", labels=["frontend", "safari"],
           custom_fields={str(env.id): "staging"}, description="On Safari 17 the Pay button overlaps the total. @sam could you take a look?")
        move(db, ken, ops_issues[2], "Done")
    with Phase(db, 1):
        move(db, sam, backlog[3], "In Review"); move(db, ken, backlog[2], "In Progress")
        comment(db, pm, backlog[1], "Reminder: legal needs to sign off on storing card fingerprints before we ship. @lena")

    # ---------------- Today ----------------
    with Phase(db, 0):
        sprint3 = sprint_svc.create_sprint(db, web, {"name": "WEB Sprint 3", "goal": "Payments polish + performance",
                                                     "start_date": today + timedelta(days=6), "end_date": today + timedelta(days=19)})
        for i in [backlog[4], backlog[5], backlog[7], backlog[9]]:
            issue_svc.move_issue(db, sm, i, status_id=None, sprint_id=sprint3.id, move_sprint=True, above_id=None, below_id=None)
        mk(db, admin, ops, "Document restore procedure", issue_type="task", assignee_id=lena.id, priority="high",
           due_date=today + timedelta(days=3), description="Write down and test the restore steps from backups/ on a clean VM.")

    db.close()
    print("Demo data created.")
    print(f"  Users (password '{DEMO_PASSWORD}'): " + ", ".join(n for n, *_ in PEOPLE))
    print("  Projects: WEB (scrum, 2 sprints of history + 1 planned), OPS (kanban)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    main(ap.parse_args().force)
