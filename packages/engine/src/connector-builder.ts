import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { amiHome, getSetting, insertLlmUsage, type Db } from "@ami/db";
import { llmApiKey, llmEnv } from "@ami/memory";
import {
  activateCustomConnector,
  connectorIdAvailable,
  customConnectorFile,
  instantiateCustomConnector,
} from "@ami/connectors";
import { WRITING_STYLE, type AmiEvent } from "@ami/shared";

type Publish = (e: AmiEvent) => void;

/** The connector builder: a Claude Code session that researches an app's API
 * and writes a connector module matching the built-in ones exactly — same
 * interface, same registry, same tool surface. The agent iterates against the
 * validate_connector tool until the module loads clean; the harness then
 * re-validates independently before registering it. */

export interface ConnectorBuild {
  id: string;
  name: string;
  status: "running" | "succeeded" | "failed";
  message?: string;
  startedAt: string;
  finishedAt?: string;
}

const builds = new Map<string, ConnectorBuild>();

export function connectorBuilds(): ConnectorBuild[] {
  return [...builds.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || "app"
  );
}

/** The full authoring contract, taught the way the built-ins implement it. */
const CONNECTOR_SPEC = `You build a connector for Ami, a local AI assistant. A connector is ONE self-contained ESM module that talks to an app's public HTTP API. It must be indistinguishable in quality from Ami's built-in connectors.

# Module contract

The file default-exports a factory. Dependencies are injected — the module must not import anything except Node built-ins (node:crypto, node:url, …). \`fetch\` is global. No npm packages.

\`\`\`js
// connector.mjs — complete worked example for a fictional task app
export default function createConnector({ z }) {
  const BASE = "https://api.acmetask.com/v1";

  async function api(auth, path, init = {}) {
    const res = await fetch(\`\${BASE}\${path}\`, {
      ...init,
      headers: {
        Authorization: \`Bearer \${auth.api_key}\`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(\`acmetask \${path}: \${j.error?.message ?? res.status}\`);
    return j;
  }

  return {
    id: "acmetask",
    meta: {
      label: "AcmeTask",
      authKind: "token",
      authFields: [{ key: "api_key", label: "API key", secret: true }],
      setupHelp:
        "Create a personal API key in AcmeTask under Settings → API and paste it here. Ami reads your assigned tasks and drafts comments you approve before they post.",
      setupActions: [{ label: "Open AcmeTask API settings", url: "https://app.acmetask.com/settings/api" }],
    },
    async validateAuth(auth) {
      try {
        const me = await api(auth, "/me");
        return { ok: true, accountLabel: me.email ?? me.name };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    streams() {
      return [{ name: "assigned", intervalSec: 180 }];
    },
    async poll({ auth, cursor }) {
      const since = cursor ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const j = await api(auth, \`/tasks?assigned=me&updated_after=\${encodeURIComponent(since)}\`);
      const items = j.tasks ?? [];
      const signals = items.map((t) => ({
        externalId: \`task:\${t.id}:\${t.updated_at}\`,
        kind: "ticket",
        title: t.title,
        body: t.description ?? "",
        author: t.creator?.name ?? "unknown",
        url: t.web_url,
        threadRef: String(t.id),
        raw: t,
        occurredAt: t.updated_at,
      }));
      const newest = items.map((t) => t.updated_at).sort().pop() ?? since;
      return { signals, nextCursor: newest };
    },
    actions: [
      {
        name: "acmetask_list_tasks",
        readOnly: true,
        description:
          "List the user's AcmeTask tasks, newest first. Use to see current workload before creating or commenting.",
        schema: {
          status: z.enum(["open", "done", "all"]).default("open"),
          limit: z.number().int().min(1).max(50).default(20),
        },
        async run(auth, input) {
          try {
            const j = await api(auth, \`/tasks?status=\${input.status}&limit=\${input.limit ?? 20}\`);
            const tasks = (j.tasks ?? []).map((t) => ({ id: t.id, title: t.title, status: t.status, url: t.web_url }));
            return { ok: true, output: tasks };
          } catch (e) {
            return { ok: false, output: null, error: e.message };
          }
        },
      },
      {
        name: "acmetask_comment",
        isSend: true,
        description: "Post a comment on an AcmeTask task in the user's name (goes through draft approval).",
        schema: { targetRef: z.string().describe("Task id"), body: z.string() },
        async run(auth, input) {
          try {
            const j = await api(auth, \`/tasks/\${input.targetRef}/comments\`, {
              method: "POST",
              body: JSON.stringify({ text: input.body }),
            });
            return { ok: true, externalId: String(j.comment.id), url: j.comment.web_url, output: j.comment };
          } catch (e) {
            return { ok: false, output: null, error: e.message };
          }
        },
      },
    ],
  };
}
\`\`\`

# Field semantics

- **id**: given in the task — use it exactly. Every action name is prefixed \`<id>_\`.
- **meta.authKind**: "token" (the user pastes an API key/PAT — the normal case) or "none". OAuth is not available to custom connectors.
- **meta.authFields**: what the connect form collects. Keys become \`auth.<key>\` in your code. Mark secrets \`secret: true\`. Ask only for what the API needs (key; plus e.g. a workspace URL when the API is per-instance).
- **meta.setupHelp**: 2-4 sentences telling the user exactly where in the app to create the token, which scopes/permissions to give it, and what Ami will do. This renders in the connect panel.
- **meta.setupActions**: optional deep links to the app's token-creation page. \`{field}\` placeholders substitute typed auth fields.
- **validateAuth**: one cheap authenticated call (a /me or equivalent). Returns \`accountLabel\` (email/username/workspace) shown on the connector card. Never throws.
- **streams() + poll(ctx)**: the inbox. Declare a stream ONLY for things that should reach the user's to-do list (things assigned to them, mentions of them, replies to them, new items needing their attention). Dashboards, metrics and archives are NOT streams — actions cover those. If nothing in this app demands the user's attention, return \`[]\` from streams() and \`{ signals: [], nextCursor: null }\` from poll. Poll rules:
  - \`ctx.cursor\` is yours: an ISO timestamp or the API's own cursor. First run (null cursor) looks back ~24h, never further.
  - \`externalId\` must be stable and unique per item (dedup key).
  - \`kind\` is one of "message" | "email" | "event" | "issue" | "ticket".
  - \`threadRef\` is where a reply would go — set it whenever the app supports replying, matching what your isSend action expects as targetRef.
  - intervalSec >= 120. poll may throw; the scheduler records the error.
- **actions**: the agent-facing tool surface. Every action carries exactly one mark:
  - \`readOnly: true\` — pure reads. Most actions. list/search/get for whatever the user's intended usage needs.
  - \`isSend: true\` — delivers a message/comment/reply to humans. Signature is fixed: \`run(auth, { targetRef, body })\` — Ami's draft-approval flow calls it exactly like that. At most one send action. Never callable directly by agents; only through approved drafts.
  - \`needsApproval: true\` — every other side effect (create, update, configure). Each call pauses for the user's explicit approval in the console.
  - Destructive operations (delete, cancel, revoke, refund) get NO action at all unless the intended usage explicitly asks; then they are needsApproval.
- **run() never throws** — always \`return { ok: false, output: null, error: e.message }\` on failure, with an error message specific enough for the agent to correct course (include the API's own message).
- **descriptions** are written for the AI agent that picks tools: say what it returns and when to reach for it.

# Method

1. Research before writing. WebFetch the app's homepage and find the OFFICIAL API documentation. Confirm the real base URL, auth header format, endpoint paths, response shapes, pagination and rate limits from the docs — never guess an endpoint. If docs pages 404, search for them.
2. Design the surface from the user's intended usage: 4-10 actions that make that usage genuinely work, plus the reads an agent needs for orientation (list + search + get). A stream only if items demand the user's attention.
3. Write connector.mjs, then call validate_connector. Fix every reported problem and validate again — repeat until it returns ok: true. You are not done while validation fails.
4. Robustness: encodeURIComponent every interpolated value; cap page sizes; truncate long text fields in outputs (agents don't need 50KB blobs); tolerate missing optional fields with ?? fallbacks.
5. When validation passes, end with a short summary: what the connector reads, what it can do, where the user gets their token.

${WRITING_STYLE}`;

