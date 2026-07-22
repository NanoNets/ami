import { createRequire } from "node:module";
import path from "node:path";

/** Playwright MCP: gives agents a real browser (navigate, click, type, read
 * the page) for tasks that need interactive web work — WebFetch/WebSearch
 * stay the cheap path for plain reads. The stdio server is spawned per agent
 * session; the browser window itself only launches on first tool use, so
 * non-web runs pay nothing.
 *
 * Uses the installed Chrome and a persistent dedicated profile (~/.cache),
 * so logins the user performs in Ami's browser windows survive across runs. */
export function browserMcpServer(): { command: string; args: string[]; alwaysLoad: boolean } {
  const require = createRequire(import.meta.url);
  // cli.js isn't in the package's exports map — resolve via package.json.
  const cli = path.join(path.dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
  // alwaysLoad blocks session startup until the server connects: MCP startup
  // is otherwise non-blocking, and this server boots slower than the turn-1
  // prompt is built, so its tools never made it into the session without it.
  return { command: process.execPath, args: [cli, "--browser", "chrome"], alwaysLoad: true };
}
