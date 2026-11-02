import csv
import io


def test_create_issue_assigns_sequential_keys_and_records_history(ctx):
    a = ctx.issue(summary="First")
    b = ctx.issue(summary="Second", issue_type="bug", priority="high")
    assert (a["key"], b["key"]) == ("APP-1", "APP-2")
    assert a["status"]["name"] == "To Do" and a["reporter"]["username"] == "paula"
    hist = ctx.c.get(f"/api/issues/{a['key']}/history", headers=ctx.pm).json()
    assert hist[-1]["field"] == "created"


def test_hierarchy_rules(ctx):
    c = ctx.c
    epic = ctx.issue(issue_type="epic", summary="Epic")
    story = ctx.issue(issue_type="story", parent_id=epic["id"])
    sub = ctx.issue(issue_type="subtask", parent_id=story["id"])
    bad = lambda **kw: c.post("/api/issues", json={"project_id": ctx.pid, "summary": "x", **kw}, headers=ctx.pm)  # noqa: E731
    assert bad(issue_type="subtask").status_code == 422                       # subtask needs parent
    assert bad(issue_type="subtask", parent_id=epic["id"]).status_code == 422  # not under an epic
    assert bad(issue_type="subtask", parent_id=sub["id"]).status_code == 422   # not under a subtask
    assert bad(issue_type="task", parent_id=story["id"]).status_code == 422    # tasks only under epics
    assert bad(issue_type="epic", parent_id=epic["id"]).status_code == 422
    detail = c.get(f"/api/issues/{story['key']}", headers=ctx.pm).json()
    assert detail["parent"]["key"] == epic["key"] and [x["key"] for x in detail["children"]] == [sub["key"]]
    # epic with children cannot change type
    assert c.patch(f"/api/issues/{epic['key']}", json={"issue_type": "task"}, headers=ctx.pm).status_code == 422
    # epic filter returns story + its subtask
    keys = {i["key"] for i in c.get(f"/api/issues?epic_id={epic['id']}", headers=ctx.pm).json()["items"]}
    assert keys == {story["key"], sub["key"]}
    # deleting the story deletes its subtasks
    assert c.delete(f"/api/issues/{story['key']}", headers=ctx.pm).status_code == 204
    assert c.get(f"/api/issues/{sub['key']}", headers=ctx.pm).status_code == 404


def test_update_tracks_history_resolution_and_optimistic_locking(ctx):
    c = ctx.c
    i = ctx.issue(story_points=3)
    r = c.patch(f"/api/issues/{i['key']}", json={"status_id": ctx.statuses["Done"], "story_points": 5,
                                                 "assignee_id": ctx.dev_user.id, "version": i["version"]}, headers=ctx.pm)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["resolved_at"] is not None and body["version"] == i["version"] + 1
    fields = {h["field"]: h for h in c.get(f"/api/issues/{i['key']}/history", headers=ctx.pm).json()}
    assert fields["status"]["old_value"] == "To Do" and fields["status"]["new_value"] == "Done"
    assert fields["story_points"]["old_value"] == "3" and fields["story_points"]["new_value"] == "5"
    assert fields["assignee"]["new_value"] == "Dave"
    # stale version → 409
    r = c.patch(f"/api/issues/{i['key']}", json={"summary": "stale", "version": i["version"]}, headers=ctx.dev)
    assert r.status_code == 409
    # reopening clears resolution
    r = c.patch(f"/api/issues/{i['key']}", json={"status_id": ctx.statuses["In Progress"]}, headers=ctx.pm)
    assert r.json()["resolved_at"] is None


def test_self_assigned_issue_creation(ctx):
    # reporter == assignee must not create a duplicate watcher row
    i = ctx.issue(headers=ctx.dev, assignee_id=ctx.dev_user.id)
    assert [w["username"] for w in ctx.c.get(f"/api/issues/{i['key']}", headers=ctx.dev).json()["watchers"]] == ["dave"]


def test_assignee_must_be_working_member(ctx):
    i = ctx.issue()
    for uid in (ctx.outsider_user.id, ctx.view_user.id):
        assert ctx.c.patch(f"/api/issues/{i['key']}", json={"assignee_id": uid}, headers=ctx.pm).status_code == 422


