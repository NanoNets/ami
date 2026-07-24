import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import {
  amiHome,
  appendStep,
  connectorAccounts,
  getRun,
  getSignal,
  getTodo,
  insertRun,
  insertTrace,
  latestRunForTodo,
  listDraftsForTodo,
  listFeedbackForTodo,
  taskRuns,
  updateRun,
  updateTodo,
  type Db,
} from "@ami/db";
import {
  buildOwnerBlock,
  entityFilesForAuthor,
  getPreferences,
  getStyleProfile,
  llmApiKey,
  memoryContextBlock,
  runAgentSession,
  writeSourceDoc,
} from "@ami/memory";
import type { AmiEvent } from "@ami/shared";
import { amiMcpServer } from "./mcp-server.js";
import { browserMcpServer } from "./browser-mcp.js";
import { AMI_APPEND, buildTaskPrompt, taskGuidance, taskTools } from "./prompts.js";
import { codeProjects, insertArtifact } from "@ami/db";
import { changedSinceBase, ensureWorktree, worktreeRoot } from "./coding/worktree.js";
import { cloneManagedRepo, managedRepoSlug } from "./coding/managed-repos.js";
import { createPermissionBroker, type ApprovalPolicy } from "./coding/permissions.js";
import { gitIdentityEnv } from "./coding/identity.js";

type Publish = (e: AmiEvent) => void;

const WATCHDOG_MS = 30 * 60 * 1000;
const running = new Map<string, AbortController>();

export function cancelRun(runId: string): boolean {
  const ctrl = running.get(runId);
  if (ctrl) {
    ctrl.abort();
    return true;
  }
  return false;
}

/** Startup recovery: a server crash mid-run leaves task_runs stuck at
 * running/queued and their todos stuck at "running" forever. Mark them failed
 * and reopen the todos so they're actionable again. */
export function recoverOrphanedRuns(db: Db, publish: Publish): number {
  const orphans = db
    .select()
    .from(taskRuns)
    .where(inArray(taskRuns.status, ["running", "queued"]))
    .all();
  for (const run of orphans) {
    updateRun(db, run.id, {
      status: "failed",
      error: "orphaned by server restart",
      finishedAt: new Date().toISOString(),
    });
    const todo = run.todoId.startsWith("bg:") ? null : getTodo(db, run.todoId);
    if (todo && todo.status === "running") {
      updateTodo(db, todo.id, { status: "open" });
      publish({ type: "todo.updated", todoId: todo.id });
    }
    publish({ type: "run.status", runId: run.id, todoId: run.todoId, status: "failed" });
  }
  if (orphans.length > 0) {
    console.log(`[engine] recovered ${orphans.length} orphaned run(s) from previous session`);
  }
  return orphans.length;
}

export interface StartRunArgs {
  todoId: string;
  mode: "plan" | "auto";
  /** Resume this run's session (plan approval / feedback iteration). */
  resumeRunId?: string;
  /** Extra prompt injected on resume (feedback text, "plan approved", ...). */
  extraPrompt?: string;
  /** Permission policy for coding runs (default ask-risky when user-started). */
  policy?: ApprovalPolicy;
}

