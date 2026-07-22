/** LLM provider configuration — one place that decides which endpoint, key
 * and model every LLM call in Ami uses.
 *
 * Ami speaks the Anthropic Messages API as its protocol, not its provider:
 * setting `llm_base_url` points every call — direct SDK calls and Agent SDK
 * (Claude Code) runs alike — at any Anthropic-compatible endpoint: hosted
 * open models (Kimi, GLM, DeepSeek, MiniMax) or a local LiteLLM proxy in
 * front of Ollama/vLLM/llama.cpp. Unset = api.anthropic.com.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getSetting, type Db } from "@ami/db";
import { z } from "zod";

/** Model for the knowledge agents (note creation, curation, agent notes,
 * style/rule distillation) and other light utility calls (event routing,
 * meeting prep). Separate knob from the main triage/task model — these run
 * on every substantive signal, so the default is the cheaper Sonnet. On a
 * local provider this is the knob to point at a small model. */
export function kgModel(db: Db): string {
  return getSetting(db, "kg_model") ?? "claude-sonnet-4-6";
}

export function llmBaseUrl(db: Db): string | null {
  const raw = (getSetting(db, "llm_base_url") ?? process.env.ANTHROPIC_BASE_URL ?? "").trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

export function llmApiKey(db: Db): string | null {
  return getSetting(db, "anthropic_api_key") ?? process.env.ANTHROPIC_API_KEY ?? null;
}

/** The client factory for every direct (non-agent) LLM call. */
export function anthropicClient(db: Db): Anthropic | null {
  const apiKey = llmApiKey(db);
  if (!apiKey) return null;
  return new Anthropic({ apiKey, baseURL: llmBaseUrl(db) ?? undefined });
}

/** Env for Agent SDK query() runs. Claude Code honors ANTHROPIC_BASE_URL, so
 * agent runs follow the same provider as direct calls. Its internal
 * small-model calls (haiku by default) are pointed at the utility model —
 * a name a non-Anthropic endpoint actually serves. */
export function llmEnv(db: Db): Record<string, string> {
  const key = llmApiKey(db);
  const base = llmBaseUrl(db);
  return {
    ...(key ? { ANTHROPIC_API_KEY: key } : {}),
    ...(base
      ? {
          ANTHROPIC_BASE_URL: base,
          ANTHROPIC_SMALL_FAST_MODEL: kgModel(db),
          ANTHROPIC_DEFAULT_HAIKU_MODEL: kgModel(db),
        }
      : {}),
  };
}

/** messages.parse with a portability fallback: Anthropic's native structured
 * outputs against api.anthropic.com; schema-in-prompt + validated JSON parse
 * on custom endpoints (compat providers implement output_config unevenly).
 * Returns the messages.parse shape callers already use. */
export async function parseWithSchema<S extends z.ZodType>(
  db: Db,
  client: Anthropic,
  params: { model: string; max_tokens: number; system?: string; messages: Anthropic.MessageParam[] },
  schema: S,
): Promise<{ parsed_output: z.infer<S> | null; usage: Anthropic.Usage }> {
  if (!llmBaseUrl(db)) {
    const res = await client.messages.parse({
      ...params,
      output_config: { format: zodOutputFormat(schema) },
    });
    return { parsed_output: (res.parsed_output as z.infer<S> | null) ?? null, usage: res.usage };
  }
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
  const system = `${params.system ? `${params.system}\n\n` : ""}Respond with a single JSON object that validates against this JSON Schema — no prose, no markdown fences, nothing outside the JSON:\n${jsonSchema}`;
  const res = await client.messages.create({ ...params, system });
  const text = res.content.find((b) => b.type === "text")?.text ?? "";
  return { parsed_output: extractJson(text, schema), usage: res.usage };
}

function extractJson<S extends z.ZodType>(text: string, schema: S): z.infer<S> | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  const candidates = [stripped, first >= 0 && last > first ? stripped.slice(first, last + 1) : ""];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = schema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through to the next candidate
    }
  }
  return null;
}
