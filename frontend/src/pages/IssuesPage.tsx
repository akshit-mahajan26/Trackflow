import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Bookmark, Code2, Download, Plus, Save, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { IssueView } from "../components/IssueView";
import { useQuickCreate } from "../components/Layout";
import { DueDate, IssueTypeIcon, Points, PriorityIcon, StatusBadge } from "../components/issue-bits";
import { useToast } from "../components/toast";
import { Avatar, Button, EmptyState, ErrorState, Field, Input, Menu, MenuItem, Modal, PageHeader, Select, Spinner } from "../components/ui";
import { api, download, errorMessage, filterToQuery } from "../lib/api";
import { CATEGORY_LABEL, fmtDate, ISSUE_TYPES, PRIORITIES } from "../lib/format";
import { useInvalidateIssues, useLabels, useMembers, useProject, useProjects, useSprints, useUsers } from "../lib/queries";
import type { Issue, IssueFilter, Page, SavedFilter } from "../lib/types";

const ARRAY_KEYS = ["project_ids", "issue_types", "status_ids", "status_categories", "priorities", "assignee_ids", "sprint_ids", "labels"] as const;
const SCALAR_KEYS = ["text", "overdue", "resolved", "due_from", "due_to", "sort", "order", "tql", "epic_id"] as const;

function readFilter(sp: URLSearchParams): IssueFilter {
  const f: Record<string, unknown> = {};
  for (const k of ARRAY_KEYS) {
    const v = sp.getAll(k);
    if (v.length) f[k] = v.map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  }
  for (const k of SCALAR_KEYS) {
    const v = sp.get(k);
    if (v !== null && v !== "") f[k] = v === "true" ? true : v === "false" ? false : v;
  }
  return f as IssueFilter;
}

function writeFilter(f: IssueFilter): URLSearchParams {
  return new URLSearchParams(filterToQuery(f).slice(1));
}

const COLUMNS: { key: string; label: string; sort?: string }[] = [
  { key: "key", label: "Key", sort: "key" }, { key: "summary", label: "Summary", sort: "summary" }, { key: "status", label: "Status" },
  { key: "priority", label: "P", sort: "priority" }, { key: "assignee", label: "Assignee" }, { key: "sprint", label: "Sprint" },
  { key: "points", label: "Pts", sort: "points" }, { key: "due", label: "Due", sort: "due" }, { key: "updated", label: "Updated", sort: "updated" },
];