/** Create a run row and execute it in the background. Returns the run id immediately. */
export function startRun(db: Db, publish: Publish, args: StartRunArgs): string {
  const todo = getTodo(db, args.todoId);
  if (!todo) throw new Error(`todo ${args.todoId} not found`);

  const parentRun = args.resumeRunId ? getRun(db, args.resumeRunId) : null;

  // A task with a registered code project attached IS a coding task: it runs
  // in an isolated git worktree on an ami/<todo> branch with the full coding
  // toolset. Without one it runs as a generalist over the connector tools.
  const project = todo.projectId
    ? db.select().from(codeProjects).where(eq(codeProjects.id, todo.projectId)).get()
    : undefined;
  const worktree =
    project
      ? {
          projectPath: project.path,
          path: path.join(worktreeRoot(), todo.id),
          branch: `ami/${todo.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(-24)}`,
        }
      : null;

  const workspaceDir = parentRun?.workspaceDir ?? worktree?.path ?? path.join(amiHome(), "workspaces", `${todo.id}`);
  if (!worktree) fs.mkdirSync(workspaceDir, { recursive: true });

  const policy: ApprovalPolicy =
    args.policy ?? (project ? "ask-risky" : "full-auto");

  const signal = todo.signalId ? getSignal(db, todo.signalId) : undefined;
  const feedback = listFeedbackForTodo(db, todo.id).map((f) => f.text);

  const prompt = parentRun?.sessionId
    ? (args.extraPrompt ?? "Continue.")
    : buildTaskPrompt({
        title: todo.title,
        summary: todo.summary,
        signalText: signal ? `${signal.title}\nFrom: ${signal.author}\n${signal.body}` : null,
        signalConnector: signal?.connector ?? null,
        threadRef: signal?.threadRef ?? null,
        ownerBlock: buildOwnerBlock(db),
        memoryContext: memoryContextBlock(`${todo.title} ${todo.summary}`, 6, 9000, {
          mustInclude: entityFilesForAuthor(signal?.author),
        }),
        styleProfile: getStyleProfile(db, signal?.connector === "gmail" ? "email" : "slack"),
        preferences: getPreferences(),
        feedback,
        mode: args.mode,
      });

  const runId = insertRun(db, {
    todoId: todo.id,
    mode: args.mode,
    parentRunId: parentRun?.id ?? null,
    prompt,
    workspaceDir,
    policy,
  });

  updateTodo(db, todo.id, { status: args.mode === "plan" ? "open" : "running" });
  publish({ type: "todo.updated", todoId: todo.id });

  void executeRun(db, publish, runId, {
    todoId: todo.id,
    coding: !!project,
    mode: args.mode,
    prompt,
    workspaceDir,
    resumeSessionId: parentRun?.sessionId ?? undefined,
    defaultChannel: signal?.connector ?? null,
    defaultTargetRef: signal?.threadRef ?? null,
    policy,
    worktree,
  }).catch((e) => {
    updateRun(db, runId, { status: "failed", error: String(e), finishedAt: new Date().toISOString() });
    publish({ type: "run.status", runId, todoId: todo.id, status: "failed" });
  });

  return runId;
}

