from datetime import date, datetime, timedelta, timezone

from sqlalchemy import update

from app.core.database import SessionLocal
from app.models import Issue, IssueHistory, Sprint


def _sprint(ctx, **kw):
    r = ctx.c.post("/api/projects/APP/sprints", json=kw, headers=ctx.pm)
    assert r.status_code == 201, r.text
    return r.json()


def test_sprint_lifecycle(ctx):
    c = ctx.c
    s1 = _sprint(ctx, goal="Ship login")
    assert s1["name"] == "APP Sprint 1" and s1["state"] == "future"
    # cannot start an empty sprint; developers cannot manage sprints
    assert c.post(f"/api/sprints/{s1['id']}/start", json={}, headers=ctx.pm).status_code == 422
    a = ctx.issue(story_points=5, sprint_id=s1["id"])
    b = ctx.issue(story_points=3)
    r = c.post(f"/api/issues/{b['key']}/move", json={"sprint_id": s1["id"], "move_sprint": True}, headers=ctx.dev)
    assert r.json()["sprint_id"] == s1["id"]
    assert c.post(f"/api/sprints/{s1['id']}/start", json={}, headers=ctx.dev).status_code == 403
    r = c.post(f"/api/sprints/{s1['id']}/start", json={"end_date": (date.today() + timedelta(days=10)).isoformat()}, headers=ctx.pm)
    assert r.status_code == 200 and r.json()["state"] == "active" and r.json()["committed_points"] == 8
    # only one active sprint
    s2 = _sprint(ctx)
    ctx.issue(sprint_id=s2["id"])
    assert c.post(f"/api/sprints/{s2['id']}/start", json={}, headers=ctx.pm).status_code == 409
    # scrum board shows the active sprint
    board = c.get("/api/projects/APP/board", headers=ctx.viewer).json()
    assert board["sprint"]["id"] == s1["id"] and {i["key"] for i in board["issues"]} == {a["key"], b["key"]}
    # complete with one done issue, carry the other to sprint 2
    c.patch(f"/api/issues/{a['key']}", json={"status_id": ctx.statuses["Done"]}, headers=ctx.dev)
    r = c.post(f"/api/sprints/{s1['id']}/complete", json={"move_incomplete_to": s2["id"]}, headers=ctx.pm)
    assert r.status_code == 200
    assert (r.json()["completed"], r.json()["incomplete"]) == (1, 1)
    assert r.json()["sprint"]["completed_points"] == 5
    assert c.get(f"/api/issues/{b['key']}", headers=ctx.pm).json()["sprint_id"] == s2["id"]
    assert c.get(f"/api/issues/{a['key']}", headers=ctx.pm).json()["sprint_id"] == s1["id"]  # history preserved
    # closed sprint: cannot add issues / edit
    assert c.patch(f"/api/issues/{b['key']}", json={"sprint_id": s1["id"]}, headers=ctx.pm).status_code == 422
    assert c.patch(f"/api/sprints/{s1['id']}", json={"goal": "x"}, headers=ctx.pm).status_code == 422
    # velocity
    v = c.get("/api/projects/APP/reports/velocity", headers=ctx.pm).json()
    assert v == [{"sprint_id": s1["id"], "name": "APP Sprint 1", "committed": 8, "completed": 5,
                  "completed_at": v[0]["completed_at"]}]
    # backlog view excludes closed sprints
    bl = c.get("/api/projects/APP/backlog", headers=ctx.pm).json()
    assert [s["id"] for s in bl["sprints"]] == [s2["id"]]
    # deleting a future sprint returns its issues to the backlog
    assert c.delete(f"/api/sprints/{s2['id']}", headers=ctx.pm).status_code == 204
    assert c.get(f"/api/issues/{b['key']}", headers=ctx.pm).json()["sprint_id"] is None


