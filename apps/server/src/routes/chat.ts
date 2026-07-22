import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { chatSessions, type Db } from "@ami/db";
import { createChatSession, listChatSessions, listChatTurns, runChatTurn, stopChatTurn } from "@ami/engine";
import { publish } from "../sse.js";

export function chatRoutes(db: Db) {
  const app = new Hono();

  app.get("/sessions", (c) =>
    c.json(
      listChatSessions(db).map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    ),
  );

  app.post("/sessions", (c) => c.json({ id: createChatSession(db) }));

  app.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    return c.json({
      id,
      turns: listChatTurns(db, id).map((t) => ({
        id: t.id,
        seq: t.seq,
        role: t.role,
        content: JSON.parse(t.contentJson),
        createdAt: t.createdAt,
      })),
    });
  });

  app.post("/sessions/:id/message", async (c) => {
    const { text } = await c.req.json<{ text: string }>();
    if (!text?.trim()) return c.json({ ok: false, error: "empty message" }, 400);
    // Fire and return; streaming happens over SSE (chat.delta/chat.done).
    void runChatTurn(db, publish, c.req.param("id"), text.trim()).then((res) => {
      if (!res.ok) console.error(`[chat ${c.req.param("id")}]`, res.error);
    });
    return c.json({ ok: true });
  });

  // Stop the turn currently running in this session (console's Stop button).
  app.post("/sessions/:id/stop", (c) => {
    const stopped = stopChatTurn(c.req.param("id"));
    return c.json({ ok: stopped });
  });

  app.post("/sessions/:id/archive", (c) => {
    db.update(chatSessions).set({ archived: 1 }).where(eq(chatSessions.id, c.req.param("id"))).run();
    return c.json({ ok: true });
  });

  return app;
}
