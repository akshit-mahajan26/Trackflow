import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, errorMessage } from "../lib/api";
import { useInvalidateIssues, useSprints } from "../lib/queries";
import type { Sprint } from "../lib/types";
import { useToast } from "./toast";
import { Button, Field, Input, Modal, Select, Textarea } from "./ui";

type SprintLike = Pick<Sprint, "id" | "name" | "goal" | "start_date" | "end_date" | "issue_count" | "done_count">;

export function SprintFormDialog({ projectKey, sprint, mode, onClose }: { projectKey: string; sprint?: SprintLike; mode: "create" | "edit" | "start"; onClose: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const twoWeeks = new Date(Date.now() + 13 * 864e5).toISOString().slice(0, 10);
  const [name, setName] = useState(sprint?.name ?? "");
  const [goal, setGoal] = useState(sprint?.goal ?? "");
  const [start, setStart] = useState(sprint?.start_date ?? (mode === "start" ? today : ""));
  const [end, setEnd] = useState(sprint?.end_date ?? (mode === "start" ? twoWeeks : ""));
  const invalidate = useInvalidateIssues();
  const toast = useToast();
  const m = useMutation({
    mutationFn: async () => {
      const dates = { start_date: start || null, end_date: end || null };
      if (mode === "create") return api.post(`/projects/${projectKey}/sprints`, { name: name || null, goal, ...dates });
      if (mode === "edit") return api.patch(`/sprints/${sprint!.id}`, { name, goal, ...dates });
      if (name !== sprint!.name) await api.patch(`/sprints/${sprint!.id}`, { name });
      return api.post(`/sprints/${sprint!.id}/start`, { goal, ...dates });
    },
    onSuccess: () => {
      invalidate();
      toast.success(mode === "start" ? `${name || "Sprint"} started` : mode === "create" ? "Sprint created" : "Sprint updated");
      onClose();
    },
  });
  const title = { create: "Create sprint", edit: "Edit sprint", start: "Start sprint" }[mode];
  return (
    <Modal open onClose={onClose} title={title}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>{mode === "start" ? "Start" : "Save"}</Button></>}>
      <div className="space-y-3">
        {mode === "start" && <p className="text-sm text-muted">{sprint?.issue_count} issue(s) will be included. Their current story points become the sprint commitment.</p>}
        <Field label="Sprint name"><Input value={name} placeholder="Auto-named if empty" onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start date"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="End date"><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
        <Field label="Sprint goal"><Textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} /></Field>
        {m.isError && <p role="alert" className="text-sm text-danger">{errorMessage(m.error)}</p>}
      </div>
    </Modal>
  );
}

export function CompleteSprintDialog({ projectKey, sprint, onClose }: { projectKey: string; sprint: SprintLike; onClose: () => void }) {
  const { data: future = [] } = useSprints(projectKey, "future");
  const [target, setTarget] = useState<string>("");
  const invalidate = useInvalidateIssues();
  const toast = useToast();
  const incomplete = sprint.issue_count - sprint.done_count;
  const m = useMutation({
    mutationFn: () => api.post<{ completed: number; incomplete: number }>(`/sprints/${sprint.id}/complete`, { move_incomplete_to: target ? Number(target) : null }),
    onSuccess: (r) => {
      invalidate();
      toast.success(`${sprint.name} completed: ${r.completed} done, ${r.incomplete} moved`);
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title={`Complete ${sprint.name}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Complete sprint</Button></>}>
      <div className="space-y-3 text-sm">
        <p><strong>{sprint.done_count}</strong> completed issue(s) stay in this sprint's history.</p>
        {incomplete > 0 ? (
          <Field label={`Move ${incomplete} incomplete issue(s) to`}>
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Backlog</option>
              {future.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        ) : <p className="text-success">All issues are done. 🎉</p>}
        {m.isError && <p role="alert" className="text-danger">{errorMessage(m.error)}</p>}
      </div>
    </Modal>
  );
}
