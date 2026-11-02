import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { addWeeks, differenceInCalendarDays, format, parseISO, startOfWeek } from "date-fns";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { IssueTypeIcon } from "../components/issue-bits";
import { Button, EmptyState, ErrorState, PageHeader, Select, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { CATEGORY_COLOR } from "../lib/format";
import { useProject, useSprints } from "../lib/queries";
import type { Issue, Page } from "../lib/types";

const DAY_PX = { week: 28, month: 10, quarter: 4 } as const;

type SprintDates = Map<number, [Date, Date]>;

/** Bar span: the issue's own start/due dates; otherwise its sprint's window (flagged `fromSprint`). */
function span(i: Issue, sprints: SprintDates): { range: [Date, Date]; fromSprint: boolean } | null {
  const end = i.due_date ? parseISO(i.due_date) : null;
  const start = i.start_date ? parseISO(i.start_date) : end ? (parseISO(i.created_at) < end ? parseISO(i.created_at) : end) : null;
  if (start) return { range: [start, end ?? start], fromSprint: false };
  const sprint = i.sprint_id ? sprints.get(i.sprint_id) : undefined;
  return sprint ? { range: sprint, fromSprint: true } : null;
}

export default function Timeline() {
  const { key } = useParams();
  const { data: project } = useProject(key);
  const [zoom, setZoom] = useState<keyof typeof DAY_PX>("month");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const { data: sprintList = [] } = useSprints(key);
  const { data, isLoading, error } = useQuery({
    queryKey: ["issues", "timeline", project?.id],
    queryFn: () => api.get<Page<Issue>>(`/issues?project_ids=${project!.id}&issue_types=epic&issue_types=story&issue_types=task&issue_types=bug&issue_types=improvement&page_size=500&sort=rank`),
    enabled: !!project,
  });
  if (!project || isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} />;
  const all = data!.items;
  const epics = all.filter((i) => i.issue_type === "epic");
  const children = (id: number) => all.filter((i) => i.parent_id === id);
  const sprints: SprintDates = new Map(sprintList.filter((s) => s.start_date && s.end_date).map((s) => [s.id, [parseISO(s.start_date!), parseISO(s.end_date!)]]));
  const orphans = all.filter((i) => i.issue_type !== "epic" && !i.parent_id && span(i, sprints));
  const spans = all.map((i) => span(i, sprints)?.range).filter(Boolean) as [Date, Date][];
  const px = DAY_PX[zoom];
  const today = new Date();
  const min = startOfWeek(addWeeks(spans.length ? new Date(Math.min(...spans.map((s) => +s[0]), +today)) : today, -1), { weekStartsOn: 1 });
  const maxDate = addWeeks(spans.length ? new Date(Math.max(...spans.map((s) => +s[1]), +today)) : addWeeks(today, 8), 2);
  const totalDays = differenceInCalendarDays(maxDate, min) + 1;
  const weeks: Date[] = [];
  for (let d = min; d <= maxDate; d = addWeeks(d, 1)) weeks.push(d);

  const Bar = ({ issue, epic }: { issue: Issue; epic?: boolean }) => {
    const sp = span(issue, sprints);
    if (!sp) return <span className="pl-2 text-xs text-subtle">Unscheduled — set dates or add to a sprint</span>;
    const s = sp.range;
    const left = differenceInCalendarDays(s[0], min) * px;
    const width = Math.max(px, (differenceInCalendarDays(s[1], s[0]) + 1) * px);
    const pct = issue.child_count ? issue.child_done_count / issue.child_count : issue.status.category === "done" ? 1 : 0;
    return (
      <Link to={`/issues/${issue.key}`} title={`${issue.key}: ${issue.summary} (${format(s[0], "d MMM")} – ${format(s[1], "d MMM")}${sp.fromSprint ? ", from sprint" : ""})`}
        className={clsx("absolute top-1.5 h-5 overflow-hidden rounded", epic ? "bg-[#7c3aed]/25" : "bg-surface-3", sp.fromSprint && "border border-dashed border-subtle/60 opacity-80")} style={{ left, width }}>
        <span className="absolute inset-y-0 left-0" style={{ width: `${pct * 100}%`, background: epic ? "#7c3aed" : CATEGORY_COLOR[issue.status.category], opacity: 0.8 }} />
        <span className="relative truncate px-1.5 text-[11px] font-medium leading-5">{issue.summary}</span>
      </Link>
    );
  };
  const Row = ({ issue, depth = 0, toggle }: { issue: Issue; depth?: number; toggle?: React.ReactNode }) => (
    <div className="flex border-b hover:bg-surface-2/60">
      <div className="sticky left-0 z-10 flex w-72 shrink-0 items-center gap-1.5 border-r bg-surface px-2 py-1.5" style={{ paddingLeft: 8 + depth * 18 }}>
        {toggle}
        <IssueTypeIcon type={issue.issue_type} size={14} />
        <Link to={`/issues/${issue.key}`} className="truncate text-sm hover:underline">{issue.summary}</Link>
      </div>
      <div className="relative h-8" style={{ width: totalDays * px }}><Bar issue={issue} epic={issue.issue_type === "epic"} /></div>
    </div>
  );

  return (
    <div className="p-4 md:p-6">
      <PageHeader title="Timeline" breadcrumb={<Link to={`/projects/${key}`} className="hover:underline">{project.name}</Link>}
        subtitle="Bars use start/due dates (dashed: sprint window when an issue has no dates). Fill shows completion."
        actions={<Select value={zoom} onChange={(e) => setZoom(e.target.value as keyof typeof DAY_PX)} className="w-32" aria-label="Zoom">
          <option value="week">Weeks</option><option value="month">Months</option><option value="quarter">Quarters</option></Select>} />
      {epics.length === 0 && orphans.length === 0 ? (
        <EmptyState title="Nothing scheduled yet">Create epics and give issues start and due dates to build a roadmap.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-surface scroll-thin">
          <div className="relative" style={{ width: 288 + totalDays * px }}>
            <div className="sticky top-0 z-20 flex border-b bg-surface-2 text-[11px] text-muted">
              <div className="sticky left-0 z-10 w-72 shrink-0 border-r bg-surface-2 px-2 py-1.5 font-semibold">Work</div>
              <div className="relative h-7" style={{ width: totalDays * px }}>
                {weeks.map((w) => (
                  <span key={+w} className="absolute top-0 h-full border-l pl-1 pt-1.5" style={{ left: differenceInCalendarDays(w, min) * px }}>
                    {zoom === "quarter" ? (w.getDate() <= 7 ? format(w, "MMM") : "") : format(w, zoom === "week" ? "d MMM" : "d MMM")}
                  </span>
                ))}
              </div>
            </div>
            <div className="pointer-events-none absolute bottom-0 top-7 z-0 w-px bg-danger" style={{ left: 288 + differenceInCalendarDays(today, min) * px + px / 2 }} title="Today" />
            {epics.map((e) => {
              const open = !collapsed.has(e.id);
              return (
                <div key={e.id}>
                  <Row issue={e} toggle={
                    <button aria-label={open ? "Collapse epic" : "Expand epic"} onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n; })}>
                      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>} />
                  {open && children(e.id).map((c) => <Row key={c.id} issue={c} depth={1} />)}
                </div>
              );
            })}
            {orphans.length > 0 && <div className="border-b bg-surface-2 px-2 py-1 text-xs font-semibold text-muted">Issues without an epic</div>}
            {orphans.map((i) => <Row key={i.id} issue={i} />)}
          </div>
        </div>
      )}
      <p className="mt-2 text-xs text-subtle"><Button size="sm" variant="ghost" onClick={() => setZoom("week")}>Zoom in</Button> Red line marks today.</p>
    </div>
  );
}
