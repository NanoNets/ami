import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Playwright MCP: gives agents a real browser (navigate, click, type, read
 * the page) for tasks that need interactive web work — WebFetch/WebSearch
 * stay the cheap path for plain reads.
 *
 * The browser runs as ONE long-lived HTTP server shared by every agent
 * session, not a stdio subprocess spawned per `query()`. That distinction is
 * load-bearing: a stdio server is torn down the instant its owning turn ends,
 * which slams the browser window shut. Interactive logins — "navigate to the
 * login page, keep the window open, ask the user to sign in" — need the window
 * to survive past the turn that opened it, and across the later turn that
 * re-reads the page once they're in.
 *
 * But a shared *server* alone isn't enough. Playwright MCP ties the browser's
 * life to its connected-client count, not to the server process: when the last
 * MCP client disconnects it runs `browserContext.close()` + `browser().close()`
 * (see coreBundle's shared-browser factory `disposed`). Each task/chat turn is
 * one client — it connects for the turn, then the Agent SDK disconnects at
 * turn end, dropping the count to zero and closing the window mid-login. So we
 * also hold ONE persistent keep-alive client for the whole process lifetime: it
 * connects once and makes a single tool call (the count only increments on the
 * first tool call, not on connect), which launches the shared browser and pins
 * the count at >= 1. Turns then come and go (count 2 -> 1) without ever hitting
 * zero, so the window stays put across turns.
 *
 * Uses the installed Chrome and the default persistent profile, so logins the
 * user performs in Ami's browser window survive across runs. */

const PORT = Number(process.env.AMI_BROWSER_MCP_PORT ?? 4142);
// Must be `localhost`, not `127.0.0.1`: Playwright MCP guards the endpoint by
// Host header and only answers to the exact host it bound to (localhost).
const ENDPOINT = `http://localhost:${PORT}/mcp`;

let proc: ChildProcess | null = null;
let starting: Promise<void> | null = null;

function cliPath(): string {
  const require = createRequire(import.meta.url);
  // cli.js isn't in the package's exports map — resolve via package.json.
  return path.join(path.dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
}

/** True once something is accepting connections on the port — either our own
 * child or a server left running by a previous `tsx watch` incarnation (the
 * child outlives a parent restart, so the browser survives a dev reload). */
function portOpen(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** Start the shared Playwright MCP server if it isn't already up, and wait
 * until the port answers. Best-effort: never throws — a browser hiccup must
 * not take down chat/task runs. If we can't confirm readiness, we still hand
 * back the endpoint and let the SDK's connect timeout degrade gracefully
 * (the browser tools simply won't appear for that turn). */
async function ensureServer(): Promise<void> {
  if (await portOpen(PORT)) return;
  if (starting) return starting;

  starting = (async () => {
    const child = spawn(
      process.execPath,
      [
        cliPath(),
        "--browser",
        "chrome",
        "--port",
        String(PORT),
        // Bind to the default host (localhost) — see ENDPOINT above.
        // Keep the same browser context (and its logged-in tabs) across the
        // separate client connections each turn makes.
        "--shared-browser-context",
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    proc = child;
    child.on("exit", () => {
      if (proc === child) proc = null;
    });
    // Don't pin the event loop open on this child; if our process restarts the
    // server keeps running and the next boot reuses it via the port check.
    child.unref();

    // Poll until the server accepts connections (browser boot is lazy — it
    // only launches on first tool use, so the server itself comes up fast).
    for (let i = 0; i < 40; i++) {
      if (await portOpen(PORT)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  })().finally(() => {
    starting = null;
  });

  return starting;
}

let keepAlive: Client | null = null;
let keepAliveStarting: Promise<void> | null = null;

/** Hold one persistent MCP client so the browser outlives every turn. Playwright
 * only counts a client once it makes its first tool call, so we make exactly one
 * (`browser_tabs`/list — no navigation, no state change, just launches the shared
 * browser and opens a blank tab the real turn reuses) and then keep the session
 * open forever. Best-effort: a failure here must not break the turn — the browser
 * just reverts to closing at turn end (the pre-fix behaviour). */
async function ensureKeepAlive(): Promise<void> {
  if (keepAlive) return;
  if (keepAliveStarting) return keepAliveStarting;

  keepAliveStarting = (async () => {
    const client = new Client({ name: "ami-browser-keepalive", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT));
    // If the session ever drops (e.g. the server process restarts), clear the
    // handle so the next turn re-establishes it.
    transport.onclose = () => {
      if (keepAlive === client) keepAlive = null;
    };
    await client.connect(transport);
    // Bound the call: if it can't complete we tear the client down and rethrow,
    // which frees `keepAliveStarting` so a later turn retries from scratch.
    try {
      await client.callTool({ name: "browser_tabs", arguments: { action: "list" } }, undefined, {
        timeout: 20_000,
      });
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    keepAlive = client;
  })().finally(() => {
    keepAliveStarting = null;
  });

  return keepAliveStarting;
}

/** Never let establishing the keep-alive hold up a turn for more than this. The
 * tool call normally returns in a second or two (headed Chrome launch); this cap
 * only bites if the browser is wedged, and then we just proceed without the
 * keep-alive (the attempt keeps running in the background for the next turn). */
const KEEPALIVE_WAIT_MS = 8_000;

/** MCP config for the shared browser server. `alwaysLoad` forces the tools
 * into the turn-1 prompt (they're otherwise deferred behind tool search) and
 * blocks session startup until the server connects. */
export async function browserMcpServer(): Promise<{ type: "http"; url: string; alwaysLoad: true }> {
  await ensureServer();
  // Establish the keep-alive before the turn's own client connects, so the
  // browser is already pinned open when this turn's client later disconnects.
  // Wait for it, but never longer than KEEPALIVE_WAIT_MS — a wedged browser
  // must not stall the turn.
  await Promise.race([
    ensureKeepAlive().catch(() => {}),
    new Promise((r) => setTimeout(r, KEEPALIVE_WAIT_MS)),
  ]);
  return { type: "http", url: ENDPOINT, alwaysLoad: true };
}

/** Warm the browser server at boot so the first turn that needs it doesn't
 * pay the cold-start wait. Safe to call more than once. */
export function startBrowserMcp(): void {
  void ensureServer();
}
