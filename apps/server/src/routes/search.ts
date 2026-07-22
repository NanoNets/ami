import { Hono } from "hono";
import { rawSqlite, type Db } from "@ami/db";
import { searchKnowledge } from "@ami/memory";

/** Global search across knowledge notes, chat history, tasks, and signals. */

export interface SearchResult {
  type: "knowledge" | "chat" | "task" | "signal";
  title: string;
  preview: string;
  /** Route target: note path, chat session id, or todo id. */
  ref: string;
}

export function searchRoutes(db: Db) {
  void db;
  const app = new Hono();

  app.get("/", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (q.length < 2) return c.json([]);
    const sqlite = rawSqlite();
    const like = `%${q.replace(/[%_]/g, " ")}%`;
    const results: SearchResult[] = [];

    // Knowledge (ranked index+content scoring).
    for (const hit of searchKnowledge(q, 6)) {
      results.push({
        type: "knowledge",
        title: hit.name,
        preview: hit.excerpt.replace(/\s+/g, " ").slice(0, 140),
        ref: hit.file,
      });
    }

    // Chat: session titles + turn content.
    const chatRows = sqlite
      .prepare(
        `SELECT s.id, s.title, t.content_json FROM chat_sessions s
         LEFT JOIN chat_turns t ON t.session_id = s.id AND t.content_json LIKE ?
         WHERE s.archived = 0 AND (s.title LIKE ? OR t.id IS NOT NULL)
         GROUP BY s.id ORDER BY s.updated_at DESC LIMIT 6`,
      )
      .all(like, like) as { id: string; title: string | null; content_json: string | null }[];
    for (const r of chatRows) {
      let preview = "";
      if (r.content_json) {
        const idx = r.content_json.toLowerCase().indexOf(q.toLowerCase());
        preview = r.content_json
          .slice(Math.max(0, idx - 40), idx + 100)
          .replace(/[{}"[\]\\]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
      results.push({ type: "chat", title: r.title ?? "Untitled chat", preview, ref: r.id });
    }

    // Tasks.
    const todoRows = sqlite
      .prepare(
        `SELECT id, title, summary, status FROM todos
         WHERE title LIKE ? OR summary LIKE ? ORDER BY updated_at DESC LIMIT 6`,
      )
      .all(like, like) as { id: string; title: string; summary: string; status: string }[];
    for (const r of todoRows) {
      results.push({ type: "task", title: r.title, preview: `${r.status} — ${r.summary.slice(0, 120)}`, ref: r.id });
    }

    // Signals via FTS5.
    try {
      const match = q
        .split(/\s+/)
        .filter((t) => t.length > 1)
        .map((t) => `"${t.replace(/"/g, "")}"`)
        .join(" OR ");
      if (match) {
        const sigRows = sqlite
          .prepare(
            `SELECT s.id, s.title, s.body FROM signals_fts f
             JOIN signals s ON s.id = f.signal_id
             WHERE signals_fts MATCH ? ORDER BY rank LIMIT 5`,
          )
          .all(match) as { id: string; title: string; body: string }[];
        for (const r of sigRows) {
          results.push({
            type: "signal",
            title: r.title,
            preview: r.body.replace(/\s+/g, " ").slice(0, 140),
            ref: r.id,
          });
        }
      }
    } catch {
      // FTS syntax edge cases — signals are optional in results
    }

    return c.json(results);
  });

  return app;
}
