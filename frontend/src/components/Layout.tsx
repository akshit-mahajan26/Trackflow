import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  Bell,
  CalendarDays,
  ChartColumn,
  ChevronDown,
  FolderKanban,
  GanttChart,
  KanbanSquare,
  LayoutDashboard,
  ListTodo,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings,
  Shield,
  Sun,
  User as UserIcon,
  Users,
  Rows3,
  X,
} from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useMatch, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth, useMe } from "../lib/auth";
import { fmtRelative } from "../lib/format";
import { useProject, useProjects } from "../lib/queries";
import { useRealtime } from "../lib/realtime";
import { usePublicConfig } from "../lib/site";
import { useTheme } from "../lib/theme";
import type { IssueType, Notification, StatusCategory } from "../lib/types";
import { CreateIssueModal, type CreateDefaults } from "./CreateIssueModal";
import { IssueTypeIcon, StatusBadge } from "./issue-bits";
import { Avatar, Button, Menu, MenuItem } from "./ui";

const CreateContext = createContext<(d?: CreateDefaults) => void>(() => {});
export const useQuickCreate = () => useContext(CreateContext);

export function Layout() {
  const me = useMe();
  const [createOpen, setCreateOpen] = useState<CreateDefaults | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  useRealtime(me.id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable) return;
      if (e.key === "c" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setCreateOpen({});
      }
      if (e.key === "/") {
        e.preventDefault();
        document.getElementById("global-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <CreateContext.Provider value={(d) => setCreateOpen(d ?? {})}>
      <div className="flex h-full">
        <aside className={clsx("fixed inset-y-0 left-0 z-40 w-60 shrink-0 border-r bg-surface transition-transform md:static md:translate-x-0",
          mobileNav ? "translate-x-0" : "-translate-x-full")}>
          <Sidebar onNavigate={() => setMobileNav(false)} />
        </aside>
        {mobileNav && <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setMobileNav(false)} />}
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onMenu={() => setMobileNav(true)} onCreate={() => setCreateOpen({})} />
          <main className="min-h-0 flex-1 overflow-auto scroll-thin">
            <Outlet />
          </main>
        </div>
      </div>
      {createOpen && <CreateIssueModal defaults={createOpen} onClose={() => setCreateOpen(null)} />}
    </CreateContext.Provider>
  );
}

function NavItem({ to, icon, children, end, onClick }: { to: string; icon: ReactNode; children: ReactNode; end?: boolean; onClick?: () => void }) {
  return (
    <NavLink to={to} end={end} onClick={onClick}
      className={({ isActive }) => clsx("flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm",
        isActive ? "bg-primary-soft font-medium text-primary" : "text-muted hover:bg-surface-2 hover:text-fg")}>
      {icon}
      <span className="truncate">{children}</span>
    </NavLink>
  );
}

function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const me = useMe();
  const match = useMatch("/projects/:key/*");
  const key = match?.params.key;
  const { data: projects } = useProjects();
  const { data: project } = useProject(key);
  const navigate = useNavigate();
  const { siteName } = usePublicConfig();

  return (
    <div className="flex h-full flex-col">
      <Link to="/" onClick={onNavigate} className="flex h-12 items-center gap-2 border-b px-4">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-white"><FolderKanban size={16} /></span>
        <span className="truncate text-base font-semibold">{siteName}</span>
      </Link>
      <nav className="flex-1 space-y-4 overflow-y-auto p-3 scroll-thin">
        <div className="space-y-0.5">
          <NavItem to="/" end icon={<LayoutDashboard size={16} />} onClick={onNavigate}>Dashboard</NavItem>
          <NavItem to="/issues" icon={<ListTodo size={16} />} onClick={onNavigate}>All issues</NavItem>
          <NavItem to="/projects" end icon={<FolderKanban size={16} />} onClick={onNavigate}>Projects</NavItem>
          <NavItem to="/team" icon={<Users size={16} />} onClick={onNavigate}>Team</NavItem>
          {me.is_admin && <NavItem to="/admin" icon={<Shield size={16} />} onClick={onNavigate}>Administration</NavItem>}
        </div>

        <div>
          <p className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">Project</p>
          <select aria-label="Select project" value={key ?? ""} onChange={(e) => { if (e.target.value) { navigate(`/projects/${e.target.value}/board`); onNavigate(); } }}
            className="mb-2 h-8 w-full rounded-md border bg-surface px-2 text-sm">
            <option value="">Select a project…</option>
            {projects?.map((p) => <option key={p.id} value={p.key}>{p.name} ({p.key})</option>)}
          </select>
          {key && project && (
            <div className="space-y-0.5">
              <NavItem to={`/projects/${key}`} end icon={<ChartColumn size={16} />} onClick={onNavigate}>Summary</NavItem>
              {project.board_type === "scrum" && <NavItem to={`/projects/${key}/backlog`} icon={<Rows3 size={16} />} onClick={onNavigate}>Backlog</NavItem>}
              <NavItem to={`/projects/${key}/board`} icon={<KanbanSquare size={16} />} onClick={onNavigate}>
                {project.board_type === "scrum" ? "Active sprint" : "Kanban board"}
              </NavItem>
              <NavItem to={`/projects/${key}/issues`} icon={<ListTodo size={16} />} onClick={onNavigate}>Issues</NavItem>
              <NavItem to={`/projects/${key}/timeline`} icon={<GanttChart size={16} />} onClick={onNavigate}>Timeline</NavItem>
              <NavItem to={`/projects/${key}/calendar`} icon={<CalendarDays size={16} />} onClick={onNavigate}>Calendar</NavItem>
              <NavItem to={`/projects/${key}/reports`} icon={<ChartColumn size={16} />} onClick={onNavigate}>Reports</NavItem>
              <NavItem to={`/projects/${key}/settings`} icon={<Settings size={16} />} onClick={onNavigate}>Settings</NavItem>
            </div>
          )}
        </div>
      </nav>
    </div>
  );
}