def test_workflow_transition_enforcement(ctx):
    c = ctx.c
    s = ctx.statuses
    i = ctx.issue()
    r = c.put("/api/projects/APP/transitions", json=[{"from_status_id": s["To Do"], "to_status_id": s["In Progress"]}],
              headers=ctx.pm)
    assert r.status_code == 200
    c.patch("/api/projects/APP", json={"settings": {"enforce_transitions": True}}, headers=ctx.pm)
    assert c.patch(f"/api/issues/{i['key']}", json={"status_id": s["Done"]}, headers=ctx.dev).status_code == 422
    detail = c.get(f"/api/issues/{i['key']}", headers=ctx.dev).json()
    assert [t["name"] for t in detail["available_transitions"]] == ["In Progress"]
    assert c.patch(f"/api/issues/{i['key']}", json={"status_id": s["In Progress"]}, headers=ctx.dev).status_code == 200


def test_status_crud_and_delete_migrates_issues(ctx):
    c = ctx.c
    r = c.post("/api/projects/APP/statuses", json={"name": "QA", "category": "in_progress", "wip_limit": 3}, headers=ctx.pm)
    assert r.status_code == 201
    qa = r.json()["id"]
    assert c.post("/api/projects/APP/statuses", json={"name": "qa"}, headers=ctx.pm).status_code == 409
    assert c.post("/api/projects/APP/statuses", json={"name": "Z"}, headers=ctx.dev).status_code == 403
    i = ctx.issue(status_id=qa)
    assert c.delete(f"/api/projects/APP/statuses/{qa}", headers=ctx.pm).status_code == 422  # in use
    assert c.delete(f"/api/projects/APP/statuses/{qa}?move_to={ctx.statuses['To Do']}", headers=ctx.pm).status_code == 204
    assert c.get(f"/api/issues/{i['key']}", headers=ctx.pm).json()["status"]["name"] == "To Do"
    ids = [s["id"] for s in c.get("/api/projects/APP", headers=ctx.pm).json()["statuses"]]
    r = c.put("/api/projects/APP/statuses/order", json={"status_ids": list(reversed(ids))}, headers=ctx.pm)
    assert [s["id"] for s in r.json()] == list(reversed(ids))


def test_custom_fields_validation(ctx):
    c = ctx.c
    sel = c.post("/api/projects/APP/fields", json={"name": "Env", "field_type": "select", "options": ["prod", "staging"],
                                                   "required": True}, headers=ctx.pm).json()
    num = c.post("/api/projects/APP/fields", json={"name": "Cost", "field_type": "number"}, headers=ctx.pm).json()
    post = lambda cf: c.post("/api/issues", json={"project_id": ctx.pid, "summary": "x", "custom_fields": cf}, headers=ctx.pm)  # noqa: E731
    assert post({}).status_code == 422                                  # required missing
    assert post({str(sel["id"]): "dev"}).status_code == 422             # invalid option
    assert post({str(sel["id"]): "prod", str(num["id"]): "abc"}).status_code == 422
    r = post({str(sel["id"]): "prod", str(num["id"]): "12.5"})
    assert r.status_code == 201 and r.json()["custom_fields"] == {str(sel["id"]): "prod", str(num["id"]): 12.5}


def test_labels_normalised_and_filterable(ctx):
    ctx.issue(labels=["Backend", "backend", "Tech Debt"])
    ctx.issue(labels=["frontend"])
    items = ctx.c.get("/api/issues?labels=tech-debt", headers=ctx.pm).json()["items"]
    assert len(items) == 1 and items[0]["labels"] == ["backend", "tech-debt"]
    assert ctx.c.get("/api/projects/APP/labels", headers=ctx.pm).json() == ["backend", "frontend", "tech-debt"]


def test_filters_text_assignee_overdue_and_sort(ctx):
    c = ctx.c
    ctx.issue(summary="Login fails on Safari", assignee_id=ctx.dev_user.id, due_date="2020-01-01", priority="low")
    ctx.issue(summary="Dark mode", priority="highest")
    done = ctx.issue(summary="Old overdue but done", due_date="2020-01-01", status_id=ctx.statuses["Done"])
    get = lambda qs, h=ctx.pm: c.get(f"/api/issues?{qs}", headers=h).json()  # noqa: E731
    assert [i["summary"] for i in get("text=safari")["items"]] == ["Login fails on Safari"]
    assert get("assignee_ids=me", ctx.dev)["total"] == 1
    assert get("assignee_ids=none")["total"] == 2
    assert [i["key"] for i in get("overdue=true")["items"]] == ["APP-1"]
    assert done["key"] not in [i["key"] for i in get("resolved=false")["items"]]
    assert get("sort=priority")["items"][0]["summary"] == "Dark mode"
    # LIKE wildcards are escaped
    assert get("text=%25")["total"] == 0


