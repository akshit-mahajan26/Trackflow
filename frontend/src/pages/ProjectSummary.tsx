import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Avatar, Badge, Card, ErrorState, PageHeader, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { fmtDate, roleLabel } from "../lib/format";
import { useMembers, useProject } from "../lib/queries";
import type { Dashboard } from "../lib/types";
import { DashboardView } from "./Dashboard";

export default function ProjectSummary() {
  const { key } = useParams();
  const { data: project, error, refetch } = useProject(key);
  const { data: members = [] } = useMembers(key);
  const dash = useQuery({ queryKey: ["dashboard", key], queryFn: () => api.get<Dashboard>(`/projects/${key}/dashboard`), enabled: !!project });
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!project) return <Spinner />;
  return (
    <div className="mx-auto max-w-7xl p-4 md:p-6">
      <PageHeader title={project.name} breadcrumb={`Projects / ${project.key}`}
        subtitle={<span className="flex flex-wrap items-center gap-2">
          <Badge tone="blue">{project.board_type}</Badge>
          {project.status === "archived" && <Badge tone="amber">Archived</Badge>}
          <span>Lead: {project.lead?.full_name ?? "—"}</span>
          <span>· {fmtDate(project.start_date)} → {fmtDate(project.due_date)}</span>
          <span>· Your role: {project.my_role ? roleLabel(project.my_role) : "Administrator"}</span>
        </span>} />
      {project.description && <Card className="mb-4"><p className="prose-issue p-4 text-sm text-muted">{project.description}</p></Card>}
      {dash.isLoading ? <Spinner /> : dash.error ? <ErrorState error={dash.error} /> : <DashboardView data={dash.data!} projectKey={key} />}
      <Card title={`Members (${members.length})`} className="mt-4">
        <ul className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-2 lg:grid-cols-4">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-2">
              <Avatar user={m.user} size={28} />
              <div><p className="text-sm font-medium">{m.user.full_name}</p><p className="text-xs text-muted">{roleLabel(m.role)}</p></div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
