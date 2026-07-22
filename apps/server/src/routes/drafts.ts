import { Hono } from "hono";
import { getDraft, updateDraft, type Db } from "@ami/db";
import { sendDraft } from "@ami/engine";
import { publish } from "../sse.js";

export function draftRoutes(db: Db) {
  const app = new Hono();

  app.post("/:id", async (c) => {
    const { editedBody } = await c.req.json<{ editedBody: string }>();
    updateDraft(db, c.req.param("id"), { editedBody });
    const d = getDraft(db, c.req.param("id"));
    if (d) publish({ type: "draft.updated", draftId: d.id, todoId: d.todoId });
    return c.json({ ok: true });
  });

  app.post("/:id/send", async (c) => {
    try {
      await sendDraft(db, publish, c.req.param("id"));
      return c.json({ ok: true });
    } catch (e: any) {
      return c.json({ ok: false, error: e.message }, 500);
    }
  });

  app.post("/:id/discard", (c) => {
    const id = c.req.param("id");
    updateDraft(db, id, { status: "discarded" });
    const d = getDraft(db, id);
    if (d) publish({ type: "draft.updated", draftId: id, todoId: d.todoId });
    return c.json({ ok: true });
  });

  return app;
}
