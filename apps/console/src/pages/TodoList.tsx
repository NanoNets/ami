import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TodoDto } from "@ami/shared";
import { api } from "../lib/api";
import { timeAgo } from "../lib/time";
import { toast, errMsg } from "../lib/toast";
import { ConnectorIcon } from "../components/ConnectorIcon";
import { Markdown } from "../components/Markdown";
import { ExternalIcon, SproutIcon } from "../components/icons";
import { OverflowMenu, SkeletonRows } from "../components/ui";
import { DueBy, StartContextPanel, StatusStepper } from "../components/TaskControls";

type UndoState = { id: string; title: string; verb: string } | null;

type TaskSort = "newest" | "due";

export default function TodoList() {
  const qc = useQueryClient();
  const { data: todos = [], isLoading } = useQuery({ queryKey: ["todos"], queryFn: api.todos });
  const [undo, setUndo] = useState<UndoState>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sort, setSort] = useState<TaskSort>(
    () => (localStorage.getItem("ami.todoSort") === "due" ? "due" : "newest"),
  );
  const changeSort = (s: TaskSort) => {
    setSort(s);
    localStorage.setItem("ami.todoSort", s);
  };

  // A dismissal/snooze shows a quiet 6-second undo row instead of a confirm.
  const showUndo = (u: NonNullable<UndoState>) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(u);
    undoTimer.current = setTimeout(() => setUndo(null), 6000);
  };
  const doUndo = async () => {
    if (!undo) return;
    setUndo(null);
    await api.reopenTodo(undo.id).catch((e) => toast.error(errMsg(e)));
    void qc.invalidateQueries({ queryKey: ["todos"] });
  };

  const visible = todos.filter((t) => !["dismissed", "resolved"].includes(t.status));
  const tasks = visible
    .filter((t) => t.type === "task" && t.status !== "snoozed")
    .sort(
      sort === "due"
        ? // Soonest deadline first; undated tasks sink to the bottom.
          (a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") || b.createdAt.localeCompare(a.createdAt)
        : (a, b) => b.createdAt.localeCompare(a.createdAt),
    );
  const fyis = visible.filter((t) => t.type === "fyi" && t.status !== "snoozed");
  const snoozed = visible.filter((t) => t.status === "snoozed");

  if (isLoading)
    return (
      <div className="space-y-8">
        <SkeletonRows count={3} />
      </div>
    );

  const undoRow = undo && (
    <div className="card px-4 py-2 text-sm flex items-center gap-2">
      <span className="text-mut min-w-0 truncate">
        {undo.verb} “{undo.title}”
      </span>
      <button className="btn text-xs ml-auto shrink-0" onClick={doUndo}>
        Undo
      </button>
    </div>
  );

  if (visible.length === 0)
    return (
      <div className="space-y-8">
        {undoRow}
        <div className="text-center py-24 text-mut">
          <SproutIcon className="mx-auto mb-4 text-mut/60" size={32} />
          <p>Nothing yet — ami is watching your connected tools.</p>
          <p className="text-sm mt-2">
            Connect tools in <Link className="text-acc" to="/settings">Settings</Link> and new work
            lands here as it arrives.
          </p>
        </div>
      </div>
    );

  return (
    <div className="space-y-8">
      {undoRow}
      <Section title={`Tasks (${tasks.length})`} controls={<SortToggle sort={sort} onChange={changeSort} />}>
        {tasks.map((t) => (
          <TodoCard key={t.id} todo={t} onUndoable={showUndo} />
        ))}
      </Section>
      {fyis.length > 0 && (
        <Section title={`For your information (${fyis.length})`}>
          {fyis.map((t) => (
            <TodoCard key={t.id} todo={t} onUndoable={showUndo} />
          ))}
        </Section>
      )}
      {snoozed.length > 0 && (
        <Section title={`Snoozed (${snoozed.length})`}>
          {snoozed.map((t) => (
            <TodoCard key={t.id} todo={t} onUndoable={showUndo} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  controls,
  children,
}: {
  title: string;
  controls?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm uppercase tracking-wider text-mut">{title}</h2>
        {controls}
      </div>
      <div className="space-y-3 rise-stagger">{children}</div>
    </section>
  );
}

function SortToggle({ sort, onChange }: { sort: TaskSort; onChange: (s: TaskSort) => void }) {
  return (
    <span className="flex items-center gap-2 text-xs">
      <span className="text-mut">sort:</span>
      {(
        [
          ["newest", "newest"],
          ["due", "due by"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          className={`cursor-pointer transition-colors ${sort === value ? "text-hi font-medium" : "text-mut hover:text-hi"}`}
          aria-pressed={sort === value}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

/* ---------- card ---------- */

function TodoCard({
  todo,
  onUndoable,
}: {
  todo: TodoDto;
  onUndoable: (u: { id: string; title: string; verb: string }) => void;
}) {
  const qc = useQueryClient();
  const [planOpen, setPlanOpen] = useState(false);
  const [askContext, setAskContext] = useState<"plan" | "start" | null>(null);
  const [exiting, setExiting] = useState(false);
  const action = useMutation({
    mutationFn: ({
      act,
      context,
      opts,
    }: {
      act: "plan" | "start" | "resolve" | "dismiss" | "snooze";
      context?: string;
      opts?: { projectId: string; policy: string };
    }) => api.todoAction(todo.id, act, context, opts),
    // The card starts sliding out the moment you click — the server call runs
    // behind the animation instead of in front of it.
    onMutate: ({ act }) => {
      if (["resolve", "dismiss", "snooze"].includes(act)) setExiting(true);
    },
    onSuccess: (_res, vars) => {
      setAskContext(null);
      if (["resolve", "dismiss", "snooze"].includes(vars.act)) {
        setTimeout(() => {
          if (vars.act === "dismiss") onUndoable({ id: todo.id, title: todo.title, verb: "Dismissed" });
          if (vars.act === "snooze") onUndoable({ id: todo.id, title: todo.title, verb: "Snoozed" });
          qc.setQueryData<TodoDto[]>(["todos"], (prev) =>
            prev?.map((t) =>
              t.id === todo.id
                ? { ...t, status: vars.act === "resolve" ? "resolved" : vars.act === "dismiss" ? "dismissed" : "snoozed" }
                : t,
            ),
          );
          void qc.invalidateQueries({ queryKey: ["todos"] });
        }, 200);
      } else {
        void qc.invalidateQueries({ queryKey: ["todos"] });
      }
    },
    onError: (e) => {
      setExiting(false);
      toast.error(errMsg(e));
    },
  });
  const unsnooze = useMutation({
    mutationFn: () => api.reopenTodo(todo.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["todos"] }),
    onError: (e) => toast.error(errMsg(e)),
  });

  const busy = action.isPending;
  const isTask = todo.type === "task";
  const running = todo.status === "running";

  // One visible action per card; everything secondary lives in the ⋯ menu.
  const menuItems = [
    ...(isTask && todo.status === "open"
      ? [{ label: "Plan first", onClick: () => setAskContext(askContext === "plan" ? null : "plan"), disabled: busy }]
      : []),
    ...(isTask && ["open", "planned", "awaiting_review"].includes(todo.status)
      ? [{ label: "Mark resolved", onClick: () => action.mutate({ act: "resolve" }), disabled: busy }]
      : []),
    ...(todo.status === "snoozed"
      ? [{ label: "Unsnooze", onClick: () => unsnooze.mutate(), disabled: unsnooze.isPending }]
      : [{ label: "Snooze until tomorrow", onClick: () => action.mutate({ act: "snooze" }), disabled: busy }]),
    { label: "Dismiss", onClick: () => action.mutate({ act: "dismiss" }), danger: true, disabled: busy },
  ];

  // Hovering the title warms the detail page's cache so the click lands instantly.
  const prefetch = () =>
    void qc.prefetchQuery({ queryKey: ["task", todo.id], queryFn: () => api.task(todo.id), staleTime: 15_000 });

  return (
    <div className={`card p-4 ${exiting ? "row-exit" : ""}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <Link
            to={`/tasks/${todo.id}`}
            className="font-medium hover:text-acc transition-colors"
            onMouseEnter={prefetch}
            onFocus={prefetch}
          >
            {todo.title}
          </Link>
          <p className="text-sm text-mut mt-1">{todo.summary}</p>

          {/* open tasks get no stepper — title + summary is the whole story */}
          {(!isTask || todo.status !== "open") && (
            <div className="mt-4 mb-1">
              {isTask ? (
                <StatusStepper status={todo.status} />
              ) : (
                <span className="text-xs text-mut uppercase tracking-wide">fyi — no action needed</span>
              )}
            </div>
          )}

          {todo.hasPendingDraft && !["awaiting_review", "resolved", "dismissed"].includes(todo.status) && (
            <Link
              to={`/tasks/${todo.id}`}
              className="inline-flex items-center gap-1.5 mt-3 text-xs text-acc hover:underline"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-acc inline-block" />
              reply drafted — review &amp; send
            </Link>
          )}

          {askContext && (
            <StartContextPanel
              todo={todo}
              act={askContext}
              busy={busy}
              onSubmit={(context, opts) => action.mutate({ act: askContext, context, opts })}
              onCancel={() => setAskContext(null)}
            />
          )}
          {todo.planMd && todo.status === "planned" && (
            <PlanReview todo={todo} open={planOpen} setOpen={setPlanOpen} />
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {isTask && todo.status === "open" && (
            <button
              className={`btn btn-primary ${askContext === "start" ? "opacity-80" : ""}`}
              disabled={busy}
              onClick={() => setAskContext(askContext === "start" ? null : "start")}
            >
              Start
            </button>
          )}
          {isTask && todo.status === "planned" && (
            <button className="btn btn-primary" onClick={() => setPlanOpen((v) => !v)}>
              {planOpen ? "Hide plan" : "Review plan"}
            </button>
          )}
          {(running || todo.status === "awaiting_review") && (
            <Link to={`/tasks/${todo.id}`} className="btn btn-primary text-center">
              {running ? "Watch" : "Review"}
            </Link>
          )}
          <OverflowMenu items={menuItems} />
        </div>
      </div>

      {/* footer: source bottom-left, due date + created time bottom-right */}
      <div className="flex items-center justify-between border-t border-edge mt-3 pt-2.5">
        <span className="flex items-center gap-2 text-xs text-mut min-w-0">
          <ConnectorIcon id={todo.connector} size={14} />
          {todo.connector === "chat" ? (
            <span className="truncate">from ami chat</span>
          ) : (
            todo.sourceAuthor && <span className="truncate">{todo.sourceAuthor}</span>
          )}
          {todo.sourceUrl &&
            (todo.sourceUrl.startsWith("/") ? (
              // In-app source (e.g. the chat conversation that created this) —
              // navigate in place instead of opening a tab.
              <Link to={todo.sourceUrl} className="text-acc hover:underline shrink-0">
                source
              </Link>
            ) : (
              <a
                href={todo.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="text-acc hover:underline shrink-0 inline-flex items-center gap-1"
              >
                source <ExternalIcon size={11} />
              </a>
            ))}
        </span>
        <span className="flex items-center gap-3 shrink-0">
          {isTask && <DueBy todo={todo} />}
          <span className="text-xs text-mut" title={new Date(todo.createdAt).toLocaleString()}>
            {timeAgo(todo.createdAt)}
          </span>
        </span>
      </div>
    </div>
  );
}

function PlanReview({
  todo,
  open,
  setOpen,
}: {
  todo: TodoDto;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [feedbackText, setFeedbackText] = useState("");
  const feedback = useMutation({
    mutationFn: () => api.planFeedback(todo.id, feedbackText),
    onSuccess: () => {
      setFeedbackText("");
      void qc.invalidateQueries({ queryKey: ["todos"] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const approve = useMutation({
    mutationFn: () => api.planApprove(todo.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["todos"] }),
    onError: (e) => toast.error(errMsg(e)),
  });

  if (!open) return null;
  return (
    <div className="mt-3 bg-panel2 border border-edge p-4">
      <div className="max-h-72 overflow-y-auto">
        <Markdown>{todo.planMd ?? ""}</Markdown>
      </div>
      <div className="mt-3 flex gap-2 items-start">
        <textarea
          className="input h-16"
          placeholder="Feedback to revise the plan (ami remembers this for future tasks)…"
          value={feedbackText}
          onChange={(e) => setFeedbackText(e.target.value)}
        />
      </div>
      <div className="mt-2 flex gap-2">
        <button
          className="btn"
          disabled={!feedbackText.trim() || feedback.isPending}
          onClick={() => feedback.mutate()}
        >
          {feedback.isPending ? "Revising…" : "Send feedback"}
        </button>
        <button className="btn btn-primary" disabled={approve.isPending} onClick={() => approve.mutate()}>
          Approve & start
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
    </div>
  );
}
