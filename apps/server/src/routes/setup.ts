import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { getSetting, setSetting, type Db } from "@ami/db";
import { llmBaseUrl } from "@ami/memory";

type LlmMode = "anthropic" | "hosted" | "local";

/** The three-way provider choice the console's model config presents. Stored
 * explicitly so the UI restores the right tab; derived for installs that
 * predate the setting from whether a base URL is set and whether it's local. */
function llmMode(db: Db): LlmMode {
  const stored = getSetting(db, "llm_mode");
  if (stored === "anthropic" || stored === "hosted" || stored === "local") return stored;
  const base = (getSetting(db, "llm_base_url") ?? "").trim();
  if (!base) return "anthropic";
  try {
    const host = new URL(base).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") return "local";
  } catch {
    // unparseable base URL — treat as a hosted endpoint
  }
  return "hosted";
}

/** Validate a key against the currently-configured endpoint and model. Returns
 * a human-readable error string, or null on success. Does not persist. */
async function validateKey(db: Db, apiKey: string): Promise<string | null> {
  const baseUrl = llmBaseUrl(db);
  try {
    const client = new Anthropic({ apiKey, baseURL: baseUrl ?? undefined });
    if (baseUrl) {
      // Compat endpoints rarely implement count_tokens — validate with a
      // minimal real completion against the configured model instead.
      await client.messages.create({
        model: getSetting(db, "model") ?? "claude-opus-4-8",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      });
    } else {
      await client.messages.countTokens({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "ping" }],
      });
    }
    return null;
  } catch (e: any) {
    // The SDK's e.message embeds the raw JSON error body; pull out the
    // human-readable message and translate the two common failures.
    const apiMsg: string | undefined = e?.error?.error?.message;
    const provider = baseUrl ? `The endpoint at ${new URL(baseUrl).host}` : "Anthropic";
    if (e?.status === 401) {
      return `${provider} rejected this key. Check for typos and that the key is still active.`;
    }
    if (apiMsg?.toLowerCase().includes("credit balance")) {
      return "The key is valid, but its account is out of credits. Add credits under Plans & Billing at platform.claude.com, then save again.";
    }
    if (baseUrl && e?.status === 404) {
      return `${provider} accepted the connection but doesn't serve model "${getSetting(db, "model") ?? "claude-opus-4-8"}". Set the model names to ones your provider serves, then save again.`;
    }
    return `Key validation failed: ${apiMsg ?? e?.message ?? "unknown error"}`;
  }
}

