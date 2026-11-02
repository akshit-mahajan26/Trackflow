from tests.conftest import login, make_user


def test_login_and_me(client):
    make_user("alice")
    h = login(client, "alice")
    r = client.get("/api/auth/me", headers=h)
    assert r.status_code == 200 and r.json()["username"] == "alice"
    # login by email, case-insensitive
    assert client.post("/api/auth/login", json={"username": "ALICE@example.com", "password": "password123"}).status_code == 200


def test_bad_credentials_and_missing_token(client):
    make_user("alice")
    assert client.post("/api/auth/login", json={"username": "alice", "password": "nope"}).status_code == 401
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer garbage"}).status_code == 401


def test_password_change_revokes_old_tokens(client):
    make_user("alice")
    h = login(client, "alice")
    r = client.post("/api/auth/me/password", json={"current_password": "password123", "new_password": "newpassword1"}, headers=h)
    assert r.status_code == 204
    assert client.get("/api/auth/me", headers=h).status_code == 401
    login(client, "alice", "newpassword1")


def test_registration_disabled_by_default_and_admin_can_enable(client):
    make_user("root", admin=True)
    body = {"email": "new@x.io", "username": "newbie", "full_name": "New", "password": "password123"}
    assert client.post("/api/auth/register", json=body).status_code == 403
    admin = login(client, "root")
    assert client.put("/api/admin/settings", json={"allow_registration": True}, headers=admin).status_code == 200
    assert client.post("/api/auth/register", json=body).status_code == 201
    assert client.post("/api/auth/register", json=body).status_code == 409


def test_admin_only_endpoints(client):
    make_user("root", admin=True)
    make_user("bob")
    bob = login(client, "bob")
    assert client.get("/api/admin/audit", headers=bob).status_code == 403
    assert client.post("/api/users", json={"email": "a@b.co", "username": "abc", "full_name": "A",
                                           "password": "password123"}, headers=bob).status_code == 403
    admin = login(client, "root")
    r = client.post("/api/users", json={"email": "a@b.co", "username": "abc", "full_name": "A", "password": "password123"},
                    headers=admin)
    assert r.status_code == 201
    # deactivate → token revoked + login blocked
    uid = r.json()["id"]
    h = login(client, "abc")
    assert client.patch(f"/api/users/{uid}", json={"is_active": False}, headers=admin).status_code == 200
    assert client.get("/api/auth/me", headers=h).status_code == 401
    assert client.post("/api/auth/login", json={"username": "abc", "password": "password123"}).status_code == 403
    # admin cannot demote themselves
    me = client.get("/api/auth/me", headers=admin).json()
    assert client.patch(f"/api/users/{me['id']}", json={"is_admin": False}, headers=admin).status_code == 422
    actions = [e["action"] for e in client.get("/api/admin/audit", headers=admin).json()["items"]]
    assert "user.create" in actions and "user.update" in actions


def test_project_visibility_and_role_matrix(ctx):
    c = ctx.c
    # outsider cannot see the project at all (404, not 403)
    assert c.get("/api/projects/APP", headers=ctx.outsider).status_code == 404
    assert c.get("/api/projects", headers=ctx.outsider).json() == []
    assert c.get("/api/issues", headers=ctx.outsider).json()["total"] == 0
    # viewer: read-only
    assert c.get("/api/projects/APP", headers=ctx.viewer).status_code == 200
    r = c.post("/api/issues", json={"project_id": ctx.pid, "summary": "x"}, headers=ctx.viewer)
    assert r.status_code == 403
    issue = ctx.issue(summary="PM issue")
    assert c.post(f"/api/issues/{issue['key']}/comments", json={"body": "hi"}, headers=ctx.viewer).status_code == 403
    # reporter: can create + edit own, not others'
    mine = ctx.issue(headers=ctx.rep, summary="Reporter's")
    assert c.patch(f"/api/issues/{mine['key']}", json={"summary": "edited"}, headers=ctx.rep).status_code == 200
    assert c.patch(f"/api/issues/{issue['key']}", json={"summary": "nope"}, headers=ctx.rep).status_code == 403
    # developer can edit any issue, but not manage members or delete issues
    assert c.patch(f"/api/issues/{issue['key']}", json={"summary": "dev edit"}, headers=ctx.dev).status_code == 200
    assert c.post("/api/projects/APP/members", json={"user_id": ctx.outsider_user.id}, headers=ctx.dev).status_code == 403
    assert c.delete(f"/api/issues/{issue['key']}", headers=ctx.dev).status_code == 403
    assert c.delete(f"/api/issues/{issue['key']}", headers=ctx.pm).status_code == 204
    # project settings permissions
    assert c.patch("/api/projects/APP", json={"name": "X"}, headers=ctx.dev).status_code == 403
    assert c.patch("/api/projects/APP", json={"name": "X"}, headers=ctx.pm).status_code == 200
    detail = c.get("/api/projects/APP", headers=ctx.viewer).json()
    assert detail["my_role"] == "viewer" and detail["permissions"] == ["view_project"]


