import path from "node:path";
import type { AmiEvent } from "@ami/shared";
import type { Db } from "@ami/db";
import { askUser } from "../questions.js";

type Publish = (e: AmiEvent) => void;

/** Permission broker for coding runs:
 * replaces blanket bypassPermissions with a canUseTool callback.
 *
 * Policies:
 * - full-auto: allow everything (background agents — no human available)
 * - ask-risky: reads and in-worktree edits auto-allowed; ask for risky ops
 * - ask-all: ask for everything that isn't a read
 *
 * A per-run sticky "Always allow" memory (keyed by tool name / command prefix)
 * keeps repeated identical asks from nagging. Unanswered asks fail closed.
 */

export type ApprovalPolicy = "full-auto" | "ask-risky" | "ask-all";

const READ_TOOLS = new Set([
  "Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite", "Task", "NotebookRead",
]);

const RISKY_BASH_RE =
  /\b(git\s+push|gh\s+(pr|release|repo\s+delete)|npm\s+publish|pnpm\s+publish|yarn\s+publish|rm\s+-rf?|sudo|ssh|scp|rsync|curl|wget|docker\s+push|kubectl|terraform|aws|gcloud)\b/;

function memoryKey(toolName: string, input: any): string {
  if (toolName === "Bash") {
    const cmd = String(input?.command ?? "");
    return `bash:${cmd.trim().split(/\s+/).slice(0, 2).join(" ")}`;
  }
  return `tool:${toolName}`;
}

function describeCall(toolName: string, input: any): string {
  if (toolName === "Bash") return `Run command:\n\`${String(input?.command ?? "").slice(0, 400)}\``;
  if (toolName === "Write" || toolName === "Edit") return `${toolName} file: ${input?.file_path ?? "?"}`;
  return `Use tool ${toolName}${input?.file_path ? `: ${input.file_path}` : ""}`;
}

export function createPermissionBroker(args: {
  db: Db;
  publish: Publish;
  policy: ApprovalPolicy;
  runId: string;
  todoId: string | null;
  sessionId?: string | null;
  /** Writes inside this directory are considered safe under ask-risky. */
  workspaceDir: string;
}) {
  const alwaysAllow = new Set<string>();

  return async function canUseTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  > {
    const allow = { behavior: "allow" as const, updatedInput: input };

    if (args.policy === "full-auto") return allow;
    // Ami's own MCP tools are pre-gated (no send tools; ask_user is itself the channel).
    if (toolName.startsWith("mcp__")) return allow;
    if (READ_TOOLS.has(toolName)) return allow;
    if (alwaysAllow.has(memoryKey(toolName, input))) return allow;

    let needsAsk: boolean;
    if (args.policy === "ask-all") {
      needsAsk = true;
    } else {
      // ask-risky
      if (toolName === "Bash") {
        needsAsk = RISKY_BASH_RE.test(String(input?.command ?? ""));
      } else if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
        const p = String(input?.file_path ?? "");
        const abs = path.resolve(args.workspaceDir, p);
        needsAsk = !abs.startsWith(path.resolve(args.workspaceDir) + path.sep);
      } else {
        needsAsk = false;
      }
    }
    if (!needsAsk) return allow;

    const answer = await askUser(args.db, args.publish, {
      runId: args.runId,
      todoId: args.todoId,
      sessionId: args.sessionId ?? null,
      kind: "permission",
      question: describeCall(toolName, input),
      options: ["Allow once", "Always allow", "Deny"],
      timeoutMs: 10 * 60 * 1000,
    });

    const a = answer.toLowerCase();
    if (a.startsWith("always")) {
      alwaysAllow.add(memoryKey(toolName, input));
      return allow;
    }
    if (a.startsWith("allow")) return allow;
    return {
      behavior: "deny",
      message:
        "The user denied this action. Adjust your approach — do not retry the same call verbatim.",
    };
  };
}
