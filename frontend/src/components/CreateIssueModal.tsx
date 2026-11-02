import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { api, errorMessage } from "../lib/api";
import { ISSUE_TYPES, PRIORITIES } from "../lib/format";
import { useFields, useInvalidateIssues, useMembers, useProject, useProjects, useSprints } from "../lib/queries";
import type { CustomField, IssueDetail, IssueType, Page, Issue, Priority } from "../lib/types";
import { useToast } from "./toast";
import { UserSelect } from "./issue-bits";
import { Button, Field, Input, Modal, Select, Textarea } from "./ui";

export interface CreateDefaults {
  projectKey?: string;
  issue_type?: IssueType;
  parent_id?: number;
  sprint_id?: number | null;
  status_id?: number;
  due_date?: string;
}

export function CustomFieldInput({ field, value, onChange }: { field: CustomField; value: unknown; onChange: (v: unknown) => void }) {
  const v = value ?? "";
  if (field.field_type === "select")
    return (
      <Select value={String(v)} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">—</option>
        {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </Select>
    );
  return (
    <Input type={field.field_type === "number" ? "number" : field.field_type === "date" ? "date" : "text"} value={String(v)}
      onChange={(e) => onChange(e.target.value || null)} />
  );
}

export function CreateIssueModal({ defaults, onClose }: { defaults: CreateDefaults; onClose: () => void }) {
  const routeKey = useMatch("/projects/:key/*")?.params.key;
  const { data: projects } = useProjects();
  const [projectKey, setProjectKey] = useState(defaults.projectKey ?? routeKey ?? "");
  useEffect(() => {
    if (!projectKey && projects?.length) setProjectKey(projects[0].key);
  }, [projects, projectKey]);
  const { data: project } = useProject(projectKey || undefined);
  const { data: members = [] } = useMembers(projectKey || undefined);
  const { data: sprints = [] } = useSprints(projectKey || undefined, "future,active");
  const { data: fields = [] } = useFields(projectKey || undefined);

  const [type, setType] = useState<IssueType>(defaults.issue_type ?? "task");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [assignee, setAssignee] = useState<number | null>(null);
  const [parentId, setParentId] = useState<number | null>(defaults.parent_id ?? null);
  const [sprintId, setSprintId] = useState<number | null>(defaults.sprint_id ?? null);
  const [points, setPoints] = useState("");
  const [due, setDue] = useState(defaults.due_date ?? "");
  const [labels, setLabels] = useState("");
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [another, setAnother] = useState(false);

  // Candidate parents: epics for standard issues; non-epic, non-subtask issues for subtasks.
  const parentTypes = type === "subtask" ? ["story", "task", "bug", "improvement"] : ["epic"];
  const { data: parents } = useQuery({
    queryKey: ["issues", "parents", project?.id, type],
    queryFn: () => api.get<Page<Issue>>(`/issues?project_ids=${project!.id}&${parentTypes.map((t) => `issue_types=${t}`).join("&")}&page_size=200&sort=updated&order=desc`),
    enabled: !!project && type !== "epic",
  });

  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateIssues();
  const create = useMutation({
    mutationFn: () =>
      api.post<IssueDetail>("/issues", {
        project_id: project!.id,
        issue_type: type,
        summary: summary.trim(),
        description,
        priority,
        assignee_id: assignee,
        parent_id: type === "epic" ? null : parentId,
        sprint_id: type === "epic" ? null : sprintId,
        status_id: defaults.status_id,
        story_points: points === "" ? null : Number(points),
        due_date: due || null,
        labels: labels.split(",").map((l) => l.trim()).filter(Boolean),
        custom_fields: custom,
      }),
    onSuccess: (issue) => {
      invalidate();
      toast.success(`Created ${issue.key}`);
      if (another) {
        setSummary("");
        setDescription("");
      } else {
        onClose();
        if (!defaults.parent_id) navigate(`/issues/${issue.key}`);
      }
    },
  });

  const canCreate = project?.permissions.includes("create_issue");
  const valid = summary.trim() && project && (type !== "subtask" || parentId);

  return (
    <Modal open onClose={onClose} title="Create issue" width="max-w-2xl"
      footer={
        <>
          <label className="mr-auto flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={another} onChange={(e) => setAnother(e.target.checked)} /> Create another
          </label>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!valid || !canCreate} onClick={() => create.mutate()}>Create</Button>
        </>
      }>
      <form className="grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (valid) create.mutate(); }}>
        {projects?.length === 0 && <p className="sm:col-span-2 text-sm text-muted">You are not a member of any project yet.</p>}
        <Field label="Project" required>
          <Select value={projectKey} onChange={(e) => { setProjectKey(e.target.value); setParentId(null); setSprintId(null); setCustom({}); }}>
            {projects?.map((p) => <option key={p.id} value={p.key}>{p.name} ({p.key})</option>)}
          </Select>
        </Field>
        <Field label="Issue type" required>
          <Select value={type} onChange={(e) => { setType(e.target.value as IssueType); setParentId(null); }}>
            {ISSUE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Summary" required>
            <Input value={summary} maxLength={255} onChange={(e) => setSummary(e.target.value)} placeholder="What needs to be done?" autoFocus />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Description" hint="Mention teammates with @username">
            <Textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Select>
        </Field>
        <Field label="Assignee">
          <UserSelect members={members} value={assignee} onChange={setAssignee} />
        </Field>
        {type !== "epic" && (
          <Field label={type === "subtask" ? "Parent issue" : "Epic"} required={type === "subtask"}>
            <Select value={parentId ?? ""} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{type === "subtask" ? "Select parent…" : "None"}</option>
              {parents?.items.map((p) => <option key={p.id} value={p.id}>{p.key} — {p.summary}</option>)}
            </Select>
          </Field>
        )}
        {type !== "epic" && project?.board_type === "scrum" && (
          <Field label="Sprint">
            <Select value={sprintId ?? ""} onChange={(e) => setSprintId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Backlog</option>
              {sprints.map((s) => <option key={s.id} value={s.id}>{s.name}{s.state === "active" ? " (active)" : ""}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Story points">
          <Input type="number" min={0} step="0.5" value={points} onChange={(e) => setPoints(e.target.value)} />
        </Field>
        <Field label="Due date">
          <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Labels" hint="Comma separated">
            <Input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="backend, auth" />
          </Field>
        </div>
        {fields.map((f) => (
          <Field key={f.id} label={f.name} required={f.required}>
            <CustomFieldInput field={f} value={custom[String(f.id)]} onChange={(v) => setCustom((c) => ({ ...c, [f.id]: v }))} />
          </Field>
        ))}
        {project && !canCreate && <p className="sm:col-span-2 text-sm text-danger">Your role in this project cannot create issues.</p>}
        {create.isError && <p role="alert" className="sm:col-span-2 text-sm text-danger">{errorMessage(create.error)}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
