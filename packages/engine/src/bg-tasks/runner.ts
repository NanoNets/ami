import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  amiHome,
  appendStep,
  insertRun,
  updateRun,
  type Db,
} from "@ami/db";
import {
  buildOwnerBlock,
  getPreferences,
  kgModel,
  knowledgeDir,
  llmApiKey,
  memoryContextBlock,
  runAgentSession,
} from "@ami/memory";
import { WRITING_STYLE, type AmiEvent } from "@ami/shared";
import { amiMcpServer } from "../mcp-server.js";
import { browserMcpServer } from "../browser-mcp.js";
import { persistMessage } from "../runner.js";
import {
  createUnattendedGuard,
  extractRunSummary,
  MAX_CONSECUTIVE_FAILURES,
  notifyAgentPaused,
  releaseUnattendedSlot,
  tryAcquireUnattendedSlot,
} from "../unattended.js";
import { buildTriggerBlock, type TriggerType } from "./trigger-block.js";
import { fetchTask, patchTask, prependRunId, taskDir } from "./fileops.js";
import { launchCodeTask, MAX_LAUNCHES_PER_RUN } from "./code-sessions.js";

type Publish = (e: AmiEvent) => void;

/** Background-task agent runner:
 * lastAttemptAt bumped immediately (disk-persistent in-flight + backoff
 * anchor); only success advances lastRunAt (the trigger cycle anchor);
 * failures record lastRunError but keep the last good summary visible.
 * MAX_CONSECUTIVE_FAILURES consecutive failures pause the task and surface
 * an FYI on the to-do list. */

const runningTasks = new Set<string>();

const EVENT_DECISION_DIRECTIVE =
  "**Decision:** Determine whether this event genuinely warrants taking the action your instructions describe. If the event is not meaningfully relevant on closer inspection, skip the run — do not modify `index.md` and do not perform any side-effect. Only act if the event provides new or changed information that the instructions imply you should react to.";

const BG_SYSTEM = `You are one of Ami's background agents. You run unattended on a schedule or in reaction to events — there is NO human in the loop. Never ask questions; never hedge; make sensible decisions and proceed, or skip when your instructions don't apply.

Your task folder is under bg-tasks/<slug>/ (relative to your working directory). The user-visible artifact is index.md:
- If your instructions describe maintaining a document/report (OUTPUT mode): keep index.md as the current version of that document — patch it with Edit, don't rewrite wholesale.
- If your instructions describe taking actions (ACTION mode): append a dated journal entry to index.md describing what you did.
Never touch task.yaml — the runtime owns it. Never edit the "## Code Sessions" section — the launch_code_task tool manages it (you may add a short note ABOVE it). File writes are restricted to your task folder, knowledge/, and exports/ — the runtime enforces this.

You never send messages or emails yourself — propose replies with mcp__ami__report_draft and the user approves them. Record durable learnings with mcp__ami__memory_record.

A real browser is available via mcp__browser__* (navigate, click, type, read the page) when your task needs interactive web work — prefer WebFetch/WebSearch for simple reads. The never-send rule applies in the browser too: don't submit messages or posts. Never make infrastructure changes (cloud consoles, AWS, etc.) — background runs have no approval channel; describe the needed change in index.md instead. Auth-walled URLs: a past login may already be active in the persistent browser profile — try it; but if a login page appears, there is no user here to sign in, so use the freshest readable copy (slack_read_file, Drive, memory) and note in your output which source you used and that the canonical link needs a one-time login.

End with a one-line factual summary of what you did (or "No update — <reason>"). It is shown in the console next to the task.

${WRITING_STYLE}`;

function buildCodeBlock(slug: string, projectName: string): string {
  return `

# Coding task

This task is pinned to the code project **${projectName}**. Your job this run:
1. Read the relevant source material and identify **actionable coding items** — bugs to fix, features to build, concrete changes requested.
2. Be **conservative**: only hand off items that are clearly scoped and self-contained. Ambiguous, large/architectural, or different-repo items get listed briefly in index.md as "needs review" instead.
3. **Group** related items; keep unrelated items separate.
4. For each group, call \`launch_code_task\` with a short \`title\`, and a **detailed, fully self-contained \`prompt\`** (the coding agent has no other context and no human to ask). Put relevant source excerpts in \`context\`.
5. Launches run asynchronously in isolated git worktrees and manage the "## Code Sessions" section of index.md themselves.

If there are no actionable coding items, launch nothing and say so in your summary.`;
}