function Topbar({ onMenu, onCreate }: { onMenu: () => void; onCreate: () => void }) {
  const { logout } = useAuth();
  const me = useMe();
  const { pref, setPref } = useTheme();
  const navigate = useNavigate();
  const ThemeIcon = pref === "dark" ? Moon : pref === "light" ? Sun : Monitor;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-surface px-3">
      <button className="rounded p-1.5 text-muted hover:bg-surface-2 md:hidden" onClick={onMenu} aria-label="Open navigation">
        <MenuIcon size={18} />
      </button>
      <GlobalSearch />
      <Button variant="primary" icon={<Plus size={16} />} onClick={onCreate} title="Create issue (c)">
        <span className="hidden sm:inline">Create</span>
      </Button>
      <span className="flex-1" />
      <Menu width="w-40" trigger={() => (
        <button className="rounded-md p-2 text-muted hover:bg-surface-2" aria-label="Theme"><ThemeIcon size={18} /></button>
      )}>
        {(close) => (
          <>
            {(["light", "dark", "system"] as const).map((t) => (
              <MenuItem key={t} onClick={() => { setPref(t); api.patch("/auth/me", { theme: t }).catch(() => {}); close(); }}
                icon={t === "light" ? <Sun size={14} /> : t === "dark" ? <Moon size={14} /> : <Monitor size={14} />}>
                <span className={clsx(pref === t && "font-semibold")}>{t[0].toUpperCase() + t.slice(1)}</span>
              </MenuItem>
            ))}
          </>
        )}
      </Menu>
      <Notifications />
      <Menu trigger={() => (
        <button className="flex items-center gap-1 rounded-full p-0.5 hover:bg-surface-2" aria-label="Account menu">
          <Avatar user={me} size={28} />
          <ChevronDown size={14} className="text-muted" />
        </button>
      )}>
        {(close) => (
          <>
            <div className="border-b px-2 pb-2 pt-1">
              <p className="font-medium">{me.full_name}</p>
              <p className="text-xs text-muted">{me.email}</p>
            </div>
            <MenuItem icon={<UserIcon size={14} />} onClick={() => { navigate("/profile"); close(); }}>Profile & preferences</MenuItem>
            <MenuItem icon={<LogOut size={14} />} onClick={() => { close(); logout(); navigate("/login"); }}>Log out</MenuItem>
          </>
        )}
      </Menu>
    </header>
  );
}

interface SearchResult {
  projects: { id: number; key: string; name: string }[];
  issues: { id: number; key: string; summary: string; issue_type: IssueType; status: string; status_category: StatusCategory }[];
  sprints: { id: number; name: string; state: string; project_key: string }[];
  users: { id: number; full_name: string; username: string; avatar_color: string }[];
}

