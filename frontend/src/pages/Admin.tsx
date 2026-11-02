import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useToast } from "../components/toast";
import { Avatar, Badge, Button, Card, ConfirmDialog, ErrorState, Field, Input, Menu, MenuItem, MenuSeparator, Modal, PageHeader, Select, Spinner, Stat, Tabs } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useMe } from "../lib/auth";
import { fmtBytes, fmtDate, fmtRelative, FORMER_USER } from "../lib/format";
import type { AuditEntry, Page, User } from "../lib/types";

type Tab = "users" | "settings" | "audit" | "system";

export default function Admin() {
  const me = useMe();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get("tab") as Tab) ?? "users";
  if (!me.is_admin) return <Navigate to="/" replace />;
  return (
    <div className="mx-auto max-w-6xl p-4 md:p-6">
      <PageHeader title="Administration" />
      <Tabs value={tab} onChange={(v) => setSp({ tab: v }, { replace: true })}
        tabs={[{ value: "users", label: "Users" }, { value: "settings", label: "Settings" }, { value: "audit", label: "Audit log" }, { value: "system", label: "System" }]} />
      <div className="pt-4">
        {tab === "users" && <Users />}
        {tab === "settings" && <SettingsTab />}
        {tab === "audit" && <Audit />}
        {tab === "system" && <System />}
      </div>
    </div>
  );
}

