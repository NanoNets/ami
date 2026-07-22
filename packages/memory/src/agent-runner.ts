import type { CanUseTool, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { amiHome, type Db } from "@ami/db";
import { runAgentSession } from "./agent-session.js";
import { kgModel } from "./llm.js";

/** Run a knowledge agent (note creation / curation / agent notes / live
 * notes): a headless Agent SDK session with file tools, cwd at Ami's home so
 * paths like "knowledge/People/X.md" and "suggested-topics.md" resolve
 * naturally. Callers can widen the surface (extra tools, MCP servers) and
 * confine it (canUseTool guard) — a guard switches the run from blanket
 * bypassPermissions to enforced per-call checks. */
export async function runKnowledgeAgent(
  db: Db,
  args: {
    systemPrompt: string;
    message: string;
    useCase: string;
    subUseCase?: string;
    maxTurns?: number;
    timeoutMs?: number;
    /** Full built-in tool list; defaults to the file set. */
    tools?: string[];
    mcpServers?: Options["mcpServers"];
    /** Path/permission guard; presence disables bypassPermissions. */
    canUseTool?: CanUseTool;
    model?: string;
    /** Attribute LLM usage to a run/todo (live notes create run rows). */
    runId?: string;
    todoId?: string;
    /** Streamed to the caller for step persistence / console updates. */
    onMessage?: (msg: SDKMessage) => void;
  },
): Promise<{ ok: boolean; resultText: string; filesWritten: string[]; error?: string }> {
  const filesWritten = new Set<string>();

  const res = await runAgentSession(db, {
    prompt: args.message,
    options: {
      cwd: amiHome(),
      model: args.model ?? kgModel(db),
      ...(args.canUseTool
        ? { permissionMode: "default" as const, canUseTool: args.canUseTool }
        : { permissionMode: "bypassPermissions" as const, allowDangerouslySkipPermissions: true }),
      settingSources: [],
      tools: args.tools ?? ["Read", "Write", "Edit", "Glob", "Grep"],
      mcpServers: args.mcpServers,
      systemPrompt: args.systemPrompt,
      maxTurns: args.maxTurns ?? 80,
    },
    usage: { useCase: args.useCase, subUseCase: args.subUseCase, runId: args.runId, todoId: args.todoId },
    timeoutMs: args.timeoutMs ?? 10 * 60 * 1000,
    onMessage: (msg) => {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "tool_use" && (block.name === "Write" || block.name === "Edit")) {
            const p = (block.input as any)?.file_path;
            if (typeof p === "string") filesWritten.add(p);
          }
        }
      }
      args.onMessage?.(msg);
    },
  });

  return {
    ok: res.ok,
    resultText: res.resultText,
    filesWritten: [...filesWritten],
    error: res.ok ? undefined : res.aborted ? "timed out" : res.error,
  };
}
