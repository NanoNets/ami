import { beforeEach, describe, expect, it } from "vitest";
import { openTestDb, setSetting, type Db } from "@ami/db";
import { z } from "zod";
import { anthropicClient, llmBaseUrl, llmEnv, parseWithSchema } from "../src/llm.js";

let db: Db;

beforeEach(() => {
  db = openTestDb();
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
});

const usage = { input_tokens: 1, output_tokens: 1 } as any;
const textClient = (text: string) =>
  ({ messages: { create: async () => ({ content: [{ type: "text", text }], usage }) } }) as any;

describe("provider config", () => {
  it("normalizes the base URL and treats empty as Anthropic", () => {
    expect(llmBaseUrl(db)).toBeNull();
    setSetting(db, "llm_base_url", "http://localhost:4000/");
    expect(llmBaseUrl(db)).toBe("http://localhost:4000");
    setSetting(db, "llm_base_url", "   ");
    expect(llmBaseUrl(db)).toBeNull();
  });

  it("llmEnv only overrides the endpoint when one is configured", () => {
    setSetting(db, "anthropic_api_key", "sk-test");
    expect(llmEnv(db)).toEqual({ ANTHROPIC_API_KEY: "sk-test" });
    setSetting(db, "llm_base_url", "http://localhost:4000");
    setSetting(db, "kg_model", "qwen3-8b");
    expect(llmEnv(db)).toEqual({
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_BASE_URL: "http://localhost:4000",
      ANTHROPIC_SMALL_FAST_MODEL: "qwen3-8b",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3-8b",
    });
  });

  it("supports a keyless local endpoint (base URL set, no key)", () => {
    // No key and no endpoint: no client, no injected key.
    expect(anthropicClient(db)).toBeNull();
    expect(llmEnv(db)).toEqual({});

    // Base URL but no key: a placeholder token stands in so the client and
    // agent runs work against a proxy that ignores auth.
    setSetting(db, "llm_base_url", "http://localhost:4000");
    expect(anthropicClient(db)).not.toBeNull();
    expect(llmEnv(db).ANTHROPIC_API_KEY).toBeTruthy();
    expect(llmEnv(db).ANTHROPIC_BASE_URL).toBe("http://localhost:4000");
  });
});

describe("parseWithSchema fallback (custom endpoint)", () => {
  const schema = z.object({ ids: z.array(z.string()) });
  const params = { model: "m", max_tokens: 100, messages: [] as any[] };

  beforeEach(() => setSetting(db, "llm_base_url", "http://localhost:4000"));

  it("parses clean JSON, fenced JSON, and JSON wrapped in prose", async () => {
    for (const text of [
      `{"ids":["a","b"]}`,
      "```json\n{\"ids\":[\"a\",\"b\"]}\n```",
      `Sure — here is the result:\n{"ids":["a","b"]}\nLet me know if you need more.`,
    ]) {
      const res = await parseWithSchema(db, textClient(text), params, schema);
      expect(res.parsed_output).toEqual({ ids: ["a", "b"] });
    }
  });

  it("returns null on schema-invalid or non-JSON output", async () => {
    for (const text of [`{"ids":"not-an-array"}`, "I cannot answer that."]) {
      const res = await parseWithSchema(db, textClient(text), params, schema);
      expect(res.parsed_output).toBeNull();
    }
  });

  it("appends the schema instruction to the system prompt", async () => {
    let seen: any;
    const client = {
      messages: {
        create: async (p: any) => {
          seen = p;
          return { content: [{ type: "text", text: `{"ids":[]}` }], usage };
        },
      },
    } as any;
    await parseWithSchema(db, client, { ...params, system: "You classify." }, schema);
    expect(seen.system).toContain("You classify.");
    expect(seen.system).toContain("JSON Schema");
    expect(seen.output_config).toBeUndefined();
  });
});
