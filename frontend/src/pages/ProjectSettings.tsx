import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { StatusBadge } from "../components/issue-bits";
import { useToast } from "../components/toast";
import { Avatar, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Input, PageHeader, Select, Spinner, Tabs, Textarea } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { CATEGORY_LABEL, PRIORITIES, ROLES } from "../lib/format";
import { can, useFields, useMembers, useProject, useUsers } from "../lib/queries";
import type { ProjectDetail, Status, StatusCategory } from "../lib/types";

type Tab = "details" | "members" | "workflow" | "fields" | "danger";

function useProjectMutation<T>(fn: (v: T) => Promise<unknown>, success?: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const k of ["project", "projects", "members", "fields", "transitions", "board", "backlog"]) qc.invalidateQueries({ queryKey: [k] });
      if (success) toast.success(success);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export default function ProjectSettings() {
  const { key } = useParams();
  const { data: project, error } = useProject(key);
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get("tab") as Tab) ?? "details";
  if (error) return <ErrorState error={error} />;
  if (!project) return <Spinner />;
  return (
    <div className="mx-auto max-w-5xl p-4 md:p-6">
      <PageHeader title="Project settings" breadcrumb={<Link to={`/projects/${key}`} className="hover:underline">{project.name}</Link>} />
      <Tabs value={tab} onChange={(v) => setSp({ tab: v }, { replace: true })} tabs={[
        { value: "details", label: "Details" }, { value: "members", label: "Members & roles" }, { value: "workflow", label: "Workflow & board" },
        { value: "fields", label: "Custom fields" }, { value: "danger", label: "Archive & delete" },
      ]} />
      <div className="pt-4">
        {tab === "details" && <Details project={project} />}
        {tab === "members" && <Members project={project} />}
        {tab === "workflow" && <Workflow project={project} />}
        {tab === "fields" && <Fields project={project} />}
        {tab === "danger" && <Danger project={project} />}
      </div>
    </div>
  );
}

function Details({ project }: { project: ProjectDetail }) {
  const { data: members = [] } = useMembers(project.key);
  const [f, setF] = useState({ name: project.name, description: project.description, board_type: project.board_type, priority: project.priority,
    lead_id: project.lead?.id ?? null, start_date: project.start_date ?? "", due_date: project.due_date ?? "" });
  const editable = can(project, "edit_project");
  const save = useProjectMutation(() => api.patch(`/projects/${project.key}`, { ...f, start_date: f.start_date || null, due_date: f.due_date || null }), "Project updated");
  return (
    <Card>
      <form className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <Field label="Name"><Input disabled={!editable} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Key" hint="Keys cannot be changed after creation"><Input disabled value={project.key} /></Field>
        <Field label="Board type" hint="Scrum uses sprints and a backlog; Kanban is continuous flow">
          <Select disabled={!editable} value={f.board_type} onChange={(e) => setF({ ...f, board_type: e.target.value as "scrum" | "kanban" })}>
            <option value="scrum">Scrum</option><option value="kanban">Kanban</option>
          </Select>
        </Field>
        <Field label="Priority">
          <Select disabled={!editable} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as never })}>
            {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Select>
        </Field>
        <Field label="Project lead">
          <Select disabled={!editable} value={f.lead_id ?? ""} onChange={(e) => setF({ ...f, lead_id: e.target.value ? Number(e.target.value) : null })}>
            {members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.full_name}</option>)}
          </Select>
        </Field>
        <div />
        <Field label="Start date"><Input type="date" disabled={!editable} value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></Field>
        <Field label="Target date"><Input type="date" disabled={!editable} value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label="Description"><Textarea disabled={!editable} rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div>
        {editable ? <div><Button type="submit" variant="primary" loading={save.isPending}>Save changes</Button></div>
          : <p className="text-sm text-muted sm:col-span-2">Only project managers can edit project details.</p>}
      </form>
    </Card>
  );
}

