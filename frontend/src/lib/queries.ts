import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "../components/toast";
import { api, errorMessage } from "./api";
import type { CustomField, IssueDetail, Member, ProjectDetail, ProjectSummary, Sprint, User } from "./types";

export const useProjects = (includeArchived = false) =>
  useQuery({
    queryKey: ["projects", includeArchived],
    queryFn: () => api.get<ProjectSummary[]>(`/projects${includeArchived ? "?include_archived=true" : ""}`),
  });

export const useProject = (key: string | undefined) =>
  useQuery({ queryKey: ["project", key], queryFn: () => api.get<ProjectDetail>(`/projects/${key}`), enabled: !!key });

export const useMembers = (key: string | undefined) =>
  useQuery({ queryKey: ["members", key], queryFn: () => api.get<Member[]>(`/projects/${key}/members`), enabled: !!key });

export const useSprints = (key: string | undefined, state?: string) =>
  useQuery({
    queryKey: ["sprints", key, state],
    queryFn: () => api.get<Sprint[]>(`/projects/${key}/sprints${state ? `?state=${state}` : ""}`),
    enabled: !!key,
  });

export const useFields = (key: string | undefined) =>
  useQuery({ queryKey: ["fields", key], queryFn: () => api.get<CustomField[]>(`/projects/${key}/fields`), enabled: !!key });

export const useLabels = (key: string | undefined) =>
  useQuery({ queryKey: ["labels", key], queryFn: () => api.get<string[]>(`/projects/${key}/labels`), enabled: !!key });

export const useUsers = () => useQuery({ queryKey: ["users"], queryFn: () => api.get<User[]>("/users"), staleTime: 60_000 });

export const useIssue = (key: string | undefined) =>
  useQuery({ queryKey: ["issue", key], queryFn: () => api.get<IssueDetail>(`/issues/${key}`), enabled: !!key });

/** Invalidate everything that may display issue data. */
export function useInvalidateIssues() {
  const qc = useQueryClient();
  return (key?: string) => {
    for (const k of ["issues", "board", "backlog", "dashboard", "sprints", "labels", "reports"]) qc.invalidateQueries({ queryKey: [k] });
    if (key) qc.invalidateQueries({ queryKey: ["issue", key] });
    qc.invalidateQueries({ queryKey: ["issue-history"] });
  };
}

/** PATCH an issue with optimistic-concurrency version; refreshes caches and surfaces conflicts. */
export function useUpdateIssue(issueKey: string) {
  const invalidate = useInvalidateIssues();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (changes: Record<string, unknown>) => api.patch<IssueDetail>(`/issues/${issueKey}`, changes),
    onSuccess: (data) => {
      qc.setQueryData(["issue", issueKey], data);
      invalidate(issueKey);
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      invalidate(issueKey);
    },
  });
}

export const can = (project: ProjectDetail | undefined, permission: string) => !!project?.permissions.includes(permission);
