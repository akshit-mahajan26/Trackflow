import { format, formatDistanceToNowStrict, isPast, parseISO } from "date-fns";
import type { IssueType, Priority, ProjectRole, StatusCategory } from "./types";

export const FORMER_USER = "Former user";

export const ISSUE_TYPES: { value: IssueType; label: string; color: string }[] = [
  { value: "epic", label: "Epic", color: "#7c3aed" },
  { value: "story", label: "Story", color: "#16a34a" },
  { value: "task", label: "Task", color: "#2563eb" },
  { value: "bug", label: "Bug", color: "#dc2626" },
  { value: "improvement", label: "Improvement", color: "#0891b2" },
  { value: "subtask", label: "Subtask", color: "#64748b" },
];
export const typeMeta = (t: IssueType) => ISSUE_TYPES.find((x) => x.value === t) ?? ISSUE_TYPES[2];

export const PRIORITIES: { value: Priority; label: string; color: string }[] = [
  { value: "highest", label: "Highest", color: "#c9372c" },
  { value: "high", label: "High", color: "#e2483d" },
  { value: "medium", label: "Medium", color: "#d97008" },
  { value: "low", label: "Low", color: "#2563eb" },
  { value: "lowest", label: "Lowest", color: "#64748b" },
];
export const priorityMeta = (p: Priority) => PRIORITIES.find((x) => x.value === p) ?? PRIORITIES[2];

export const CATEGORY_LABEL: Record<StatusCategory, string> = { todo: "To do", in_progress: "In progress", done: "Done" };
export const CATEGORY_TONE: Record<StatusCategory, "neutral" | "blue" | "green"> = { todo: "neutral", in_progress: "blue", done: "green" };
export const CATEGORY_COLOR: Record<StatusCategory, string> = { todo: "#8a93a3", in_progress: "#2459d8", done: "#1f845a" };

export const ROLES: { value: ProjectRole; label: string; description: string }[] = [
  { value: "project_manager", label: "Project Manager", description: "Full control of the project, members and settings" },
  { value: "scrum_master", label: "Scrum Master", description: "Manages sprints, workflow and all issues" },
  { value: "developer", label: "Developer", description: "Creates, edits and transitions any issue; ranks backlog" },
  { value: "reporter", label: "Reporter", description: "Creates issues, comments, edits own issues" },
  { value: "viewer", label: "Viewer", description: "Read-only access" },
];
export const roleLabel = (r: string | null | undefined) => ROLES.find((x) => x.value === r)?.label ?? (r ? r : "—");

export function fmtDate(d: string | null | undefined, pattern = "d MMM yyyy") {
  if (!d) return "—";
  try {
    return format(parseISO(d), pattern);
  } catch {
    return d;
  }
}

export function fmtRelative(d: string | null | undefined) {
  if (!d) return "—";
  try {
    return `${formatDistanceToNowStrict(parseISO(d))} ago`;
  } catch {
    return d;
  }
}

export function isOverdue(due: string | null | undefined, category?: StatusCategory) {
  if (!due || category === "done") return false;
  const d = parseISO(due);
  d.setHours(23, 59, 59);
  return isPast(d);
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtHours(h: number) {
  if (h < 24) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

export const FIELD_LABEL: Record<string, string> = {
  status: "Status", assignee: "Assignee", sprint: "Sprint", parent: "Parent", summary: "Summary",
  description: "Description", priority: "Priority", issue_type: "Type", story_points: "Story points",
  original_estimate_hours: "Estimate", time_spent_hours: "Time spent", start_date: "Start date",
  due_date: "Due date", labels: "Labels", custom_fields: "Custom fields", comment: "Comment",
  attachment: "Attachment", link: "Link", created: "Created",
};

export function describeChange(h: { field: string; old_value: string | null; new_value: string | null }) {
  const label = FIELD_LABEL[h.field] ?? h.field;
  if (h.field === "created") return "created the issue";
  if (h.field === "comment") return "commented";
  if (h.field === "description") return "updated the description";
  if (h.field === "attachment") return h.new_value ? `attached ${h.new_value}` : `removed attachment ${h.old_value}`;
  if (h.field === "link") return h.new_value ? `linked: ${h.new_value}` : `removed link: ${h.old_value}`;
  if (!h.old_value) return `set ${label} to ${h.new_value}`;
  if (!h.new_value) return `cleared ${label} (was ${h.old_value})`;
  return `changed ${label}: ${h.old_value} → ${h.new_value}`;
}