function GlobalSearch() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const fn = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);
  const { data, isFetching } = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api.get<SearchResult>(`/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length > 0,
  });
  const go = (path: string) => {
    setOpen(false);
    setQ("");
    navigate(path);
  };
  const empty = data && !data.projects.length && !data.issues.length && !data.sprints.length && !data.users.length;

  return (
    <div ref={ref} className="relative w-full max-w-md">
      <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
      <input id="global-search" value={q} placeholder="Search issues, projects, people…  ( / )" autoComplete="off"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && q.trim()) go(`/issues?text=${encodeURIComponent(q.trim())}`);
          if (e.key === "Escape") setOpen(false);
        }}
        className="h-8 w-full rounded-md border bg-surface-2 pl-8 pr-7 text-sm placeholder:text-subtle focus:border-primary focus:bg-surface focus:outline-none" />
      {q && <button className="absolute right-2 top-1/2 -translate-y-1/2 text-subtle" onClick={() => setQ("")} aria-label="Clear search"><X size={14} /></button>}
      {open && debounced && (
        <div className="absolute z-50 mt-1 max-h-[70vh] w-full overflow-y-auto rounded-lg border bg-surface p-1 shadow-xl">
          {isFetching && !data && <p className="p-3 text-sm text-muted">Searching…</p>}
          {empty && <p className="p-3 text-sm text-muted">No results for “{debounced}”.</p>}
          {!!data?.issues.length && <SearchGroup title="Issues">
            {data.issues.map((i) => (
              <button key={i.id} onClick={() => go(`/issues/${i.key}`)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-2">
                <IssueTypeIcon type={i.issue_type} size={14} />
                <span className="text-xs font-medium text-muted">{i.key}</span>
                <span className="flex-1 truncate">{i.summary}</span>
                <StatusBadge status={{ name: i.status, category: i.status_category }} />
              </button>
            ))}
          </SearchGroup>}
          {!!data?.projects.length && <SearchGroup title="Projects">
            {data.projects.map((p) => (
              <button key={p.id} onClick={() => go(`/projects/${p.key}`)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-2">
                <FolderKanban size={14} className="text-muted" /> {p.name} <span className="text-xs text-muted">{p.key}</span>
              </button>
            ))}
          </SearchGroup>}
          {!!data?.sprints.length && <SearchGroup title="Sprints">
            {data.sprints.map((s) => (
              <button key={s.id} onClick={() => go(`/projects/${s.project_key}/${s.state === "active" ? "board" : "backlog"}`)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-2">
                <Rows3 size={14} className="text-muted" /> {s.name} <span className="text-xs text-muted">{s.state}</span>
              </button>
            ))}
          </SearchGroup>}
          {!!data?.users.length && <SearchGroup title="People">
            {data.users.map((u) => (
              <button key={u.id} onClick={() => go(`/team?user=${u.id}`)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-2">
                <Avatar user={{ ...u }} size={18} /> {u.full_name} <span className="text-xs text-muted">@{u.username}</span>
              </button>
            ))}
          </SearchGroup>}
          {data && !empty && (
            <button onClick={() => go(`/issues?text=${encodeURIComponent(debounced)}`)} className="mt-1 w-full rounded border-t px-2 py-2 text-left text-xs text-primary hover:bg-surface-2">
              View all matching issues →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SearchGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="py-1">
      <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">{title}</p>
      {children}
    </div>
  );
}

function Notifications() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<{ items: Notification[]; unread: number }>("/notifications?limit=30"),
    refetchInterval: 60_000,
  });
  const readAll = useMutation({
    mutationFn: () => api.post("/notifications/read-all"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const open = async (n: Notification, close: () => void) => {
    if (!n.is_read) await api.post(`/notifications/${n.id}/read`).catch(() => {});
    qc.invalidateQueries({ queryKey: ["notifications"] });
    close();
    if (n.issue_key) navigate(`/issues/${n.issue_key}`);
  };
  const unread = data?.unread ?? 0;
  return (
    <Menu width="w-[min(380px,90vw)]" trigger={() => (
      <button className="relative rounded-md p-2 text-muted hover:bg-surface-2" aria-label={`Notifications (${unread} unread)`}>
        <Bell size={18} />
        {unread > 0 && <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">{unread > 99 ? "99+" : unread}</span>}
      </button>
    )}>
      {(close) => (
        <div>
          <div className="flex items-center justify-between px-2 py-1.5">
            <p className="font-semibold">Notifications</p>
            {unread > 0 && <button className="text-xs text-primary hover:underline" onClick={() => readAll.mutate()}>Mark all read</button>}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {!data?.items.length && <p className="px-2 py-6 text-center text-sm text-muted">You're all caught up.</p>}
            {data?.items.map((n) => (
              <button key={n.id} onClick={() => open(n, close)}
                className={clsx("flex w-full gap-2 rounded px-2 py-2 text-left hover:bg-surface-2", !n.is_read && "bg-primary-soft/60")}>
                <Avatar user={n.actor} size={24} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{n.message}</p>
                  <p className="text-xs text-subtle">{fmtRelative(n.created_at)}</p>
                </div>
                {!n.is_read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </Menu>
  );
}
