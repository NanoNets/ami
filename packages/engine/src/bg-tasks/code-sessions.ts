import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  appendStep,
  codeProjects,
  connectorAccounts,
  getSetting,
  insertRun,
  updateRun,
  type Db,
} from "@ami/db";
import { llmApiKey, runAgentSession } from "@ami/memory";
import type { AmiEvent } from "@ami/shared";
import { changedSinceBase, ensureWorktree, worktreeRoot } from "../coding/worktree.js";
import { gitIdentityEnv } from "../coding/identity.js";
import { persistMessage } from "../runner.js";
import { indexPath } from "./fileops.js";

type Publish = (e: AmiEvent) => void;

/** launch_code_task: a background
 * agent hands a clearly-scoped coding item to an autonomous coding run in an
 * isolated git worktree, and its status block in index.md is finalized in
 * place when the run settles. */

export const MAX_LAUNCHES_PER_RUN = 5;
const CODE_WATCHDOG_MS = 90 * 60 * 1000;

const AUTONOMOUS_SCAFFOLD = (title: string, prompt: string, context: string | undefined) => `You are an autonomous coding agent working in an isolated git worktree. There is NO human available — never ask questions; make sensible decisions and proceed.

# Task: ${title}

${prompt}

${context ? `# Source context\n\n${context}\n` : ""}
# Operating rules
- Work end-to-end: implement, verify (build/tests where present), and commit your work with clear messages.
- Stay inside this worktree. Do not push, publish, or open PRs.
- Be conservative: if part of the task is ambiguous or belongs to a different repository, skip it and say so in the summary.
- End your final message with a "## Summary" section: 2-5 factual bullets of what you did (it is extracted verbatim into the task journal).`;

function startMarker(runId: string): string {
  return `<!-- cs-start:${runId} -->`;
}
function endMarker(runId: string): string {
  return `<!-- cs-end:${runId} -->`;
}

/** Insert a running block under "## Code Sessions" (created if missing). */
function appendRunningBlock(slug: string, runId: string, title: string, branch: string): void {
  const p = indexPath(slug);
  let content = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
  if (!content.includes("## Code Sessions")) {
    content = `${content.trimEnd()}\n\n## Code Sessions\n`;
  }
  const block = `\n${startMarker(runId)}\n### ⏳ ${title}\n- Branch: \`${branch}\`\n- Status: running…\n${endMarker(runId)}\n`;
  const idx = content.indexOf("## Code Sessions");
  const insertAt = content.indexOf("\n", idx) + 1;
  content = content.slice(0, insertAt) + block + content.slice(insertAt);
  fs.writeFileSync(p, content, "utf-8");
}

function finalizeBlock(
  slug: string,
  runId: string,
  args: { title: string; branch: string; ok: boolean; changed: string[]; summary: string },
): void {
  const p = indexPath(slug);
  if (!fs.existsSync(p)) return;
  const content = fs.readFileSync(p, "utf-8");
  const re = new RegExp(`${startMarker(runId)}[\\s\\S]*?${endMarker(runId)}`);
  const status = args.ok ? "✅" : "❌";
  const block = [
    startMarker(runId),
    `### ${status} ${args.title}`,
    `- Branch: \`${args.branch}\``,
    args.changed.length ? `- Changed: ${args.changed.slice(0, 12).map((f) => `\`${f}\``).join(", ")}${args.changed.length > 12 ? ` (+${args.changed.length - 12} more)` : ""}` : `- No file changes`,
    args.summary ? `\n${args.summary.trim()}\n` : "",
    endMarker(runId),
  ].join("\n");
  fs.writeFileSync(p, content.replace(re, block), "utf-8");
}

function extractSummary(finalText: string): string {
  const m = finalText.match(/## Summary\s*([\s\S]*)$/);
  return m ? m[1].trim().split("\n").slice(0, 8).join("\n") : "";
}

export async function launchCodeTask(
  db: Db,
  publish: Publish,
  args: {
    slug: string;
    projectId: string;
    title: string;
    prompt: string;
    context?: string;
  },
): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const project = db.select().from(codeProjects).where(eq(codeProjects.id, args.projectId)).get();
  if (!project) return { ok: false, error: `code project ${args.projectId} not registered` };

  const runId = insertRun(db, {
    todoId: `bg:${args.slug}`,
    mode: "auto",
    prompt: args.prompt,
    policy: "full-auto",
  });
  const branch = `ami/bg-${runId.slice(-12)}`;
  const worktreePath = path.join(worktreeRoot(), `bg-${runId.slice(-12)}`);

  // Fire and forget — the bg agent's turn continues; the block finalizes later.
  void (async () => {
    const step = (kind: string, label: string, detail?: unknown) => {
      appendStep(db, runId, kind, label, detail);
    };
    let ok = false;
    let finalText = "";
    let baseBranch: string | null = null;
    try {
      const wt = await ensureWorktree(project.path, worktreePath, branch);
      baseBranch = wt.baseBranch;
      appendRunningBlock(args.slug, runId, args.title, branch);
      updateRun(db, runId, { status: "running", startedAt: new Date().toISOString(), workspaceDir: worktreePath });

      if (!llmApiKey(db)) throw new Error("no API key");
      const ghRow = db
        .select()
        .from(connectorAccounts)
        .where(eq(connectorAccounts.connector, "github"))
        .get();
      const ghToken = ghRow ? (JSON.parse(ghRow.authJson).token as string) : undefined;
      const res = await runAgentSession(db, {
        prompt: AUTONOMOUS_SCAFFOLD(args.title, args.prompt, args.context),
        options: {
          cwd: worktreePath,
          model: getSetting(db, "model") ?? "claude-opus-4-8",
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          settingSources: [],
          systemPrompt: { type: "preset", preset: "claude_code" },
          maxTurns: 150,
        },
        usage: { useCase: "bg_code_task", runId },
        timeoutMs: CODE_WATCHDOG_MS,
        env: {
          ...(ghToken ? { GH_TOKEN: ghToken, GITHUB_TOKEN: ghToken } : {}),
          ...(await gitIdentityEnv(db)),
        },
        onMessage: (msg) => {
          persistMessage(step, db, runId, msg);
          if (msg.type === "system" && msg.subtype === "init") {
            updateRun(db, runId, { sessionId: msg.session_id });
          }
        },
      });
      ok = res.ok;
      if (res.ok) finalText = res.resultText;
      else updateRun(db, runId, { error: res.aborted ? "timed out (90m)" : (res.error ?? "failed") });
    } catch (e: any) {
      updateRun(db, runId, { error: String(e?.message ?? e) });
    } finally {
      const changed = await changedSinceBase(worktreePath, baseBranch ?? "HEAD").catch(() => []);
      finalizeBlock(args.slug, runId, {
        title: args.title,
        branch,
        ok,
        changed: changed.map((f) => f.path),
        summary: extractSummary(finalText),
      });
      updateRun(db, runId, {
        status: ok ? "succeeded" : "failed",
        finishedAt: new Date().toISOString(),
      });
      publish({ type: "bgtask.updated", slug: args.slug });
    }
  })();

  return { ok: true, runId };
}
