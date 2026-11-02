import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Eye, EyeOff, Link2, MoreHorizontal, Paperclip, Plus, Trash2, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, download, errorMessage } from "../lib/api";
import { useMe } from "../lib/auth";
import { describeChange, fmtBytes, fmtDate, fmtRelative, FORMER_USER, ISSUE_TYPES, PRIORITIES } from "../lib/format";
import { can, useFields, useInvalidateIssues, useIssue, useMembers, useProject, useSprints, useUpdateIssue } from "../lib/queries";
import type { Attachment, Comment, History, Issue, IssueDetail, IssueType, Page, Priority } from "../lib/types";
import { CustomFieldInput } from "./CreateIssueModal";
import { useQuickCreate } from "./Layout";
import { IssueKeyLink, IssueTypeIcon, PriorityIcon, StatusBadge, UserSelect } from "./issue-bits";
import { useToast } from "./toast";
import { Avatar, Button, ConfirmDialog, ErrorState, Input, Menu, MenuItem, Select, Spinner, Tabs, Textarea } from "./ui";

export function IssueView({ issueKey, onClose }: { issueKey: string; onClose?: () => void }) {
  const { data: issue, isLoading, error, refetch } = useIssue(issueKey);
  if (isLoading) return <Spinner />;
  if (error || !issue) return <ErrorState error={error ?? "Issue not found"} onRetry={refetch} />;
  return <IssueBody issue={issue} onClose={onClose} />;
}