async function executeRun(
  db: Db,
  publish: Publish,
  runId: string,
  ctx: {
    todoId: string;
    coding: boolean;
    mode: "plan" | "auto";
    prompt: string;
    workspaceDir: string;
    resumeSessionId?: string;
    defaultChannel: string | null;
    defaultTargetRef: string | null;
    policy: ApprovalPolicy;
    worktree: { projectPath: string; path: string; branch: string } | null;
  },
): Promise<void> {
  if (!llmApiKey(db)) throw new Error("No API key configured (set it in onboarding/settings)");

  const ghRow = db
    .select()
    .from(connectorAccounts)
    .where(eq(connectorAccounts.connector, "github"))
    .get();
  const ghToken = ghRow ? (JSON.parse(ghRow.authJson).token as string) : undefined;

  const abort = new AbortController();
  running.set(runId, abort);

  updateRun(db, runId, { status: "running", startedAt: new Date().toISOString() });
  publish({ type: "run.status", runId, todoId: ctx.todoId, status: "running" });

  const step = (kind: string, label: string, detail?: unknown) => {
    const stepId = appendStep(db, runId, kind, label, detail);
    publish({ type: "step.appended", runId, todoId: ctx.todoId, stepId });
  };

  let finalText = "";
  let failed: string | null = null;
  let baseBranch: string | null = null;

  try {
    if (ctx.worktree) {
      // A managed project may not be cloned yet (repo resolved, no local
      // copy anywhere) — Ami fetches its own clone first.
      if (!fs.existsSync(ctx.worktree.projectPath)) {
        const slug = managedRepoSlug(ctx.worktree.projectPath);
        if (!slug) throw new Error(`code project folder is gone: ${ctx.worktree.projectPath}`);
        step("status", `Cloning ${slug} → ${ctx.worktree.projectPath}`);
        await cloneManagedRepo(db, ctx.worktree.projectPath);
      }
      const wt = await ensureWorktree(ctx.worktree.projectPath, ctx.worktree.path, ctx.worktree.branch);
      baseBranch = wt.baseBranch;
      step("status", `Worktree ready: ${ctx.worktree.branch} (from ${ctx.worktree.projectPath})`);
    }

    // Coding runs under an ask policy go through the permission broker
    // instead of blanket bypass; everything else keeps the existing behavior.
    const useBroker = ctx.mode === "auto" && ctx.policy !== "full-auto";
    const canUseTool = useBroker
      ? createPermissionBroker({
          db,
          publish,
          policy: ctx.policy,
          runId,
          todoId: ctx.todoId,
          workspaceDir: ctx.workspaceDir,
        })
      : undefined;
    const browser = await browserMcpServer();
    const res = await runAgentSession(db, {
      prompt: ctx.prompt,
      options: {
        cwd: ctx.workspaceDir,
        resume: ctx.resumeSessionId,
        permissionMode: ctx.mode === "plan" ? "plan" : useBroker ? "default" : "bypassPermissions",
        ...(ctx.mode === "plan"
          ? {
              planModeInstructions:
                "You are producing a task plan for Ami's console. IMPORTANT — this overrides any other plan-mode workflow you were given: do NOT write the plan to a plan file (Write is unavailable), do NOT call or mention ExitPlanMode, and do NOT ask for approval — the user reviews and approves the plan in Ami's console UI. Simply end your turn with the complete plan as clean markdown: goal, numbered steps, tools/repos/accounts touched, the expected deliverable, and assumptions. Nothing after the plan.",
              disallowedTools: ["ExitPlanMode"],
            }
          : useBroker
            ? { canUseTool }
            : { allowDangerouslySkipPermissions: true }),
        settingSources: [],
        tools: taskTools(ctx.coding),
        mcpServers: {
          ami: amiMcpServer({
            db,
            publish,
            todoId: ctx.todoId,
            runId,
            defaultChannel: ctx.defaultChannel,
            defaultTargetRef: ctx.defaultTargetRef,
          }),
          browser,
        },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: `${AMI_APPEND}\n\n${taskGuidance(ctx.coding)}`,
        },
        maxTurns: 120,
      },
      usage: { useCase: "task_run", subUseCase: ctx.mode, runId, todoId: ctx.todoId },
      timeoutMs: WATCHDOG_MS,
      env: {
        ...(ghToken ? { GH_TOKEN: ghToken, GITHUB_TOKEN: ghToken } : {}),
        // Commits are authored as the user (deploys gate on the author's
        // GitHub account), never an invented identity.
        ...(await gitIdentityEnv(db)),
      },
      abortController: abort,
      onMessage: (msg) => {
        persistMessage(step, db, runId, msg);
        if (msg.type === "system" && msg.subtype === "init") {
          updateRun(db, runId, { sessionId: msg.session_id });
        }
      },
    });
    if (res.ok) finalText = res.resultText;
    else failed = res.aborted ? "cancelled or timed out" : (res.error ?? "failed");
  } catch (e: any) {
    failed = abort.signal.aborted ? "cancelled or timed out" : String(e?.message ?? e);
  } finally {
    running.delete(runId);
  }

  const now = new Date().toISOString();
  if (failed) {
    updateRun(db, runId, { status: "failed", error: failed, finishedAt: now });
    updateTodo(db, ctx.todoId, { status: "open" });
    publish({ type: "run.status", runId, todoId: ctx.todoId, status: "failed" });
    publish({ type: "todo.updated", todoId: ctx.todoId });
    return;
  }

  updateRun(db, runId, { status: "succeeded", finishedAt: now });

  // Worktree runs report what changed on the branch (committed + uncommitted).
  if (ctx.worktree && ctx.mode === "auto") {
    try {
      const changed = await changedSinceBase(ctx.worktree.path, baseBranch ?? "HEAD");
      if (changed.length > 0) {
        const id = insertArtifact(db, {
          runId,
          type: "other",
          title: `Branch ${ctx.worktree.branch}: ${changed.length} file(s) changed`,
          contentMd: [
            `Worktree: \`${ctx.worktree.path}\``,
            `Branch: \`${ctx.worktree.branch}\`${baseBranch ? ` (from \`${baseBranch}\`)` : ""}`,
            ``,
            ...changed.map((f) => `- \`${f.state}\` ${f.path}`),
            ``,
            `Merge back from Settings → Code projects, or push/PR from the worktree.`,
          ].join("\n"),
        });
        publish({ type: "artifact.created", artifactId: id, runId, todoId: ctx.todoId });
      }
    } catch (e) {
      console.error("[worktree] changed-files report failed:", e);
    }
  }

  if (ctx.mode === "plan") {
    updateTodo(db, ctx.todoId, { status: "planned", planMd: finalText });
  } else {
    // Fallback draft if the agent produced none and there is a reply target.
    const hasDraft = listDraftsForTodo(db, ctx.todoId).some((d) => d.runId === runId);
    if (!hasDraft && ctx.defaultChannel && ctx.defaultTargetRef && finalText) {
      const { insertDraft } = await import("@ami/db");
      const summary = finalText.length > 900 ? `${finalText.slice(0, 900)}…` : finalText;
      const draftId = insertDraft(db, {
        todoId: ctx.todoId,
        runId,
        channel: ctx.defaultChannel,
        targetRef: ctx.defaultTargetRef,
        body: summary,
      });
      publish({ type: "draft.created", draftId, todoId: ctx.todoId });
    }
    updateTodo(db, ctx.todoId, { status: "awaiting_review" });
    insertTrace(db, {
      todoId: ctx.todoId,
      runId,
      kind: "execution_choice",
      situation: "Task executed",
      decision: "completed",
      outcome: finalText.slice(0, 300),
    });
    // Feed the outcome to the entity-graph builder: what Ami did for a task is
    // a fact about the projects/people it touched. One file per todo — a later
    // run on the same todo overwrites and re-queues it.
    if (finalText) {
      const todo = getTodo(db, ctx.todoId);
      const signal = todo?.signalId ? getSignal(db, todo.signalId) : undefined;
      writeSourceDoc(
        "ami-tasks",
        ctx.todoId,
        `Task completed by the assistant: ${todo?.title ?? ctx.todoId}`,
        [
          `**Outcome:** the assistant completed this task on ${now.slice(0, 10)} (pending the user's review).`,
          ``,
          todo ? `**Task summary:** ${todo.summary}` : "",
          signal ? `\n**Originating ${signal.connector} message** (from ${signal.author}): ${signal.title}` : "",
          ``,
          `**Result:**\n${finalText.slice(0, 4000)}`,
        ].join("\n"),
      );
    }
  }
  publish({ type: "run.status", runId, todoId: ctx.todoId, status: "succeeded" });
  publish({ type: "todo.updated", todoId: ctx.todoId });
}

