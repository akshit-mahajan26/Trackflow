import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartCard, ChartTooltip, Legend, useAxisProps, useChartColors } from "../components/charts";
import { useToast } from "../components/toast";
import { Card, EmptyState, ErrorState, Input, PageHeader, ProgressBar, Select, Spinner, Stat, Tabs } from "../components/ui";
import { api, download, errorMessage } from "../lib/api";
import { fmtDate, fmtHours, priorityMeta, typeMeta } from "../lib/format";
import { useProject, useSprints } from "../lib/queries";

type Tab = "burndown" | "burnup" | "velocity" | "cfd" | "resolution" | "completion";

export default function Reports() {
  const { key } = useParams();
  const { data: project } = useProject(key);
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get("tab") as Tab) ?? "burndown";
  const tabs: { value: Tab; label: string }[] = [
    ...(project?.board_type === "scrum" ? [{ value: "burndown" as const, label: "Burndown" }, { value: "burnup" as const, label: "Burnup" }, { value: "velocity" as const, label: "Velocity" }] : []),
    { value: "cfd", label: "Cumulative flow" }, { value: "resolution", label: "Resolution time" }, { value: "completion", label: "Project completion" },
  ];
  if (!project) return <Spinner />;
  const active = tabs.some((t) => t.value === tab) ? tab : tabs[0].value;
  return (
    <div className="mx-auto max-w-6xl p-4 md:p-6">
      <PageHeader title="Reports" breadcrumb={<Link to={`/projects/${key}`} className="hover:underline">{project.name}</Link>}
        subtitle="Calculated from recorded issue history" />
      <Tabs tabs={tabs} value={active} onChange={(v) => setSp({ tab: v }, { replace: true })} />
      <div className="pt-4">
        {(active === "burndown" || active === "burnup") && <SprintReport projectKey={key!} kind={active} />}
        {active === "velocity" && <Velocity projectKey={key!} />}
        {active === "cfd" && <CumulativeFlow projectKey={key!} />}
        {active === "resolution" && <Resolution projectKey={key!} />}
        {active === "completion" && <Completion projectKey={key!} />}
      </div>
    </div>
  );
}

function useExport(projectKey: string) {
  const toast = useToast();
  return (kind: string, qs = "") => download(`/projects/${projectKey}/reports/${kind}.csv${qs}`, `${projectKey}-${kind}.csv`).catch((e) => toast.error(errorMessage(e)));
}

interface SeriesRow { date: string; scope: number | null; completed: number | null; remaining: number | null; ideal: number }

