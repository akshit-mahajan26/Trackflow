import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartCard, ChartTooltip, Legend, useAxisProps, useChartColors } from "../components/charts";
import { DueDate, IssueTypeIcon, PriorityIcon, StatusBadge } from "../components/issue-bits";
import { Avatar, Card, EmptyState, ErrorState, PageHeader, ProgressBar, Spinner, Stat } from "../components/ui";
import { api } from "../lib/api";
import { useMe } from "../lib/auth";
import { CATEGORY_LABEL, describeChange, fmtDate, fmtRelative, FORMER_USER, priorityMeta, typeMeta } from "../lib/format";
import type { Dashboard as DashboardData, DashboardRow } from "../lib/types";

export default function Dashboard() {
  const me = useMe();
  const q = useQuery({ queryKey: ["dashboard", "global"], queryFn: () => api.get<DashboardData>("/dashboard") });
  return (
    <div className="mx-auto max-w-7xl p-4 md:p-6">
      <PageHeader title={`Welcome back, ${me.full_name.split(" ")[0]}`} subtitle="Across all projects you can access" />
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : <DashboardView data={q.data!} />}
    </div>
  );
}

export function DashboardView({ data, projectKey }: { data: DashboardData; projectKey?: string }) {
  const c = data.counts;
  const issuesLink = (qs: string) => (projectKey ? `/projects/${projectKey}/issues?${qs}` : `/issues?${qs}`);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Link to={issuesLink("resolved=false")}><Stat label="Open" value={c.open} /></Link>
        <Stat label="In progress" value={c.in_progress} tone="blue" />
        <Stat label="Done" value={c.done} tone="green" hint={c.total ? `${Math.round((c.done / c.total) * 100)}% of ${c.total}` : undefined} />
        <Link to={issuesLink("overdue=true")}><Stat label="Overdue" value={c.overdue} tone={c.overdue ? "red" : undefined} /></Link>
        <Stat label="Due in 7 days" value={c.due_this_week} />
        <Link to={issuesLink("assignee_ids=me&resolved=false")}><Stat label="Assigned to me" value={c.assigned_to_me} /></Link>
        <Link to={issuesLink("assignee_ids=none&resolved=false")}><Stat label="Unassigned" value={c.unassigned} /></Link>
        <Stat label="Total issues" value={c.total} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2"><TrendChart data={data} /></div>
        <ActiveSprints data={data} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Distribution title="Issues by status category" rows={data.by_category.map((r) => ({ label: CATEGORY_LABEL[r.key] ?? r.key, count: r.count }))} />
        <Distribution title="Issues by type" rows={data.by_type.map((r) => ({ label: typeMeta(r.key).label, count: r.count }))} />
        <Distribution title="Issues by priority"
          rows={["highest", "high", "medium", "low", "lowest"].map((p) => ({ label: priorityMeta(p as never).label, count: data.by_priority.find((r) => r.key === p)?.count ?? 0 }))} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <IssueTable title="My open issues" rows={data.my_issues} empty="Nothing assigned to you. Nice!" />
        <Workload data={data} />
        <IssueTable title="Overdue" rows={data.overdue} empty="No overdue issues." />
        <IssueTable title="Upcoming deadlines" rows={data.upcoming} empty="No upcoming due dates." />
      </div>

      <Card title="Recent activity">
        {data.activity.length === 0 ? <EmptyState title="No activity yet" /> : (
          <ul className="divide-y">
            {data.activity.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 px-4 py-2 text-sm">
                <span className="font-medium">{a.actor ?? FORMER_USER}</span>
                <span className="text-muted">{describeChange(a)}</span>
                <span className="text-muted">on</span>
                <Link to={`/issues/${a.issue_key}`} className="font-medium text-primary hover:underline">{a.issue_key}</Link>
                <span className="min-w-0 flex-1 truncate text-muted">{a.issue_summary}</span>
                <span className="text-xs text-subtle">{fmtRelative(a.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function TrendChart({ data }: { data: DashboardData }) {
  const col = useChartColors();
  const axis = useAxisProps();
  const rows = data.trend.map((t) => ({ ...t, day: fmtDate(t.date, "d MMM") }));
  return (
    <ChartCard title="Created vs resolved · last 14 days" rows={rows}
      columns={[{ key: "day", label: "Day" }, { key: "created", label: "Created" }, { key: "resolved", label: "Resolved" }]}>
      <Legend items={[{ label: "Created", color: col.series[0] }, { label: "Resolved", color: col.series[1] }]} />
      <div className="h-56 px-2 pb-2">
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 10, right: 12, bottom: 0, left: -20 }}>
            <CartesianGrid vertical={false} stroke={col.grid} />
            <XAxis dataKey="day" {...axis} interval="preserveStartEnd" minTickGap={16} />
            <YAxis allowDecimals={false} {...axis} />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: col.axis, strokeDasharray: "3 3" }} />
            <Line dataKey="created" name="Created" stroke={col.series[0]} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: col.surface, strokeWidth: 2 }} />
            <Line dataKey="resolved" name="Resolved" stroke={col.series[1]} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: col.surface, strokeWidth: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

function Distribution({ title, rows }: { title: string; rows: { label: string; count: number }[] }) {
  const col = useChartColors();
  const axis = useAxisProps();
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <ChartCard title={title} rows={rows} columns={[{ key: "label", label: "Group" }, { key: "count", label: "Issues" }]}
      empty={<EmptyState title="No issues yet" />}>
      <div className="h-48 px-2 py-2">
        {total === 0 ? <EmptyState title="No issues yet" /> : (
          <ResponsiveContainer>
            {/* One measure across categories: a single hue, with the label on the axis carrying identity. */}
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 28, bottom: 0, left: 8 }} barCategoryGap={4}>
              <XAxis type="number" hide allowDecimals={false} />
              <YAxis type="category" dataKey="label" width={90} {...axis} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: col.grid }} />
              <Bar dataKey="count" name="Issues" fill={col.series[0]} radius={[0, 4, 4, 0]} maxBarSize={18}
                label={{ position: "right", fill: col.muted, fontSize: 11 }} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </ChartCard>
  );
}

