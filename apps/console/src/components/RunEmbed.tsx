import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { toast, errMsg } from "../lib/toast";
import { Markdown } from "./Markdown";
import { StepTimeline } from "./StepTimeline";
import { QuestionCard } from "./QuestionCard";
import { BoxIcon, BranchIcon, CheckIcon, ChevronIcon, ExternalIcon, Spinner, XIcon } from "./icons";

/** A task run living inside a chat thread: when chat starts a to-do, the whole
 * run happens right here — live step timeline, approval questions answered
 * inline, and the deliverables when it lands. Chat-born tasks have no thread
 * to reply to, so there are no drafts here — execution, approvals, deliverable.
 * The task page stays the archive; the chat is where the work is watched. */
export function RunEmbed({ todoId, runId }: { todoId: string; runId: string }) {
  const { data } = useQuery({
    queryKey: ["task", todoId],
    queryFn: () => api.task(todoId),
    // SSE invalidation does the live updates; the interval is the safety net.
    refetchInterval: (q) =>
      q.state.data?.runs.some((r) => r.id === runId && (r.status === "running" || r.status === "queued"))
        ? 2500
        : false,
  });
  const { data: todos = [] } = useQuery({ queryKey: ["todos"], queryFn: api.todos });
  const { data: pendingQuestions = [] } = useQuery({
    queryKey: ["questions"],
    queryFn: api.questions,
    refetchInterval: 5000,
  });
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => api.cancelRun(runId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["task", todoId] }),
    onError: (e) => toast.error(errMsg(e)),
  });

  // While running the timeline is the point; once settled it folds to a line.
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);

  const run = data?.runs.find((r) => r.id === runId);
  if (!data || !run) return null;
  const steps = data.steps.filter((s) => s.runId === runId);
  const questions = pendingQuestions.filter((q) => q.todoId === todoId);
  const active = run.status === "running" || run.status === "queued";
  const timelineOpen = openOverride ?? active;
  const title = todos.find((t) => t.id === todoId)?.title ?? "Task";

  const statusColor =
    run.status === "succeeded" ? "text-ok" : run.status === "failed" ? "text-bad" : run.status === "running" ? "text-acc" : "text-mut";

  return (
    <div className="card overflow-hidden max-w-[92%]">
      <div className="flex items-center gap-2 px-3.5 py-2.5 bg-panel2/60">
        <span className={`shrink-0 ${statusColor}`}>
          {active ? <Spinner /> : run.status === "succeeded" ? <CheckIcon /> : <XIcon />}
        </span>
        <Link to={`/tasks/${todoId}`} className="text-sm font-medium truncate hover:text-acc" title="Open the task page">
          {title}
        </Link>
        <span className={`text-xs shrink-0 ${statusColor}`}>{run.status}</span>
        {run.costUsd > 0 && <span className="text-xs text-mut shrink-0">· ${run.costUsd.toFixed(run.costUsd < 0.1 ? 3 : 2)}</span>}
        <span className="flex-1" />
        {active && (
          <button className="btn text-xs shrink-0" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            {cancel.isPending ? "Cancelling…" : "Cancel"}
          </button>
        )}
        <button
          className="inline-flex items-center gap-1 text-xs text-mut hover:text-hi cursor-pointer shrink-0"
          aria-expanded={timelineOpen}
          onClick={() => setOpenOverride(!timelineOpen)}
        >
          {steps.length} steps <ChevronIcon size={11} open={timelineOpen} />
        </button>
      </div>

      {timelineOpen && (
        <div className="px-3.5 py-3 max-h-80 overflow-y-auto border-t border-edge">
          <StepTimeline run={run} steps={steps} />
        </div>
      )}

      {questions.length > 0 && (
        <div className="px-3.5 py-3 space-y-3 border-t border-edge rise">
          {questions.map((q) => (
            <QuestionCard key={q.id} q={q} />
          ))}
        </div>
      )}

      {data.artifacts.length > 0 && (
        <div className="px-3.5 py-2.5 space-y-1.5 border-t border-edge">
          {data.artifacts.map((a) => (
            <ArtifactRow key={a.id} type={a.type} title={a.title} url={a.url} contentMd={a.contentMd} />
          ))}
        </div>
      )}
    </div>
  );
}

function ArtifactRow({ type, title, url, contentMd }: { type: string; title: string; url: string | null; contentMd: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-sm rise">
      <div className="flex items-center gap-2">
        <span className="text-mut shrink-0">{type === "pr" ? <BranchIcon /> : <BoxIcon />}</span>
        <span className="font-medium truncate">{title}</span>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="btn btn-primary text-xs shrink-0 inline-flex items-center gap-1">
            Open <ExternalIcon size={11} />
          </a>
        )}
        {contentMd && (
          <button className="btn text-xs shrink-0" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "View"}
          </button>
        )}
      </div>
      {open && contentMd && (
        <div className="mt-2 bg-panel2 p-3 max-h-80 overflow-y-auto">
          <Markdown>{contentMd}</Markdown>
        </div>
      )}
    </div>
  );
}

