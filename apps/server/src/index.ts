import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "@ami/db";
import { subscribe } from "./sse.js";
import { startScheduler } from "./scheduler.js";
import { setupRoutes } from "./routes/setup.js";
import { connectorRoutes, googleCallbackRoute, microsoftCallbackRoute } from "./routes/connectors.js";
import { todoRoutes } from "./routes/todos.js";
import { taskRoutes } from "./routes/tasks.js";
import { draftRoutes } from "./routes/drafts.js";
import { memoryRoutes } from "./routes/memory.js";
import { questionRoutes } from "./routes/questions.js";
import { projectRoutes } from "./routes/projects.js";
import { agentRoutes } from "./routes/agents.js";
import { chatRoutes } from "./routes/chat.js";
import { searchRoutes } from "./routes/search.js";
import { recorderRoutes } from "./routes/recorder.js";
import { exportRoutes } from "./routes/exports.js";

const PORT = parseInt(process.env.AMI_PORT ?? "4141", 10);
const db = openDb();

// User-built connectors register before anything polls or serves.
try {
  const { loadCustomConnectors } = await import("@ami/connectors");
  const res = await loadCustomConnectors();
  if (res.loaded.length) console.log(`[connectors] custom loaded: ${res.loaded.join(", ")}`);
  for (const [id, err] of Object.entries(res.errors)) console.error(`[connectors] custom ${id} skipped: ${err}`);
} catch (e) {
  console.error("[connectors] custom load", e);
}

const app = new Hono();

app.route("/api/setup", setupRoutes(db));
app.route("/api/exports", exportRoutes());
app.route("/api/connectors", connectorRoutes(db, PORT));
app.route("/", googleCallbackRoute(db, PORT));
app.route("/", microsoftCallbackRoute(db, PORT));
app.route("/api/todos", todoRoutes(db));
app.route("/api/tasks", taskRoutes(db));
app.route("/api/drafts", draftRoutes(db));
app.route("/api/memory", memoryRoutes(db));
app.route("/api/questions", questionRoutes(db));
app.route("/api/projects", projectRoutes(db));
app.route("/api/agents", agentRoutes(db));
app.route("/api/chat", chatRoutes(db));
app.route("/api/search", searchRoutes(db));
app.route("/api/recorder", recorderRoutes(db));

app.get("/api/meetings/today", async (c) => {
  const { todayMeetings } = await import("@ami/engine");
  return c.json(await todayMeetings(db));
});

app.get("/api/events", (c) =>
  streamSSE(c, async (stream) => {
    let open = true;
    const unsubscribe = subscribe((e) => {
      if (open) void stream.writeSSE({ data: JSON.stringify(e) });
    });
    stream.onAbort(() => {
      open = false;
      unsubscribe();
    });
    // Heartbeat keeps proxies from closing the stream.
    while (open) {
      await stream.writeSSE({ event: "ping", data: String(Date.now()) });
      await new Promise((r) => setTimeout(r, 25_000));
    }
  }),
);

// Serve the built console.
const consoleDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../console/dist",
);
if (fs.existsSync(consoleDist)) {
  const rel = path.relative(process.cwd(), consoleDist);
  // The entry document must always revalidate: a cached index.html points at
  // hashed bundles that stop existing on the next build, which blanks the page.
  const serveIndex = (c: Context) => {
    c.header("Cache-Control", "no-cache");
    return c.html(fs.readFileSync(path.join(consoleDist, "index.html"), "utf8"));
  };
  app.get("/", serveIndex);
  // Hashed assets never change content: cache forever. A missing one must be
  // a real 404 — falling back to index.html hands the browser HTML where it
  // expects JavaScript, and the console dies with a parse error.
  app.use("/assets/*", async (c, next) => {
    await next();
    if (c.res.status === 200) c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  });
  app.use("/assets/*", serveStatic({ root: rel }));
  app.get("/assets/*", (c) => c.text("not found", 404));
  app.use("/*", serveStatic({ root: rel }));
  app.get("/*", serveIndex); // SPA fallback for client-side routes
} else {
  app.get("/", (c) =>
    c.text("Console not built. Run `pnpm --filter @ami/console build` (or use the console dev server on :5173)."),
  );
}

startScheduler(db);

// Warm the shared browser server so the first turn that needs it doesn't pay
// the cold-start wait (the browser window itself stays lazy until first use).
void import("@ami/engine").then(({ startBrowserMcp }) => startBrowserMcp());

// AWS self-connects from the local CLI (~/.aws) when credentials work — no
// manual connect step, and it survives onboarding wipes. Writes stay
// approval-gated regardless of how the connector was registered.
void (async () => {
  const { connectorAccounts, upsertAccount } = await import("@ami/db");
  const { eq } = await import("drizzle-orm");
  const { getConnector } = await import("@ami/connectors");
  const existing = db.select().from(connectorAccounts).where(eq(connectorAccounts.connector, "aws")).get();
  if (existing) return;
  const aws = getConnector("aws");
  if (!aws) return;
  const check = await aws.validateAuth({}).catch(() => ({ ok: false as const, error: "unreachable" }));
  if (check.ok) {
    upsertAccount(db, "aws", {}, check.accountLabel ?? "local CLI");
    console.log(`[aws] auto-connected from local CLI (${check.accountLabel})`);
  }
})().catch((e) => console.error("[aws auto-connect]", e));

serve({ fetch: app.fetch, port: PORT }, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  ami console →  ${url}\n`);
  if (process.env.AMI_NO_OPEN !== "1" && process.platform === "darwin") {
    exec(`open ${url}`);
  }
});