export async function runBackgroundTask(
  db: Db,
  publish: Publish,
  slug: string,
  trigger: TriggerType = "manual",
  context?: string,
): Promise<{ slug: string; runId: string | null; summary: string | null; error?: string }> {
  if (runningTasks.has(slug)) return { slug, runId: null, summary: null, error: "already running" };
  const task = fetchTask(slug);
  if (!task) return { slug, runId: null, summary: null, error: "task not found" };
  // Scheduled/event runs skip without bumping lastAttemptAt when the global
  // cap is hit — the next tick simply retries. Manual runs always go through.
  if (!tryAcquireUnattendedSlot({ force: trigger === "manual" })) {
    return { slug, runId: null, summary: null, error: "unattended concurrency cap reached" };
  }
  runningTasks.add(slug);
  try {
    const { codeProjects } = await import("@ami/db");
    const { eq } = await import("drizzle-orm");
    const project = task.projectId
      ? db.select().from(codeProjects).where(eq(codeProjects.id, task.projectId)).get()
      : undefined;

    const now = new Date();
    let message = `Run the background task at \`bg-tasks/${slug}/\`.\n\n`;
    message += `**Time:** ${now.toLocaleString("en-US", { dateStyle: "full", timeStyle: "long" })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})\n\n`;
    message += buildOwnerBlock(db);
    message += `\n**Instructions:**\n${task.instructions}\n`;
    const memory = memoryContextBlock(`${task.name} ${task.instructions}`, 4, 6000);
    if (memory) {
      message += `\n# ${memory}\n\nThe dossiers above were auto-matched from memory for this task; verify with a live tool read where currency matters.\n`;
    }
    const prefs = getPreferences();
    if (prefs) {
      message += `\n# User's learned preferences\nStanding rules the user has expressed — respect any that apply to this task:\n\n${prefs}\n`;
    }
    if (project) message += buildCodeBlock(slug, project.name);
    message += buildTriggerBlock({
      trigger,
      triggers: task.triggers,
      context: trigger === "event" ? undefined : context,
      eventPayload: trigger === "event" ? context : undefined,
      targetNoun: "task",
      decisionDirective: EVENT_DECISION_DIRECTIVE,
    });

    const runId = insertRun(db, { todoId: `bg:${slug}`, mode: "auto", prompt: message, policy: "full-auto" });
    prependRunId(slug, runId);
    // lastAttemptAt is the backoff anchor + disk-persistent in-flight signal;
    // lastRunAt/lastRunSummary stay untouched until success. projectId is
    // re-asserted on every patch (self-heal against config corruption).
    const heal = task.projectId ? { projectId: task.projectId } : {};
    patchTask(slug, { lastAttemptAt: now.toISOString(), lastRunId: runId, ...heal });
    publish({ type: "bgtask.updated", slug });

    if (!llmApiKey(db)) {
      updateRun(db, runId, { status: "failed", error: "no API key", finishedAt: new Date().toISOString() });
      return { slug, runId, summary: null, error: "no API key" };
    }

    updateRun(db, runId, { status: "running", startedAt: new Date().toISOString() });
    const step = (kind: string, label: string, detail?: unknown) => {
      const stepId = appendStep(db, runId, kind, label, detail);
      publish({ type: "step.appended", runId, todoId: `bg:${slug}`, stepId });
    };

    let launches = 0;
    const codeTools = project
      ? [
          tool(
            "launch_code_task",
            "Hand a clearly-scoped coding item to an autonomous coding agent. It runs asynchronously in an isolated git worktree of the pinned project and manages its own status block under '## Code Sessions' in index.md. The prompt must be fully self-contained.",
            {
              title: z.string(),
              prompt: z.string().describe("Detailed, self-contained implementation instructions"),
              context: z.string().describe("Relevant source excerpts").optional(),
            },
            async (input) => {
              if (launches >= MAX_LAUNCHES_PER_RUN) {
                return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `launch cap (${MAX_LAUNCHES_PER_RUN}) reached for this run` }) }] };
              }
              launches++;
              const res = await launchCodeTask(db, publish, {
                slug,
                projectId: task.projectId!,
                title: input.title,
                prompt: input.prompt,
                context: input.context,
              });
              return { content: [{ type: "text" as const, text: JSON.stringify(res) }] };
            },
          ),
        ]
      : [];

    // Writes are confined to this task's folder, the knowledge base, and
    // exports; task.yaml/runs.log stay runtime-owned even inside the folder.
    const guard = createUnattendedGuard({
      writableRoots: [taskDir(slug), knowledgeDir(), path.join(amiHome(), "exports")],
      deniedWrites: [path.join(taskDir(slug), "task.yaml"), path.join(taskDir(slug), "runs.log")],
    });

    const browser = await browserMcpServer();
    const res = await runAgentSession(db, {
      prompt: message,
      options: {
        cwd: amiHome(),
        model: task.model ?? kgModel(db),
        permissionMode: "default",
        canUseTool: guard,
        settingSources: [],
        tools: ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"],
        mcpServers: {
          ami: amiMcpServer({
            db,
            publish,
            todoId: `bg:${slug}`,
            runId,
            defaultChannel: null,
            defaultTargetRef: null,
            allowAskUser: false,
          }),
          ...(codeTools.length > 0
            ? { amicode: createSdkMcpServer({ name: "amicode", tools: codeTools }) }
            : {}),
          browser,
        },
        systemPrompt: BG_SYSTEM,
        maxTurns: 60,
      },
      usage: { useCase: "bg_task", subUseCase: trigger, runId },
      timeoutMs: 30 * 60 * 1000,
      onMessage: (msg) => {
        persistMessage(step, db, runId, msg);
        if (msg.type === "system" && msg.subtype === "init") {
          updateRun(db, runId, { sessionId: msg.session_id });
        }
      },
    });

    const failed = res.ok ? null : res.aborted ? "timed out" : (res.error ?? "failed");
    const doneAt = new Date().toISOString();
    if (failed) {
      updateRun(db, runId, { status: "failed", error: failed, finishedAt: doneAt });
      const failCount = (task.failCount ?? 0) + 1;
      const pause = failCount >= MAX_CONSECUTIVE_FAILURES;
      patchTask(slug, { lastRunError: failed, failCount, ...(pause ? { active: false } : {}), ...heal });
      if (pause) notifyAgentPaused(db, publish, { kind: "background agent", name: task.name, lastError: failed });
      publish({ type: "bgtask.updated", slug });
      return { slug, runId, summary: null, error: failed };
    }
    const summary = extractRunSummary(res.resultText);
    updateRun(db, runId, { status: "succeeded", finishedAt: doneAt });
    patchTask(slug, {
      lastRunAt: doneAt,
      lastRunSummary: summary ?? undefined,
      lastRunError: undefined,
      failCount: undefined,
      ...heal,
    });
    publish({ type: "bgtask.updated", slug });
    return { slug, runId, summary };
  } finally {
    runningTasks.delete(slug);
    releaseUnattendedSlot();
  }
}