export default function IssuesPage() {
  const { key } = useParams();
  const { data: project } = useProject(key);
  const [sp, setSp] = useSearchParams();
  const filter = useMemo(() => readFilter(sp), [sp]);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(!!filter.tql);
  const [tqlDraft, setTqlDraft] = useState(filter.tql ?? "");
  const [saving, setSaving] = useState(false);
  const [bulk, setBulk] = useState(false);
  const toast = useToast();
  const quickCreate = useQuickCreate();

  // On a project page every query (structured or TQL) is scoped server-side to that project.
  const effective: IssueFilter = project ? { ...filter, project_ids: [project.id] } : filter;
  const qs = filterToQuery(effective, { page, page_size: 50 });
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["issues", "list", qs],
    queryFn: () => api.get<Page<Issue>>(`/issues${qs}`),
    placeholderData: keepPreviousData,
    enabled: !key || !!project,
  });

  const update = (patch: Partial<IssueFilter>) => {
    setPage(1);
    setSelected(new Set());
    setSp(writeFilter({ ...filter, ...patch }), { replace: true });
  };
  const toggleSort = (s: string) => update({ sort: s, order: filter.sort === s && filter.order !== "desc" ? "desc" : "asc" });
  const items = data?.items ?? [];
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const exportCsv = () => download(`/issues/export.csv${filterToQuery(effective)}`, "issues.csv").catch((e) => toast.error(errorMessage(e)));

  return (
    <div className="p-4 md:p-6">
      <PageHeader title={project ? "Issues" : "All issues"} breadcrumb={project && <Link to={`/projects/${key}`} className="hover:underline">{project.name}</Link>}
        actions={<>
          <SavedFilters projectId={project?.id} current={filter} onApply={(q) => { setAdvanced(!!q.tql); setTqlDraft(q.tql ?? ""); setSp(writeFilter(q)); }} onSave={() => setSaving(true)} />
          <Button icon={<Download size={14} />} onClick={exportCsv}>Export CSV</Button>
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => quickCreate({ projectKey: key })}>Create</Button>
        </>} />

      <div className="mb-3 rounded-lg border bg-surface p-3">
        <div className="mb-2 flex items-center gap-2">
          <button onClick={() => setAdvanced(false)} className={clsx("flex items-center gap-1 rounded px-2 py-1 text-xs font-medium", !advanced ? "bg-primary-soft text-primary" : "text-muted")}>
            <SlidersHorizontal size={12} /> Basic</button>
          <button onClick={() => setAdvanced(true)} className={clsx("flex items-center gap-1 rounded px-2 py-1 text-xs font-medium", advanced ? "bg-primary-soft text-primary" : "text-muted")}>
            <Code2 size={12} /> TQL (advanced)</button>
          <span className="flex-1" />
          {(sp.toString() !== "") && <Button size="sm" variant="ghost" icon={<X size={12} />} onClick={() => { setTqlDraft(""); setSp(new URLSearchParams()); }}>Clear filters</Button>}
        </div>
        {advanced ? (
          <form onSubmit={(e) => { e.preventDefault(); update({ tql: tqlDraft.trim() || undefined }); }} className="space-y-1.5">
            <div className="flex gap-2">
              <Input value={tqlDraft} onChange={(e) => setTqlDraft(e.target.value)} className="font-mono text-xs" aria-label="TQL query"
                placeholder='assignee = currentUser() AND statusCategory != done ORDER BY priority DESC' />
              <Button type="submit" variant="primary">Search</Button>
            </div>
            <p className="text-xs text-subtle">
              Fields: project, type, status, statusCategory, priority, assignee, reporter, sprint, labels, epic, parent, key, summary ~, text ~, storyPoints, due, created, updated, resolved.
              Functions: currentUser(), activeSprint(), openSprints(), futureSprints(), now(), startOfDay(n), startOfWeek(n). Relative dates: -7d, 2w. Operators: = != &gt; &gt;= &lt; &lt;= IN, NOT IN, IS EMPTY, ~, AND/OR/NOT, ORDER BY.
            </p>
          </form>
        ) : (
          <BasicFilters filter={filter} projectKey={key} onChange={update} />
        )}
      </div>

      {selected.size > 0 && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-primary/40 bg-primary-soft px-3 py-1.5 text-sm">
          <strong>{selected.size}</strong> selected
          <Button size="sm" variant="primary" onClick={() => setBulk(true)}>Bulk change</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      {error ? <ErrorState error={error} onRetry={refetch} /> : isLoading ? <Spinner /> : items.length === 0 ? (
        <div className="rounded-lg border bg-surface"><EmptyState title="No issues match these filters" action={<Button onClick={() => quickCreate({ projectKey: key })}>Create issue</Button>} /></div>
      ) : (
        <div className={clsx("overflow-x-auto rounded-lg border bg-surface", isFetching && "opacity-70")}>
          <table className="w-full min-w-[960px] text-sm">
            <thead className="border-b bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th className="w-8 px-3 py-2"><input type="checkbox" aria-label="Select all" checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))} /></th>
                <th className="w-6" />
                {COLUMNS.map((c) => (
                  <th key={c.key} className="px-2 py-2 font-semibold">
                    {c.sort ? (
                      <button className="inline-flex items-center gap-1 hover:text-fg" onClick={() => toggleSort(c.sort!)}>
                        {c.label}{filter.sort === c.sort && (filter.order === "desc" ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
                      </button>
                    ) : c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((i) => (
                <tr key={i.id} className={clsx("cursor-pointer hover:bg-surface-2", selected.has(i.id) && "bg-primary-soft/50")} onClick={() => setOpenKey(i.key)}>
                  <td className="px-3" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`Select ${i.key}`} checked={selected.has(i.id)} onChange={() => {
                      const s = new Set(selected); if (s.has(i.id)) s.delete(i.id); else s.add(i.id); setSelected(s);
                    }} />
                  </td>
                  <td><IssueTypeIcon type={i.issue_type} size={14} /></td>
                  <td className="whitespace-nowrap px-2 py-2 text-xs font-medium text-muted">{i.key}</td>
                  <td className="max-w-md px-2">
                    <span className="line-clamp-1">{i.summary}</span>
                    {i.parent_key && <span className="text-xs text-subtle">↳ {i.parent_key} {i.parent_summary}</span>}
                  </td>
                  <td className="px-2"><StatusBadge status={i.status} /></td>
                  <td className="px-2"><PriorityIcon priority={i.priority} size={14} /></td>
                  <td className="px-2"><span className="flex items-center gap-1.5"><Avatar user={i.assignee} size={20} /><span className="truncate">{i.assignee?.full_name ?? ""}</span></span></td>
                  <td className="px-2 text-xs text-muted">{i.sprint_name ?? ""}</td>
                  <td className="px-2"><Points value={i.story_points} /></td>
                  <td className="px-2"><DueDate due={i.due_date} category={i.status.category} /></td>
                  <td className="whitespace-nowrap px-2 text-xs text-muted">{fmtDate(i.updated_at, "d MMM")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted">
            <span>{(page - 1) * 50 + 1}–{Math.min(page * 50, data!.total)} of {data!.total}</span>
            <div className="flex gap-1">
              <Button size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <Button size="sm" disabled={page * 50 >= data!.total} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </div>
      )}

      {openKey && (
        <Modal open onClose={() => setOpenKey(null)} title={openKey} width="max-w-5xl">
          <div className="-mx-5 -my-4"><IssueView issueKey={openKey} onClose={() => setOpenKey(null)} /></div>
        </Modal>
      )}
      {saving && <SaveFilterDialog projectId={project?.id} query={filter} onClose={() => setSaving(false)} />}
      {bulk && <BulkDialog issues={items.filter((i) => selected.has(i.id))} projectKey={key} onClose={(done) => { setBulk(false); if (done) setSelected(new Set()); }} />}
    </div>
  );
}

function MultiSelect<T extends string | number>({ label, options, value, onChange }: { label: string; options: { value: T; label: string }[]; value: T[]; onChange: (v: T[]) => void }) {
  return (
    <Menu align="left" width="w-56" trigger={() => (
      <Button size="sm" variant={value.length ? "subtle" : "secondary"} className={clsx(value.length && "border border-primary/50 text-primary")}>
        {label}{value.length ? `: ${value.length}` : ""} ▾
      </Button>
    )}>
      {() => (
        <div className="max-h-72 overflow-y-auto">
          {options.map((o) => (
            <label key={String(o.value)} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface-2">
              <input type="checkbox" checked={value.includes(o.value)} onChange={() => onChange(value.includes(o.value) ? value.filter((x) => x !== o.value) : [...value, o.value])} />
              {o.label}
            </label>
          ))}
          {options.length === 0 && <p className="px-2 py-1 text-xs text-subtle">No options</p>}
        </div>
      )}
    </Menu>
  );
}

function BasicFilters({ filter, projectKey, onChange }: { filter: IssueFilter; projectKey?: string; onChange: (p: Partial<IssueFilter>) => void }) {
  const { data: projects = [] } = useProjects();
  const { data: project } = useProject(projectKey);
  const { data: members = [] } = useMembers(projectKey);
  const { data: users = [] } = useUsers();
  const { data: sprints = [] } = useSprints(projectKey);
  const { data: labels = [] } = useLabels(projectKey);
  const [text, setText] = useState(filter.text ?? "");
  const people = projectKey ? members.map((m) => m.user) : users;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <form onSubmit={(e) => { e.preventDefault(); onChange({ text: text || undefined }); }}>
        <Input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== (filter.text ?? "") && onChange({ text: text || undefined })}
          placeholder="Search text or key" className="w-52" aria-label="Search text" />
      </form>
      {!projectKey && <MultiSelect label="Project" value={filter.project_ids ?? []} onChange={(v) => onChange({ project_ids: v })}
        options={projects.map((p) => ({ value: p.id, label: `${p.name} (${p.key})` }))} />}
      <MultiSelect label="Type" value={filter.issue_types ?? []} onChange={(v) => onChange({ issue_types: v })} options={ISSUE_TYPES.map((t) => ({ value: t.value, label: t.label }))} />
      {project ? (
        <MultiSelect label="Status" value={filter.status_ids ?? []} onChange={(v) => onChange({ status_ids: v })} options={project.statuses.map((s) => ({ value: s.id, label: s.name }))} />
      ) : (
        <MultiSelect label="Status" value={filter.status_categories ?? []} onChange={(v) => onChange({ status_categories: v })}
          options={(["todo", "in_progress", "done"] as const).map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))} />
      )}
      <MultiSelect label="Priority" value={filter.priorities ?? []} onChange={(v) => onChange({ priorities: v })} options={PRIORITIES.map((p) => ({ value: p.value, label: p.label }))} />
      <MultiSelect label="Assignee" value={(filter.assignee_ids ?? []) as (number | string)[]} onChange={(v) => onChange({ assignee_ids: v as IssueFilter["assignee_ids"] })}
        options={[{ value: "me", label: "Me" }, { value: "none", label: "Unassigned" }, ...people.map((u) => ({ value: u.id, label: u.full_name }))]} />
      {projectKey && project?.board_type === "scrum" && (
        <MultiSelect label="Sprint" value={(filter.sprint_ids ?? []) as (number | string)[]} onChange={(v) => onChange({ sprint_ids: v as IssueFilter["sprint_ids"] })}
          options={[{ value: "active", label: "Active sprint" }, { value: "none", label: "Backlog (no sprint)" }, ...sprints.map((s) => ({ value: s.id, label: s.name }))]} />
      )}
      {projectKey && labels.length > 0 && <MultiSelect label="Labels" value={filter.labels ?? []} onChange={(v) => onChange({ labels: v })} options={labels.map((l) => ({ value: l, label: l }))} />}
      <Select value={filter.resolved === true ? "true" : filter.resolved === false ? "false" : ""} className="w-36" aria-label="Resolution"
        onChange={(e) => onChange({ resolved: e.target.value === "" ? undefined : e.target.value === "true" })}>
        <option value="">Any resolution</option><option value="false">Unresolved</option><option value="true">Resolved</option>
      </Select>
      <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={!!filter.overdue} onChange={(e) => onChange({ overdue: e.target.checked || undefined })} /> Overdue</label>
      <label className="flex items-center gap-1.5 text-xs text-muted">Due
        <Input type="date" value={filter.due_from ?? ""} onChange={(e) => onChange({ due_from: e.target.value || undefined })} className="w-36" aria-label="Due from" /> –
        <Input type="date" value={filter.due_to ?? ""} onChange={(e) => onChange({ due_to: e.target.value || undefined })} className="w-36" aria-label="Due to" />
      </label>
    </div>
  );
}

function SavedFilters({ projectId, onApply, onSave, current }: { projectId?: number; current: IssueFilter; onApply: (q: IssueFilter) => void; onSave: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data = [] } = useQuery({ queryKey: ["filters", projectId], queryFn: () => api.get<SavedFilter[]>(`/filters${projectId ? `?project_id=${projectId}` : ""}`) });
  const del = useMutation({ mutationFn: (id: number) => api.del(`/filters/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["filters"] }), onError: (e) => toast.error(errorMessage(e)) });
  return (
    <Menu width="w-72" trigger={() => <Button icon={<Bookmark size={14} />}>Filters ▾</Button>}>
      {(close) => (
        <div>
          <MenuItem icon={<Save size={14} />} onClick={() => { close(); onSave(); }}>{Object.keys(current).length ? "Save current filter…" : "Save filter… (set some filters first)"}</MenuItem>
          <div className="my-1 border-t" />
          {data.length === 0 && <p className="px-2 py-2 text-xs text-subtle">No saved filters.</p>}
          {data.map((f) => (
            <div key={f.id} className="group flex items-center rounded hover:bg-surface-2">
              <button className="flex-1 truncate px-2 py-1.5 text-left text-sm" onClick={() => { onApply(f.query); close(); }}>
                {f.name} {f.is_shared && <span className="text-xs text-subtle">· shared by {f.owner.full_name}</span>}
              </button>
              <button className="px-2 text-subtle opacity-0 hover:text-danger group-hover:opacity-100" aria-label={`Delete filter ${f.name}`} onClick={() => del.mutate(f.id)}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </Menu>
  );
}

function SaveFilterDialog({ projectId, query, onClose }: { projectId?: number; query: IssueFilter; onClose: () => void }) {
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => api.post("/filters", { name, query, project_id: projectId ?? null, is_shared: shared }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["filters"] }); toast.success("Filter saved"); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title="Save filter"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim()} loading={m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Name" required><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with everyone who can access {projectId ? "this project" : "these issues"}</label>
        <pre className="max-h-32 overflow-auto rounded bg-surface-2 p-2 text-xs">{JSON.stringify(query, null, 1)}</pre>
        {m.isError && <p className="text-sm text-danger">{errorMessage(m.error)}</p>}
      </div>
    </Modal>
  );
}

function BulkDialog({ issues, projectKey, onClose }: { issues: Issue[]; projectKey?: string; onClose: (done: boolean) => void }) {
  const singleProject = new Set(issues.map((i) => i.project_id)).size === 1;
  const key = projectKey ?? (singleProject ? issues[0]?.project_key ?? undefined : undefined);
  const { data: project } = useProject(key);
  const { data: members = [] } = useMembers(key);
  const { data: sprints = [] } = useSprints(key, "future,active");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [assignee, setAssignee] = useState("__keep");
  const [sprint, setSprint] = useState("__keep");
  const invalidate = useInvalidateIssues();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => api.post<{ updated: number; results: { key?: string; ok: boolean; error?: string }[] }>("/issues/bulk", {
      issue_ids: issues.map((i) => i.id),
      status_id: status ? Number(status) : null,
      priority: priority || null,
      set_assignee: assignee !== "__keep", assignee_id: assignee === "__keep" || assignee === "" ? null : Number(assignee),
      set_sprint: sprint !== "__keep", sprint_id: sprint === "__keep" || sprint === "" ? null : Number(sprint),
    }),
    onSuccess: (r) => {
      invalidate();
      const failed = r.results.filter((x) => !x.ok);
      if (failed.length) toast.error(`${r.updated} updated, ${failed.length} failed: ${failed.slice(0, 3).map((f) => `${f.key}: ${f.error}`).join("; ")}`);
      else toast.success(`${r.updated} issues updated`);
      onClose(true);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Modal open onClose={() => onClose(false)} title={`Bulk change ${issues.length} issues`}
      footer={<><Button variant="ghost" onClick={() => onClose(false)}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Apply</Button></>}>
      <div className="space-y-3">
        {!singleProject && <p className="text-sm text-warning">Issues span several projects: only priority can be changed.</p>}
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value)}><option value="">Keep</option>{PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>
        </Field>
        {singleProject && project && (<>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Keep</option>{project.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          </Field>
          <Field label="Assignee">
            <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="__keep">Keep</option><option value="">Unassigned</option>
              {members.filter((x) => x.role !== "viewer").map((x) => <option key={x.user.id} value={x.user.id}>{x.user.full_name}</option>)}
            </Select>
          </Field>
          {project.board_type === "scrum" && (
            <Field label="Sprint">
              <Select value={sprint} onChange={(e) => setSprint(e.target.value)}>
                <option value="__keep">Keep</option><option value="">Backlog</option>
                {sprints.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
          )}
        </>)}
      </div>
    </Modal>
  );
}
