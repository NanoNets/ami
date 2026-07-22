import { Hono } from "hono";
import type { Db } from "@ami/db";
import { answerQuestion, listPendingQuestions } from "@ami/engine";
import { publish } from "../sse.js";

export function questionRoutes(db: Db) {
  const app = new Hono();

  app.get("/", (c) => {
    const status = c.req.query("status") ?? "pending";
    if (status !== "pending") return c.json([]);
    return c.json(
      listPendingQuestions(db).map((q) => ({
        id: q.id,
        runId: q.runId,
        todoId: q.todoId,
        sessionId: q.sessionId,
        kind: q.kind,
        question: q.question,
        options: q.optionsJson ? (JSON.parse(q.optionsJson) as string[]) : [],
        createdAt: q.createdAt,
      })),
    );
  });

  app.post("/:id/answer", async (c) => {
    const { answer } = await c.req.json<{ answer: string }>();
    const ok = answerQuestion(db, publish, c.req.param("id"), answer);
    return c.json({ ok });
  });

  return app;
}