export function persistMessage(
  step: (kind: string, label: string, detail?: unknown) => void,
  _db: Db,
  _runId: string,
  msg: SDKMessage,
): void {
  if (msg.type === "system" && msg.subtype === "init") {
    step("status", `Session started (${msg.model})`);
    return;
  }
  if (msg.type === "assistant") {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text.trim()) {
        step("text", truncate(block.text, 160), { text: block.text });
      } else if (block.type === "thinking" && (block as any).thinking?.trim()) {
        step("thinking", truncate((block as any).thinking, 160));
      } else if (block.type === "tool_use") {
        step("tool_use", toolLabel(block.name, block.input), { name: block.name, input: block.input });
      }
    }
    return;
  }
  if (msg.type === "user" && typeof msg.message?.content !== "string") {
    for (const block of msg.message?.content ?? []) {
      if ((block as any).type === "tool_result") {
        const content = (block as any).content;
        const text = Array.isArray(content)
          ? content
              .map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`))
              .join(" ")
          : String(content ?? "");
        step("tool_result", truncate(text, 160), { text: text.slice(0, 4000) });
      }
    }
    return;
  }
  if (msg.type === "result") {
    step("status", msg.subtype === "success" ? "Completed" : `Failed: ${msg.subtype}`);
  }
}

function toolLabel(name: string, input: unknown): string {
  const i = input as Record<string, unknown>;
  const short = name.replace(/^mcp__ami__/, "ami:");
  if (name === "Bash" && i?.command) return `Bash: ${truncate(String(i.command), 120)}`;
  if ((name === "Read" || name === "Write" || name === "Edit") && i?.file_path)
    return `${name}: ${i.file_path}`;
  if (i?.query) return `${short}: ${truncate(String(i.query), 100)}`;
  return short;
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export function latestSessionRun(db: Db, todoId: string) {
  return latestRunForTodo(db, todoId);
}
