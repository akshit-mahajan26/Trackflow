import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Avatar, Card, EmptyState, ErrorState, Input, Modal, PageHeader, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { fmtRelative, roleLabel } from "../lib/format";
import { useProjects, useUsers } from "../lib/queries";
import type { Issue, Page, User } from "../lib/types";

export default function Team() {
  const { data: users = [], isLoading, error } = useUsers();
  const [q, setQ] = useState("");
  const [sp, setSp] = useSearchParams();
  const selected = Number(sp.get("user")) || null;
  const list = users.filter((u) => !q || `${u.full_name} ${u.username} ${u.email} ${u.job_title ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="mx-auto max-w-6xl p-4 md:p-6">
      <PageHeader title="Team" subtitle={`${users.length} active people`} actions={
        <div className="relative"><Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" className="w-56 pl-7" aria-label="Search people" /></div>} />
      {isLoading ? <Spinner /> : error ? <ErrorState error={error} /> : list.length === 0 ? <EmptyState title="No people found" /> : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((u) => (
            <button key={u.id} onClick={() => setSp({ user: String(u.id) })} className="flex items-center gap-3 rounded-lg border bg-surface p-4 text-left hover:border-primary/50">
              <Avatar user={u} size={40} />
              <div className="min-w-0">
                <p className="truncate font-medium">{u.full_name} {u.is_admin && <span className="text-xs text-primary">· Admin</span>}</p>
                <p className="truncate text-xs text-muted">{u.job_title || `@${u.username}`}</p>
                <p className="truncate text-xs text-subtle">{u.email}</p>
              </div>
            </button>
          ))}
        </div>
      )}
      {selected && <UserModal user={users.find((u) => u.id === selected)} id={selected} onClose={() => setSp({})} />}
    </div>
  );
}

function UserModal({ id, user, onClose }: { id: number; user?: User; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ["user", id], queryFn: () => api.get<{ user: User; memberships: { project_id: number; role: string }[]; open_issues: number }>(`/users/${id}`) });
  const { data: projects = [] } = useProjects();
  const { data: issues } = useQuery({ queryKey: ["issues", "user", id], queryFn: () => api.get<Page<Issue>>(`/issues?assignee_ids=${id}&resolved=false&page_size=20&sort=due`) });
  const u = data?.user ?? user;
  return (
    <Modal open onClose={onClose} title={u?.full_name ?? "Profile"} width="max-w-xl">
      {!u ? <Spinner /> : (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Avatar user={u} size={48} />
            <div><p className="font-semibold">{u.full_name}</p><p className="text-sm text-muted">@{u.username} · {u.email}</p>
              <p className="text-xs text-subtle">{u.job_title}{u.last_login_at && ` · last active ${fmtRelative(u.last_login_at)}`}</p></div>
          </div>
          <Card title="Projects">
            <ul className="divide-y text-sm">
              {data?.memberships.map((m) => {
                const p = projects.find((x) => x.id === m.project_id);
                return <li key={m.project_id} className="flex justify-between px-4 py-1.5">{p ? <Link to={`/projects/${p.key}`} className="hover:underline">{p.name}</Link> : <span className="text-muted">Private project</span>}<span className="text-muted">{roleLabel(m.role)}</span></li>;
              })}
              {data?.memberships.length === 0 && <li className="px-4 py-2 text-muted">Not a member of any project.</li>}
            </ul>
          </Card>
          <Card title={`Open assigned issues (${data?.open_issues ?? "…"})`}>
            <ul className="divide-y text-sm">
              {issues?.items.map((i) => <li key={i.id} className="flex gap-2 px-4 py-1.5"><Link to={`/issues/${i.key}`} className="text-xs font-medium text-muted hover:text-primary">{i.key}</Link><span className="truncate">{i.summary}</span></li>)}
              {issues?.items.length === 0 && <li className="px-4 py-2 text-muted">No open issues you can see.</li>}
            </ul>
          </Card>
        </div>
      )}
    </Modal>
  );
}
