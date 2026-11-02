export type IssueType = "epic" | "story" | "task" | "bug" | "improvement" | "subtask";
export type Priority = "highest" | "high" | "medium" | "low" | "lowest";
export type StatusCategory = "todo" | "in_progress" | "done";
export type ProjectRole = "project_manager" | "scrum_master" | "developer" | "reporter" | "viewer";
export type SprintState = "future" | "active" | "closed";

export interface UserBrief {
  id: number;
  username: string;
  full_name: string;
  avatar_color: string;
}

export interface User extends UserBrief {
  email: string;
  is_admin: boolean;
  is_active: boolean;
  job_title: string | null;
  theme: "light" | "dark" | "system";
  created_at: string;
  last_login_at: string | null;
}

export interface Status {
  id: number;
  name: string;
  category: StatusCategory;
  position: number;
  wip_limit: number | null;
}

export interface Project {
  id: number;
  key: string;
  name: string;
  description: string;
  board_type: "scrum" | "kanban";
  priority: Priority;
  status: "active" | "archived";
  lead: UserBrief | null;
  start_date: string | null;
  due_date: string | null;
  settings: { enforce_transitions?: boolean; kanban_done_days?: number; [k: string]: unknown };
  created_at: string;
}

export interface ProjectSummary extends Project {
  issue_count: number;
  done_count: number;
  member_count: number;
  my_role: ProjectRole | null;
}

export interface ProjectDetail extends Project {
  statuses: Status[];
  my_role: ProjectRole | null;
  permissions: string[];
}

export interface Member {
  id: number;
  role: ProjectRole;
  joined_at: string;
  user: UserBrief;
}

export interface Sprint {
  id: number;
  project_id: number;
  name: string;
  goal: string;
  state: SprintState;
  start_date: string | null;
  end_date: string | null;
  started_at: string | null;
  completed_at: string | null;
  committed_points: number | null;
  completed_points: number | null;
  issue_count: number;
  done_count: number;
  total_points: number;
  done_points: number;
}

export interface IssueRef {
  id: number;
  key: string;
  summary: string;
  issue_type: IssueType;
  priority: Priority;
  status: Status;
  assignee: UserBrief | null;
}

export interface Issue {
  id: number;
  key: string;
  number: number;
  project_id: number;
  issue_type: IssueType;
  summary: string;
  description: string;
  status: Status;
  priority: Priority;
  assignee: UserBrief | null;
  reporter: UserBrief | null;
  parent_id: number | null;
  sprint_id: number | null;
  story_points: number | null;
  original_estimate_hours: number | null;
  time_spent_hours: number;
  start_date: string | null;
  due_date: string | null;
  resolved_at: string | null;
  rank: number;
  labels: string[];
  custom_fields: Record<string, string | number | null>;
  version: number;
  created_at: string;
  updated_at: string;
  parent_key: string | null;
  parent_summary: string | null;
  sprint_name: string | null;
  project_key: string | null;
  child_count: number;
  child_done_count: number;
}

export interface IssueLinkInfo {
  id: number;
  link_type: "blocks" | "relates_to" | "duplicates";
  direction: "outward" | "inward";
  label: string;
  issue: IssueRef;
}

export interface IssueDetail extends Issue {
  project: Project;
  sprint: Sprint | null;
  parent: IssueRef | null;
  children: IssueRef[];
  links: IssueLinkInfo[];
  watchers: UserBrief[];
  is_watching: boolean;
  can_edit: boolean;
  available_transitions: Status[];
}

export interface Comment {
  id: number;
  issue_id: number;
  author: UserBrief | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Attachment {
  id: number;
  issue_id: number;
  filename: string;
  content_type: string;
  size_bytes: number;
  uploader: UserBrief | null;
  created_at: string;
}

export interface History {
  id: number;
  issue_id: number;
  actor: UserBrief | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

export interface Activity extends History {
  issue_key: string;
  issue_summary: string;
  project_key: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface Notification {
  id: number;
  kind: string;
  message: string;
  issue_id: number | null;
  project_id: number | null;
  is_read: boolean;
  actor: UserBrief | null;
  created_at: string;
  issue_key: string | null;
}

export interface CustomField {
  id: number;
  name: string;
  field_type: "text" | "number" | "date" | "select";
  options: string[];
  required: boolean;
  position: number;
}

export interface SavedFilter {
  id: number;
  name: string;
  project_id: number | null;
  query: IssueFilter;
  is_shared: boolean;
  owner: UserBrief;
  created_at: string;
}

export interface IssueFilter {
  project_ids?: number[];
  issue_types?: IssueType[];
  status_ids?: number[];
  status_categories?: StatusCategory[];
  priorities?: Priority[];
  assignee_ids?: (number | "me" | "none")[];
  sprint_ids?: (number | "none" | "active")[];
  labels?: string[];
  text?: string;
  epic_id?: number;
  overdue?: boolean;
  resolved?: boolean;
  due_from?: string;
  due_to?: string;
  sort?: string;
  order?: "asc" | "desc";
  tql?: string;
}

export interface DashboardRow {
  id: number;
  key: string;
  summary: string;
  issue_type: IssueType;
  priority: Priority;
  status: string;
  status_category: StatusCategory;
  due_date: string | null;
  assignee: string | null;
}

export interface Dashboard {
  counts: Record<"total" | "open" | "in_progress" | "done" | "overdue" | "due_this_week" | "assigned_to_me" | "unassigned", number>;
  by_category: { key: StatusCategory; count: number }[];
  by_type: { key: IssueType; count: number }[];
  by_priority: { key: Priority; count: number }[];
  workload: { user_id: number; name: string; avatar_color: string; open_issues: number; open_points: number }[];
  active_sprints: (Omit<Sprint, "state" | "start_date" | "started_at" | "completed_at" | "committed_points" | "completed_points"> & {
    project_key: string; days_left: number | null;
  })[];
  upcoming: DashboardRow[];
  overdue: DashboardRow[];
  my_issues: DashboardRow[];
  trend: { date: string; created: number; resolved: number }[];
  activity: { id: number; issue_key: string; issue_summary: string; field: string; old_value: string | null;
    new_value: string | null; actor: string | null; created_at: string }[];
}

export interface AuditEntry {
  id: number;
  actor: UserBrief | null;
  action: string;
  entity_type: string;
  entity_id: number | null;
  details: Record<string, unknown>;
  ip_address: string | null;
  created_at: string;
}