function ActiveSprints({ data }: { data: DashboardData }) {
  return (
    <Card title="Active sprints">
      {data.active_sprints.length === 0 ? <EmptyState title="No active sprints" /> : (
        <ul className="divide-y">
          {data.active_sprints.map((s) => (
            <li key={s.id} className="space-y-1.5 px-4 py-3">
              <div className="flex items-center gap-2">
                <Link to={`/projects/${s.project_key}/board`} className="font-medium hover:underline">{s.name}</Link>
                <span className="text-xs text-muted">{s.project_key}</span>
                <span className="flex-1" />
                {s.days_left !== null && (
                  <span className={`text-xs ${s.days_left < 0 ? "font-semibold text-danger" : "text-muted"}`}>
                    {s.days_left < 0 ? `${-s.days_left}d overdue` : `${s.days_left}d left`}
                  </span>
                )}
              </div>
              {s.goal && <p className="truncate text-xs text-muted">{s.goal}</p>}
              <ProgressBar value={s.done_points || s.done_count} total={s.total_points || s.issue_count} />
              <p className="text-xs text-subtle">{s.done_count}/{s.issue_count} issues · {s.done_points}/{s.total_points} pts</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Workload({ data }: { data: DashboardData }) {
  const max = Math.max(1, ...data.workload.map((w) => w.open_issues));
  return (
    <Card title="Team workload (open issues)">
      {data.workload.length === 0 ? <EmptyState title="No assigned open work" /> : (
        <ul className="space-y-2 p-4">
          {data.workload.map((w) => (
            <li key={w.user_id} className="flex items-center gap-3">
              <Avatar user={{ id: w.user_id, full_name: w.name, avatar_color: w.avatar_color, username: "" }} size={24} />
              <span className="w-32 truncate text-sm">{w.name}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3">
                <div className="h-full rounded-full bg-primary" style={{ width: `${(w.open_issues / max) * 100}%` }} />
              </div>
              <span className="w-24 text-right text-xs tabular-nums text-muted">{w.open_issues} issues · {w.open_points} pts</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function IssueTable({ title, rows, empty }: { title: string; rows: DashboardRow[]; empty: string }) {
  return (
    <Card title={title}>
      {rows.length === 0 ? <p className="px-4 py-6 text-center text-sm text-muted">{empty}</p> : (
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-2 px-4 py-2">
              <IssueTypeIcon type={r.issue_type} size={14} />
              <Link to={`/issues/${r.key}`} className="text-xs font-medium text-muted hover:text-primary">{r.key}</Link>
              <Link to={`/issues/${r.key}`} className="min-w-0 flex-1 truncate text-sm hover:underline">{r.summary}</Link>
              <PriorityIcon priority={r.priority} size={14} />
              <DueDate due={r.due_date} category={r.status_category} />
              <StatusBadge status={{ name: r.status, category: r.status_category }} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