def test_completion_day_counts_scope_before_carry_over(ctx):
    c = ctx.c
    s = _sprint(ctx)
    nxt = _sprint(ctx)
    done = ctx.issue(story_points=3, sprint_id=s["id"])
    ctx.issue(story_points=5, sprint_id=s["id"])
    c.post(f"/api/sprints/{s['id']}/start", json={}, headers=ctx.pm)
    c.patch(f"/api/issues/{done['key']}", json={"status_id": ctx.statuses["Done"]}, headers=ctx.pm)
    c.post(f"/api/sprints/{s['id']}/complete", json={"move_incomplete_to": nxt["id"]}, headers=ctx.pm)
    last = c.get(f"/api/sprints/{s['id']}/report", headers=ctx.pm).json()["series"][-1]
    # at the moment of completion the unfinished 5 points were still in scope
    assert (last["scope"], last["completed"], last["remaining"]) == (8, 3, 5)


def test_epics_cannot_join_sprints(ctx):
    s = _sprint(ctx)
    epic = ctx.issue(issue_type="epic")
    assert ctx.c.patch(f"/api/issues/{epic['key']}", json={"sprint_id": s["id"]}, headers=ctx.pm).status_code == 422


def _backdate(issue_ids: list[int], sprint_id: int, start: date, days_ago_done: dict[int, int]):
    """Rewrite timestamps so the sprint ran over the past days (reports read real history rows)."""
    start_dt = datetime.combine(start, datetime.min.time(), tzinfo=timezone.utc)
    with SessionLocal() as db:
        db.execute(update(Sprint).where(Sprint.id == sprint_id).values(start_date=start, started_at=start_dt))
        for iid in issue_ids:
            db.execute(update(Issue).where(Issue.id == iid).values(created_at=start_dt - timedelta(days=1)))
            db.execute(update(IssueHistory).where(IssueHistory.issue_id == iid, IssueHistory.field.in_(["created", "sprint"]))
                       .values(created_at=start_dt - timedelta(hours=12)))
        for iid, ago in days_ago_done.items():
            when = datetime.now(timezone.utc) - timedelta(days=ago)
            db.execute(update(IssueHistory).where(IssueHistory.issue_id == iid, IssueHistory.field == "status")
                       .values(created_at=when))
            db.execute(update(Issue).where(Issue.id == iid).values(resolved_at=when))
        db.commit()


def test_burndown_burnup_from_history(ctx):
    c = ctx.c
    s = _sprint(ctx)
    a = ctx.issue(story_points=5, sprint_id=s["id"])
    b = ctx.issue(story_points=3, sprint_id=s["id"])
    c3 = ctx.issue(story_points=2, sprint_id=s["id"])
    start = date.today() - timedelta(days=4)
    c.post(f"/api/sprints/{s['id']}/start", json={"start_date": start.isoformat(),
                                                   "end_date": (date.today() + timedelta(days=5)).isoformat()}, headers=ctx.pm)
    c.patch(f"/api/issues/{a['key']}", json={"status_id": ctx.statuses["Done"]}, headers=ctx.pm)
    c.patch(f"/api/issues/{b['key']}", json={"status_id": ctx.statuses["Done"]}, headers=ctx.pm)
    _backdate([a["id"], b["id"], c3["id"]], s["id"], start, {a["id"]: 3, b["id"]: 1})
    rep = c.get(f"/api/sprints/{s['id']}/report", headers=ctx.viewer).json()
    series = {row["date"]: row for row in rep["series"]}
    d = lambda n: (date.today() - timedelta(days=n)).isoformat()  # noqa: E731
    assert rep["committed_points"] == 10
    assert series[d(4)]["remaining"] == 10 and series[d(4)]["scope"] == 10
    assert series[d(3)]["remaining"] == 5 and series[d(3)]["completed"] == 5
    assert series[d(1)]["remaining"] == 2
    assert series[d(0)]["remaining"] == 2
    future = (date.today() + timedelta(days=2)).isoformat()
    assert series[future]["remaining"] is None          # no fabricated future data
    assert series[d(4)]["ideal"] == 10 and rep["series"][-1]["ideal"] == 0
    # CSV export of the same series
    r = c.get(f"/api/projects/APP/reports/burndown.csv?sprint_id={s['id']}", headers=ctx.pm)
    assert r.status_code == 200 and r.text.startswith("date,")