function Members({ project }: { project: ProjectDetail }) {
  const { data: members = [], isLoading } = useMembers(project.key);
  const { data: users = [] } = useUsers();
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("developer");
  const [removing, setRemoving] = useState<{ id: number; name: string } | null>(null);
  const manage = can(project, "manage_members");
  const add = useProjectMutation(() => api.post(`/projects/${project.key}/members`, { user_id: Number(userId), role }), "Member added");
  const change = useProjectMutation((v: { id: number; role: string }) => api.patch(`/projects/${project.key}/members/${v.id}`, { role: v.role }), "Role updated");
  const remove = useProjectMutation((id: number) => api.del(`/projects/${project.key}/members/${id}`), "Member removed");
  const candidates = users.filter((u) => !members.some((m) => m.user.id === u.id));
  return (
    <div className="space-y-4">
      {manage && (
        <Card title="Add member">
          <div className="flex flex-wrap items-end gap-2 p-4">
            <div className="w-64"><Field label="User">
              <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Select a user…</option>
                {candidates.map((u) => <option key={u.id} value={u.id}>{u.full_name} (@{u.username})</option>)}
              </Select>
            </Field></div>
            <div className="w-48"><Field label="Role">
              <Select value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</Select>
            </Field></div>
            <Button variant="primary" disabled={!userId} loading={add.isPending} onClick={() => add.mutate(undefined, { onSuccess: () => setUserId("") })}>Add</Button>
          </div>
        </Card>
      )}
      <Card title={`Members (${members.length})`}>
        {isLoading ? <Spinner /> : (
          <table className="w-full text-sm">
            <tbody className="divide-y">
              {members.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-2"><span className="flex items-center gap-2"><Avatar user={m.user} size={26} /><span><span className="font-medium">{m.user.full_name}</span> <span className="text-xs text-muted">@{m.user.username}</span></span></span></td>
                  <td className="w-56 px-2">
                    {manage ? (
                      <Select value={m.role} onChange={(e) => change.mutate({ id: m.id, role: e.target.value })} aria-label={`Role for ${m.user.full_name}`}>
                        {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </Select>
                    ) : ROLES.find((r) => r.value === m.role)?.label}
                  </td>
                  <td className="w-12 px-2 text-right">
                    {manage && <button aria-label={`Remove ${m.user.full_name}`} className="text-subtle hover:text-danger" onClick={() => setRemoving({ id: m.id, name: m.user.full_name })}><Trash2 size={15} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Role permissions">
        <ul className="divide-y text-sm">{ROLES.map((r) => <li key={r.value} className="px-4 py-2"><span className="font-medium">{r.label}</span> <span className="text-muted">— {r.description}</span></li>)}</ul>
        <p className="border-t px-4 py-2 text-xs text-subtle">Administrators have full access to every project. Permissions are enforced by the server.</p>
      </Card>
      <ConfirmDialog open={!!removing} danger title="Remove member?" confirmLabel="Remove" message={`${removing?.name} will lose access to ${project.name}. Their issues stay assigned.`}
        onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing.id, { onSuccess: () => setRemoving(null) })} loading={remove.isPending} />
    </div>
  );
}

function Workflow({ project }: { project: ProjectDetail }) {
  const statuses = project.statuses;
  const manage = can(project, "manage_workflow");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<StatusCategory>("in_progress");
  const [deleting, setDeleting] = useState<Status | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const add = useProjectMutation(() => api.post(`/projects/${project.key}/statuses`, { name, category }), "Status added");
  const upd = useProjectMutation((v: { id: number; body: Record<string, unknown> }) => api.patch(`/projects/${project.key}/statuses/${v.id}`, v.body));
  const reorder = useProjectMutation((ids: number[]) => api.put(`/projects/${project.key}/statuses/order`, { status_ids: ids }));
  const del = useProjectMutation((v: { id: number; moveTo: string }) => api.del(`/projects/${project.key}/statuses/${v.id}${v.moveTo ? `?move_to=${v.moveTo}` : ""}`), "Status deleted");
  const settings = useProjectMutation((s: Record<string, unknown>) => api.patch(`/projects/${project.key}`, { settings: s }), "Board settings saved");
  const swap = (i: number, j: number) => { const ids = statuses.map((s) => s.id); [ids[i], ids[j]] = [ids[j], ids[i]]; reorder.mutate(ids); };

  return (
    <div className="space-y-4">
      <Card title="Statuses & board columns" actions={<span className="text-xs text-muted">Each status is a board column; category drives reports</span>}>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted"><tr><th className="px-4 py-2">Order</th><th>Name</th><th>Category</th><th>WIP limit</th><th /></tr></thead>
          <tbody className="divide-y">
            {statuses.map((s, i) => (
              <tr key={s.id}>
                <td className="px-4 py-1.5">
                  {manage && <span className="flex gap-1">
                    <button disabled={i === 0} onClick={() => swap(i, i - 1)} aria-label={`Move ${s.name} left`} className="text-muted disabled:opacity-30"><ArrowUp size={14} /></button>
                    <button disabled={i === statuses.length - 1} onClick={() => swap(i, i + 1)} aria-label={`Move ${s.name} right`} className="text-muted disabled:opacity-30"><ArrowDown size={14} /></button>
                  </span>}
                </td>
                <td className="py-1.5 pr-2">{manage ? <InlineInput value={s.name} onSave={(v) => upd.mutate({ id: s.id, body: { name: v } })} /> : <StatusBadge status={s} />}</td>
                <td className="w-40 pr-2">
                  <Select disabled={!manage} value={s.category} onChange={(e) => upd.mutate({ id: s.id, body: { category: e.target.value } })}>
                    {(["todo", "in_progress", "done"] as const).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                  </Select>
                </td>
                <td className="w-28 pr-2"><InlineInput type="number" placeholder="None" disabled={!manage} value={s.wip_limit ? String(s.wip_limit) : ""}
                  onSave={(v) => upd.mutate({ id: s.id, body: { wip_limit: v ? Number(v) : 0 } })} /></td>
                <td className="w-10 pr-4 text-right">{manage && statuses.length > 1 &&
                  <button aria-label={`Delete status ${s.name}`} className="text-subtle hover:text-danger" onClick={() => { setDeleting(s); setMoveTo(String(statuses.find((x) => x.id !== s.id)!.id)); }}><Trash2 size={14} /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {manage && (
          <form className="flex flex-wrap items-end gap-2 border-t p-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(undefined, { onSuccess: () => setName("") }); }}>
            <div className="w-56"><Field label="New status"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. QA" /></Field></div>
            <div className="w-40"><Field label="Category"><Select value={category} onChange={(e) => setCategory(e.target.value as StatusCategory)}>
              {(["todo", "in_progress", "done"] as const).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</Select></Field></div>
            <Button type="submit" variant="primary" disabled={!name.trim()} loading={add.isPending}>Add status</Button>
          </form>
        )}
      </Card>
      <Transitions project={project} onToggle={(v) => settings.mutate({ enforce_transitions: v })} />
      {project.board_type === "kanban" && (
        <Card title="Kanban board">
          <div className="flex items-end gap-2 p-4">
            <div className="w-64"><Field label="Hide done issues after (days)">
              <InlineInput type="number" disabled={!manage} value={String(project.settings.kanban_done_days ?? 14)} onSave={(v) => settings.mutate({ kanban_done_days: Number(v) || 14 })} />
            </Field></div>
          </div>
        </Card>
      )}
      <ConfirmDialog open={!!deleting} danger title={`Delete status "${deleting?.name}"?`} confirmLabel="Delete status" loading={del.isPending}
        message="Issues currently in this status will be moved to the status you choose. This is recorded in each issue's history."
        onClose={() => setDeleting(null)} onConfirm={() => deleting && del.mutate({ id: deleting.id, moveTo }, { onSuccess: () => setDeleting(null) })}>
        <Field label="Move issues to">
          <Select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>{statuses.filter((s) => s.id !== deleting?.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        </Field>
      </ConfirmDialog>
    </div>
  );
}

function InlineInput({ value, onSave, type = "text", placeholder, disabled }: { value: string; onSave: (v: string) => void; type?: string; placeholder?: string; disabled?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <Input type={type} min={type === "number" ? 0 : undefined} value={v} placeholder={placeholder} disabled={disabled}
    onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && (type === "number" || v.trim()) && onSave(v.trim())}
    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />;
}

function Transitions({ project, onToggle }: { project: ProjectDetail; onToggle: (v: boolean) => void }) {
  const manage = can(project, "manage_workflow");
  const toast = useToast();
  const qc = useQueryClient();
  const { data: transitions = [], isLoading } = useQuery({ queryKey: ["transitions", project.key], queryFn: () => api.get<{ from_status_id: number; to_status_id: number }[]>(`/projects/${project.key}/transitions`) });
  const [matrix, setMatrix] = useState<Set<string>>(new Set());
  useEffect(() => setMatrix(new Set(transitions.map((t) => `${t.from_status_id}:${t.to_status_id}`))), [transitions]);
  const save = useMutation({
    mutationFn: () => api.put(`/projects/${project.key}/transitions`, [...matrix].map((k) => { const [a, b] = k.split(":").map(Number); return { from_status_id: a, to_status_id: b }; })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["transitions"] }); toast.success("Transitions saved"); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const enforced = !!project.settings.enforce_transitions;
  const s = project.statuses;
  return (
    <Card title="Allowed transitions" actions={
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" disabled={!manage} checked={enforced} onChange={(e) => onToggle(e.target.checked)} /> Enforce
        {enforced ? <Badge tone="green">On</Badge> : <Badge>Off: any move allowed</Badge>}
      </label>}>
      {isLoading ? <Spinner /> : (
        <div className="overflow-x-auto p-4">
          <table className="text-sm">
            <thead><tr><th className="pr-3 text-left text-xs text-muted">From ↓ / To →</th>{s.map((t) => <th key={t.id} className="px-2 text-xs font-medium">{t.name}</th>)}</tr></thead>
            <tbody>{s.map((from) => (
              <tr key={from.id}>
                <td className="py-1 pr-3 font-medium">{from.name}</td>
                {s.map((to) => (
                  <td key={to.id} className="px-2 text-center">
                    {from.id === to.id ? <span className="text-subtle">—</span> : (
                      <input type="checkbox" disabled={!manage} aria-label={`${from.name} to ${to.name}`} checked={matrix.has(`${from.id}:${to.id}`)}
                        onChange={() => setMatrix((m) => { const n = new Set(m); const k = `${from.id}:${to.id}`; if (n.has(k)) n.delete(k); else n.add(k); return n; })} />
                    )}
                  </td>
                ))}
              </tr>
            ))}</tbody>
          </table>
          {manage && <div className="mt-3 flex gap-2">
            <Button variant="primary" size="sm" loading={save.isPending} onClick={() => save.mutate()}>Save transitions</Button>
            <Button size="sm" variant="ghost" onClick={() => setMatrix(new Set(s.flatMap((a) => s.filter((b) => b.id !== a.id).map((b) => `${a.id}:${b.id}`))))}>Allow all</Button>
          </div>}
          <p className="mt-2 text-xs text-subtle">When enforcement is on, the server rejects status changes that are not ticked here, including board drags.</p>
        </div>
      )}
    </Card>
  );
}

function Fields({ project }: { project: ProjectDetail }) {
  const { data: fields = [], isLoading } = useFields(project.key);
  const manage = can(project, "manage_workflow");
  const [f, setF] = useState({ name: "", field_type: "text", options: "", required: false });
  const [deleting, setDeleting] = useState<number | null>(null);
  const add = useProjectMutation(() => api.post(`/projects/${project.key}/fields`, { ...f, options: f.options.split(",").map((o) => o.trim()).filter(Boolean) }), "Field created");
  const del = useProjectMutation((id: number) => api.del(`/projects/${project.key}/fields/${id}`), "Field deleted");
  return (
    <div className="space-y-4">
      <Card title="Custom fields">
        {isLoading ? <Spinner /> : fields.length === 0 ? <EmptyState title="No custom fields">Add fields such as Environment, Customer or Release to capture project-specific data.</EmptyState> : (
          <ul className="divide-y">{fields.map((x) => (
            <li key={x.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className="font-medium">{x.name}</span><Badge>{x.field_type}</Badge>{x.required && <Badge tone="amber">Required</Badge>}
              {x.options.length > 0 && <span className="truncate text-xs text-muted">{x.options.join(" · ")}</span>}
              <span className="flex-1" />
              {manage && <button aria-label={`Delete field ${x.name}`} className="text-subtle hover:text-danger" onClick={() => setDeleting(x.id)}><Trash2 size={14} /></button>}
            </li>
          ))}</ul>
        )}
      </Card>
      {manage && (
        <Card title="Add field">
          <form className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); add.mutate(undefined, { onSuccess: () => setF({ name: "", field_type: "text", options: "", required: false }) }); }}>
            <Field label="Name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Type"><Select value={f.field_type} onChange={(e) => setF({ ...f, field_type: e.target.value })}>
              <option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="select">Select list</option></Select></Field>
            {f.field_type === "select" && <div className="sm:col-span-2"><Field label="Options" hint="Comma separated"><Input value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} /></Field></div>}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} /> Required when creating issues</label>
            <div><Button type="submit" variant="primary" disabled={!f.name.trim()} loading={add.isPending}>Add field</Button></div>
          </form>
        </Card>
      )}
      <ConfirmDialog open={deleting !== null} danger title="Delete custom field?" confirmLabel="Delete" message="The field and its values on every issue will be removed."
        onClose={() => setDeleting(null)} onConfirm={() => deleting && del.mutate(deleting, { onSuccess: () => setDeleting(null) })} loading={del.isPending} />
    </div>
  );
}

function Danger({ project }: { project: ProjectDetail }) {
  const [confirmKey, setConfirmKey] = useState("");
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const archive = useProjectMutation(() => api.patch(`/projects/${project.key}`, { status: project.status === "active" ? "archived" : "active" }),
    project.status === "active" ? "Project archived" : "Project restored");
  const del = useMutation({
    mutationFn: () => api.del(`/projects/${project.key}?confirm_key=${encodeURIComponent(confirmKey)}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["projects"] }); toast.success("Project deleted"); navigate("/projects"); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!can(project, "edit_project")) return <p className="text-sm text-muted">Only project managers can archive or delete this project.</p>;
  return (
    <div className="space-y-4">
      <Card title={project.status === "active" ? "Archive project" : "Restore project"}>
        <div className="flex items-center justify-between gap-4 p-4 text-sm">
          <p className="text-muted">{project.status === "active" ? "Archived projects are read-only for new issues and hidden from the project list. Data is kept." : "Restore the project so the team can create issues again."}</p>
          <Button loading={archive.isPending} onClick={() => archive.mutate(undefined)}>{project.status === "active" ? "Archive" : "Restore"}</Button>
        </div>
      </Card>
      {can(project, "delete_project") && (
        <Card title="Delete project" className="border-danger/40">
          <div className="flex items-center justify-between gap-4 p-4 text-sm">
            <p className="text-muted">Permanently delete this project with all issues, sprints, comments and attachments. This cannot be undone. Consider taking a backup first.</p>
            <Button variant="danger" onClick={() => setOpen(true)}>Delete…</Button>
          </div>
        </Card>
      )}
      <ConfirmDialog open={open} danger title={`Delete ${project.name}?`} confirmLabel="Delete permanently" loading={del.isPending}
        message={<>Type <strong>{project.key}</strong> to confirm.</>} onClose={() => setOpen(false)} onConfirm={() => confirmKey.toUpperCase() === project.key && del.mutate()}>
        <Input value={confirmKey} onChange={(e) => setConfirmKey(e.target.value)} aria-label="Confirm project key" autoFocus />
      </ConfirmDialog>
    </div>
  );
}