def test_saved_filters_sharing(ctx):
    c = ctx.c
    r = c.post("/api/filters", json={"name": "My bugs", "query": {"issue_types": ["bug"]}, "project_id": ctx.pid}, headers=ctx.dev)
    assert r.status_code == 201
    fid = r.json()["id"]
    assert c.get("/api/filters", headers=ctx.rep).json() == []
    c.put(f"/api/filters/{fid}", json={"name": "Team bugs", "query": {"issue_types": ["bug"]}, "project_id": ctx.pid,
                                        "is_shared": True}, headers=ctx.dev)
    assert [f["name"] for f in c.get("/api/filters", headers=ctx.rep).json()] == ["Team bugs"]
    assert c.delete(f"/api/filters/{fid}", headers=ctx.rep).status_code == 403
    # filter body can be executed through /search
    ctx.issue(issue_type="bug")
    ctx.issue(issue_type="task")
    assert c.post("/api/issues/search", json={"issue_types": ["bug"]}, headers=ctx.dev).json()["total"] == 1


def test_comments_mentions_watchers_notifications(ctx):
    c = ctx.c
    i = ctx.issue(assignee_id=ctx.dev_user.id)
    # dev got an assignment notification
    n = c.get("/api/notifications", headers=ctx.dev).json()
    assert n["unread"] == 2  # "added to project" + assignment
    assert n["items"][0]["kind"] == "assigned" and n["items"][0]["issue_key"] == i["key"]
    # reporter mentions the viewer (a member) and the outsider (not a member → ignored)
    r = c.post(f"/api/issues/{i['key']}/comments", json={"body": "ping @victor and @olga"}, headers=ctx.rep)
    assert r.status_code == 201
    assert c.get("/api/notifications", headers=ctx.viewer).json()["items"][0]["kind"] == "mention"
    assert c.get("/api/notifications", headers=ctx.outsider).json()["unread"] == 0
    # watchers (pm reporter, dev assignee) get comment notifications
    kinds = [x["kind"] for x in c.get("/api/notifications", headers=ctx.pm).json()["items"]]
    assert "comment" in kinds
    # commenter auto-watches; status change notifies watchers except the actor
    c.patch(f"/api/issues/{i['key']}", json={"status_id": ctx.statuses["In Progress"]}, headers=ctx.dev)
    assert c.get("/api/notifications", headers=ctx.rep).json()["items"][0]["kind"] == "status"
    # only author edits comment
    cid = r.json()["id"]
    assert c.patch(f"/api/issues/{i['key']}/comments/{cid}", json={"body": "x"}, headers=ctx.dev).status_code == 403
    assert c.patch(f"/api/issues/{i['key']}/comments/{cid}", json={"body": "edited"}, headers=ctx.rep).status_code == 200
    c.post("/api/notifications/read-all", headers=ctx.dev)
    assert c.get("/api/notifications", headers=ctx.dev).json()["unread"] == 0
    # explicit watch / unwatch
    assert c.post(f"/api/issues/{i['key']}/watch", headers=ctx.viewer).status_code == 204
    assert c.get(f"/api/issues/{i['key']}", headers=ctx.viewer).json()["is_watching"] is True
    c.delete(f"/api/issues/{i['key']}/watch", headers=ctx.viewer)
    assert c.get(f"/api/issues/{i['key']}", headers=ctx.viewer).json()["is_watching"] is False


def test_links_and_dependency_cycle_detection(ctx):
    c = ctx.c
    a, b, d = ctx.issue(summary="A"), ctx.issue(summary="B"), ctx.issue(summary="C")
    assert c.post(f"/api/issues/{a['key']}/links", json={"target_id": b["id"], "link_type": "blocks"}, headers=ctx.pm).status_code == 201
    assert c.post(f"/api/issues/{b['key']}/links", json={"target_id": d["id"], "link_type": "blocks"}, headers=ctx.pm).status_code == 201
    # C blocks A would close A→B→C→A
    assert c.post(f"/api/issues/{d['key']}/links", json={"target_id": a["id"], "link_type": "blocks"}, headers=ctx.pm).status_code == 422
    assert c.post(f"/api/issues/{a['key']}/links", json={"target_id": b["id"], "link_type": "blocks"}, headers=ctx.pm).status_code == 409
    links = c.get(f"/api/issues/{b['key']}", headers=ctx.pm).json()["links"]
    assert sorted((l["label"], l["issue"]["key"]) for l in links) == [("blocks", d["key"]), ("is blocked by", a["key"])]
    assert c.delete(f"/api/issues/{b['key']}/links/{links[0]['id']}", headers=ctx.pm).status_code == 204


