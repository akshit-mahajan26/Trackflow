"""Concurrent-user scenarios against the real database (separate connections per thread)."""

import json
from concurrent.futures import ThreadPoolExecutor

from tests.conftest import login


def test_concurrent_issue_creation_yields_unique_gapless_keys(ctx):
    def create(n):
        r = ctx.c.post("/api/issues", json={"project_id": ctx.pid, "summary": f"c{n}"}, headers=[ctx.pm, ctx.dev][n % 2])
        return r.status_code, r.json().get("key")

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(create, range(40)))
    assert all(code == 201 for code, _ in results)
    keys = sorted(int(k.split("-")[1]) for _, k in results)
    assert keys == list(range(1, 41))


def test_concurrent_edits_one_wins_other_gets_conflict(ctx):
    issue = ctx.issue()

    def edit(h):
        return ctx.c.patch(f"/api/issues/{issue['key']}", json={"summary": "edit", "version": issue["version"]},
                           headers=h).status_code

    with ThreadPoolExecutor(max_workers=6) as pool:
        codes = list(pool.map(edit, [ctx.pm, ctx.dev] * 3))
    assert codes.count(200) == 1 and codes.count(409) == 5
    assert ctx.c.get(f"/api/issues/{issue['key']}", headers=ctx.pm).json()["version"] == issue["version"] + 1


def test_concurrent_sprint_start_only_one_active(ctx):
    sprints = []
    for _ in range(4):
        s = ctx.c.post("/api/projects/APP/sprints", json={}, headers=ctx.pm).json()
        ctx.issue(sprint_id=s["id"])
        sprints.append(s["id"])
    with ThreadPoolExecutor(max_workers=4) as pool:
        codes = list(pool.map(lambda sid: ctx.c.post(f"/api/sprints/{sid}/start", json={}, headers=ctx.pm).status_code, sprints))
    assert codes.count(200) == 1 and codes.count(409) == 3


def test_websocket_receives_project_events_and_personal_notifications(ctx):
    token = ctx.dev["Authorization"].split()[1]
    with ctx.c.websocket_connect(f"/ws?token={token}") as ws:
        ws.send_text("ping")
        assert json.loads(ws.receive_text())["type"] == "pong"
        ctx.issue(summary="Realtime", assignee_id=ctx.dev_user.id)
        seen = {json.loads(ws.receive_text())["type"] for _ in range(2)}
        assert seen == {"issue_created", "notification"}


def test_websocket_rejects_bad_token_and_hides_other_projects(ctx):
    import pytest
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with ctx.c.websocket_connect("/ws?token=bad") as ws:
            ws.receive_text()
    # outsider is connected but must not receive APP events
    token = ctx.outsider["Authorization"].split()[1]
    with ctx.c.websocket_connect(f"/ws?token={token}") as ws:
        ctx.issue(summary="secret")
        ws.send_text("ping")
        assert json.loads(ws.receive_text())["type"] == "pong"  # first message is the pong, not the issue event


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["database"] == "ok" and r.json()["migration"] == "0002"
