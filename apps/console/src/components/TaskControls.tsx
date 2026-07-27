import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TodoDto } from "@ami/shared";
import { api } from "../lib/api";
import { toast, errMsg } from "../lib/toast";

/** Pieces shared between the to-do card and the task detail page: the status
 * stepper, the click-to-edit due date, and the "anything ami
 * should know?" panel that fronts Plan/Start. */

/* ---------- status stepper: the task's resolution pipeline ---------- */

const PIPELINE = ["open", "planned", "running", "awaiting_review", "resolved"] as const;
const STAGE_LABEL: Record<string, string> = {
  open: "Open",
  planned: "Planned",
  running: "Running",
  awaiting_review: "Review",
  resolved: "Done",
};

/** Rendered only once a task is actually in flight (planned+) — an open task
 * showing four gray dots is noise, not information. */
export function StatusStepper({ status }: { status: string }) {
  if (status === "snoozed") {
    return <span className="text-xs text-mut italic">snoozed — returns tomorrow 9am</span>;
  }
  const idx = PIPELINE.indexOf(status as (typeof PIPELINE)[number]);
  if (idx < 1) return null;
  return (
    <div className="flex items-start pl-4">
      {PIPELINE.map((stage, i) => {
        const done = i < idx;
        const current = i === idx;
        return (
          <div key={stage} className="flex items-start">
            {i > 0 && <div className={`h-px w-16 mt-[5px] ${i <= idx ? "bg-hi/50" : "bg-edge2"}`} />}
            <div className="flex flex-col items-center w-0">
              <span
                className={`rounded-full shrink-0 ${
                  current
                    ? "w-[11px] h-[11px] ring-2 ring-acc/25 bg-acc"
                    : `w-[7px] h-[7px] mt-[2px] ${done ? "bg-hi/50" : "bg-edge2"}`
                }`}
              />
              <span
                className={`mt-2 text-[10px] leading-none whitespace-nowrap ${
                  current ? "text-acc font-semibold" : done ? "text-mut" : "text-mut/50"
                }`}
              >
                {STAGE_LABEL[stage]}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- due date: glanceable, click to edit ---------- */

function dueMeta(dueAt: string): { text: string; cls: string } {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const days = Math.round((Date.parse(dueAt) - Date.parse(todayStr)) / 86400_000);
  const pretty = new Date(`${dueAt}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (days < 0) return { text: `overdue — was due ${pretty}`, cls: "text-bad" };
  if (days === 0) return { text: "due today", cls: "text-warn" };
  if (days === 1) return { text: "due tomorrow", cls: "text-warn" };
  return { text: `due ${pretty}`, cls: "text-mut" };
}

export function DueBy({ todo }: { todo: TodoDto }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const save = useMutation({
    mutationFn: (dueAt: string) => api.setTodoDue(todo.id, dueAt),
    // Optimistic: the new date shows the instant it's picked.
    onMutate: (dueAt) => {
      setEditing(false);
      qc.setQueryData<TodoDto[]>(["todos"], (prev) => prev?.map((t) => (t.id === todo.id ? { ...t, dueAt } : t)));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["todos"] }),
    onError: (e) => toast.error(errMsg(e)),
  });

  // A finished task no longer has a deadline to count down — show when it was
  // done instead of a due date or the "set due date" prompt.
  if (todo.status === "resolved") {
    const done = new Date(todo.updatedAt);
    const pretty = done.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(done.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
    });
    return (
      <span className="text-xs text-ok" title={`Resolved ${done.toLocaleString()}`}>
        done {pretty}
      </span>
    );
  }

  if (editing)
    return (
      <input
        type="date"
        className="input w-auto h-6 text-xs py-0 px-1"
        defaultValue={todo.dueAt ?? ""}
        autoFocus
        onBlur={() => setEditing(false)}
        onChange={(e) => {
          if (e.target.value) save.mutate(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  if (!todo.dueAt)
    return (
      <button
        className="text-xs text-mut/70 hover:text-hi cursor-pointer"
        title="Set a due date"
        onClick={() => setEditing(true)}
      >
        set due date
      </button>
    );
  const { text, cls } = dueMeta(todo.dueAt);
  return (
    <button
      className={`text-xs ${cls} hover:underline cursor-pointer`}
      title="Click to change the due date"
      onClick={() => setEditing(true)}
    >
      {text}
    </button>
  );
}

/* ---------- pre-start context panel ---------- */

export function StartContextPanel({
  todo,
  act,
  busy,
  onSubmit,
  onCancel,
}: {
  todo: TodoDto;
  act: "plan" | "start";
  busy: boolean;
  onSubmit: (context: string, opts?: { projectId: string; policy: string }) => void;
  onCancel: () => void;
}) {
  const [contextText, setContextText] = useState("");
  // Pre-select the auto-attached project; the user can still detach or switch.
  const [projectId, setProjectId] = useState(todo.projectId ?? "");
  const [policy, setPolicy] = useState("ask-risky");
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: api.projects });

  return (
    <div className="mt-4 bg-panel2 border border-edge p-3">
      <p className="text-xs text-mut mb-2">
        Anything ami should know before it {act === "plan" ? "plans" : "starts"} this task? (optional)
      </p>
      <textarea
        autoFocus
        className="input h-16"
        placeholder="e.g. the repo is /new-website, keep the tone casual, use the google doc template, don't touch pricing…"
        value={contextText}
        onChange={(e) => setContextText(e.target.value)}
      />
      <div className="flex gap-2 mt-2 flex-wrap">
          <select
            className="input w-auto text-xs"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            title="Attaching a code project makes this a coding run: isolated worktree, full coding toolset"
          >
            <option value="">no code project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                worktree: {p.name}
              </option>
            ))}
          </select>
          <select
            className="input w-auto text-xs"
            value={policy}
            onChange={(e) => setPolicy(e.target.value)}
            title="Permission policy for this run"
          >
            <option value="ask-risky">ask before risky actions</option>
            <option value="ask-all">ask before every action</option>
            <option value="full-auto">full auto</option>
          </select>
        </div>
      <div className="flex gap-2 mt-2">
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => onSubmit(contextText, { projectId, policy })}
        >
          {busy ? "Starting…" : act === "plan" ? "Plan task" : "Start task"}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
