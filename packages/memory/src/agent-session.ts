import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { insertLlmUsage, type Db } from "@ami/db";
import { llmApiKey, llmEnv } from "./llm.js";

/** One Agent SDK session, run to completion. Owns the parts every runner in
 * Ami used to hand-roll identically: the API-key gate, the abort watchdog,
 * the message loop with init/result capture, the per-run LLM usage row, and
 * failure mapping. Callers keep their own semantics via `options` (tools,
 * MCP servers, permission mode, resume, …) and `onMessage` (step persistence,
 * console streaming). */
export interface AgentSessionResult {
  ok: boolean;
  resultText: string;
  /** Model actually used (from the init message; falls back to options.model). */
  model: string;
  sessionId: string | null;
  /** True when the watchdog or an external abort ended the run. */
  aborted: boolean;
  error?: string;
}

export async function runAgentSession(
  db: Db,
  args: {
    prompt: string;
    /** Raw Agent SDK options. env and abortController are owned here — pass
     * extra env via `env`, an external controller via `abortController`. */
    options: Omit<Options, "env" | "abortController">;
    usage: { useCase: string; subUseCase?: string; runId?: string; todoId?: string };
    timeoutMs: number;
    env?: Record<string, string>;
    /** External controller (e.g. a cancel button); the watchdog arms it too. */
    abortController?: AbortController;
    onMessage?: (msg: SDKMessage) => void;
  },
): Promise<AgentSessionResult> {
  const fail = (error: string, aborted = false): AgentSessionResult => ({
    ok: false,
    resultText: "",
    model: String(args.options.model ?? "unknown"),
    sessionId: null,
    aborted,
    error,
  });
  if (!llmApiKey(db)) return fail("no API key");

  const abort = args.abortController ?? new AbortController();
  const watchdog = setTimeout(() => abort.abort(), args.timeoutMs);
  let model = String(args.options.model ?? "unknown");
  let sessionId: string | null = null;
  let resultText = "";
  let failed: string | null = null;

  try {
    const q = query({
      prompt: args.prompt,
      options: {
        ...args.options,
        env: { ...process.env, ...llmEnv(db), ...args.env },
        abortController: abort,
      },
    });
    for await (const msg of q) {
      args.onMessage?.(msg);
      if (msg.type === "system" && msg.subtype === "init") {
        model = msg.model;
        sessionId = msg.session_id;
      } else if (msg.type === "result") {
        if (msg.subtype === "success") {
          resultText = msg.result;
        } else {
          const detail = "result" in msg ? String((msg as any).result ?? "").trim() : "";
          failed = detail ? `${msg.subtype}: ${detail}` : msg.subtype;
        }
        const u: any = (msg as any).usage;
        insertLlmUsage(db, {
          useCase: args.usage.useCase,
          subUseCase: args.usage.subUseCase,
          model,
          inputTokens: u?.input_tokens ?? 0,
          outputTokens: u?.output_tokens ?? 0,
          cacheReadTokens: u?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
          costUsd: (msg as any).total_cost_usd ?? undefined,
          runId: args.usage.runId,
          todoId: args.usage.todoId,
        });
      }
    }
  } catch (e: any) {
    failed = abort.signal.aborted ? "aborted" : String(e?.message ?? e);
  } finally {
    clearTimeout(watchdog);
  }

  if (failed) return { ...fail(failed, abort.signal.aborted), model, sessionId };
  return { ok: true, resultText, model, sessionId, aborted: false };
}
