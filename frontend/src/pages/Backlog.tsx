import { closestCenter, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, Search } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { IssueView } from "../components/IssueView";
import { CompleteSprintDialog, SprintFormDialog } from "../components/SprintDialogs";
import { DueDate, IssueTypeIcon, Points, PriorityIcon, StatusBadge } from "../components/issue-bits";
import { useToast } from "../components/toast";
import { Avatar, Badge, Button, ConfirmDialog, ErrorState, Input, Menu, MenuItem, Modal, PageHeader, ProgressBar, Spinner } from "../components/ui";
import { api, errorMessage, filterToQuery } from "../lib/api";
import { fmtDate } from "../lib/format";
import { can, useInvalidateIssues, useProject } from "../lib/queries";
import type { Issue, ProjectDetail, Sprint } from "../lib/types";

type SprintBlock = Sprint & { issues: Issue[] };
interface BacklogData { sprints: SprintBlock[]; backlog: Issue[]; epics: Issue[] }

const BACKLOG = "backlog";

export default function Backlog() {
  const { key } = useParams();
  const { data: project, error: pErr } = useProject(key);
  const [text, setText] = useState("");
  const [epic, setEpic] = useState<number | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const qs = filterToQuery({ text: text || undefined, epic_id: epic ?? undefined });
  const queryKey = ["backlog", key, qs];
  const { data, isLoading, error, refetch } = useQuery({ queryKey, queryFn: () => api.get<BacklogData>(`/projects/${key}/backlog${qs}`), enabled: !!project });
  const [dialog, setDialog] = useState<{ mode: "create" | "edit" | "start"; sprint?: SprintBlock } | null>(null);
  const [completing, setCompleting] = useState<SprintBlock | null>(null);
  const [deleting, setDeleting] = useState<SprintBlock | null>(null);
  const invalidate = useInvalidateIssues();
  const toast = useToast();
  const del = useMutation({
    mutationFn: (s: SprintBlock) => api.del(`/sprints/${s.id}`),
    onSuccess: () => { invalidate(); setDeleting(null); toast.success("Sprint deleted; its issues moved to the backlog"); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (pErr) return <ErrorState error={pErr} />;
  if (!project || isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const d = data!;
  const hasActive = d.sprints.some((s) => s.state === "active");
  const manage = can(project, "manage_sprints");

  return (
    <div className="flex h-full flex-col p-4 md:p-6">
      <PageHeader title="Backlog" breadcrumb={<Link to={`/projects/${key}`} className="hover:underline">{project.name}</Link>}
        actions={manage && <Button icon={<Plus size={14} />} onClick={() => setDialog({ mode: "create" })}>Create sprint</Button>} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-subtle" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search backlog" className="w-56 pl-7" aria-label="Search backlog" />
        </div>
        {epic && <Button size="sm" variant="subtle" onClick={() => setEpic(null)}>Epic filter ✕</Button>}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <EpicPanel epics={d.epics} selected={epic} onSelect={setEpic} projectKey={key!} />
        <BacklogLists project={project} data={d} queryKey={queryKey} onOpen={setOpenKey}
          sprintActions={(s) => (
            <div className="flex items-center gap-1">
              {s.state === "future" && manage && !hasActive && d.sprints.find((x) => x.state === "future")?.id === s.id && (
                <Button size="sm" disabled={s.issues.length === 0} title={s.issues.length === 0 ? "Add issues first" : undefined} onClick={() => setDialog({ mode: "start", sprint: s })}>Start sprint</Button>
              )}
              {s.state === "active" && manage && <Button size="sm" onClick={() => setCompleting(s)}>Complete sprint</Button>}
              {manage && (
                <Menu width="w-40" trigger={() => <Button size="sm" variant="ghost" aria-label="Sprint actions"><MoreHorizontal size={14} /></Button>}>
                  {(close) => (<>
                    <MenuItem onClick={() => { close(); setDialog({ mode: "edit", sprint: s }); }}>Edit sprint</MenuItem>
                    {s.state === "future" && <MenuItem danger onClick={() => { close(); setDeleting(s); }}>Delete sprint</MenuItem>}
                  </>)}
                </Menu>
              )}
            </div>
          )} />
      </div>
      {dialog && <SprintFormDialog projectKey={key!} mode={dialog.mode} sprint={dialog.sprint ? { ...dialog.sprint, issue_count: dialog.sprint.issues.length } : undefined} onClose={() => setDialog(null)} />}
      {completing && <CompleteSprintDialog projectKey={key!} sprint={completing} onClose={() => setCompleting(null)} />}
      <ConfirmDialog open={!!deleting} danger title={`Delete ${deleting?.name}?`} confirmLabel="Delete sprint" loading={del.isPending}
        message="The sprint is removed and its issues return to the backlog. Issues are not deleted." onClose={() => setDeleting(null)} onConfirm={() => deleting && del.mutate(deleting)} />
      {openKey && (
        <Modal open onClose={() => setOpenKey(null)} title={openKey} width="max-w-5xl">
          <div className="-mx-5 -my-4"><IssueView issueKey={openKey} onClose={() => setOpenKey(null)} /></div>
        </Modal>
      )}
    </div>
  );
}

function EpicPanel({ epics, selected, onSelect, projectKey }: { epics: Issue[]; selected: number | null; onSelect: (id: number | null) => void; projectKey: string }) {
  return (
    <aside className="hidden overflow-y-auto rounded-lg border bg-surface p-2 lg:block">
      <p className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted">Epics</p>
      <button onClick={() => onSelect(null)} className={clsx("w-full rounded px-2 py-1.5 text-left text-sm", selected === null ? "bg-primary-soft text-primary" : "hover:bg-surface-2")}>All issues</button>
      {epics.map((e) => (
        <button key={e.id} onClick={() => onSelect(e.id)} className={clsx("mt-1 w-full rounded px-2 py-1.5 text-left", selected === e.id ? "bg-primary-soft" : "hover:bg-surface-2")}>
          <span className="flex items-center gap-1.5 text-sm"><IssueTypeIcon type="epic" size={14} /><span className="truncate">{e.summary}</span></span>
          <ProgressBar value={e.child_done_count} total={e.child_count} className="mt-1.5" />
          <span className="text-[11px] text-subtle">{e.child_done_count}/{e.child_count} done</span>
        </button>
      ))}
      {epics.length === 0 && <p className="px-2 py-2 text-xs text-subtle">No epics. Create one from <Link className="text-primary" to={`/projects/${projectKey}/issues`}>Issues</Link>.</p>}
    </aside>
  );
}

function BacklogLists({ project, data, queryKey, onOpen, sprintActions }: {
  project: ProjectDetail; data: BacklogData; queryKey: unknown[]; onOpen: (k: string) => void; sprintActions: (s: SprintBlock) => React.ReactNode;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const invalidate = useInvalidateIssues();
  const [activeId, setActiveId] = useState<number | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const canPlan = can(project, "rank_backlog") || can(project, "manage_sprints");

  const lists: Record<string, Issue[]> = { [BACKLOG]: data.backlog };
  data.sprints.forEach((s) => (lists[`s${s.id}`] = s.issues));
  const listOf = (id: number) => Object.keys(lists).find((k) => lists[k].some((i) => i.id === id));

  const move = useMutation({
    mutationFn: (v: { issue: Issue; sprintId: number | null; aboveId: number | null; belowId: number | null }) =>
      api.post(`/issues/${v.issue.key}/move`, { sprint_id: v.sprintId, move_sprint: true, above_id: v.aboveId, below_id: v.belowId }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<BacklogData>(queryKey);
      if (prev) {
        const strip = (l: Issue[]) => l.filter((i) => i.id !== v.issue.id);
        const insert = (l: Issue[]) => {
          const out = strip(l);
          const idx = v.belowId ? out.findIndex((i) => i.id === v.belowId) : v.aboveId ? out.findIndex((i) => i.id === v.aboveId) + 1 : out.length;
          out.splice(idx < 0 ? out.length : idx, 0, { ...v.issue, sprint_id: v.sprintId });
          return out;
        };
        qc.setQueryData<BacklogData>(queryKey, {
          ...prev,
          backlog: v.sprintId === null ? insert(prev.backlog) : strip(prev.backlog),
          sprints: prev.sprints.map((s) => ({ ...s, issues: s.id === v.sprintId ? insert(s.issues) : strip(s.issues) })),
        });
      }
      return { prev };
    },
    onError: (e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev); toast.error(errorMessage(e)); },
    onSettled: (_d, _e, v) => invalidate(v.issue.key),
  });

  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    if (!e.over) return;
    const id = Number(e.active.id);
    const issue = Object.values(lists).flat().find((i) => i.id === id);
    if (!issue) return;
    const overId = String(e.over.id);
    const targetList = overId.startsWith("list:") ? overId.slice(5) : listOf(Number(overId));
    if (!targetList) return;
    const items = lists[targetList].filter((i) => i.id !== id);
    let index = items.length;
    if (!overId.startsWith("list:")) {
      const overIdx = items.findIndex((i) => i.id === Number(overId));
      const sameList = listOf(id) === targetList;
      const fromIdx = lists[targetList].findIndex((i) => i.id === id);
      const toIdx = lists[targetList].findIndex((i) => i.id === Number(overId));
      index = sameList && fromIdx < toIdx ? overIdx + 1 : overIdx;
    }
    const sprintId = targetList === BACKLOG ? null : Number(targetList.slice(1));
    const aboveId = items[index - 1]?.id ?? null;
    const belowId = items[index]?.id ?? null;
    if (listOf(id) === targetList) {
      const cur = lists[targetList];
      const ci = cur.findIndex((i) => i.id === id);
      if ((cur[ci - 1]?.id ?? null) === aboveId && (cur[ci + 1]?.id ?? null) === belowId) return;
    }
    move.mutate({ issue, sprintId, aboveId, belowId });
  };

  const active = activeId ? Object.values(lists).flat().find((i) => i.id === activeId) : null;
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(e) => setActiveId(Number(e.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
      <div className="min-h-0 space-y-4 overflow-y-auto pb-8 scroll-thin">
        {data.sprints.map((s) => (
          <IssueList key={s.id} id={`s${s.id}`} issues={s.issues} canPlan={canPlan} onOpen={onOpen}
            header={<>
              <span className="font-semibold">{s.name}</span>
              {s.state === "active" && <Badge tone="blue">Active</Badge>}
              <span className="text-xs text-muted">{s.start_date ? `${fmtDate(s.start_date)} – ${fmtDate(s.end_date)}` : "Not scheduled"} · {s.issues.length} issues</span>
              {s.goal && <span className="hidden truncate text-xs text-subtle md:inline">· {s.goal}</span>}
              <span className="flex-1" />
              <PointsSummary issues={s.issues} />
              {sprintActions(s)}
            </>} />
        ))}
        <IssueList id={BACKLOG} issues={data.backlog} canPlan={canPlan} onOpen={onOpen} project={project}
          header={<><span className="font-semibold">Backlog</span><span className="text-xs text-muted">{data.backlog.length} issues</span><span className="flex-1" /><PointsSummary issues={data.backlog} /></>} />
      </div>
      <DragOverlay>{active && <div className="rounded-md border bg-surface shadow-xl"><Row issue={active} /></div>}</DragOverlay>
    </DndContext>
  );
}

function PointsSummary({ issues }: { issues: Issue[] }) {
  const sum = (cat: string | null) => issues.filter((i) => cat === null || i.status.category === cat).reduce((s, i) => s + (i.story_points ?? 0), 0);
  return (
    <span className="flex gap-1 text-[11px] font-semibold" title="Story points: to do / in progress / done">
      <span className="rounded-full bg-surface-3 px-1.5">{sum("todo")}</span>
      <span className="rounded-full bg-primary-soft px-1.5 text-primary">{sum("in_progress")}</span>
      <span className="rounded-full bg-success/15 px-1.5 text-success">{sum("done")}</span>
    </span>
  );
}

function IssueList({ id, issues, header, canPlan, onOpen, project }: { id: string; issues: Issue[]; header: React.ReactNode; canPlan: boolean; onOpen: (k: string) => void; project?: ProjectDetail }) {
  const [collapsed, setCollapsed] = useState(false);
  const { setNodeRef, isOver } = useDroppable({ id: `list:${id}` });
  return (
    <section className="rounded-lg border bg-surface">
      <header className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? "Expand" : "Collapse"} className="text-muted">
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
        {header}
      </header>
      {!collapsed && (
        <div ref={setNodeRef} className={clsx("min-h-10 border-t", isOver && "bg-primary-soft/50")}>
          <SortableContext items={issues.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            {issues.map((i) => <SortableRow key={i.id} issue={i} disabled={!canPlan} onOpen={onOpen} />)}
          </SortableContext>
          {issues.length === 0 && <p className="px-4 py-3 text-center text-xs text-subtle">{id === BACKLOG ? "Your backlog is empty." : "Drag issues here to plan this sprint."}</p>}
          {project && can(project, "create_issue") && <QuickCreate project={project} />}
        </div>
      )}
    </section>
  );
}

function QuickCreate({ project }: { project: ProjectDetail }) {
  const [summary, setSummary] = useState("");
  const [open, setOpen] = useState(false);
  const invalidate = useInvalidateIssues();
  const toast = useToast();
  const create = useMutation({
    mutationFn: () => api.post<Issue>("/issues", { project_id: project.id, summary: summary.trim(), issue_type: "story" }),
    onSuccess: (i) => { setSummary(""); invalidate(); toast.success(`Created ${i.key}`); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!open) return <button onClick={() => setOpen(true)} className="flex w-full items-center gap-1.5 border-t px-4 py-2 text-left text-sm text-muted hover:bg-surface-2"><Plus size={14} /> Create issue</button>;
  return (
    <form className="flex gap-2 border-t p-2" onSubmit={(e) => { e.preventDefault(); if (summary.trim()) create.mutate(); }}>
      <Input autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What needs to be done? (Enter to create story)" aria-label="New issue summary"
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)} />
      <Button type="submit" variant="primary" loading={create.isPending} disabled={!summary.trim()}>Create</Button>
    </form>
  );
}

function SortableRow({ issue, disabled, onOpen }: { issue: Issue; disabled: boolean; onOpen: (k: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: issue.id, disabled });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} {...attributes} {...listeners}
      className={clsx("border-b last:border-b-0", isDragging && "opacity-40")} onClick={() => onOpen(issue.key)}>
      <Row issue={issue} />
    </div>
  );
}

function Row({ issue }: { issue: Issue }) {
  return (
    <div className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-surface-2">
      <IssueTypeIcon type={issue.issue_type} size={14} />
      <span className="w-16 shrink-0 text-xs font-medium text-muted">{issue.key}</span>
      <span className={clsx("min-w-0 flex-1 truncate text-sm", issue.status.category === "done" && "text-muted line-through")}>{issue.summary}</span>
      {issue.parent_summary && <span className="hidden max-w-36 truncate rounded bg-[#7c3aed]/12 px-1.5 text-[11px] text-[#7c3aed] dark:text-[#b794f6] md:inline">{issue.parent_summary}</span>}
      <DueDate due={issue.due_date} category={issue.status.category} />
      <StatusBadge status={issue.status} />
      <Points value={issue.story_points} />
      <PriorityIcon priority={issue.priority} size={14} />
      <Avatar user={issue.assignee} size={20} />
    </div>
  );
}