function Users() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const { data = [], isLoading, error } = useQuery({ queryKey: ["admin-users"], queryFn: () => api.get<User[]>("/users?include_inactive=true") });
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [deactivating, setDeactivating] = useState<User | null>(null);
  const toggle = useMutation({
    mutationFn: (u: User) => api.patch(`/users/${u.id}`, { is_active: !u.is_active }),
    onSuccess: (_d, u) => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      qc.invalidateQueries({ queryKey: ["users"] });
      toast.success(u.is_active ? `${u.full_name} deactivated` : `${u.full_name} reactivated`);
      setDeactivating(null);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} />;
  return (
    <Card title={`Users (${data.length})`} actions={<Button size="sm" variant="primary" onClick={() => setEditing("new")}>Create user</Button>}>
      {/* overflow is only needed on narrow screens; on desktop it would clip the row action menus */}
      <div className="overflow-x-auto md:overflow-visible">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="text-left text-xs text-muted"><tr><th className="px-4 py-2">User</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th className="w-12"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody className="divide-y">
            {data.map((u) => (
              <tr key={u.id} className={u.is_active ? "" : "opacity-60"}>
                <td className="px-4 py-2">
                  <button onClick={() => setEditing(u)} className="flex items-center gap-2 text-left hover:underline">
                    <Avatar user={u} size={24} />{u.full_name} <span className="text-xs text-muted">@{u.username}</span>
                  </button>
                </td>
                <td className="text-muted">{u.email}</td>
                <td>{u.is_admin ? <Badge tone="blue">Admin</Badge> : <Badge>User</Badge>}</td>
                <td>{u.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Deactivated</Badge>}</td>
                <td className="text-xs text-muted">{u.last_login_at ? fmtRelative(u.last_login_at) : "Never"}</td>
                <td className="pr-3 text-right">
                  <Menu width="w-48" trigger={(open) => (
                    <button aria-label={`Actions for ${u.full_name}`} aria-haspopup="menu" aria-expanded={open}
                      className={`rounded p-1 text-muted hover:bg-surface-3 hover:text-fg ${open ? "bg-surface-3 text-fg" : ""}`}>
                      <MoreHorizontal size={16} />
                    </button>
                  )}>
                    {(close) => (
                      <>
                        <MenuItem onClick={() => { close(); setEditing(u); }}>Edit details</MenuItem>
                        {u.id !== me.id && (
                          <MenuItem onClick={() => { close(); if (u.is_active) setDeactivating(u); else toggle.mutate(u); }}>
                            {u.is_active ? "Deactivate" : "Reactivate"}
                          </MenuItem>
                        )}
                        {u.id !== me.id && (
                          <>
                            <MenuSeparator />
                            <MenuItem danger onClick={() => { close(); setDeleting(u); }}>Delete user</MenuItem>
                          </>
                        )}
                      </>
                    )}
                  </Menu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <UserDialog user={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && <DeleteUserDialog user={deleting} onClose={() => setDeleting(null)} />}
      <ConfirmDialog open={!!deactivating} title={`Deactivate ${deactivating?.full_name}?`} confirmLabel="Deactivate"
        loading={toggle.isPending} onClose={() => setDeactivating(null)} onConfirm={() => deactivating && toggle.mutate(deactivating)}
        message={<>They will be signed out and won't be able to log in. Their projects, issues and history are kept, and you can reactivate them at any time. If they have left the company, use <strong>Delete user</strong> instead.</>} />
    </Card>
  );
}

function UserDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ full_name: user?.full_name ?? "", username: user?.username ?? "", email: user?.email ?? "", job_title: user?.job_title ?? "", password: "", is_admin: user?.is_admin ?? false });
  const m = useMutation({
    mutationFn: () => {
      if (user) {
        const body: Record<string, unknown> = { full_name: f.full_name, email: f.email, job_title: f.job_title, is_admin: f.is_admin };
        if (f.password) body.password = f.password;
        return api.patch(`/users/${user.id}`, body);
      }
      return api.post("/users", f);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-users"] }); qc.invalidateQueries({ queryKey: ["users"] }); toast.success(user ? "User updated" : "User created"); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title={user ? `Edit ${user.full_name}` : "Create user"}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
      <form className="grid grid-cols-2 gap-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Full name" required><Input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
        <Field label="Username" required><Input disabled={!!user} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
        <Field label="Email" required><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Job title"><Input value={f.job_title} onChange={(e) => setF({ ...f, job_title: e.target.value })} /></Field>
        <div className="col-span-2"><Field label={user ? "Reset password" : "Initial password"} required={!user} hint={user ? "Leave blank to keep. Resetting signs the user out everywhere." : "At least 8 characters; ask the user to change it."}>
          <Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </Field></div>
        <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_admin} onChange={(e) => setF({ ...f, is_admin: e.target.checked })} /> Administrator (full access to all projects and settings)</label>
        {m.isError && <p role="alert" className="col-span-2 text-sm text-danger">{errorMessage(m.error)}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function DeleteUserDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState("");
  const m = useMutation({
    mutationFn: () => api.del<{ unassigned_open_issues: number; projects_left: number }>(`/users/${user.id}?confirm=${encodeURIComponent(confirm)}`),
    onSuccess: (r) => {
      for (const k of ["admin-users", "users", "members", "issues", "board", "backlog", "dashboard"]) qc.invalidateQueries({ queryKey: [k] });
      toast.success(`${user.full_name} deleted: removed from ${r.projects_left} project(s), ${r.unassigned_open_issues} open issue(s) unassigned`);
      onClose();
    },
  });
  const matches = confirm.trim().toLowerCase() === user.username.toLowerCase();
  return (
    <Modal open onClose={onClose} title={`Delete ${user.full_name}?`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={!matches} loading={m.isPending} onClick={() => m.mutate()}>Delete permanently</Button></>}>
      <div className="space-y-3 text-sm">
        <p>Use this when someone has left the company. It cannot be undone.</p>
        <ul className="list-disc space-y-1 pl-5 text-muted">
          <li>Their account, login and active sessions are removed immediately.</li>
          <li>They are removed from every project and stop receiving notifications.</li>
          <li>Their open issues become unassigned. Their comments, attachments and history stay, shown as “{FORMER_USER}”.</li>
          <li>The audit log keeps a record that this account was deleted, and by whom.</li>
        </ul>
        <p className="text-muted">For a temporary absence, use <strong>Deactivate</strong> instead.</p>
        <Field label={`Type ${user.username} to confirm`}>
          <Input autoFocus value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {m.isError && <p role="alert" className="text-danger">{errorMessage(m.error)}</p>}
      </div>
    </Modal>
  );
}

interface AppSettings { site_name: string; allow_registration: boolean; allow_project_creation: boolean }

function SettingsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ["admin-settings"], queryFn: () => api.get<AppSettings>("/admin/settings") });
  const [f, setF] = useState<AppSettings | null>(null);
  const v = f ?? data;
  const save = useMutation({
    mutationFn: () => api.put("/admin/settings", v!),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-settings"] }); qc.invalidateQueries({ queryKey: ["public-config"] }); toast.success("Settings saved"); setF(null); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (isLoading || !v) return <Spinner />;
  return (
    <Card title="Workspace settings">
      <div className="space-y-4 p-4">
        <div className="w-80"><Field label="Site name"><Input value={v.site_name} onChange={(e) => setF({ ...v, site_name: e.target.value })} /></Field></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.allow_registration} onChange={(e) => setF({ ...v, allow_registration: e.target.checked })} />
          Allow self-registration from the login page (anyone who can reach the server can create an account)</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.allow_project_creation} onChange={(e) => setF({ ...v, allow_project_creation: e.target.checked })} />
          Allow non-admin users to create projects</label>
        <Button variant="primary" disabled={!f} loading={save.isPending} onClick={() => save.mutate()}>Save settings</Button>
      </div>
    </Card>
  );
}

function Audit() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const { data, isLoading, error } = useQuery({
    queryKey: ["audit", page, action],
    queryFn: () => api.get<Page<AuditEntry>>(`/admin/audit?page=${page}&page_size=50${action ? `&action=${encodeURIComponent(action)}` : ""}`),
  });
  return (
    <Card title="Audit log" actions={
      <Select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} className="w-48" aria-label="Filter actions">
        <option value="">All actions</option><option value="auth">Authentication</option><option value="user">Users</option><option value="project">Projects</option>
        <option value="workflow">Workflow</option><option value="sprint">Sprints</option><option value="issue">Issues</option><option value="admin">Admin settings</option>
      </Select>}>
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} /> : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="text-left text-xs text-muted"><tr><th className="px-4 py-2">When</th><th>Who</th><th>Action</th><th>Entity</th><th>Details</th><th>IP</th></tr></thead>
              <tbody className="divide-y">
                {data!.items.map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap px-4 py-1.5 text-xs text-muted">{fmtDate(a.created_at, "d MMM yyyy HH:mm:ss")}</td>
                    <td>{a.actor?.full_name ?? "—"}</td>
                    <td><code className="text-xs">{a.action}</code></td>
                    <td className="text-xs text-muted">{a.entity_type}{a.entity_id ? ` #${a.entity_id}` : ""}</td>
                    <td className="max-w-sm truncate text-xs text-muted" title={JSON.stringify(a.details)}>{JSON.stringify(a.details)}</td>
                    <td className="text-xs text-muted">{a.ip_address}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted">
            <span>{data!.total} entries</span>
            <div className="flex gap-1"><Button size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button><Button size="sm" disabled={page * 50 >= data!.total} onClick={() => setPage(page + 1)}>Next</Button></div>
          </div>
        </>
      )}
    </Card>
  );
}

