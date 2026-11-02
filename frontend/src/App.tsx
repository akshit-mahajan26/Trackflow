import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Spinner } from "./components/ui";
import { useAuth } from "./lib/auth";
import Login from "./pages/Login";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const Projects = lazy(() => import("./pages/Projects"));
const ProjectSummary = lazy(() => import("./pages/ProjectSummary"));
const Board = lazy(() => import("./pages/Board"));
const Backlog = lazy(() => import("./pages/Backlog"));
const IssuesPage = lazy(() => import("./pages/IssuesPage"));
const IssuePage = lazy(() => import("./pages/IssuePage"));
const Reports = lazy(() => import("./pages/Reports"));
const CalendarPage = lazy(() => import("./pages/CalendarPage"));
const Timeline = lazy(() => import("./pages/Timeline"));
const ProjectSettings = lazy(() => import("./pages/ProjectSettings"));
const Team = lazy(() => import("./pages/Team"));
const Admin = lazy(() => import("./pages/Admin"));
const Profile = lazy(() => import("./pages/Profile"));

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner label="Loading TrackFlow…" className="h-full" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

function NotFound() {
  return <div className="p-10 text-center text-muted">Page not found.</div>;
}

export default function App() {
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<RequireAuth><Layout /></RequireAuth>}>
          <Route index element={<Dashboard />} />
          <Route path="projects" element={<Projects />} />
          <Route path="projects/:key" element={<ProjectSummary />} />
          <Route path="projects/:key/board" element={<Board />} />
          <Route path="projects/:key/backlog" element={<Backlog />} />
          <Route path="projects/:key/issues" element={<IssuesPage />} />
          <Route path="projects/:key/reports" element={<Reports />} />
          <Route path="projects/:key/calendar" element={<CalendarPage />} />
          <Route path="projects/:key/timeline" element={<Timeline />} />
          <Route path="projects/:key/settings" element={<ProjectSettings />} />
          <Route path="issues" element={<IssuesPage />} />
          <Route path="issues/:issueKey" element={<IssuePage />} />
          <Route path="team" element={<Team />} />
          <Route path="admin" element={<Admin />} />
          <Route path="profile" element={<Profile />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
