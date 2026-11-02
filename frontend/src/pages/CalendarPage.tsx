import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { addDays, addMonths, endOfMonth, endOfWeek, format, isSameMonth, isToday, startOfMonth, startOfWeek } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { IssueView } from "../components/IssueView";
import { useQuickCreate } from "../components/Layout";
import { IssueTypeIcon } from "../components/issue-bits";
import { Button, ErrorState, Modal, PageHeader, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { useProject } from "../lib/queries";
import type { Issue, Page } from "../lib/types";

const iso = (d: Date) => format(d, "yyyy-MM-dd");

export default function CalendarPage() {
  const { key } = useParams();
  const { data: project } = useProject(key);
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [openKey, setOpenKey] = useState<string | null>(null);
  const quickCreate = useQuickCreate();
  const gridStart = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const gridEnd = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
  const { data, isLoading, error } = useQuery({
    queryKey: ["issues", "calendar", project?.id, iso(gridStart)],
    queryFn: () => api.get<Page<Issue>>(`/issues?project_ids=${project!.id}&due_from=${iso(gridStart)}&due_to=${iso(gridEnd)}&page_size=500&sort=priority`),
    enabled: !!project,
  });
  if (!project) return <Spinner />;
  const days: Date[] = [];
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) days.push(d);
  const byDay = new Map<string, Issue[]>();
  data?.items.forEach((i) => i.due_date && byDay.set(i.due_date, [...(byDay.get(i.due_date) ?? []), i]));
  const canCreate = project.permissions.includes("create_issue");

  return (
    <div className="p-4 md:p-6">
      <PageHeader title="Calendar" breadcrumb={<Link to={`/projects/${key}`} className="hover:underline">{project.name}</Link>} subtitle="Issues by due date"
        actions={<div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setMonth((m) => addMonths(m, -1))} aria-label="Previous month"><ChevronLeft size={16} /></Button>
          <span className="w-36 text-center font-semibold">{format(month, "MMMM yyyy")}</span>
          <Button size="sm" variant="ghost" onClick={() => setMonth((m) => addMonths(m, 1))} aria-label="Next month"><ChevronRight size={16} /></Button>
          <Button size="sm" onClick={() => setMonth(startOfMonth(new Date()))}>Today</Button>
        </div>} />
      {error && <ErrorState error={error} />}
      {isLoading ? <Spinner /> : (
        <div className="overflow-x-auto">
          <div className="grid min-w-[760px] grid-cols-7 overflow-hidden rounded-lg border bg-line gap-px">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="bg-surface-2 px-2 py-1.5 text-xs font-semibold text-muted">{d}</div>)}
            {days.map((d) => {
              const items = byDay.get(iso(d)) ?? [];
              return (
                <div key={iso(d)} className={clsx("group min-h-28 bg-surface p-1.5", !isSameMonth(d, month) && "bg-surface-2/60")}>
                  <div className="mb-1 flex items-center justify-between">
                    <span className={clsx("flex h-6 w-6 items-center justify-center rounded-full text-xs", isToday(d) ? "bg-primary font-semibold text-white" : "text-muted")}>{format(d, "d")}</span>
                    {canCreate && <button className="text-xs text-primary opacity-0 group-hover:opacity-100" onClick={() => quickCreate({ projectKey: key, due_date: iso(d) })}>+ Add</button>}
                  </div>
                  <div className="space-y-1">
                    {items.slice(0, 4).map((i) => (
                      <button key={i.id} onClick={() => setOpenKey(i.key)} title={`${i.key} ${i.summary}`}
                        className={clsx("flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-surface-3",
                          i.status.category === "done" ? "text-muted line-through" : d < new Date(new Date().toDateString()) ? "bg-danger/10 text-danger" : "bg-surface-2")}>
                        <IssueTypeIcon type={i.issue_type} size={12} /><span className="truncate">{i.summary}</span>
                      </button>
                    ))}
                    {items.length > 4 && <Link to={`/projects/${key}/issues?due_from=${iso(d)}&due_to=${iso(d)}`} className="block px-1 text-xs text-primary">+{items.length - 4} more</Link>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {openKey && <Modal open onClose={() => setOpenKey(null)} title={openKey} width="max-w-5xl"><div className="-mx-5 -my-4"><IssueView issueKey={openKey} onClose={() => setOpenKey(null)} /></div></Modal>}
    </div>
  );
}