function SprintReport({ projectKey, kind }: { projectKey: string; kind: "burndown" | "burnup" }) {
  const { data: sprints = [], isLoading } = useSprints(projectKey, "active,closed");
  const [sprintId, setSprintId] = useState<number | null>(null);
  const id = sprintId ?? sprints[0]?.id;
  const report = useQuery({
    queryKey: ["reports", "sprint", id],
    queryFn: () => api.get<{ sprint: { name: string; goal: string; state: string }; committed_points: number | null; series: SeriesRow[] }>(`/sprints/${id}/report`),
    enabled: !!id,
  });
  const col = useChartColors();
  const axis = useAxisProps();
  const exp = useExport(projectKey);
  if (isLoading) return <Spinner />;
  if (!sprints.length) return <EmptyState title="No started sprints yet">Start a sprint to see its {kind}.</EmptyState>;
  const rows = (report.data?.series ?? []).map((r) => ({ ...r, day: fmtDate(r.date, "d MMM") }));
  const last = [...rows].reverse().find((r) => r.remaining !== null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={id} onChange={(e) => setSprintId(Number(e.target.value))} className="w-64" aria-label="Sprint">
          {sprints.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.state})</option>)}
        </Select>
        {report.data?.sprint.goal && <span className="text-sm text-muted">Goal: {report.data.sprint.goal}</span>}
      </div>
      {report.error && <ErrorState error={report.error} />}
      {report.data && (<>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Committed" value={report.data.committed_points ?? "—"} hint="points at sprint start" />
          <Stat label="Current scope" value={last?.scope ?? "—"} hint="points" />
          <Stat label="Completed" value={last?.completed ?? "—"} tone="green" />
          <Stat label="Remaining" value={last?.remaining ?? "—"} tone="blue" />
        </div>
        <ChartCard title={kind === "burndown" ? "Sprint burndown (story points)" : "Sprint burnup (story points)"} rows={rows}
          onExport={() => exp(kind, `?sprint_id=${id}`)}
          columns={[{ key: "day", label: "Day" }, { key: "scope", label: "Scope" }, { key: "completed", label: "Completed" }, { key: "remaining", label: "Remaining" }, { key: "ideal", label: "Guideline" }]}>
          <Legend items={kind === "burndown"
            ? [{ label: "Remaining", color: col.series[0] }, { label: "Guideline", color: col.neutral, dashed: true }]
            : [{ label: "Completed", color: col.series[0] }, { label: "Scope", color: col.series[1] }]} />
          <div className="h-80 px-2 pb-2">
            <ResponsiveContainer>
              <LineChart data={rows} margin={{ top: 12, right: 16, bottom: 0, left: -16 }}>
                <CartesianGrid vertical={false} stroke={col.grid} />
                <XAxis dataKey="day" {...axis} minTickGap={16} />
                <YAxis allowDecimals={false} {...axis} />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: col.axis, strokeDasharray: "3 3" }} />
                {kind === "burndown" ? (<>
                  <Line dataKey="ideal" name="Guideline" stroke={col.neutral} strokeDasharray="5 4" strokeWidth={2} dot={false} />
                  <Line dataKey="remaining" name="Remaining" type="stepAfter" stroke={col.series[0]} strokeWidth={2} dot={false} connectNulls={false}
                    activeDot={{ r: 4, stroke: col.surface, strokeWidth: 2 }} />
                </>) : (<>
                  <Line dataKey="scope" name="Scope" type="stepAfter" stroke={col.series[1]} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: col.surface, strokeWidth: 2 }} />
                  <Line dataKey="completed" name="Completed" type="stepAfter" stroke={col.series[0]} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: col.surface, strokeWidth: 2 }} />
                </>)}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </>)}
    </div>
  );
}

function Velocity({ projectKey }: { projectKey: string }) {
  const { data = [], isLoading, error } = useQuery({
    queryKey: ["reports", "velocity", projectKey],
    queryFn: () => api.get<{ sprint_id: number; name: string; committed: number; completed: number }[]>(`/projects/${projectKey}/reports/velocity`),
  });
  const col = useChartColors();
  const axis = useAxisProps();
  const exp = useExport(projectKey);
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} />;
  const avg = data.length ? data.reduce((s, r) => s + r.completed, 0) / data.length : 0;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Average velocity" value={avg.toFixed(1)} hint={`over ${data.length} closed sprint(s)`} />
        <Stat label="Last sprint" value={data.at(-1)?.completed ?? "—"} hint="points completed" />
        <Stat label="Say/do ratio" value={data.length ? `${Math.round((data.reduce((s, r) => s + r.completed, 0) / Math.max(1, data.reduce((s, r) => s + r.committed, 0))) * 100)}%` : "—"} />
      </div>
      <ChartCard title="Velocity: committed vs completed" rows={data} onExport={() => exp("velocity")}
        columns={[{ key: "name", label: "Sprint" }, { key: "committed", label: "Committed" }, { key: "completed", label: "Completed" }]}
        empty={<EmptyState title="No closed sprints yet">Velocity appears after the first sprint is completed.</EmptyState>}>
        <Legend items={[{ label: "Committed", color: col.series[0] }, { label: "Completed", color: col.series[1] }]} />
        <div className="h-80 px-2 pb-2">
          <ResponsiveContainer>
            <BarChart data={data} margin={{ top: 12, right: 16, bottom: 0, left: -16 }} barGap={2}>
              <CartesianGrid vertical={false} stroke={col.grid} />
              <XAxis dataKey="name" {...axis} />
              <YAxis allowDecimals={false} {...axis} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: col.grid }} />
              <Bar dataKey="committed" name="Committed" fill={col.series[0]} radius={[4, 4, 0, 0]} maxBarSize={36} />
              <Bar dataKey="completed" name="Completed" fill={col.series[1]} radius={[4, 4, 0, 0]} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>
    </div>
  );
}

