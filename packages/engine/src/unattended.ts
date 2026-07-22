import path from "node:path";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { amiHome, insertTodo, type Db } from "@ami/db";
import type { AmiEvent } from "@ami/shared";

type Publish = (e: AmiEvent) => void;

/** Shared machinery for unattended runs (background agents, live notes):
 * a filesystem guard replacing blanket bypassPermissions, a global
 * concurrency cap, and a consecutive-failure circuit breaker.
 *
 * Threat model for the guard: unattended prompts embed external content
 * (event payloads from email/Slack), so a prompt-injected agent must not be
 * able to (a) write outside its own artifacts — in particular
 * ~/.ami/connectors/<id>/connector.mjs, which the server loads and executes,
 * or another task's task.yaml — or (b) read the token store (ami.db) and
 * exfiltrate it via WebFetch. */

const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const FILE_READ_TOOLS = new Set(["Read", "Glob", "Grep"]);

export function createUnattendedGuard(args: {
  /** Absolute dirs or exact files writes may touch. */
  writableRoots: string[];
  /** Absolute paths denied even inside a writable root (runtime-owned files). */
  deniedWrites?: string[];
}): CanUseTool {
  const home = amiHome();
  const roots = args.writableRoots.map((r) => path.resolve(r));
  const denied = (args.deniedWrites ?? []).map((r) => path.resolve(r));
  const within = (abs: string, root: string) => abs === root || abs.startsWith(root + path.sep);

  return async (toolName, input) => {
    const allow = { behavior: "allow" as const, updatedInput: input };
    // Ami's own MCP tools are pre-gated for unattended runs (no send tools,
    // no approval-needing actions); the browser server never touches disk.
    if (toolName.startsWith("mcp__")) return allow;
    // Not in the unattended toolsets, but fail closed if one ever appears.
    if (toolName === "Bash" || toolName === "BashOutput" || toolName === "KillShell") {
      return { behavior: "deny", message: "Shell access is not available in unattended runs." };
    }

    const rawPath =
      typeof input?.file_path === "string" ? input.file_path : typeof input?.path === "string" ? (input.path as string) : null;
    const abs = rawPath ? path.resolve(home, rawPath) : null;

    if (FILE_WRITE_TOOLS.has(toolName)) {
      if (!abs) return { behavior: "deny", message: "file_path is required." };
      if (denied.some((d) => within(abs, d))) {
        return { behavior: "deny", message: `${rawPath} is runtime-owned — never edit it.` };
      }
      if (!roots.some((r) => within(abs, r))) {
        return {
          behavior: "deny",
          message: `File writes in this run are restricted to: ${roots
            .map((r) => path.relative(home, r) || r)
            .join(", ")}. Put your output there instead.`,
        };
      }
      return allow;
    }

    // The token store is never readable by unattended agents.
    if (FILE_READ_TOOLS.has(toolName) && abs && path.basename(abs).startsWith("ami.db")) {
      return { behavior: "deny", message: "ami.db is off-limits." };
    }
    return allow;
  };
}

/** Global cap on simultaneous unattended agent runs — one tick firing many
 * due tasks (or a burst of events) must not fan out into an unbounded set of
 * parallel LLM sessions. Callers that fail to acquire skip without bumping
 * lastAttemptAt, so the next scheduler tick simply retries. */
const MAX_CONCURRENT_UNATTENDED = 3;
let unattendedInFlight = 0;

export function tryAcquireUnattendedSlot(opts?: { force?: boolean }): boolean {
  if (!opts?.force && unattendedInFlight >= MAX_CONCURRENT_UNATTENDED) return false;
  // Forced (user-initiated "run now") acquisitions still count toward the cap.
  unattendedInFlight++;
  return true;
}

export function releaseUnattendedSlot(): void {
  unattendedInFlight = Math.max(0, unattendedInFlight - 1);
}

/** Circuit breaker: after this many consecutive failures an unattended agent
 * is paused (active=false) instead of retrying forever on backoff. */
export const MAX_CONSECUTIVE_FAILURES = 5;

/** Surface a paused agent on the to-do list — background failures are
 * otherwise invisible until someone opens the Agents page. */
export function notifyAgentPaused(
  db: Db,
  publish: Publish,
  args: { kind: "background agent" | "live note"; name: string; lastError: string },
): void {
  const todoId = insertTodo(db, {
    type: "fyi",
    title: `${args.kind === "live note" ? "Live note" : "Background agent"} "${args.name}" paused after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
    summary: `Last error: ${args.lastError.slice(0, 300)}. Fix the cause and re-enable it from the Agents page.`,
  });
  publish({ type: "todo.created", todoId });
}

/** One-line factual summary from an agent's final message: the last line that
 * carries prose — skipping code fences, dividers, and link-only lines, which
 * models like to end on. */
export function extractRunSummary(text: string, cap = 300): string | null {
  const lines = text.trim().split("\n");
  const noise = (l: string) =>
    l.startsWith("```") ||
    l === "---" ||
    /^\[?https?:\/\/\S+\]?$/.test(l) ||
    /^\[[^\]]+\]\([^)]+\)\.?$/.test(l);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l || noise(l)) continue;
    return l.length > cap ? `${l.slice(0, cap - 1)}…` : l;
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, cap) : null;
}