export function setupRoutes(db: Db) {
  const app = new Hono();

  app.get("/status", (c) => {
    const hasApiKey = !!(getSetting(db, "anthropic_api_key") ?? process.env.ANTHROPIC_API_KEY);
    const baseUrl = getSetting(db, "llm_base_url") ?? "";
    const mode = llmMode(db);
    // A keyless local proxy counts as configured even without a key.
    const llmReady = hasApiKey || (mode === "local" && !!baseUrl);
    return c.json({
      hasApiKey,
      llmReady,
      mode,
      // Installs that predate the flag but finished setup (LLM + identity)
      // count as onboarded, so upgrades don't hide the nav on them.
      onboarded:
        getSetting(db, "onboarding_complete") === "1" ||
        (llmReady && !!getSetting(db, "user_email")),
      model: getSetting(db, "model") ?? "claude-opus-4-8",
      kgModel: getSetting(db, "kg_model") ?? "claude-sonnet-4-6",
      baseUrl,
    });
  });

  /** Set by the console when the user clicks through the end of onboarding. */
  app.post("/complete", (c) => {
    setSetting(db, "onboarding_complete", "1");
    return c.json({ ok: true });
  });

  app.post("/apikey", async (c) => {
    const { apiKey } = await c.req.json<{ apiKey: string }>();
    const error = await validateKey(db, apiKey);
    if (error) return c.json({ ok: false, error }, 400);
    setSetting(db, "anthropic_api_key", apiKey);
    return c.json({ ok: true });
  });

  /** Anthropic-compatible endpoint override (LiteLLM proxy in front of local
   * models, or hosted open-model providers). Empty = api.anthropic.com. */
  app.post("/baseurl", async (c) => {
    const { baseUrl } = await c.req.json<{ baseUrl: string }>();
    const trimmed = (baseUrl ?? "").trim().replace(/\/+$/, "");
    if (trimmed && !/^https?:\/\//.test(trimmed)) {
      return c.json({ ok: false, error: "Base URL must start with http:// or https://" }, 400);
    }
    setSetting(db, "llm_base_url", trimmed);
    return c.json({ ok: true });
  });

  /** One atomic save for the console's three-mode model config. Persists the
   * mode, endpoint and model names first, then validates the key against that
   * now-current config (so a hosted key is checked against its own endpoint).
   * In local mode the key is optional — a blank key skips validation. */
  app.post("/llm-config", async (c) => {
    const body = await c.req.json<{
      mode: LlmMode;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      kgModel?: string;
    }>();
    const mode: LlmMode =
      body.mode === "hosted" || body.mode === "local" ? body.mode : "anthropic";

    // Anthropic mode never uses a base URL; the others require a valid one.
    const baseUrl =
      mode === "anthropic" ? "" : (body.baseUrl ?? "").trim().replace(/\/+$/, "");
    if (mode !== "anthropic") {
      if (!baseUrl) return c.json({ ok: false, error: "Enter the endpoint URL." }, 400);
      if (!/^https?:\/\//.test(baseUrl)) {
        return c.json({ ok: false, error: "Endpoint must start with http:// or https://" }, 400);
      }
    }

    // Persist config first so key validation runs against the real endpoint.
    setSetting(db, "llm_mode", mode);
    setSetting(db, "llm_base_url", baseUrl);
    if (body.model?.trim()) setSetting(db, "model", body.model.trim());
    if (body.kgModel?.trim()) setSetting(db, "kg_model", body.kgModel.trim());

    const apiKey = (body.apiKey ?? "").trim();
    if (!apiKey) {
      if (mode === "local") {
        // Keyless local proxy — clear any stale key and accept the config.
        setSetting(db, "anthropic_api_key", "");
        return c.json({ ok: true });
      }
      // Blank key but one's already stored: the user is editing the model or
      // endpoint, not rotating the key — keep it (they can re-paste to revalidate).
      if (getSetting(db, "anthropic_api_key")) return c.json({ ok: true });
      return c.json({ ok: false, error: "Enter your API key." }, 400);
    }

    const error = await validateKey(db, apiKey);
    if (error) return c.json({ ok: false, error }, 400);
    setSetting(db, "anthropic_api_key", apiKey);
    return c.json({ ok: true });
  });

  app.post("/model", async (c) => {
    const { model } = await c.req.json<{ model: string }>();
    setSetting(db, "model", model);
    return c.json({ ok: true });
  });

  /** Model for the knowledge agents (note creation, curation, agent notes,
   * distillation) — runs on every substantive signal, so it gets its own,
   * typically cheaper, knob. */
  app.post("/kgmodel", async (c) => {
    const { model } = await c.req.json<{ model: string }>();
    setSetting(db, "kg_model", model);
    return c.json({ ok: true });
  });

  /** Owner identity — injected into triage, memory agents and task runs so
   * Ami never guesses who the user is from email headers. */
  app.get("/identity", (c) => {
    return c.json({
      name: getSetting(db, "user_name") ?? "",
      email: getSetting(db, "user_email") ?? "",
      domain: getSetting(db, "user_domain") ?? "",
    });
  });

  /** Granola meeting-notes ingestion (reads the local Granola app's token). */
  app.get("/granola", async (c) => {
    const { granolaAvailable } = await import("@ami/engine");
    return c.json({
      available: granolaAvailable(),
      enabled: getSetting(db, "granola_enabled") === "1",
    });
  });

  app.post("/granola", async (c) => {
    const { enabled } = await c.req.json<{ enabled: boolean }>();
    setSetting(db, "granola_enabled", enabled ? "1" : "0");
    return c.json({ ok: true });
  });

  app.post("/identity", async (c) => {
    const { name, email, domain } = await c.req.json<{ name?: string; email?: string; domain?: string }>();
    if (name !== undefined) setSetting(db, "user_name", name.trim());
    if (email !== undefined) setSetting(db, "user_email", email.trim().toLowerCase());
    if (domain !== undefined) setSetting(db, "user_domain", domain.trim().toLowerCase());
    return c.json({ ok: true });
  });

  return app;
}