function DateRange({ start, end, onChange }: { start: string; end: string; onChange: (s: string, e: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {[14, 30, 90].map((d) => (
        <button key={d} className="rounded border px-2 py-1 text-xs hover:bg-surface-2"
          onClick={() => onChange(new Date(Date.now() - (d - 1) * 864e5).toISOString().slice(0, 10), new Date().toISOString().slice(0, 10))}>Last {d} days</button>
      ))}
      <Input type="date" value={start} onChange={(e) => onChange(e.target.value, end)} className="w-36" aria-label="Start date" />–
      <Input type="date" value={end} onChange={(e) => onChange(start, e.target.value)} className="w-36" aria-label="End date" />
    </div>
  );
}

function useRange(days: number) {
  const [range, setRange] = useState({ start: new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10), end: new Date().toISOString().slice(0, 10) });
  return [range, (s: string, e: string) => setRange({ start: s, end: e })] as const;
}

function CumulativeFlow({ projectKey }: { projectKey: string }) {
  const [range, setRange] = useRange(30);
  const qs = `?start=${range.start}&end=${range.end}`;
  const { data, isLoading, error } = useQuery({
    queryKey: ["reports", "cfd", projectKey, qs],
    queryFn: () => api.get<{ statuses: { name: string; category: string }[]; series: Record<string, number | string>[] }>(`/projects/${projectKey}/reports/cumulative-flow${qs}`),
  });
  const col = useChartColors();
  const axis = useAxisProps();
  const exp = useExport(projectKey);
  // Fixed slot order by workflow position; beyond 8 statuses fold into "Other" rather than cycling hues.
  const statuses = data?.statuses ?? [];
  const shown = statuses.length > 8 ? statuses.slice(0, 7) : statuses;
  const rows = (data?.series ?? []).map((r) => {
    const row: Record<string, number | string> = { day: fmtDate(String(r.date), "d MMM") };
    shown.forEach((s) => (row[s.name] = r[s.name] as number));
    if (statuses.length > 8) row.Other = statuses.slice(7).reduce((sum, s) => sum + Number(r[s.name] ?? 0), 0);
    return row;
  });
  const keys = [...shown.map((s) => s.name), ...(statuses.length > 8 ? ["Other"] : [])];
  // Stack done at the bottom (reverse workflow order), as is conventional for CFDs.
  const stackOrder = [...keys].reverse();
  return (
    <div className="space-y-3">
      <DateRange start={range.start} end={range.end} onChange={setRange} />
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} /> : (
        <ChartCard title="Cumulative flow (issues per status)" rows={rows} onExport={() => exp("cumulative-flow", qs)}
          columns={[{ key: "day", label: "Day" }, ...keys.map((k) => ({ key: k, label: k }))]}>
          <Legend items={keys.map((k, i) => ({ label: k, color: col.series[i] }))} />
          <div className="h-80 px-2 pb-2">
            <ResponsiveContainer>
              <AreaChart data={rows} margin={{ top: 12, right: 16, bottom: 0, left: -16 }}>
                <CartesianGrid vertical={false} stroke={col.grid} />
                <XAxis dataKey="day" {...axis} minTickGap={16} />
                <YAxis allowDecimals={false} {...axis} />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: col.axis, strokeDasharray: "3 3" }} />
                {stackOrder.map((k) => (
                  <Area key={k} dataKey={k} name={k} stackId="1" type="monotone" fill={col.series[keys.indexOf(k)]} fillOpacity={0.85}
                    stroke={col.surface} strokeWidth={2} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      )}
    </div>
  );
}

