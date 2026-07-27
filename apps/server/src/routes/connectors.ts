import { Hono } from "hono";
import { connectorAccounts, syncCursors, upsertAccount, setSetting, getSetting, type Db } from "@ami/db";
import { eq, desc } from "drizzle-orm";
import {
  allConnectors,
  exchangeGoogleCode,
  exchangeMsCode,
  getConnector,
  googleApi,
  googleAuthUrl,
  isCustomConnector,
  listSlackChannels,
  msAuthUrl,
  msGraph,
  msPkcePair,
  removeCustomConnector,
} from "@ami/connectors";
import type { ConnectorStatusDto } from "@ami/shared";
import { publish } from "../sse.js";

const REDIRECT_PATH = "/oauth/google/callback";
const MS_REDIRECT_PATH = "/oauth/microsoft/callback";

/** First-connect backfill, fire-and-forget (progress arrives over SSE). */
function startBootstrap(db: Db, accountId: string): void {
  void import("@ami/engine")
    .then((e) => e.runBootstrap(db, publish, accountId))
    .catch((e) => console.error("[bootstrap]", e));
}

export function connectorRoutes(db: Db, port: number) {
  const app = new Hono();

  app.get("/", async (c) => {
    const { bootstrappingConnectors } = await import("@ami/engine");
    const bootstrapping = new Set(bootstrappingConnectors());
    const accounts = db.select().from(connectorAccounts).all();
    const dtos: ConnectorStatusDto[] = allConnectors().map((conn) => {
      const acct = accounts.find((a) => a.connector === conn.id);
      let lastPolledAt: string | null = null;
      if (acct) {
        const cur = db
          .select()
          .from(syncCursors)
          .where(eq(syncCursors.accountId, acct.id))
          .orderBy(desc(syncCursors.lastPolledAt))
          .limit(1)
          .get();
        lastPolledAt = cur?.lastPolledAt ?? null;
      }
      return {
        connector: conn.id,
        label: conn.meta.label,
        authKind: conn.meta.authKind,
        setupHelp: conn.meta.setupHelp,
        connected: !!acct && acct.status !== "disabled",
        accountLabel: acct?.label ?? null,
        status: acct?.status ?? "not_connected",
        lastPolledAt,
        error: acct?.error ?? null,
        bootstrapping: bootstrapping.has(conn.id),
        custom: isCustomConnector(conn.id),
        authFields: conn.meta.authFields,
        setupActions: conn.meta.setupActions ?? [],
        setupSnippet: conn.meta.setupSnippet ?? null,
      } as ConnectorStatusDto & { authFields: unknown; setupActions: unknown; setupSnippet: unknown };
    });
    return c.json(dtos);
  });

  // ---------- User-built connectors (the connector builder) ----------

  /** Kick off a build: Claude Code researches the app's API and writes a
   * connector module, validated before it registers. Progress over SSE. */
  app.post("/custom", async (c) => {
    const body = await c.req.json<{ name: string; homepage: string; usage: string }>();
    const { startConnectorBuild } = await import("@ami/engine");
    const res = startConnectorBuild(db, publish, body);
    return c.json(res, res.ok ? 200 : 400);
  });

  app.get("/custom/builds", async (c) => {
    const { connectorBuilds } = await import("@ami/engine");
    return c.json(connectorBuilds());
  });

  app.delete("/custom/:id", (c) => {
    const id = c.req.param("id");
    if (!isCustomConnector(id)) return c.json({ error: "not a custom connector" }, 400);
    db.delete(connectorAccounts).where(eq(connectorAccounts.connector, id)).run();
    removeCustomConnector(id);
    publish({ type: "connector.status", connector: id, status: "removed" });
    return c.json({ ok: true });
  });

  // Token-based connect (slack, github, zoom, notion, …) + storing google client creds.
  app.post("/:id/connect", async (c) => {
    const id = c.req.param("id");
    const connector = getConnector(id);
    if (!connector) return c.json({ error: "unknown connector" }, 404);
    const auth = await c.req.json<Record<string, string>>();

    if (connector.meta.authKind === "oauth") {
      if (id === "gmail") {
        // Google: store client creds, return the browser auth URL.
        // Sanitize the pasted client id — copies often pick up a URL scheme or whitespace.
        const clientId = auth.client_id.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
        if (!clientId.endsWith(".apps.googleusercontent.com")) {
          return c.json(
            { ok: false, error: "That doesn't look like a Google OAuth client ID — it should end with .apps.googleusercontent.com" },
            400,
          );
        }
        setSetting(db, "google_client_id", clientId);
        setSetting(db, "google_client_secret", auth.client_secret.trim());
        const url = googleAuthUrl(clientId, `http://localhost:${port}${REDIRECT_PATH}`, "ami");
        return c.json({ ok: true, authUrl: url });
      }
      if (id === "m365") {
        // Microsoft: public client + PKCE — no secret to store.
        const clientId = auth.client_id.trim();
        const tenant = (auth.tenant ?? "").trim() || "common";
        const { verifier, challenge } = msPkcePair();
        setSetting(db, "ms_client_id", clientId);
        setSetting(db, "ms_tenant", tenant);
        setSetting(db, "ms_code_verifier", verifier);
        const url = msAuthUrl(clientId, tenant, `http://localhost:${port}${MS_REDIRECT_PATH}`, challenge);
        return c.json({ ok: true, authUrl: url });
      }
      // gdrive/msteams ride along with their sibling's consent.
      return c.json({ ok: false, error: "This connector is registered automatically by its bundled OAuth connect." }, 400);
    }

    const check = await connector.validateAuth(auth);
    if (!check.ok) return c.json({ ok: false, error: check.error }, 400);
    const accountId = upsertAccount(db, id, auth, check.accountLabel ?? id);
    publish({ type: "connector.status", connector: connector.id, status: "connected" });

    // Pre-fill owner identity from the connected account (onboarding shows it
    // for editing) — never overwrite values the user already set.
    if (connector.identity) {
      try {
        const info = await connector.identity(auth);
        const email = info.email?.toLowerCase();
        if (!getSetting(db, "user_name") && info.name) setSetting(db, "user_name", info.name);
        if (!getSetting(db, "user_email") && email) setSetting(db, "user_email", email);
        if (!getSetting(db, "user_domain") && email?.includes("@")) {
          setSetting(db, "user_domain", email.split("@")[1]);
        }
      } catch (e) {
        console.error(`[${id} identity prefill]`, e);
      }
    }

    startBootstrap(db, accountId);
    return c.json({ ok: true, accountLabel: check.accountLabel });
  });

  // ---------- Slack channel modes (read every message vs mentions-only) ----------

  app.get("/slack/channels", async (c) => {
    const acct = db
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.connector, "slack"))
      .get();
    if (!acct) return c.json({ error: "slack not connected" }, 400);
    try {
      const { channels, privateUnavailable } = await listSlackChannels(JSON.parse(acct.authJson));
      const readAll: { id: string }[] = JSON.parse(getSetting(db, "slack_read_all_channels") ?? "[]");
      return c.json({
        channels,
        privateUnavailable,
        readAllIds: readAll.map((ch) => ch.id),
        readDms: getSetting(db, "slack_read_dms") !== "0",
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  app.post("/slack/channels", async (c) => {
    const body = await c.req.json<{ readAll: { id: string; name: string }[]; readDms?: boolean }>();
    const readAll = (body.readAll ?? []).map((ch) => ({ id: ch.id, name: ch.name }));
    setSetting(db, "slack_read_all_channels", JSON.stringify(readAll));
    if (body.readDms !== undefined) setSetting(db, "slack_read_dms", body.readDms ? "1" : "0");
    return c.json({ ok: true, count: readAll.length });
  });

  app.post("/:id/disconnect", (c) => {
    const id = c.req.param("id");
    db.delete(connectorAccounts).where(eq(connectorAccounts.connector, id)).run();
    return c.json({ ok: true });
  });

  return app;
}

/** GET /oauth/google/callback — completes the loopback OAuth flow and registers
 * both gmail and gcal accounts with the shared token blob. */
export function googleCallbackRoute(db: Db, port: number) {
  const app = new Hono();
  app.get(REDIRECT_PATH, async (c) => {
    const code = c.req.query("code");
    if (!code) return c.text("Missing code", 400);
    const clientId = getSetting(db, "google_client_id");
    const clientSecret = getSetting(db, "google_client_secret");
    if (!clientId || !clientSecret) return c.text("Google client not configured", 400);
    try {
      const tokens = await exchangeGoogleCode(
        clientId,
        clientSecret,
        code,
        `http://localhost:${port}${REDIRECT_PATH}`,
      );
      const auth = {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        expiry: String(Date.now() + tokens.expires_in * 1000),
      };
      const gmail = getConnector("gmail")!;
      const check = await gmail.validateAuth(auth);
      const label = check.accountLabel ?? "google";
      const gmailId = upsertAccount(db, "gmail", auth, label);
      const gcalId = upsertAccount(db, "gcal", auth, label);
      const gdriveId = upsertAccount(db, "gdrive", auth, label);
      publish({ type: "connector.status", connector: "gmail", status: "connected" });
      publish({ type: "connector.status", connector: "gcal", status: "connected" });
      publish({ type: "connector.status", connector: "gdrive", status: "connected" });

      // Pre-fill owner identity from the Google account (onboarding shows it for
      // editing) — never overwrite values the user already set.
      try {
        const info = await googleApi(auth, "https://www.googleapis.com/oauth2/v2/userinfo");
        const email = typeof info.email === "string" ? info.email.toLowerCase() : null;
        if (!getSetting(db, "user_email") && email) setSetting(db, "user_email", email);
        if (!getSetting(db, "user_name") && typeof info.name === "string" && info.name) {
          setSetting(db, "user_name", info.name);
        }
        if (!getSetting(db, "user_domain") && email?.includes("@")) {
          setSetting(db, "user_domain", email.split("@")[1]);
        }
      } catch (e) {
        console.error("[google identity prefill]", e);
      }

      startBootstrap(db, gmailId);
      startBootstrap(db, gcalId);
      startBootstrap(db, gdriveId);
      return c.html(
        `<html><body style="font-family:sans-serif;padding:3rem;text-align:center"><h2>Google connected ✓</h2><p>${label}</p><p>You can close this tab and return to Ami.</p></body></html>`,
      );
    } catch (e: any) {
      return c.text(`OAuth failed: ${e.message}`, 500);
    }
  });
  return app;
}

/** GET /oauth/microsoft/callback — completes the PKCE flow and registers both
 * m365 (mail+calendar) and msteams with the shared Graph token blob. */
export function microsoftCallbackRoute(db: Db, port: number) {
  const app = new Hono();
  app.get(MS_REDIRECT_PATH, async (c) => {
    const code = c.req.query("code");
    if (!code) return c.text(`Missing code: ${c.req.query("error_description") ?? ""}`, 400);
    const clientId = getSetting(db, "ms_client_id");
    const tenant = getSetting(db, "ms_tenant") || "common";
    const verifier = getSetting(db, "ms_code_verifier");
    if (!clientId || !verifier) return c.text("Microsoft client not configured", 400);
    try {
      const tokens = await exchangeMsCode(
        clientId,
        tenant,
        code,
        `http://localhost:${port}${MS_REDIRECT_PATH}`,
        verifier,
      );
      const auth = {
        client_id: clientId,
        tenant,
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        expiry: String(Date.now() + tokens.expires_in * 1000),
      };
      const me = await msGraph(auth, "/me?$select=displayName,mail,userPrincipalName");
      const label = me.mail ?? me.userPrincipalName ?? "microsoft";
      const m365Id = upsertAccount(db, "m365", auth, label);
      const teamsId = upsertAccount(db, "msteams", auth, `${label} (Teams)`);
      publish({ type: "connector.status", connector: "m365", status: "connected" });
      publish({ type: "connector.status", connector: "msteams", status: "connected" });

      // Pre-fill owner identity from the Microsoft account — same rules as
      // Google/Slack: never overwrite what the user already set.
      const email = typeof label === "string" && label.includes("@") ? label.toLowerCase() : null;
      if (!getSetting(db, "user_name") && me.displayName) setSetting(db, "user_name", me.displayName);
      if (!getSetting(db, "user_email") && email) setSetting(db, "user_email", email);
      if (!getSetting(db, "user_domain") && email) setSetting(db, "user_domain", email.split("@")[1]);

      startBootstrap(db, m365Id);
      startBootstrap(db, teamsId);
      return c.html(
        `<html><body style="font-family:sans-serif;padding:3rem;text-align:center"><h2>Microsoft connected ✓</h2><p>${label}</p><p>You can close this tab and return to Ami.</p></body></html>`,
      );
    } catch (e: any) {
      return c.text(`OAuth failed: ${e.message}`, 500);
    }
  });
  return app;
}
