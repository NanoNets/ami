import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { amiHome } from "@ami/db";

/** Serves ~/.ami/exports — the directory agents Write file deliverables into
 * (newsletters, CSVs, generated SVGs). Images render inline so chat <img>
 * tags work; everything else downloads. Nothing here ever leaves the machine
 * unless the user takes it somewhere. */

const INLINE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const TEXT: Record<string, string> = {
  ".html": "text/html",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".pdf": "application/pdf",
};

export function exportRoutes() {
  const dir = path.join(amiHome(), "exports");
  fs.mkdirSync(dir, { recursive: true });

  const app = new Hono();
  app.get("/*", (c) => {
    const rel = decodeURIComponent(c.req.path.replace(/^\/api\/exports\/?/, ""));
    const full = path.resolve(dir, rel);
    if (!rel || !full.startsWith(dir + path.sep)) return c.text("forbidden", 403);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return c.text("not found", 404);
    const ext = path.extname(full).toLowerCase();
    const inline = INLINE[ext];
    c.header("Content-Type", inline ?? TEXT[ext] ?? "application/octet-stream");
    c.header(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename="${path.basename(full).replace(/"/g, "")}"`,
    );
    // Agent-generated SVG displays as an image; never as a scripting surface.
    if (ext === ".svg" || ext === ".html") c.header("Content-Security-Policy", "script-src 'none'");
    return c.body(new Uint8Array(fs.readFileSync(full)));
  });
  return app;
}