function System() {
  const { data, isLoading } = useQuery({ queryKey: ["admin-stats"], queryFn: () => api.get<Record<string, number | string>>("/admin/stats"), refetchInterval: 30_000 });
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.get<{ status: string; database: string; migration: string }>("/health") });
  if (isLoading || !data) return <Spinner />;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Health" value={health.data?.status ?? "…"} tone={health.data?.status === "ok" ? "green" : "red"} hint={`DB ${health.data?.database ?? "?"} · migration ${health.data?.migration ?? "?"}`} />
        <Stat label="Users" value={`${data.active_users}/${data.users}`} hint="active / total" />
        <Stat label="Projects" value={data.projects} />
        <Stat label="Issues" value={data.issues} />
        <Stat label="Database size" value={fmtBytes(Number(data.database_bytes))} />
        <Stat label="Attachments" value={data.attachments} hint={fmtBytes(Number(data.attachment_bytes))} />
        <Stat label="Live connections" value={data.websocket_connections} hint="WebSocket clients" />
        <Stat label="Server time" value={fmtDate(String(data.server_time), "HH:mm")} hint={fmtDate(String(data.server_time))} />
      </div>
      <Card title="Backup & restore">
        <div className="space-y-2 p-4 text-sm text-muted">
          <p>Backups include the PostgreSQL database and the uploads directory. Run from the project root on the server:</p>
          <pre className="overflow-x-auto rounded bg-surface-2 p-3 text-xs text-fg">{`./scripts/backup.sh                 # writes backups/trackflow-<timestamp>.tar.gz
./scripts/restore.sh backups/trackflow-<timestamp>.tar.gz   # stops nothing; asks for confirmation`}</pre>
          <p>Schedule <code>backup.sh</code> with cron for nightly backups. See README → Backup & restore.</p>
        </div>
      </Card>
    </div>
  );
}