def test_scope_change_mid_sprint_shows_in_burnup(ctx):
    c = ctx.c
    s = _sprint(ctx)
    ctx.issue(story_points=4, sprint_id=s["id"])
    c.post(f"/api/sprints/{s['id']}/start", json={}, headers=ctx.pm)
    late = ctx.issue(story_points=6)
    c.post(f"/api/issues/{late['key']}/move", json={"sprint_id": s["id"], "move_sprint": True}, headers=ctx.pm)
    today = c.get(f"/api/sprints/{s['id']}/report", headers=ctx.pm).json()["series"][0]
    assert today["scope"] == 10 and today["remaining"] == 10


def test_cumulative_flow_resolution_and_completion(ctx):
    c = ctx.c
    epic = ctx.issue(issue_type="epic", summary="Epic")
    a = ctx.issue(parent_id=epic["id"], story_points=2)
    ctx.issue(parent_id=epic["id"], issue_type="bug")
    c.patch(f"/api/issues/{a['key']}", json={"status_id": ctx.statuses["Done"]}, headers=ctx.pm)
    cfd = c.get("/api/projects/APP/reports/cumulative-flow", headers=ctx.pm).json()
    last = cfd["series"][-1]
    assert last["Done"] == 1 and last["To Do"] == 1 and len(cfd["series"]) == 30
    assert cfd["series"][0]["Done"] == 0
    res = c.get("/api/projects/APP/reports/resolution-time", headers=ctx.pm).json()
    assert res["overall"]["count"] == 1 and res["distribution"][0]["count"] == 1
    comp = c.get("/api/projects/APP/reports/completion", headers=ctx.pm).json()
    assert (comp["total_issues"], comp["done_issues"], comp["percent_complete"]) == (2, 1, 50.0)
    assert comp["epics"][0]["total"] == 2 and comp["epics"][0]["done"] == 1
    # reports require project access
    assert c.get("/api/projects/APP/reports/completion", headers=ctx.outsider).status_code == 404
    assert c.get("/api/projects/APP/reports/velocity.csv", headers=ctx.pm).status_code == 200


def test_dashboards(ctx):
    ctx.issue(assignee_id=ctx.dev_user.id, due_date=(date.today() - timedelta(days=1)).isoformat(), story_points=3)
    ctx.issue(due_date=(date.today() + timedelta(days=2)).isoformat())
    g = ctx.c.get("/api/dashboard", headers=ctx.dev).json()
    assert g["counts"]["total"] == 2 and g["counts"]["overdue"] == 1 and g["counts"]["assigned_to_me"] == 1
    assert g["counts"]["due_this_week"] == 1
    assert g["workload"][0]["name"] == "Dave" and g["workload"][0]["open_points"] == 3
    assert len(g["trend"]) == 14 and g["trend"][-1]["created"] == 2
    assert ctx.c.get("/api/dashboard", headers=ctx.outsider).json()["counts"]["total"] == 0
    p = ctx.c.get("/api/projects/APP/dashboard", headers=ctx.viewer).json()
    assert p["counts"]["open"] == 2


def test_kanban_board_and_wip(ctx):
    c = ctx.c
    c.patch("/api/projects/APP", json={"board_type": "kanban"}, headers=ctx.pm)
    c.patch(f"/api/projects/APP/statuses/{ctx.statuses['In Progress']}", json={"wip_limit": 2}, headers=ctx.pm)
    ctx.issue(summary="k1")
    ctx.issue(issue_type="epic", summary="epic hidden")
    b = c.get("/api/projects/APP/board", headers=ctx.dev).json()
    assert b["board_type"] == "kanban" and [i["summary"] for i in b["issues"]] == ["k1"]
    assert next(col for col in b["columns"] if col["name"] == "In Progress")["wip_limit"] == 2
    # board filters
    assert c.get("/api/projects/APP/board?assignee_ids=me", headers=ctx.dev).json()["issues"] == []
