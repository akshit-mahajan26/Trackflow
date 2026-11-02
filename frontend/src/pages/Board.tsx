import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { IssueView } from "../components/IssueView";
import { useQuickCreate } from "../components/Layout";
import { CompleteSprintDialog } from "../components/SprintDialogs";
import { IssueCardBody, IssueTypeIcon } from "../components/issue-bits";
import { useToast } from "../components/toast";
import { Avatar, Button, EmptyState, ErrorState, Input, Modal, PageHeader, Select, Spinner } from "../components/ui";
import { api, errorMessage, filterToQuery } from "../lib/api";
import { useMe } from "../lib/auth";
import { fmtDate, ISSUE_TYPES, PRIORITIES } from "../lib/format";
import { can, useInvalidateIssues, useMembers, useProject } from "../lib/queries";
import type { Issue, IssueType, ProjectDetail, Sprint, Status } from "../lib/types";

interface BoardData {
  board_type: "scrum" | "kanban";
  sprint: (Sprint & { issue_count: number; done_count: number; total_points: number; done_points: number }) | null;
  columns: Status[];
  issues: Issue[];
}

type Swimlane = "none" | "assignee" | "epic" | "priority";

/** Pure helper (unit-tested): where does `activeId` land, given what it was dropped on? */
export function resolveDrop(
  issues: Issue[],
  activeId: number,
  over: { type: "column"; statusId: number } | { type: "card"; issueId: number },
  sameLane: (i: Issue) => boolean = () => true,
): { statusId: number; aboveId: number | null; belowId: number | null } | null {
  const active = issues.find((i) => i.id === activeId);
  if (!active) return null;
  const statusId = over.type === "column" ? over.statusId : issues.find((i) => i.id === over.issueId)?.status.id;
  if (statusId === undefined) return null;
  const col = issues.filter((i) => i.status.id === statusId && i.id !== activeId && sameLane(i)).sort((a, b) => a.rank - b.rank);
  let index = col.length; // dropped on empty space → bottom
  if (over.type === "card") {
    const overIdx = col.findIndex((i) => i.id === over.issueId);
    if (overIdx >= 0) {
      // moving down within the same column lands *after* the hovered card, otherwise before it
      const movingDown = active.status.id === statusId && active.rank < col[overIdx].rank;
      index = movingDown ? overIdx + 1 : overIdx;
    }
  }
  return { statusId, aboveId: col[index - 1]?.id ?? null, belowId: col[index]?.id ?? null };
}

