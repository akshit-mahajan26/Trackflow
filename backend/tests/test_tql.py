from datetime import date, timedelta

import pytest

from app.services.tql import BoolOp, Clause, Func, Not, TQLError, parse


def test_parser_builds_ast_with_precedence():
    q = parse('project = APP AND (status IN ("In Progress", Done) OR NOT assignee IS EMPTY) ORDER BY priority DESC, rank')
    assert isinstance(q.where, BoolOp) and q.where.op == "and"
    assert q.where.left == Clause("project", "=", ("APP",))
    right = q.where.right
    assert right.op == "or" and right.left == Clause("status", "in", ("In Progress", "Done"))
    assert right.right == Not(Clause("assignee", "is_empty", ()))
    assert q.order == (("priority", "desc"), ("rank", "asc"))
    assert parse("assignee = currentUser()").where.values == (Func("currentuser", ()),)
    assert parse('"Story Points" > 3').where.field == "storypoints"
    assert parse("ORDER BY created DESC").where is None


@pytest.mark.parametrize("bad", ['project =', 'status IN (', 'a = b AND', 'x ?? y', '((((' * 6 + 'a=b' + '))))' * 6,
                                 'summary = "unterminated', 'project = APP ORDER created'])
def test_parser_rejects_malformed(bad):
    with pytest.raises(TQLError):
        parse(bad)


def _keys(ctx, tql, h=None):
    r = ctx.c.get("/api/issues", params={"tql": tql}, headers=h or ctx.pm)
    assert r.status_code == 200, r.text
    return sorted(i["key"] for i in r.json()["items"])


def test_tql_end_to_end(ctx):
    c = ctx.c
    s = c.post("/api/projects/APP/sprints", json={}, headers=ctx.pm).json()
    epic = ctx.issue(issue_type="epic", summary="Payments epic")
    a = ctx.issue(summary="Card declined error", issue_type="bug", priority="highest", assignee_id=ctx.dev_user.id,
                  labels=["payments"], story_points=5, sprint_id=s["id"], parent_id=epic["id"],
                  due_date=(date.today() - timedelta(days=2)).isoformat())
    b = ctx.issue(summary="Refactor checkout", priority="low", story_points=2, sprint_id=s["id"])
    d = ctx.issue(summary="Docs", status_id=ctx.statuses["Done"])
    c.post(f"/api/sprints/{s['id']}/start", json={}, headers=ctx.pm)

    assert _keys(ctx, "project = APP AND type = bug") == [a["key"]]
    assert _keys(ctx, "assignee = currentUser()", ctx.dev) == [a["key"]]
    assert _keys(ctx, "assignee = dave") == [a["key"]]
    assert _keys(ctx, "sprint = activeSprint() AND priority >= high") == [a["key"]]
    assert _keys(ctx, "sprint IN openSprints() ORDER BY rank") == sorted([a["key"], b["key"]])
    assert _keys(ctx, 'status = "Done"') == [d["key"]]
    assert _keys(ctx, "statusCategory != done AND type != epic") == sorted([a["key"], b["key"]])
    assert _keys(ctx, "labels = payments") == [a["key"]]
    assert _keys(ctx, f"epic = {epic['key']}") == [a["key"]]
    assert _keys(ctx, 'summary ~ "checkout"') == [b["key"]]
    assert _keys(ctx, "storyPoints > 3") == [a["key"]]
    assert _keys(ctx, "due < now() AND statusCategory != done") == [a["key"]]
    assert _keys(ctx, "due < -1d") == [a["key"]]
    assert _keys(ctx, "assignee IS EMPTY AND NOT type = epic") == sorted([b["key"], d["key"]])
    assert _keys(ctx, f"created >= {date.today().isoformat()}") == sorted([epic["key"], a["key"], b["key"], d["key"]])
    r = c.get("/api/issues", params={"tql": "type = bug OR priority = low ORDER BY priority DESC"}, headers=ctx.pm).json()
    assert [i["key"] for i in r["items"]] == [a["key"], b["key"]]
    # access scoping: outsider sees nothing even for an unrestricted query
    assert _keys(ctx, "project = APP", ctx.outsider) == []
    # injection attempts are just values
    assert _keys(ctx, "summary ~ \"'; DROP TABLE issues; --\"") == []
    assert c.get("/api/issues", params={"tql": "status = Done"}, headers=ctx.pm).json()["total"] == 1
    # errors are 422 with position info
    r = c.get("/api/issues", params={"tql": "bogusfield = 1"}, headers=ctx.pm)
    assert r.status_code == 422 and "Unknown field" in r.json()["detail"]
    # project scope is applied outside the TQL string, so ORDER BY in the query still works
    r = c.get("/api/issues", params={"tql": "type != epic ORDER BY priority DESC", "project_ids": ctx.pid}, headers=ctx.pm)
    assert r.status_code == 200 and r.json()["items"][0]["key"] == a["key"]
    r = c.get("/api/issues", params={"tql": "type = bug", "project_ids": 999}, headers=ctx.pm)
    assert r.json()["total"] == 0
    r = c.get("/api/issues/export.csv", params={"tql": "type = bug"}, headers=ctx.pm)
    assert r.status_code == 200 and len(r.text.strip().splitlines()) == 2