interface Summary { key: string; count: number; avg_hours: number; median_hours: number }

function Resolution({ projectKey }: { projectKey: string }) {
  const [range, setRange] = useRange(90);
  const qs = `?start=${range.start}&end=${range.end}`;
  const { data, isLoading, error } = useQuery({
    queryKey: ["reports", "resolution", projectKey, qs],
    queryFn: () => api.get<{ overall: Omit<Summary, "key">; by_type: Summary[]; by_priority: Summary[]; distribution: { bucket: string; count: number }[]; weekly: { week: string; avg_hours: number; count: number }[] }>(`/projects/${projectKey}/reports/resolution-time${qs}`),
  });
  const col = useChartColors();
  const axis = useAxisProps();
  const exp = useExport(projectKey);
  return (
    <div className="space-y-4">
      <DateRange start={range.start} end={range.end} onChange={setRange} />
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} /> : (<>
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Resolved issues" value={data!.overall.count} />
          <Stat label="Average time to resolve" value={data!.overall.count ? fmtHours(data!.overall.avg_hours) : "—"} />
          <Stat label="Median time to resolve" value={data!.overall.count ? fmtHours(data!.overall.median_hours) : "—"} />
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ChartCard title="Resolution time distribution" rows={data!.distribution} onExport={() => exp("resolution-time", qs)}
            columns={[{ key: "bucket", label: "Time to resolve" }, { key: "count", label: "Issues" }]}>
            <div className="h-64 px-2 py-2">
              <ResponsiveContainer>
                <BarChart data={data!.distribution} margin={{ top: 16, right: 8, bottom: 0, left: -20 }}>
                  <CartesianGrid vertical={false} stroke={col.grid} />
                  <XAxis dataKey="bucket" {...axis} />
                  <YAxis allowDecimals={false} {...axis} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: col.grid }} />
                  <Bar dataKey="count" name="Issues" fill={col.series[0]} radius={[4, 4, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>
          <ChartCard title="Average resolution time per week" rows={data!.weekly.map((w) => ({ ...w, label: fmtDate(w.week, "d MMM") }))}
            columns={[{ key: "label", label: "Week of" }, { key: "avg_hours", label: "Avg hours" }, { key: "count", label: "Resolved" }]}
            empty={<EmptyState title="Nothing resolved in this range" />}>
            <div className="h-64 px-2 py-2">
              <ResponsiveContainer>
                <LineChart data={data!.weekly.map((w) => ({ ...w, label: fmtDate(w.week, "d MMM") }))} margin={{ top: 16, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid vertical={false} stroke={col.grid} />
                  <XAxis dataKey="label" {...axis} />
                  <YAxis {...axis} />
                  <Tooltip content={<ChartTooltip format={fmtHours} />} cursor={{ stroke: col.axis, strokeDasharray: "3 3" }} />
                  <Line dataKey="avg_hours" name="Average" stroke={col.series[0]} strokeWidth={2} dot={{ r: 4, fill: col.series[0], stroke: col.surface, strokeWidth: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SummaryTable title="By issue type" rows={data!.by_type} label={(k) => typeMeta(k as never).label} />
          <SummaryTable title="By priority" rows={data!.by_priority} label={(k) => priorityMeta(k as never).label} />
        </div>
      </>)}
    </div>
  );
}

function SummaryTable({ title, rows, label }: { title: string; rows: Summary[]; label: (k: string) => string }) {
  return (
    <Card title={title}>
      {rows.length === 0 ? <p className="p-4 text-sm text-muted">No resolved issues.</p> : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted"><tr><th className="px-4 py-2">Group</th><th>Resolved</th><th>Average</th><th>Median</th></tr></thead>
          <tbody className="divide-y">{rows.map((r) => (
            <tr key={r.key}><td className="px-4 py-1.5">{label(r.key)}</td><td className="tabular-nums">{r.count}</td><td className="tabular-nums">{fmtHours(r.avg_hours)}</td><td className="tabular-nums">{fmtHours(r.median_hours)}</td></tr>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

function Completion({ projectKey }: { projectKey: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["reports", "completion", projectKey],
    queryFn: () => api.get<{
      total_issues: number; done_issues: number; total_points: number; done_points: number; percent_complete: number;
      epics: { id: number; key: string; summary: string; total: number; done: number; points: number; done_points: number; due_date: string | null }[];
      trend: { week: string; created: number; resolved: number }[]; weekly_throughput: number; forecast_completion: string | null; due_date: string | null;
    }>(`/projects/${projectKey}/reports/completion`),
  });
  const col = useChartColors();
  const axis = useAxisProps();
  const exp = useExport(projectKey);
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} />;
  const d = data!;
  const late = d.forecast_completion && d.due_date && d.forecast_completion > d.due_date;
  const trend = d.trend.map((t) => ({ ...t, label: fmtDate(t.week, "d MMM") }));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Complete" value={`${d.percent_complete}%`} tone="green" hint={`${d.done_issues}/${d.total_issues} issues`} />
        <Stat label="Points done" value={`${d.done_points}/${d.total_points}`} />
        <Stat label="Throughput" value={d.weekly_throughput} hint="issues resolved / week (12-week avg)" />
        <Stat label="Forecast completion" value={d.forecast_completion ? fmtDate(d.forecast_completion) : "—"} tone={late ? "red" : undefined}
          hint={d.due_date ? `Target ${fmtDate(d.due_date)}${late ? " · at risk" : ""}` : "No target date set"} />
      </div>
      <ChartCard title="Created vs resolved per week" rows={trend} columns={[{ key: "label", label: "Week of" }, { key: "created", label: "Created" }, { key: "resolved", label: "Resolved" }]}
        empty={<EmptyState title="No activity in the last 12 weeks" />}>
        <Legend items={[{ label: "Created", color: col.series[0] }, { label: "Resolved", color: col.series[1] }]} />
        <div className="h-64 px-2 pb-2">
          <ResponsiveContainer>
            <BarChart data={trend} margin={{ top: 12, right: 16, bottom: 0, left: -16 }} barGap={2}>
              <CartesianGrid vertical={false} stroke={col.grid} />
              <XAxis dataKey="label" {...axis} />
              <YAxis allowDecimals={false} {...axis} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: col.grid }} />
              <Bar dataKey="created" name="Created" fill={col.series[0]} radius={[4, 4, 0, 0]} maxBarSize={28} />
              <Bar dataKey="resolved" name="Resolved" fill={col.series[1]} radius={[4, 4, 0, 0]} maxBarSize={28} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>
      <Card title="Epic progress" actions={<button className="text-xs text-primary hover:underline" onClick={() => exp("completion")}>Export CSV</button>}>
        {d.epics.length === 0 ? <p className="p-4 text-sm text-muted">No epics in this project.</p> : (
          <ul className="divide-y">{d.epics.map((e) => (
            <li key={e.id} className="grid grid-cols-[minmax(0,1fr)_200px_110px] items-center gap-3 px-4 py-2">
              <Link to={`/issues/${e.key}`} className="truncate text-sm hover:underline"><span className="text-xs text-muted">{e.key}</span> {e.summary}</Link>
              <div><ProgressBar value={e.done} total={e.total} /><span className="text-xs text-subtle">{e.done}/{e.total} issues · {e.done_points}/{e.points} pts</span></div>
              <span className="text-right text-xs text-muted">{e.due_date ? `Due ${fmtDate(e.due_date)}` : ""}</span>
            </li>
          ))}</ul>
        )}
      </Card>
    </div>
  );
}
