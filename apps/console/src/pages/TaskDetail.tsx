import { Fragment, useState, type ReactElement, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { worktreeBranchForTodo, type ArtifactDto, type DraftDto, type TaskRunDto, type TaskStepDto, type TodoDto } from "@ami/shared";
import { api } from "../lib/api";
import { timeAgo } from "../lib/time";
import { toast, errMsg } from "../lib/toast";
import { Markdown } from "../components/Markdown";
import { StepTimeline } from "../components/StepTimeline";
import { QuestionCard } from "../components/QuestionCard";
import { DraftEditor } from "../components/DraftCard";
import { ConnectorIcon } from "../components/ConnectorIcon";
import { OverflowMenu, SkeletonRows } from "../components/ui";
import { DueBy, StartContextPanel, StatusStepper } from "../components/TaskControls";
import {
  BoxIcon,
  BranchIcon,
  CalendarIcon,
  CheckIcon,
  ExternalIcon,
  FileIcon,
  MegaphoneIcon,
  PaperclipIcon,
  PlusIcon,
  VideoIcon,
} from "../components/icons";

/** The task's home: full controls in the header, and every lane of the task's
 * life — task runs (plan + execution), deliverables, drafted replies,
 * follow-up — always visible, with honest empty states before they fill in. */

export default function TaskDetail() {
  const { todoId = "" } = useParams();
  const { data: todos = [], isLoading: todosLoading } = useQuery({ queryKey: ["todos"], queryFn: api.todos });
  const todo = todos.find((t) => t.id === todoId);
  const { data, isLoading } = useQuery({
    queryKey: ["task", todoId],
    queryFn: () => api.task(todoId),
    refetchInterval: (q) =>
      q.state.data?.runs.some((r) => r.status === "running" || r.status === "queued") ? 2500 : false,
  });

  const { data: pendingQuestions = [] } = useQuery({
    queryKey: ["questions"],
    queryFn: api.questions,
    refetchInterval: 5000,
  });
  const todoQuestions = pendingQuestions.filter((q) => q.todoId === todoId);

  if (isLoading || !data || todosLoading)
    return (
      <div className="space-y-4">
        <SkeletonRows count={2} height="h-32" />
      </div>
    );
  const { runs, steps, artifacts, drafts } = data;
  const activeRun = runs.find((r) => r.status === "running");

  return (
    <div>
      <Link to="/todos" className="text-sm text-mut hover:text-hi">
        ← back to list
      </Link>

      {todo ? (
        <HeaderCard todo={todo} />
      ) : (
        <div className="card p-5 mt-3 mb-6">
          <h1 className="text-xl font-semibold">{todoId}</h1>
          <p className="text-sm text-mut mt-1">This to-do no longer exists (it may have been dismissed).</p>
        </div>
      )}

      {todoQuestions.length > 0 && (
        <div className="space-y-3 mb-6">
          {todoQuestions.map((q) => (
            <QuestionCard key={q.id} q={q} />
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <TaskRunsSection todo={todo} runs={runs} steps={steps} activeRun={activeRun} />
        </div>
        <div className="space-y-6">
          <ArtifactPanel artifacts={artifacts} todo={todo} />
          <DraftPanel drafts={drafts} />
        </div>
      </div>
    </div>
  );
}

/* ---------- header: title, controls, pipeline, metadata ---------- */

function HeaderCard({ todo }: { todo: TodoDto }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [askContext, setAskContext] = useState<"plan" | "start" | null>(null);
  const isTask = todo.type === "task";

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
    onSuccess: (_res, vars) => {
      setAskContext(null);
      void qc.invalidateQueries({ queryKey: ["todos"] });
      void qc.invalidateQueries({ queryKey: ["task", todo.id] });
      if (vars.act === "dismiss") {
        toast(`Dismissed "${todo.title}"`);
        navigate("/todos");
      }
      if (vars.act === "snooze") toast("Snoozed — returns tomorrow 9am");
      if (vars.act === "resolve") toast("Marked resolved");
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const unsnooze = useMutation({
    mutationFn: () => api.reopenTodo(todo.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["todos"] }),
    onError: (e) => toast.error(errMsg(e)),
  });

  const busy = action.isPending;
  const done = ["resolved", "dismissed"].includes(todo.status);
  const menuItems = [
    ...(isTask && todo.status === "open"
      ? [{ label: "Plan first", onClick: () => setAskContext(askContext === "plan" ? null : "plan"), disabled: busy }]
      : []),
    ...(isTask && ["open", "planned", "awaiting_review"].includes(todo.status)
      ? [{ label: "Mark resolved", onClick: () => action.mutate({ act: "resolve" }), disabled: busy }]
      : []),
    ...(todo.status === "snoozed"
      ? [{ label: "Unsnooze", onClick: () => unsnooze.mutate(), disabled: unsnooze.isPending }]
      : done
        ? []
        : [{ label: "Snooze until tomorrow", onClick: () => action.mutate({ act: "snooze" }), disabled: busy }]),
    ...(done ? [] : [{ label: "Dismiss", onClick: () => action.mutate({ act: "dismiss" }), danger: true, disabled: busy }]),
  ];

  return (
    <div className="card p-5 mt-3 mb-6">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold">{todo.title}</h1>
          {todo.summary && <p className="text-mut mt-1 text-sm whitespace-pre-wrap">{todo.summary}</p>}
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
          {todo.status === "resolved" && (
            <span className="text-ok text-sm inline-flex items-center gap-1">
              <CheckIcon /> resolved
            </span>
          )}
          <OverflowMenu items={menuItems} />
        </div>
      </div>

      {isTask && todo.status !== "open" && (
        <div className="mt-5">
          <StatusStepper status={todo.status} />
        </div>
      )}
      {!isTask && (
        <span className="block mt-3 text-xs text-mut uppercase tracking-wide">fyi — no action needed</span>
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

      {/* metadata: where it came from, what kind it is, when it's due */}
      <div className="flex items-center gap-3 flex-wrap border-t border-edge mt-4 pt-3">
        <span className="flex items-center gap-2 text-xs text-mut min-w-0">
          <ConnectorIcon id={todo.connector} size={14} />
          {todo.connector === "chat" ? (
            <span className="truncate">from ami chat</span>
          ) : (
            todo.sourceAuthor && <span className="truncate">{todo.sourceAuthor}</span>
          )}
          {todo.sourceUrl &&
            (todo.sourceUrl.startsWith("/") ? (
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
        {isTask && <DueBy todo={todo} />}
        <span className="text-xs text-mut ml-auto" title={new Date(todo.createdAt).toLocaleString()}>
          created {timeAgo(todo.createdAt)}
        </span>
      </div>
    </div>
  );
}

/* ---------- shared section chrome ---------- */

function SectionTitle({ children, className = "mb-3" }: { children: ReactNode; className?: string }) {
  return <h2 className={`text-sm uppercase tracking-wider text-mut ${className}`}>{children}</h2>;
}

/** A lane that exists but hasn't filled in yet — dashed border marks it as a
 * placeholder, and the copy says what will land there. */
function EmptyLane({ children }: { children: ReactNode }) {
  return <div className="card border-dashed p-4 text-sm text-mut">{children}</div>;
}

/* ---------- task runs: plans and executions living together ---------- */

/** One lane for everything ami has run on this task, in the order it
 * happened: planning runs, the plan they produced, execution runs — each in
 * its own sub-card. Below the runs, a follow-up button resumes the task. */
function TaskRunsSection({
  todo,
  runs,
  steps,
  activeRun,
}: {
  todo: TodoDto | undefined;
  runs: TaskRunDto[];
  steps: TaskStepDto[];
  activeRun: TaskRunDto | undefined;
}) {
  // The plan document reads as the artifact of the planning run that wrote
  // it, so it renders right below the latest planning run.
  const lastPlanRunId = runs.filter((r) => r.mode === "plan").at(-1)?.id;

  return (
    <section>
      <SectionTitle>
        Task runs {runs.length > 0 && `(${runs.length})`}
        {activeRun && <span className="text-acc normal-case tracking-normal"> · running…</span>}
      </SectionTitle>

      <div className="space-y-4">
        {todo?.planMd && !lastPlanRunId && <PlanDocument todo={todo} />}

        {runs.length === 0 && !todo?.planMd && (
          <EmptyLane>
            <strong>Start</strong> hands this task to ami, and every step it takes
            shows up here live. 
            <br/>
            <strong>Plan first</strong> (in the ⋯ menu) has ami lay out the
            steps in an editable plan before anything executes.
          </EmptyLane>
        )}

        {runs.map((r) => (
          <Fragment key={r.id}>
            <RunTimeline
              run={r}
              index={runs.filter((o) => o.mode === r.mode).indexOf(r)}
              steps={steps.filter((s) => s.runId === r.id)}
            />
            {r.id === lastPlanRunId && todo?.planMd && <PlanDocument todo={todo} />}
          </Fragment>
        ))}

        {runs.length > 0 && <FollowUp todoId={runs[0].todoId} disabled={!!activeRun} />}
      </div>
    </section>
  );
}

/** The plan itself — the artifact of the plan lane, rendered as markdown.
 * Editable in place: Save writes the edited markdown back, and approval
 * executes exactly the stored (possibly edited) plan. */
function PlanDocument({ todo }: { todo: TodoDto }) {
  const qc = useQueryClient();
  const [feedbackText, setFeedbackText] = useState("");
  const [editText, setEditText] = useState<string | null>(null); // null = viewing
  const feedback = useMutation({
    mutationFn: () => api.planFeedback(todo.id, feedbackText),
    onSuccess: () => {
      setFeedbackText("");
      toast("Feedback sent — ami is revising the plan");
      void qc.invalidateQueries({ queryKey: ["todos"] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const approve = useMutation({
    mutationFn: () => api.planApprove(todo.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["todos"] });
      void qc.invalidateQueries({ queryKey: ["task", todo.id] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const save = useMutation({
    mutationFn: (planMd: string) => api.savePlan(todo.id, planMd),
    onSuccess: () => {
      setEditText(null);
      toast("Plan saved — approval runs this version");
      void qc.invalidateQueries({ queryKey: ["todos"] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (!todo.planMd) return null;
  const editing = editText !== null;
  return (
    <div className="card p-4">
      <div className="flex items-center mb-2">
        <div className="text-xs uppercase tracking-wider text-mut">Proposed plan</div>
        {!editing && (
          <button className="btn text-xs ml-auto" onClick={() => setEditText(todo.planMd ?? "")}>
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <>
          <textarea
            className="input h-72 font-mono text-xs leading-relaxed"
            autoFocus
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
          />
          <div className="mt-2 flex gap-2">
            <button
              className="btn btn-primary"
              disabled={!editText.trim() || save.isPending}
              onClick={() => save.mutate(editText)}
            >
              {save.isPending ? "Saving…" : "Save plan"}
            </button>
            <button className="btn" disabled={save.isPending} onClick={() => setEditText(null)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          <Markdown>{todo.planMd}</Markdown>
        </div>
      )}
      {todo.status === "planned" && !editing && (
        <div className="border-t border-edge mt-3 pt-3">
          <textarea
            className="input h-16"
            placeholder="Feedback to revise the plan (ami remembers this for future tasks)…"
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
          />
          <div className="mt-2 flex gap-2">
            <button className="btn btn-primary" disabled={approve.isPending} onClick={() => approve.mutate()}>
              {approve.isPending ? "Starting…" : "Approve & start"}
            </button>
            <button
              className="btn"
              disabled={!feedbackText.trim() || feedback.isPending}
              onClick={() => feedback.mutate()}
            >
              {feedback.isPending ? "Revising…" : "Send feedback"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- a single run ---------- */

function RunTimeline({ run, index, steps }: { run: TaskRunDto; index: number; steps: TaskStepDto[] }) {
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => api.cancelRun(run.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["task"] }),
    onError: (e) => toast.error(errMsg(e)),
  });
  const statusColor =
    run.status === "succeeded"
      ? "text-ok"
      : run.status === "failed"
        ? "text-bad"
        : run.status === "running"
          ? "text-acc"
          : "text-mut";
  const duration =
    run.startedAt && run.finishedAt
      ? `${Math.max(1, Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000))}s`
      : null;
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-sm font-medium">
          {run.mode === "plan" ? "Planning" : "Run"} #{index + 1}
        </span>
        <span className={`text-xs ${statusColor}`}>{run.status}</span>
        {duration && <span className="text-xs text-mut">· {duration}</span>}
        {run.costUsd > 0 && (
          <span className="text-xs text-mut" title={`${run.inputTokens} in / ${run.outputTokens} out tokens`}>
            · ${run.costUsd.toFixed(run.costUsd < 0.1 ? 3 : 2)}
          </span>
        )}
        {run.status === "running" && (
          <button className="btn ml-auto text-xs" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            {cancel.isPending ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>
      <div className="max-h-[32rem] overflow-y-auto pr-1">
        <StepTimeline run={run} steps={steps} />
      </div>
    </div>
  );
}

/* ---------- deliverables ---------- */

const artifactIcon: Record<string, ReactElement> = {
  pr: <BranchIcon />,
  doc: <FileIcon />,
  calendar_event: <CalendarIcon />,
  meeting_link: <VideoIcon />,
  post: <MegaphoneIcon />,
  file: <PaperclipIcon />,
  branch: <BranchIcon />,
  other: <BoxIcon />,
};

function ArtifactPanel({ artifacts, todo }: { artifacts: ArtifactDto[]; todo: TodoDto | undefined }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section>
      <SectionTitle>Deliverables {artifacts.length > 0 && `(${artifacts.length})`}</SectionTitle>
      {artifacts.length === 0 ? (
        <EmptyLane>PRs, documents, files, links, etc. that ami produces land here.</EmptyLane>
      ) : (
        <div className="space-y-2">
          {artifacts.map((a) => (
            <div key={a.id} className="card p-3">
              <div className="flex items-center gap-2">
                <span className="text-mut shrink-0">{artifactIcon[a.type] ?? <BoxIcon />}</span>
                <span className="font-medium text-sm flex-1">{a.title}</span>
                {a.url && (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-primary text-xs inline-flex items-center gap-1"
                  >
                    Open <ExternalIcon size={11} />
                  </a>
                )}
                {a.contentMd && (
                  <button className="btn text-xs" onClick={() => setOpen(open === a.id ? null : a.id)}>
                    {open === a.id ? "Hide" : "View"}
                  </button>
                )}
              </div>
              {open === a.id && a.contentMd && (
                <div className="mt-2 bg-panel2 p-3 max-h-96 overflow-y-auto">
                  <Markdown>{a.contentMd}</Markdown>
                </div>
              )}
              {a.type === "branch" && todo?.projectId && <MergeBackButton todo={todo} />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Merge the coding run's ami/<task> worktree branch back into the project's
 * checkout — the manual step after a worktree run, right on its deliverable. */
function MergeBackButton({ todo }: { todo: TodoDto }) {
  const merge = useMutation({
    mutationFn: () => api.mergeBack(todo.projectId!, worktreeBranchForTodo(todo.id)),
    onSuccess: (res) => (res.ok ? toast(res.message) : toast.error(res.message)),
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <div className="border-t border-edge mt-2 pt-2 flex items-center gap-2">
      <button className="btn text-xs" disabled={merge.isPending} onClick={() => merge.mutate()}>
        {merge.isPending ? "Merging…" : "Merge back"}
      </button>
      <span className="text-xs text-mut">
        Merges <code>{worktreeBranchForTodo(todo.id)}</code> into your checkout's current branch.
      </span>
    </div>
  );
}

/* ---------- drafted replies ---------- */

function DraftPanel({ drafts }: { drafts: DraftDto[] }) {
  const pending = drafts.filter((d) => d.status === "pending");
  const sent = drafts.filter((d) => d.status === "sent");
  return (
    <section>
      <SectionTitle>Drafted reply {pending.length > 0 && `(${pending.length} awaiting approval)`}</SectionTitle>
      {drafts.length === 0 ? (
        <EmptyLane>
          Ami drafts slack messages, emails, etc. in your writing style and asks approval to send them.
        </EmptyLane>
      ) : (
        <div className="space-y-2">
          {pending.map((d) => (
            <DraftEditor key={d.id} draft={d} />
          ))}
          {sent.map((d) => (
            <div key={d.id} className="card p-3 text-sm text-mut">
              <span className="text-ok mr-2 inline-flex items-center gap-1">
                <CheckIcon /> sent via {d.channel}
              </span>
              {(d.editedBody ?? d.body).slice(0, 140)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------- follow up: lives at the bottom of the runs lane ---------- */

/** Collapsed to a single + button under the last run; expands into the
 * feedback box that resumes the task with full context. */
function FollowUp({ todoId, disabled }: { todoId: string; disabled: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const m = useMutation({
    mutationFn: () => api.taskFeedback(todoId, text),
    onSuccess: () => {
      setText("");
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["task", todoId] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (!open)
    return (
      <div>
        <button
          className="btn inline-flex items-center gap-1.5"
          disabled={disabled}
          onClick={() => setOpen(true)}
          title={disabled ? "Available when the current run finishes" : undefined}
        >
          <PlusIcon /> Add follow-up
        </button>
        {disabled && <p className="text-xs text-mut mt-1.5">Available when the current run finishes.</p>}
      </div>
    );

  return (
    <div className="card p-3">
      <textarea
        className="input h-20"
        autoFocus
        placeholder="Give feedback on the result — ami resumes the task with full context…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="mt-2 flex gap-2">
        <button className="btn btn-primary" disabled={!text.trim() || m.isPending} onClick={() => m.mutate()}>
          {m.isPending ? "Starting…" : "Send follow-up"}
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