export default function Board() {
  const { key } = useParams();
  const { data: project, error: projectError } = useProject(key);
  const me = useMe();
  const [text, setText] = useState("");
  const [onlyMine, setOnlyMine] = useState(false);
  const [assignees, setAssignees] = useState<number[]>([]);
  const [type, setType] = useState<IssueType | "">("");
  const [priority, setPriority] = useState("");
  const [lanes, setLanes] = useState<Swimlane>("none");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const { data: members = [] } = useMembers(key);
  const quickCreate = useQuickCreate();

  const filter = {
    text: text || undefined,
    assignee_ids: onlyMine ? ["me" as const] : assignees,
    issue_types: type ? [type] : undefined,
    priorities: priority ? [priority as never] : undefined,
  };
  const qs = filterToQuery(filter);
  const queryKey = ["board", key, qs];
  const { data, isLoading, error, refetch } = useQuery({ queryKey, queryFn: () => api.get<BoardData>(`/projects/${key}/board${qs}`), enabled: !!project });

  if (projectError) return <ErrorState error={projectError} />;
  if (!project || isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const board = data!;

  const title = board.board_type === "scrum" ? board.sprint?.name ?? "Active sprint" : `${project.name} board`;
  return (
    <div className="flex h-full flex-col p-4 md:p-6">
      <PageHeader title={title} breadcrumb={<Link to={`/projects/${key}`} className="hover:underline">{project.name}</Link>}
        subtitle={board.sprint && (
          <span>{board.sprint.goal && <>Goal: {board.sprint.goal} · </>}{fmtDate(board.sprint.start_date)} – {fmtDate(board.sprint.end_date)} · {board.sprint.done_count}/{board.sprint.issue_count} done</span>
        )}
        actions={<>
          {board.sprint && can(project, "manage_sprints") && <Button onClick={() => setCompleting(true)}>Complete sprint</Button>}
          {can(project, "create_issue") && (board.board_type === "kanban" || board.sprint) && (
            <Button icon={<Plus size={14} />} onClick={() => quickCreate({ projectKey: key, sprint_id: board.sprint?.id ?? null })}>Issue</Button>
          )}
        </>} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-subtle" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter board" className="w-48 pl-7" aria-label="Filter board" />
        </div>
        <div className="flex -space-x-1" role="group" aria-label="Filter by assignee">
          {members.filter((m) => m.role !== "viewer").slice(0, 10).map((m) => (
            <button key={m.user.id} title={m.user.full_name} aria-pressed={assignees.includes(m.user.id)}
              onClick={() => setAssignees((a) => (a.includes(m.user.id) ? a.filter((x) => x !== m.user.id) : [...a, m.user.id]))}
              className={clsx("rounded-full ring-2", assignees.includes(m.user.id) ? "ring-primary" : "ring-surface")}>
              <Avatar user={m.user} size={28} />
            </button>
          ))}
        </div>
        <Button size="sm" variant={onlyMine ? "primary" : "secondary"} onClick={() => setOnlyMine((v) => !v)}>Only my issues</Button>
        <Select value={type} onChange={(e) => setType(e.target.value as IssueType | "")} className="w-36" aria-label="Type filter">
          <option value="">All types</option>
          {ISSUE_TYPES.filter((t) => t.value !== "epic").map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </Select>
        <Select value={priority} onChange={(e) => setPriority(e.target.value)} className="w-36" aria-label="Priority filter">
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </Select>
        <span className="flex-1" />
        <label className="flex items-center gap-2 text-xs text-muted">Swimlanes
          <Select value={lanes} onChange={(e) => setLanes(e.target.value as Swimlane)} className="w-32">
            <option value="none">None</option><option value="assignee">Assignee</option><option value="epic">Epic</option><option value="priority">Priority</option>
          </Select>
        </label>
        {(text || assignees.length || onlyMine || type || priority) ? (
          <Button size="sm" variant="ghost" onClick={() => { setText(""); setAssignees([]); setOnlyMine(false); setType(""); setPriority(""); }}>Clear</Button>
        ) : null}
      </div>

      {board.board_type === "scrum" && !board.sprint ? (
        <EmptyState title="No active sprint" action={<Link to={`/projects/${key}/backlog`}><Button variant="primary">Go to backlog</Button></Link>}>
          Plan a sprint in the backlog and start it to see it here.
        </EmptyState>
      ) : (
        <BoardColumns project={project} board={board} queryKey={queryKey} lanes={lanes} meId={me.id} onOpen={setOpenKey} />
      )}

      {openKey && (
        <Modal open onClose={() => setOpenKey(null)} title={openKey} width="max-w-5xl">
          <div className="-mx-5 -my-4"><IssueView issueKey={openKey} onClose={() => setOpenKey(null)} /></div>
        </Modal>
      )}
      {completing && board.sprint && <CompleteSprintDialog projectKey={key!} sprint={board.sprint} onClose={() => setCompleting(false)} />}
    </div>
  );
}

function laneOf(i: Issue, mode: Swimlane): string {
  if (mode === "assignee") return i.assignee ? `u${i.assignee.id}` : "u-";
  if (mode === "epic") return i.parent_key ? `e${i.parent_key}` : "e-";
  if (mode === "priority") return `p${i.priority}`;
  return "all";
}

function laneLabel(lane: string, sample: Issue | undefined): React.ReactNode {
  if (lane === "all") return null;
  if (lane === "u-") return "Unassigned";
  if (lane === "e-") return "No epic";
  if (lane.startsWith("u")) return <span className="flex items-center gap-2"><Avatar user={sample?.assignee} size={18} />{sample?.assignee?.full_name}</span>;
  if (lane.startsWith("e")) return <span className="flex items-center gap-2"><IssueTypeIcon type="epic" size={14} />{sample?.parent_summary ?? lane.slice(1)}</span>;
  return PRIORITIES.find((p) => `p${p.value}` === lane)?.label;
}

function BoardColumns({ project, board, queryKey, lanes, onOpen }: { project: ProjectDetail; board: BoardData; queryKey: unknown[]; lanes: Swimlane; meId: number; onOpen: (k: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const invalidate = useInvalidateIssues();
  const [activeId, setActiveId] = useState<number | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const canMove = can(project, "transition_issue") || can(project, "edit_own_issue");

  const move = useMutation({
    mutationFn: (v: { issue: Issue; statusId: number; aboveId: number | null; belowId: number | null }) =>
      api.post(`/issues/${v.issue.key}/move`, { status_id: v.statusId, above_id: v.aboveId, below_id: v.belowId }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<BoardData>(queryKey);
      if (prev) {
        // Optimistic: move the card now; server confirms or we roll back.
        const status = prev.columns.find((c) => c.id === v.statusId)!;
        const above = prev.issues.find((i) => i.id === v.aboveId);
        const below = prev.issues.find((i) => i.id === v.belowId);
        const rank = above && below ? (above.rank + below.rank) / 2 : above ? above.rank + 1 : below ? below.rank - 1 : v.issue.rank;
        qc.setQueryData<BoardData>(queryKey, { ...prev, issues: prev.issues.map((i) => (i.id === v.issue.id ? { ...i, status, rank } : i)) });
      }
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev);
      toast.error(errorMessage(e));
    },
    onSettled: (_d, _e, v) => invalidate(v.issue.key),
  });

  const laneKeys = useMemo(() => {
    const keys = Array.from(new Set(board.issues.map((i) => laneOf(i, lanes))));
    if (lanes === "priority") keys.sort((a, b) => PRIORITIES.findIndex((p) => `p${p.value}` === a) - PRIORITIES.findIndex((p) => `p${p.value}` === b));
    else keys.sort((a, b) => (a.endsWith("-") ? 1 : b.endsWith("-") ? -1 : a.localeCompare(b)));
    return keys.length ? keys : ["all"];
  }, [board.issues, lanes]);

  const onDragStart = (e: DragStartEvent) => setActiveId(Number(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    if (!e.over) return;
    const issue = board.issues.find((i) => i.id === Number(e.active.id));
    if (!issue) return;
    const overId = String(e.over.id);
    const over = overId.startsWith("col:")
      ? { type: "column" as const, statusId: Number(overId.split(":")[1]) }
      : { type: "card" as const, issueId: Number(overId) };
    const lane = laneOf(issue, lanes);
    const drop = resolveDrop(board.issues, issue.id, over, (i) => laneOf(i, lanes) === lane);
    if (!drop) return;
    if (drop.statusId === issue.status.id) {
      const col = board.issues.filter((i) => i.status.id === issue.status.id && laneOf(i, lanes) === lane).sort((a, b) => a.rank - b.rank);
      const idx = col.findIndex((i) => i.id === issue.id);
      if ((col[idx - 1]?.id ?? null) === drop.aboveId && (col[idx + 1]?.id ?? null) === drop.belowId) return; // dropped in place
    }
    move.mutate({ issue, ...drop });
  };

  const active = board.issues.find((i) => i.id === activeId);
  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
      <div className="min-h-0 flex-1 overflow-auto scroll-thin">
        <div className="sticky top-0 z-10 flex gap-3 bg-bg pb-2" style={{ minWidth: board.columns.length * 280 }}>
          {board.columns.map((col) => {
            const count = board.issues.filter((i) => i.status.id === col.id).length;
            const over = col.wip_limit !== null && count > col.wip_limit;
            return (
              <div key={col.id} className={clsx("flex w-[272px] shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs font-semibold uppercase tracking-wide",
                over ? "bg-danger/15 text-danger" : "bg-surface-3 text-muted")}>
                {col.name}
                <span className="font-normal normal-case">{count}{col.wip_limit !== null && ` / ${col.wip_limit} max`}</span>
                {over && <span className="ml-auto normal-case">WIP exceeded</span>}
              </div>
            );
          })}
        </div>
        {laneKeys.map((lane) => {
          const laneIssues = board.issues.filter((i) => laneOf(i, lanes) === lane);
          return (
            <div key={lane} className="mb-3">
              {lane !== "all" && <div className="mb-1.5 flex items-center gap-2 text-sm font-medium">{laneLabel(lane, laneIssues[0])}<span className="text-xs text-muted">{laneIssues.length}</span></div>}
              <div className="flex gap-3" style={{ minWidth: board.columns.length * 280 }}>
                {board.columns.map((col) => (
                  <Column key={col.id} status={col} lane={lane} issues={laneIssues.filter((i) => i.status.id === col.id).sort((a, b) => a.rank - b.rank)}
                    canMove={canMove} onOpen={onOpen} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <DragOverlay>{active && <div className="w-[264px] rotate-2 rounded-md border bg-surface p-2.5 shadow-xl"><IssueCardBody issue={active} /></div>}</DragOverlay>
    </DndContext>
  );
}

function Column({ status, lane, issues, canMove, onOpen }: { status: Status; lane: string; issues: Issue[]; canMove: boolean; onOpen: (k: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status.id}:${lane}` });
  return (
    <div ref={setNodeRef} data-testid={`column-${status.name}`}
      className={clsx("flex min-h-24 w-[272px] shrink-0 flex-col gap-2 rounded-md bg-surface-2 p-1.5 transition-colors", isOver && "bg-primary-soft")}>
      <SortableContext items={issues.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {issues.map((i) => <Card key={i.id} issue={i} disabled={!canMove} onOpen={onOpen} />)}
      </SortableContext>
      {issues.length === 0 && <p className="py-4 text-center text-xs text-subtle">Drop issues here</p>}
    </div>
  );
}

function Card({ issue, disabled, onOpen }: { issue: Issue; disabled: boolean; onOpen: (k: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: issue.id, disabled });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} {...attributes} {...listeners}
      onClick={() => onOpen(issue.key)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(issue.key); listeners?.onKeyDown?.(e); }}
      aria-label={`${issue.key} ${issue.summary}`}
      className={clsx("cursor-pointer rounded-md border bg-surface p-2.5 shadow-sm hover:border-primary/50", isDragging && "opacity-40",
        issue.status.category === "done" && "opacity-75")}>
      <IssueCardBody issue={issue} />
    </div>
  );
}
