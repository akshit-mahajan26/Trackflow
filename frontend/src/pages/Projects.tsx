import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderKanban, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useToast } from "../components/toast";
import { Avatar, Badge, Button, EmptyState, ErrorState, Field, Input, Modal, PageHeader, ProgressBar, Select, Spinner, Textarea } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { PRIORITIES, fmtDate, roleLabel } from "../lib/format";
import { useProjects } from "../lib/queries";
import type { ProjectDetail } from "../lib/types";

export default function Projects() {
  const [showArchived, setShowArchived] = useState(false);
  const { data, isLoading, error, refetch } = useProjects(showArchived);
  const [creating, setCreating] = useState(false);
  return (
    <div className="mx-auto max-w-6xl p-4 md:p-6">
      <PageHeader title="Projects" subtitle="Projects you are a member of"
        actions={<>
          <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>New project</Button>
        </>} />
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} onRetry={refetch} /> : data!.length === 0 ? (
        <EmptyState icon={<FolderKanban size={36} />} title="No projects yet" action={<Button variant="primary" onClick={() => setCreating(true)}>Create your first project</Button>}>
          Create a project, invite your team and start tracking work.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-surface">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b bg-surface-2 text-left text-xs text-muted">
              <tr><th className="px-4 py-2">Project</th><th>Key</th><th>Type</th><th>Lead</th><th>Your role</th><th className="w-48">Progress</th><th>Due</th></tr>
            </thead>
            <tbody className="divide-y">
              {data!.map((p) => (
                <tr key={p.id} className="hover:bg-surface-2">
                  <td className="px-4 py-2.5">
                    <Link to={`/projects/${p.key}`} className="font-medium hover:underline">{p.name}</Link>
                    {p.status === "archived" && <Badge className="ml-2">Archived</Badge>}
                  </td>
                  <td className="text-muted">{p.key}</td>
                  <td className="capitalize text-muted">{p.board_type}</td>
                  <td><span className="flex items-center gap-2"><Avatar user={p.lead} size={20} />{p.lead?.full_name ?? "—"}</span></td>
                  <td className="text-muted">{roleLabel(p.my_role) === "—" ? "Admin" : roleLabel(p.my_role)}</td>
                  <td className="pr-4">
                    <ProgressBar value={p.done_count} total={p.issue_count} />
                    <span className="text-xs text-subtle">{p.done_count}/{p.issue_count} done · {p.member_count} members</span>
                  </td>
                  <td className="text-muted">{fmtDate(p.due_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CreateProjectModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: "", key: "", description: "", board_type: "scrum", priority: "medium", start_date: "", due_date: "" });
  const [keyTouched, setKeyTouched] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => api.post<ProjectDetail>("/projects", { ...f, start_date: f.start_date || null, due_date: f.due_date || null }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success(`Project ${p.key} created`);
      navigate(`/projects/${p.key}/settings?tab=members`);
    },
  });
  const suggestKey = (name: string) => name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").toUpperCase().slice(0, 5) || name.slice(0, 4).toUpperCase();
  return (
    <Modal open onClose={onClose} title="Create project"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={create.isPending} disabled={!f.name || f.key.length < 2} onClick={() => create.mutate()}>Create</Button></>}>
      <form className="grid grid-cols-2 gap-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <div className="col-span-2"><Field label="Name" required>
          <Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, key: keyTouched ? f.key : suggestKey(e.target.value) })} />
        </Field></div>
        <Field label="Key" required hint="Prefix for issue keys, e.g. APP-123">
          <Input value={f.key} maxLength={10} onChange={(e) => { setKeyTouched(true); setF({ ...f, key: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") }); }} />
        </Field>
        <Field label="Board type">
          <Select value={f.board_type} onChange={(e) => setF({ ...f, board_type: e.target.value })}>
            <option value="scrum">Scrum (sprints + backlog)</option>
            <option value="kanban">Kanban (continuous flow)</option>
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
            {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Select>
        </Field>
        <div />
        <Field label="Start date"><Input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></Field>
        <Field label="Target date"><Input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
        <div className="col-span-2"><Field label="Description"><Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div>
        {create.isError && <p role="alert" className="col-span-2 text-sm text-danger">{errorMessage(create.error)}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
