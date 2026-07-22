import fs from "node:fs";
import { Hono } from "hono";
import { usageSummary, type Db } from "@ami/db";
import {
  exportBrainGraph,
  getNoteAtCommit,
  getNoteHistory,
  getRecentCommits,
  getStyleProfile,
  readNote,
  requestAgentNotesRun,
  restoreNote,
  searchKnowledge,
  suggestedTopicsPath,
} from "@ami/memory";

export function memoryRoutes(db: Db) {
  const app = new Hono();

  // The console pings this when the user navigates away from a chat: route
  // fresh conversation facts / inbox notes into dossiers now instead of
  // waiting for the nightly cycle. Returns immediately; the run is async.
  app.post("/route-notes", (c) => {
    requestAgentNotesRun(db, "chat left");
    return c.json({ ok: true });
  });

  /** Brain graph: notes as nodes, [[wiki-links]] as edges. */
  app.get("/graph", (c) => {
    return c.json(exportBrainGraph());
  });

  /** Full note content by knowledge-relative path (?path=People/X.md). */
  app.get("/note", (c) => {
    const p = c.req.query("path") ?? "";
    const content = readNote(p);
    if (content === null) return c.json({ error: "not found" }, 404);
    return c.json({ path: p, content });
  });

  app.get("/search", (c) => {
    const q = c.req.query("q") ?? "";
    return c.json(searchKnowledge(q, 15));
  });

  /** Recent knowledge commits (what memory learned, which notes changed) —
   * the review/trust surface for agent writes. */
  app.get("/history", async (c) => {
    const limit = Math.min(50, Number(c.req.query("limit") ?? 20) || 20);
    return c.json(await getRecentCommits(limit));
  });

  /** Version history for one note. */
  app.get("/note-history", async (c) => {
    const p = c.req.query("path") ?? "";
    return c.json(await getNoteHistory(p));
  });

  app.get("/note-at", async (c) => {
    const p = c.req.query("path") ?? "";
    const oid = c.req.query("oid") ?? "";
    const content = await getNoteAtCommit(p, oid);
    if (content === null) return c.json({ error: "not found" }, 404);
    return c.json({ path: p, oid, content });
  });

  app.post("/note-restore", async (c) => {
    const { path: p, oid } = await c.req.json<{ path: string; oid: string }>();
    const ok = await restoreNote(p, oid);
    return c.json({ ok });
  });

  app.get("/suggested-topics", (c) => {
    try {
      const content = fs.readFileSync(suggestedTopicsPath(), "utf-8");
      return c.json({ content });
    } catch {
      return c.json({ content: "" });
    }
  });

  app.get("/style/:channel", (c) => {
    return c.json({ profileMd: getStyleProfile(db, c.req.param("channel")) });
  });

  app.get("/usage", (c) => {
    const since = c.req.query("since") ?? undefined;
    return c.json(usageSummary(db, since));
  });

  return app;
}