async function runBuild(
  db: Db,
  publish: Publish,
  args: { id: string; name: string; homepage: string; usage: string },
): Promise<void> {
  const { id, name, homepage, usage } = args;
  const build = builds.get(id)!;
  const dir = path.join(amiHome(), "connectors", id);
  fs.mkdirSync(dir, { recursive: true });
  const file = customConnectorFile(id);

  const finish = (status: "succeeded" | "failed", message: string) => {
    build.status = status;
    build.message = message;
    build.finishedAt = new Date().toISOString();
    publish({ type: "connector.build", connector: id, status, message });
  };

  const validateTool = tool(
    "validate_connector",
    "Load connector.mjs and check it against Ami's connector contract. Returns ok: true when the module is valid, otherwise every problem found. Call after each edit; you are done only when this passes.",
    {},
    async () => {
      const res = await instantiateCustomConnector(file, id);
      const payload = res.connector
        ? {
            ok: true,
            label: res.connector.meta.label,
            streams: res.connector.streams().map((s) => s.name),
            actions: res.connector.actions.map((a) => a.name),
          }
        : { ok: false, errors: res.errors };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    },
  );

  const abort = new AbortController();
  const watchdog = setTimeout(() => abort.abort(), 25 * 60 * 1000);
  let model = getSetting(db, "model") ?? "claude-opus-4-8";
  let failed: string | null = null;

  try {
    const q = query({
      prompt: `Build the Ami connector for **${name}**.

- Connector id (use exactly): \`${id}\`
- App homepage: ${homepage}
- What the user wants Ami to do with it:

${usage}

Write the module to \`${file}\` (your working directory is the connector's folder). Research the app's official API docs first, then write, then validate_connector until it passes.`,
      options: {
        cwd: dir,
        abortController: abort,
        model,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        tools: ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"],
        mcpServers: {
          builder: createSdkMcpServer({ name: "builder", tools: [validateTool] }),
        },
        systemPrompt: CONNECTOR_SPEC,
        env: { ...process.env, ...llmEnv(db) },
        maxTurns: 150,
      },
    });

    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        model = msg.model;
      } else if (msg.type === "result") {
        if (msg.subtype !== "success") failed = msg.subtype;
        const u: any = (msg as any).usage;
        insertLlmUsage(db, {
          useCase: "connector_builder",
          subUseCase: id,
          model,
          inputTokens: u?.input_tokens ?? 0,
          outputTokens: u?.output_tokens ?? 0,
          cacheReadTokens: u?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
          costUsd: (msg as any).total_cost_usd ?? undefined,
        });
      }
    }
  } catch (e: any) {
    failed = abort.signal.aborted ? "timed out (25 min)" : String(e?.message ?? e);
  } finally {
    clearTimeout(watchdog);
  }

  // The agent's claim isn't the verdict — the harness validates independently
  // and only a clean module reaches the registry.
  const res = await instantiateCustomConnector(file, id);
  if (res.connector) {
    activateCustomConnector(res.connector);
    publish({ type: "connector.status", connector: id, status: "built" });
    finish(
      "succeeded",
      `${res.connector.meta.label}: ${res.connector.actions.length} action(s), ${res.connector.streams().length} stream(s). Enter your ${name} credentials to connect.`,
    );
  } else {
    finish("failed", failed ?? `validation failed: ${res.errors.join("; ")}`);
  }
}

export function startConnectorBuild(
  db: Db,
  publish: Publish,
  args: { name: string; homepage: string; usage: string },
): { ok: boolean; id?: string; error?: string } {
  if (!llmApiKey(db)) return { ok: false, error: "no API key configured" };
  const name = args.name.trim();
  const homepage = args.homepage.trim();
  const usage = args.usage.trim();
  if (!name || !usage) return { ok: false, error: "name and intended usage are required" };

  const id = slugify(name);
  if (builds.get(id)?.status === "running") return { ok: false, error: `a build for "${id}" is already running` };
  if (!connectorIdAvailable(id) && !fs.existsSync(customConnectorFile(id)))
    return { ok: false, error: `"${id}" collides with a built-in connector — pick another name` };

  builds.set(id, { id, name, status: "running", startedAt: new Date().toISOString() });
  publish({ type: "connector.build", connector: id, status: "running" });
  void runBuild(db, publish, { id, name, homepage, usage }).catch((e) => {
    const b = builds.get(id);
    if (b && b.status === "running") {
      b.status = "failed";
      b.message = String(e?.message ?? e);
      b.finishedAt = new Date().toISOString();
      publish({ type: "connector.build", connector: id, status: "failed", message: b.message });
    }
  });
  return { ok: true, id };
}
