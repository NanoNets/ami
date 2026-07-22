import { getSetting, type Db } from "@ami/db";

// The client honors the configured provider (llm_base_url) — see @ami/memory's llm.ts.
export { anthropicClient } from "@ami/memory";

export function currentModel(db: Db): string {
  return getSetting(db, "model") ?? "claude-opus-4-8";
}

export function fakeLlm(): boolean {
  return process.env.AMI_FAKE_LLM === "1";
}
