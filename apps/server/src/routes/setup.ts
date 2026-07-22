import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { getSetting, setSetting, type Db } from "@ami/db";
import { llmBaseUrl } from "@ami/memory";

export function setupRoutes(db: Db) {
  const app = new Hono();

  app.get("/status", (c) => {
    const hasApiKey = !!(getSetting(db, "anthropic_api_key") ?? process.env.ANTHROPIC_API_KEY);
    return c.json({
      hasApiKey,
      // Installs that predate the flag but finished setup (key + identity)
      // count as onboarded, so upgrades don't hide the nav on them.
      onboarded:
        getSetting(db, "onboarding_complete") === "1" ||
        (hasApiKey && !!getSetting(db, "user_email")),
      model: getSetting(db, "model") ?? "claude-opus-4-8",
      kgModel: getSetting(db, "kg_model") ?? "claude-sonnet-4-6",
      baseUrl: getSetting(db, "llm_base_url") ?? "",
    });
  });

  /** Set by the console when the user clicks through the end of onboarding. */
  app.post("/complete", (c) => {
    setSetting(db, "onboarding_complete", "1");
    return c.json({ ok: true });
  });

  app.post("/apikey", async (c) => {
    const { apiKey } = await c.req.json<{ apiKey: string }>();
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
    } catch (e: any) {
      // The SDK's e.message embeds the raw JSON error body; pull out the
      // human-readable message and translate the two common failures.
      const apiMsg: string | undefined = e?.error?.error?.message;
      const provider = baseUrl ? `The endpoint at ${new URL(baseUrl).host}` : "Anthropic";
      let msg: string;
      if (e?.status === 401) {
        msg = `${provider} rejected this key. Check for typos and that the key is still active.`;
      } else if (apiMsg?.toLowerCase().includes("credit balance")) {
        msg = "The key is valid, but its account is out of credits. Add credits under Plans & Billing at platform.claude.com, then save again.";
      } else if (baseUrl && e?.status === 404) {
        msg = `${provider} accepted the connection but doesn't serve model "${getSetting(db, "model") ?? "claude-opus-4-8"}". Set the model names to ones your provider serves, then save the key again.`;
      } else {
        msg = `Key validation failed: ${apiMsg ?? e?.message ?? "unknown error"}`;
      }
      return c.json({ ok: false, error: msg }, 400);
    }
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