def test_attachments_upload_download_and_validation(ctx):
    c = ctx.c
    i = ctx.issue()
    r = c.post(f"/api/issues/{i['key']}/attachments", files={"file": ("../../etc/notes.txt", b"hello", "text/plain")}, headers=ctx.dev)
    assert r.status_code == 201, r.text
    att = r.json()
    assert att["filename"] == "notes.txt" and att["size_bytes"] == 5
    dl = c.get(f"/api/issues/{i['key']}/attachments/{att['id']}", headers=ctx.viewer)
    assert dl.status_code == 200 and dl.content == b"hello" and "attachment" in dl.headers["content-disposition"]
    assert c.post(f"/api/issues/{i['key']}/attachments", files={"file": ("x.exe", b"MZ", "application/octet-stream")},
                  headers=ctx.dev).status_code == 415
    assert c.post(f"/api/issues/{i['key']}/attachments", files={"file": ("x.txt", b"a", "text/plain")},
                  headers=ctx.viewer).status_code == 403
    assert c.get(f"/api/issues/{i['key']}/attachments/{att['id']}", headers=ctx.outsider).status_code == 404
    assert c.delete(f"/api/issues/{i['key']}/attachments/{att['id']}", headers=ctx.dev).status_code == 204


def test_rank_move_and_rebalance(ctx):
    c = ctx.c
    a, b, d = ctx.issue(summary="A"), ctx.issue(summary="B"), ctx.issue(summary="C")
    # move C between A and B
    r = c.post(f"/api/issues/{d['key']}/move", json={"above_id": a["id"], "below_id": b["id"]}, headers=ctx.dev)
    assert r.status_code == 200
    order = [i["summary"] for i in c.get("/api/issues?sort=rank", headers=ctx.pm).json()["items"]]
    assert order == ["A", "C", "B"]
    # repeated bisection into the same gap eventually rebalances and stays ordered
    for _ in range(60):
        items = c.get("/api/issues?sort=rank", headers=ctx.pm).json()["items"]
        first, second = items[0], items[1]
        c.post(f"/api/issues/{items[-1]['key']}/move", json={"above_id": first["id"], "below_id": second["id"]}, headers=ctx.dev)
    ranks = [i["rank"] for i in c.get("/api/issues?sort=rank", headers=ctx.pm).json()["items"]]
    assert ranks == sorted(ranks) and len(set(ranks)) == 3
    # viewers cannot rank
    assert c.post(f"/api/issues/{a['key']}/move", json={"below_id": b["id"]}, headers=ctx.viewer).status_code == 403


def test_bulk_update_partial_failure(ctx):
    a, b = ctx.issue(), ctx.issue(headers=ctx.rep)
    # reporter can edit only own issue
    r = ctx.c.post("/api/issues/bulk", json={"issue_ids": [a["id"], b["id"]], "priority": "highest"}, headers=ctx.rep)
    res = {x["id"]: x["ok"] for x in r.json()["results"]}
    assert res == {a["id"]: False, b["id"]: True}
    assert ctx.c.get(f"/api/issues/{b['key']}", headers=ctx.pm).json()["priority"] == "highest"
    assert ctx.c.get(f"/api/issues/{a['key']}", headers=ctx.pm).json()["priority"] == "medium"


def test_csv_export(ctx):
    ctx.issue(summary='Has, comma "and quotes"', labels=["x"])
    r = ctx.c.get("/api/issues/export.csv", headers=ctx.pm)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    rows = list(csv.reader(io.StringIO(r.text)))
    assert rows[0][0] == "Key" and rows[1][2] == 'Has, comma "and quotes"'


def test_global_search_respects_access(ctx):
    ctx.issue(summary="Payment gateway timeout")
    r = ctx.c.get("/api/search?q=payment", headers=ctx.dev).json()
    assert [i["key"] for i in r["issues"]] == ["APP-1"]
    assert ctx.c.get("/api/search?q=payment", headers=ctx.outsider).json()["issues"] == []
    assert ctx.c.get("/api/search?q=APP-1", headers=ctx.dev).json()["issues"][0]["key"] == "APP-1"