def test_last_project_manager_cannot_be_removed(ctx):
    members = ctx.c.get("/api/projects/APP/members", headers=ctx.pm).json()
    pm = next(m for m in members if m["role"] == "project_manager")
    assert ctx.c.delete(f"/api/projects/APP/members/{pm['id']}", headers=ctx.pm).status_code == 422
    assert ctx.c.patch(f"/api/projects/APP/members/{pm['id']}", json={"role": "developer"}, headers=ctx.pm).status_code == 422


def test_project_delete_requires_key_confirmation(ctx):
    ctx.issue()
    assert ctx.c.delete("/api/projects/APP?confirm_key=WRONG", headers=ctx.pm).status_code == 422
    assert ctx.c.delete("/api/projects/APP?confirm_key=app", headers=ctx.pm).status_code == 204
    assert ctx.c.get("/api/projects/APP", headers=ctx.pm).status_code == 404


def test_admin_deletes_departed_user(ctx):
    c = ctx.c
    issue = ctx.issue(assignee_id=ctx.dev_user.id)
    done = ctx.issue(assignee_id=ctx.dev_user.id, status_id=ctx.statuses["Done"])
    c.post(f"/api/issues/{issue['key']}/comments", json={"body": "on it"}, headers=ctx.dev)
    uid = ctx.dev_user.id
    # guards: non-admin, wrong confirmation, self-deletion
    assert c.delete(f"/api/users/{uid}?confirm=dave", headers=ctx.pm).status_code == 403
    assert c.delete(f"/api/users/{uid}?confirm=nope", headers=ctx.admin).status_code == 422
    me = c.get("/api/auth/me", headers=ctx.admin).json()["id"]
    assert c.delete(f"/api/users/{me}?confirm=admin", headers=ctx.admin).status_code == 422

    r = c.delete(f"/api/users/{uid}?confirm=Dave", headers=ctx.admin)
    assert r.status_code == 200, r.text
    assert r.json() == {"unassigned_open_issues": 1, "projects_left": 1}
    # gone: no login, old token dead, not listed anywhere
    assert c.get("/api/auth/me", headers=ctx.dev).status_code == 401
    assert c.post("/api/auth/login", json={"username": "dave", "password": "password123"}).status_code == 401
    assert "dave" not in [u["username"] for u in c.get("/api/users?include_inactive=true", headers=ctx.admin).json()]
    assert "dave" not in [m["user"]["username"] for m in c.get("/api/projects/APP/members", headers=ctx.pm).json()]
    # work kept, name removed
    detail = c.get(f"/api/issues/{issue['key']}", headers=ctx.pm).json()
    assert detail["assignee"] is None
    assert c.get(f"/api/issues/{done['key']}", headers=ctx.pm).json()["assignee"] is None
    comments = c.get(f"/api/issues/{issue['key']}/comments", headers=ctx.pm).json()
    assert comments[0]["body"] == "on it" and comments[0]["author"] is None
    history = c.get(f"/api/issues/{issue['key']}/history", headers=ctx.pm).json()
    assert not any("Dave" in (h["old_value"] or "") + (h["new_value"] or "") for h in history)
    assert any(h["field"] == "assignee" and h["old_value"] == "Former user" and h["new_value"] is None for h in history)
    assert c.get("/api/issues?text=on", headers=ctx.pm).status_code == 200
    assert "user.delete" in [e["action"] for e in c.get("/api/admin/audit", headers=ctx.admin).json()["items"]]


def test_cannot_delete_last_project_manager(ctx):
    r = ctx.c.delete(f"/api/users/{ctx.pm_user.id}?confirm=paula", headers=ctx.admin)
    assert r.status_code == 422 and "APP" in r.json()["detail"]
    # after appointing another PM it works
    mid = next(m["id"] for m in ctx.c.get("/api/projects/APP/members", headers=ctx.pm).json() if m["user"]["username"] == "rita")
    ctx.c.patch(f"/api/projects/APP/members/{mid}", json={"role": "project_manager"}, headers=ctx.pm)
    assert ctx.c.delete(f"/api/users/{ctx.pm_user.id}?confirm=paula", headers=ctx.admin).status_code == 200
