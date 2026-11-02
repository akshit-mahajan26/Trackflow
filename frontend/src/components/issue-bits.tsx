import clsx from "clsx";
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  Bug,
  CheckSquare,
  ChevronsDown,
  ChevronsUp,
  Equal,
  GitBranch,
  Sparkles,
  Zap,
} from "lucide-react";
import { Link } from "react-router-dom";
import { CATEGORY_TONE, isOverdue, priorityMeta, typeMeta } from "../lib/format";
import type { Issue, IssueType, Member, Priority, Status, UserBrief } from "../lib/types";
import { Avatar, Badge, Select } from "./ui";

const TYPE_ICON = { epic: Zap, story: Bookmark, task: CheckSquare, bug: Bug, improvement: Sparkles, subtask: GitBranch };

export function IssueTypeIcon({ type, size = 16 }: { type: IssueType; size?: number }) {
  const Icon = TYPE_ICON[type] ?? CheckSquare;
  const meta = typeMeta(type);
  return (
    <span title={meta.label} aria-label={meta.label} className="inline-flex shrink-0 items-center justify-center rounded-sm"
      style={{ background: meta.color, width: size, height: size }}>
      <Icon size={size * 0.7} color="white" strokeWidth={2.5} />
    </span>
  );
}

const PRIO_ICON = { highest: ChevronsUp, high: ArrowUp, medium: Equal, low: ArrowDown, lowest: ChevronsDown };

export function PriorityIcon({ priority, size = 16 }: { priority: Priority; size?: number }) {
  const Icon = PRIO_ICON[priority] ?? Equal;
  const meta = priorityMeta(priority);
  return (
    <span title={`${meta.label} priority`} aria-label={`${meta.label} priority`} className="inline-flex">
      <Icon size={size} color={meta.color} strokeWidth={2.5} />
    </span>
  );
}

export function StatusBadge({ status }: { status: Pick<Status, "name" | "category"> }) {
  return <Badge tone={CATEGORY_TONE[status.category]}>{status.name}</Badge>;
}

export function IssueKeyLink({ issueKey, className }: { issueKey: string; className?: string }) {
  return (
    <Link to={`/issues/${issueKey}`} className={clsx("font-medium text-muted hover:text-primary hover:underline", className)}>
      {issueKey}
    </Link>
  );
}

export function DueDate({ due, category }: { due: string | null; category?: Status["category"] }) {
  if (!due) return null;
  const overdue = isOverdue(due, category);
  return (
    <span className={clsx("text-xs tabular-nums", overdue ? "font-semibold text-danger" : "text-muted")} title={overdue ? "Overdue" : "Due date"}>
      {new Date(due + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" })}
    </span>
  );
}

export function Points({ value }: { value: number | null }) {
  if (value === null || value === undefined) return null;
  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-surface-3 px-1.5 text-[11px] font-semibold tabular-nums" title="Story points">
      {Number.isInteger(value) ? value : value.toFixed(1)}
    </span>
  );
}

/** Compact card used by boards and backlog. */
export function IssueCardBody({ issue, compact }: { issue: Issue; compact?: boolean }) {
  return (
    <div className="min-w-0">
      <p className={clsx("text-sm leading-snug", compact ? "truncate" : "line-clamp-3")}>{issue.summary}</p>
      {!compact && (issue.parent_key || issue.labels.length > 0) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {issue.parent_key && (
            <span className="max-w-[160px] truncate rounded bg-[#7c3aed]/12 px-1.5 py-0.5 text-[11px] font-medium text-[#7c3aed] dark:text-[#b794f6]" title={issue.parent_summary ?? ""}>
              {issue.parent_summary ?? issue.parent_key}
            </span>
          )}
          {issue.labels.slice(0, 3).map((l) => (
            <span key={l} className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] text-muted">{l}</span>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <IssueTypeIcon type={issue.issue_type} size={14} />
        <span className="text-xs font-medium text-muted">{issue.key}</span>
        {issue.child_count > 0 && (
          <span className="text-[11px] text-subtle" title="Subtasks done">{issue.child_done_count}/{issue.child_count}</span>
        )}
        <span className="flex-1" />
        <DueDate due={issue.due_date} category={issue.status.category} />
        <Points value={issue.story_points} />
        <PriorityIcon priority={issue.priority} size={14} />
        <Avatar user={issue.assignee} size={20} />
      </div>
    </div>
  );
}

export function UserSelect({
  members,
  value,
  onChange,
  allowEmpty = true,
  emptyLabel = "Unassigned",
  disabled,
  id,
  excludeViewers = true,
}: {
  members: (Member | { user: UserBrief; role?: string })[];
  value: number | null;
  onChange: (v: number | null) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  disabled?: boolean;
  id?: string;
  excludeViewers?: boolean;
}) {
  const list = members.filter((m) => !excludeViewers || m.role !== "viewer");
  return (
    <Select id={id} value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      {allowEmpty && <option value="">{emptyLabel}</option>}
      {list.map((m) => (
        <option key={m.user.id} value={m.user.id}>{m.user.full_name}</option>
      ))}
    </Select>
  );
}