function IssueBody({ issue, onClose }: { issue: IssueDetail; onClose?: () => void }) {
  const update = useUpdateIssue(issue.key);
  const save = (changes: Record<string, unknown>) => update.mutateAsync({ ...changes, version: issue.version });
  const { data: project } = useProject(issue.project.key);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidateIssues();

  const watch = useMutation({
    mutationFn: () => (issue.is_watching ? api.del(`/issues/${issue.key}/watch`) : api.post(`/issues/${issue.key}/watch`)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["issue", issue.key] }),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/issues/${issue.key}`),
    onSuccess: () => {
      toast.success(`Deleted ${issue.key}`);
      invalidate();
      qc.removeQueries({ queryKey: ["issue", issue.key] });
      if (onClose) onClose();
      else navigate(`/projects/${issue.project.key}/issues`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const edit = issue.can_edit;
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2.5 text-sm">
        <Link to={`/projects/${issue.project.key}`} className="text-muted hover:underline">{issue.project.name}</Link>
        <span className="text-subtle">/</span>
        {issue.parent && (
          <>
            <IssueTypeIcon type={issue.parent.issue_type} size={14} />
            <IssueKeyLink issueKey={issue.parent.key} />
            <span className="text-subtle">/</span>
          </>
        )}
        <IssueTypeIcon type={issue.issue_type} size={14} />
        <IssueKeyLink issueKey={issue.key} className="text-fg" />
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon={issue.is_watching ? <EyeOff size={14} /> : <Eye size={14} />} onClick={() => watch.mutate()}>
          {issue.is_watching ? "Unwatch" : "Watch"} · {issue.watchers.length}
        </Button>
        {can(project, "delete_issue") && (
          <Menu width="w-44" trigger={() => <Button size="sm" variant="ghost" aria-label="More actions"><MoreHorizontal size={16} /></Button>}>
            {(close) => <MenuItem danger icon={<Trash2 size={14} />} onClick={() => { close(); setConfirmDelete(true); }}>Delete issue</MenuItem>}
          </Menu>
        )}
        {onClose && (
          <>
            <Link to={`/issues/${issue.key}`} className="text-xs text-primary hover:underline">Open full page</Link>
            <button onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Close"><X size={18} /></button>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6 p-5">
          <InlineText value={issue.summary} disabled={!edit} onSave={(v) => save({ summary: v })}
            className="text-xl font-semibold" ariaLabel="Summary" />
          <Section title="Description">
            <DescriptionEditor value={issue.description} disabled={!edit} onSave={(v) => save({ description: v })} />
          </Section>
          {issue.issue_type !== "subtask" && <ChildIssues issue={issue} />}
          <Links issue={issue} />
          <Attachments issue={issue} canAttach={can(project, "attach")} />
          <Activity issue={issue} canComment={can(project, "comment")} />
        </div>
        <aside className="space-y-4 border-t p-5 lg:border-l lg:border-t-0">
          <StatusControl issue={issue} onChange={(id) => save({ status_id: id })} />
          <Details issue={issue} edit={edit} save={save} />
        </aside>
      </div>

      <ConfirmDialog open={confirmDelete} danger title={`Delete ${issue.key}?`} confirmLabel="Delete" loading={del.isPending}
        onClose={() => setConfirmDelete(false)} onConfirm={() => del.mutate()}
        message={<>This permanently deletes the issue, its comments, attachments and history.{issue.children.some((c) => c.issue_type === "subtask") && " Its subtasks are deleted too."}{issue.issue_type === "epic" && issue.children.length > 0 && " Child issues will be detached from the epic."}</>} />
    </div>
  );
}

function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

function InlineText({ value, onSave, disabled, className, ariaLabel }: { value: string; onSave: (v: string) => Promise<unknown>; disabled?: boolean; className?: string; ariaLabel: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing)
    return (
      <h2 title={disabled ? undefined : `Click to edit ${ariaLabel.toLowerCase()}`} onClick={() => !disabled && (setDraft(value), setEditing(true))}
        className={clsx(className, "rounded px-1 -mx-1", !disabled && "cursor-text hover:bg-surface-2")}>{value}</h2>
    );
  const commit = async () => {
    const v = draft.trim();
    if (v && v !== value) await onSave(v).catch(() => {});
    setEditing(false);
  };
  return (
    <Input autoFocus value={draft} maxLength={255} aria-label={ariaLabel} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
      className={clsx(className, "h-auto py-1")} />
  );
}

function DescriptionEditor({ value, onSave, disabled }: { value: string; onSave: (v: string) => Promise<unknown>; disabled?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  if (!editing)
    return (
      <div onClick={() => !disabled && (setDraft(value), setEditing(true))}
        className={clsx("prose-issue min-h-12 rounded-md px-2 py-1.5 -mx-2", !disabled && "cursor-text hover:bg-surface-2", !value && "text-subtle")}>
        {value ? <Mentions text={value} /> : disabled ? "No description" : "Add a description…"}
      </div>
    );
  return (
    <div className="space-y-2">
      <Textarea autoFocus rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Description" />
      <div className="flex gap-2">
        <Button size="sm" variant="primary" loading={saving}
          onClick={async () => { setSaving(true); await onSave(draft).catch(() => {}); setSaving(false); setEditing(false); }}>Save</Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
      </div>
    </div>
  );
}

export function Mentions({ text }: { text: string }) {
  const parts = text.split(/(@[a-zA-Z0-9_.-]{3,50})/g);
  return <>{parts.map((p, i) => (p.startsWith("@") ? <span key={i} className="rounded bg-primary-soft px-0.5 font-medium text-primary">{p}</span> : p))}</>;
}

function StatusControl({ issue, onChange }: { issue: IssueDetail; onChange: (id: number) => void }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-muted">Status</p>
      {issue.available_transitions.length > 0 ? (
        <Menu align="left" width="w-60" trigger={() => (
          <button className="flex items-center gap-2 rounded-md border bg-surface px-2 py-1 hover:bg-surface-2" aria-label="Change status">
            <StatusBadge status={issue.status} /> <span className="text-xs text-muted">▾</span>
          </button>
        )}>
          {(close) => issue.available_transitions.map((s) => (
            <MenuItem key={s.id} onClick={() => { close(); onChange(s.id); }}>
              <span className="text-muted">→</span> <StatusBadge status={s} />
            </MenuItem>
          ))}
        </Menu>
      ) : (
        <StatusBadge status={issue.status} />
      )}
      {issue.resolved_at && <p className="mt-1 text-xs text-success">Resolved {fmtRelative(issue.resolved_at)}</p>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[100px_minmax(0,1fr)] items-center gap-2">
      <span className="text-xs font-medium text-muted">{label}</span>
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  );
}

function Details({ issue, edit, save }: { issue: IssueDetail; edit: boolean; save: (c: Record<string, unknown>) => Promise<unknown> }) {
  const { data: members = [] } = useMembers(issue.project.key);
  const { data: sprints = [] } = useSprints(issue.project.key, "future,active");
  const { data: fields = [] } = useFields(issue.project.key);
  const { data: epics } = useQuery({
    queryKey: ["issues", "epics", issue.project_id],
    queryFn: () => api.get<Page<Issue>>(`/issues?project_ids=${issue.project_id}&issue_types=epic&page_size=200`),
    enabled: issue.issue_type !== "epic" && issue.issue_type !== "subtask",
  });
  const s = (v: string) => (v === "" ? null : v);
  return (
    <div className="space-y-2.5 rounded-lg border p-3">
      <Row label="Assignee">
        {edit ? <UserSelect members={members} value={issue.assignee?.id ?? null} onChange={(v) => save({ assignee_id: v })} />
          : <span className="flex items-center gap-2"><Avatar user={issue.assignee} size={20} />{issue.assignee?.full_name ?? "Unassigned"}</span>}
      </Row>
      <Row label="Reporter"><span className="flex items-center gap-2"><Avatar user={issue.reporter} size={20} />{issue.reporter?.full_name ?? FORMER_USER}</span></Row>
      <Row label="Type">
        {edit ? (
          <Select value={issue.issue_type} onChange={(e) => save({ issue_type: e.target.value as IssueType })}>
            {ISSUE_TYPES.filter((t) => (issue.issue_type === "subtask") === (t.value === "subtask")).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
        ) : <span className="flex items-center gap-2"><IssueTypeIcon type={issue.issue_type} />{issue.issue_type}</span>}
      </Row>
      <Row label="Priority">
        {edit ? (
          <Select value={issue.priority} onChange={(e) => save({ priority: e.target.value as Priority })}>
            {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Select>
        ) : <span className="flex items-center gap-1"><PriorityIcon priority={issue.priority} />{issue.priority}</span>}
      </Row>
      {issue.issue_type !== "epic" && issue.issue_type !== "subtask" && (
        <Row label="Epic">
          {edit ? (
            <Select value={issue.parent_id ?? ""} onChange={(e) => save({ parent_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">None</option>
              {epics?.items.map((e) => <option key={e.id} value={e.id}>{e.key} — {e.summary}</option>)}
            </Select>
          ) : issue.parent ? <IssueKeyLink issueKey={issue.parent.key} /> : "None"}
        </Row>
      )}
      {issue.issue_type !== "epic" && issue.project.board_type === "scrum" && (
        <Row label="Sprint">
          {edit && issue.sprint?.state !== "closed" ? (
            <Select value={issue.sprint_id ?? ""} onChange={(e) => save({ sprint_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Backlog</option>
              {sprints.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}{sp.state === "active" ? " (active)" : ""}</option>)}
            </Select>
          ) : issue.sprint?.name ?? "Backlog"}
        </Row>
      )}
      <Row label="Story points">
        <NumberField key={`sp${issue.story_points}`} value={issue.story_points} disabled={!edit} onSave={(v) => save({ story_points: v })} />
      </Row>
      <Row label="Estimate (h)">
        <NumberField key={`oe${issue.original_estimate_hours}`} value={issue.original_estimate_hours} disabled={!edit} onSave={(v) => save({ original_estimate_hours: v })} />
      </Row>
      <Row label="Logged (h)">
        <NumberField key={`ts${issue.time_spent_hours}`} value={issue.time_spent_hours || null} disabled={!edit} onSave={(v) => save({ time_spent_hours: v ?? 0 })} />
      </Row>
      <Row label="Start date">
        <Input type="date" disabled={!edit} value={issue.start_date ?? ""} onChange={(e) => save({ start_date: s(e.target.value) })} />
      </Row>
      <Row label="Due date">
        <Input type="date" disabled={!edit} value={issue.due_date ?? ""} onChange={(e) => save({ due_date: s(e.target.value) })} />
      </Row>
      <Row label="Labels">
        <LabelsField labels={issue.labels} disabled={!edit} onSave={(l) => save({ labels: l })} />
      </Row>
      {fields.map((f) => (
        <Row key={f.id} label={f.name}>
          {edit ? <CustomFieldInput field={f} value={issue.custom_fields[String(f.id)]} onChange={(v) => save({ custom_fields: { [f.id]: v } })} />
            : String(issue.custom_fields[String(f.id)] ?? "—")}
        </Row>
      ))}
      <div className="border-t pt-2 text-xs text-subtle">
        <p>Created {fmtDate(issue.created_at, "d MMM yyyy, HH:mm")}</p>
        <p>Updated {fmtRelative(issue.updated_at)}</p>
        {issue.watchers.length > 0 && (
          <div className="mt-2 flex items-center gap-1">Watchers: {issue.watchers.map((w) => <Avatar key={w.id} user={w} size={18} />)}</div>
        )}
      </div>
    </div>
  );
}

function NumberField({ value, onSave, disabled }: { value: number | null; onSave: (v: number | null) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const commit = () => {
    const v = draft === "" ? null : Number(draft);
    if (v !== value && (v === null || !Number.isNaN(v))) onSave(v);
  };
  return <Input type="number" min={0} step="0.5" disabled={disabled} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
    onKeyDown={(e) => e.key === "Enter" && commit()} />;
}

function LabelsField({ labels, onSave, disabled }: { labels: string[]; onSave: (l: string[]) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-1">
      {labels.map((l) => (
        <span key={l} className="inline-flex items-center gap-1 rounded bg-surface-3 px-1.5 py-0.5 text-xs">
          {l}
          {!disabled && <button aria-label={`Remove label ${l}`} onClick={() => onSave(labels.filter((x) => x !== l))}><X size={10} /></button>}
        </span>
      ))}
      {!disabled && (
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="+ label" aria-label="Add label"
          className="h-6 w-20 rounded border-none bg-transparent px-1 text-xs focus:bg-surface-2 focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              onSave([...labels, draft.trim()]);
              setDraft("");
            }
          }} />
      )}
      {disabled && labels.length === 0 && "—"}
    </div>
  );
}

function ChildIssues({ issue }: { issue: IssueDetail }) {
  const quickCreate = useQuickCreate();
  const isEpic = issue.issue_type === "epic";
  const done = issue.children.filter((c) => c.status.category === "done").length;
  return (
    <Section title={isEpic ? `Issues in this epic (${done}/${issue.children.length} done)` : `Subtasks (${done}/${issue.children.length})`}
      actions={issue.can_edit && (
        <Button size="sm" variant="ghost" icon={<Plus size={14} />}
          onClick={() => quickCreate({ projectKey: issue.project.key, issue_type: isEpic ? "story" : "subtask", parent_id: issue.id, sprint_id: isEpic ? null : issue.sprint_id })}>
          {isEpic ? "Add issue" : "Add subtask"}
        </Button>
      )}>
      {issue.children.length === 0 ? <p className="text-sm text-subtle">None yet.</p> : (
        <ul className="divide-y rounded-md border">
          {issue.children.map((c) => (
            <li key={c.id} className="flex items-center gap-2 px-3 py-1.5">
              <IssueTypeIcon type={c.issue_type} size={14} />
              <IssueKeyLink issueKey={c.key} className="text-xs" />
              <span className={clsx("flex-1 truncate text-sm", c.status.category === "done" && "text-muted line-through")}>{c.summary}</span>
              <PriorityIcon priority={c.priority} size={14} />
              <Avatar user={c.assignee} size={18} />
              <StatusBadge status={c.status} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Links({ issue }: { issue: IssueDetail }) {
  const [adding, setAdding] = useState(false);
  const [linkType, setLinkType] = useState("blocks");
  const [search, setSearch] = useState("");
  const qc = useQueryClient();
  const toast = useToast();
  const { data: candidates } = useQuery({
    queryKey: ["issues", "link-search", search],
    queryFn: () => api.get<Page<Issue>>(`/issues?text=${encodeURIComponent(search)}&page_size=10&sort=updated&order=desc`),
    enabled: adding && search.length > 0,
  });
  const add = useMutation({
    mutationFn: (target_id: number) => api.post(`/issues/${issue.key}/links`, { target_id, link_type: linkType }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["issue"] }); setAdding(false); setSearch(""); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/issues/${issue.key}/links/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["issue"] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Section title="Linked issues" actions={issue.can_edit && <Button size="sm" variant="ghost" icon={<Link2 size={14} />} onClick={() => setAdding((a) => !a)}>Link issue</Button>}>
      {adding && (
        <div className="mb-2 space-y-2 rounded-md border bg-surface-2 p-2">
          <div className="flex gap-2">
            <Select value={linkType} onChange={(e) => setLinkType(e.target.value)} className="w-40">
              <option value="blocks">blocks</option>
              <option value="relates_to">relates to</option>
              <option value="duplicates">duplicates</option>
            </Select>
            <Input autoFocus placeholder="Search by key or summary" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {candidates?.items.filter((c) => c.id !== issue.id).map((c) => (
            <button key={c.id} onClick={() => add.mutate(c.id)} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-surface">
              <IssueTypeIcon type={c.issue_type} size={14} /> <span className="text-xs text-muted">{c.key}</span> <span className="truncate">{c.summary}</span>
            </button>
          ))}
        </div>
      )}
      {issue.links.length === 0 ? <p className="text-sm text-subtle">No linked issues.</p> : (
        <ul className="divide-y rounded-md border">
          {issue.links.map((l) => (
            <li key={l.id} className="flex items-center gap-2 px-3 py-1.5">
              <span className="w-28 shrink-0 text-xs text-muted">{l.label}</span>
              <IssueTypeIcon type={l.issue.issue_type} size={14} />
              <IssueKeyLink issueKey={l.issue.key} className="text-xs" />
              <span className="flex-1 truncate text-sm">{l.issue.summary}</span>
              <StatusBadge status={l.issue.status} />
              {issue.can_edit && <button aria-label="Remove link" className="text-subtle hover:text-danger" onClick={() => remove.mutate(l.id)}><X size={14} /></button>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Attachments({ issue, canAttach }: { issue: IssueDetail; canAttach: boolean }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const { data = [] } = useQuery({ queryKey: ["attachments", issue.key], queryFn: () => api.get<Attachment[]>(`/issues/${issue.key}/attachments`) });
  const upload = useMutation({
    mutationFn: async (files: FileList) => {
      for (const f of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", f);
        await api.post(`/issues/${issue.key}/attachments`, fd);
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["attachments", issue.key] }); qc.invalidateQueries({ queryKey: ["issue-history", issue.key] }); },
    onError: (e) => { toast.error(errorMessage(e)); qc.invalidateQueries({ queryKey: ["attachments", issue.key] }); },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/issues/${issue.key}/attachments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["attachments", issue.key] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Section title={`Attachments (${data.length})`}
      actions={canAttach && <Button size="sm" variant="ghost" icon={<Paperclip size={14} />} loading={upload.isPending} onClick={() => input.current?.click()}>Attach</Button>}>
      <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) upload.mutate(e.target.files); e.target.value = ""; }} />
      {data.length === 0 ? (
        <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (canAttach && e.dataTransfer.files.length) upload.mutate(e.dataTransfer.files); }}
          className="rounded-md border border-dashed p-4 text-center text-sm text-subtle">
          {canAttach ? "Drop files here or use Attach" : "No attachments."}
        </div>
      ) : (
        <ul className="divide-y rounded-md border">
          {data.map((a) => (
            <li key={a.id} className="flex items-center gap-2 px-3 py-1.5">
              <Paperclip size={14} className="text-muted" />
              <button className="flex-1 truncate text-left text-sm text-primary hover:underline"
                onClick={() => download(`/issues/${issue.key}/attachments/${a.id}`, a.filename).catch((e) => toast.error(errorMessage(e)))}>
                {a.filename}
              </button>
              <span className="text-xs text-subtle">{fmtBytes(a.size_bytes)} · {a.uploader?.full_name ?? FORMER_USER} · {fmtRelative(a.created_at)}</span>
              {(a.uploader?.id === me.id || issue.can_edit) && (
                <button aria-label={`Delete ${a.filename}`} className="text-subtle hover:text-danger" onClick={() => remove.mutate(a.id)}><Trash2 size={14} /></button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Activity({ issue, canComment }: { issue: IssueDetail; canComment: boolean }) {
  const [tab, setTab] = useState<"comments" | "history">("comments");
  return (
    <section>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "comments", label: "Comments" }, { value: "history", label: "History" }]} />
      <div className="pt-3">{tab === "comments" ? <Comments issue={issue} canComment={canComment} /> : <HistoryList issueKey={issue.key} />}</div>
    </section>
  );
}

function Comments({ issue, canComment }: { issue: IssueDetail; canComment: boolean }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const { data = [], isLoading } = useQuery({ queryKey: ["comments", issue.key], queryFn: () => api.get<Comment[]>(`/issues/${issue.key}/comments`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["comments", issue.key] }); qc.invalidateQueries({ queryKey: ["issue-history", issue.key] }); };
  const add = useMutation({
    mutationFn: () => api.post(`/issues/${issue.key}/comments`, { body }),
    onSuccess: () => { setBody(""); refresh(); qc.invalidateQueries({ queryKey: ["issue", issue.key] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const save = useMutation({
    mutationFn: (c: { id: number; body: string }) => api.patch(`/issues/${issue.key}/comments/${c.id}`, { body: c.body }),
    onSuccess: () => { setEditing(null); refresh(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/issues/${issue.key}/comments/${id}`),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="space-y-4">
      {canComment && (
        <div className="flex gap-2">
          <Avatar user={me} size={28} />
          <div className="flex-1 space-y-2">
            <Textarea rows={2} placeholder="Add a comment… use @username to mention" value={body} onChange={(e) => setBody(e.target.value)} aria-label="New comment"
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim()) add.mutate(); }} />
            {body && <Button size="sm" variant="primary" loading={add.isPending} disabled={!body.trim()} onClick={() => add.mutate()}>Save</Button>}
          </div>
        </div>
      )}
      {isLoading && <Spinner />}
      {!isLoading && data.length === 0 && <p className="text-sm text-subtle">No comments yet.</p>}
      {[...data].reverse().map((c) => (
        <div key={c.id} className="flex gap-2">
          <Avatar user={c.author} size={28} />
          <div className="min-w-0 flex-1">
            <p className="text-sm"><span className="font-semibold">{c.author?.full_name ?? FORMER_USER}</span>
              <span className="ml-2 text-xs text-subtle">{fmtRelative(c.created_at)}{c.updated_at !== c.created_at && " (edited)"}</span></p>
            {editing?.id === c.id ? (
              <div className="mt-1 space-y-2">
                <Textarea rows={3} value={editing.body} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} />
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(editing)}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <p className="prose-issue mt-0.5 text-sm"><Mentions text={c.body} /></p>
            )}
            {c.author?.id === me.id && editing?.id !== c.id && (
              <div className="mt-1 flex gap-3 text-xs text-muted">
                <button className="hover:underline" onClick={() => setEditing({ id: c.id, body: c.body })}>Edit</button>
                <button className="hover:underline" onClick={() => remove.mutate(c.id)}>Delete</button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function HistoryList({ issueKey }: { issueKey: string }) {
  const { data = [], isLoading } = useQuery({ queryKey: ["issue-history", issueKey], queryFn: () => api.get<History[]>(`/issues/${issueKey}/history`) });
  if (isLoading) return <Spinner />;
  return (
    <ol className="space-y-3">
      {data.map((h) => (
        <li key={h.id} className="flex gap-2 text-sm">
          <Avatar user={h.actor} size={22} />
          <div>
            <span className="font-medium">{h.actor?.full_name ?? FORMER_USER}</span> <span className="text-muted">{describeChange(h)}</span>
            <p className="text-xs text-subtle">{fmtDate(h.created_at, "d MMM yyyy, HH:mm")}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
