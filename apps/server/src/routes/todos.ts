import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  drafts,
  getSignal,
  getTodo,
  insertFeedback,
  insertTrace,
  listTodos,
  normalizeDueDate,
  updateTodo,
  type Db,
} from "@ami/db";
import { startRun, resolveTodo, dismissTodo } from "@ami/engine";
import type { TodoDto, ConnectorId } from "@ami/shared";
import { publish } from "../sse.js";

export function todoRoutes(db: Db) {
  const app = new Hono();

  app.get("/", (c) => {
    const rows = listTodos(db);
    const pendingDraftTodos = new Set(
      db
        .select({ todoId: drafts.todoId })
        .from(drafts)
        .where(eq(drafts.status, "pending"))
        .all()
        .map((d) => d.todoId),
    );

    const dtos: TodoDto[] = rows.map((t) => {
      const signal = t.signalId ? getSignal(db, t.signalId) : undefined;
      return {
        id: t.id,
        signalId: t.signalId,
        type: t.type as TodoDto["type"],
        status: t.status as TodoDto["status"],
        title: t.title,
        summary: t.summary,
        connector: (signal?.connector ?? null) as TodoDto["connector"],
        sourceUrl: signal?.url ?? null,
        sourceAuthor: signal?.author ?? null,
        dueAt: t.dueAt,
        snoozedUntil: t.snoozedUntil,
        projectId: t.projectId ?? null,
        planMd: t.planMd,
        planApprovedAt: t.planApprovedAt,
        entities: [],
        hasPendingDraft: pendingDraftTodos.has(t.id),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      };
    });
    return c.json(dtos);
  });

  app.post("/:id/plan", async (c) => {
    const todoId = c.req.param("id");
    const body = await c.req
      .json<{ context?: string; projectId?: string; policy?: string }>()
      .catch(() => ({}) as { context?: string; projectId?: string; policy?: string });
    if (body.context?.trim()) {
      insertFeedback(db, { todoId, scope: "plan", text: body.context.trim() });
    }
    const hadProject = !!getTodo(db, todoId)?.projectId;
    if (body.projectId !== undefined) updateTodo(db, todoId, { projectId: body.projectId || null });
    // No project picked and none attached: resolve one now, before the run
    // decides coding vs generalist. An explicit detach (had one, chose none)
    // is respected.
    if (!body.projectId && !hadProject) {
      const { ensureProjectResolved } = await import("@ami/engine");
      await ensureProjectResolved(db, publish, todoId);
    }
    const runId = startRun(db, publish, { todoId, mode: "plan", policy: body.policy as any });
    return c.json({ runId });
  });

  app.post("/:id/plan/feedback", async (c) => {
    const todoId = c.req.param("id");
    const { text } = await c.req.json<{ text: string }>();
    insertFeedback(db, { todoId, scope: "plan", text });
    insertTrace(db, {
      todoId,
      kind: "plan_feedback",
      situation: `Plan for: ${getTodo(db, todoId)?.title ?? todoId}`,
      decision: `User feedback: ${text}`,
    });
    const { latestRunForTodo } = await import("@ami/db");
    const last = latestRunForTodo(db, todoId);
    const runId = startRun(db, publish, {
      todoId,
      mode: "plan",
      resumeRunId: last?.id,
      extraPrompt: `The user gave feedback on your plan — revise it accordingly and output the full revised plan:\n${text}`,
    });
    return c.json({ runId });
  });

  // Save a user-edited plan. The stored planMd is what approval executes,
  // so edits here are binding.
  app.put("/:id/plan", async (c) => {
    const todoId = c.req.param("id");
    const body = await c.req.json<{ planMd?: string }>().catch(() => ({}) as { planMd?: string });
    if (!body.planMd?.trim()) return c.json({ ok: false, error: "planMd required" }, 400);
    if (!getTodo(db, todoId)) return c.json({ ok: false, error: "todo not found" }, 404);
    updateTodo(db, todoId, { planMd: body.planMd });
    publish({ type: "todo.updated", todoId });
    return c.json({ ok: true });
  });

  app.post("/:id/plan/approve", async (c) => {
    const todoId = c.req.param("id");
    const todo = getTodo(db, todoId);
    updateTodo(db, todoId, { planApprovedAt: new Date().toISOString() });
    insertTrace(db, {
      todoId,
      kind: "plan_approval",
      situation: `Plan for: ${todo?.title ?? todoId}`,
      decision: "approved",
    });
    const { latestRunForTodo } = await import("@ami/db");
    const last = latestRunForTodo(db, todoId);
    // Include the stored plan verbatim: the user may have edited it since the
    // planning run wrote it, and the edited version is the approved one.
    const runId = startRun(db, publish, {
      todoId,
      mode: "auto",
      resumeRunId: last?.id,
      extraPrompt: todo?.planMd
        ? `The plan is approved — in the form below, which may include the user's edits. Execute exactly this plan now, reporting artifacts and drafts via the ami tools.\n\n${todo.planMd}`
        : "The plan is approved. Execute it now, reporting artifacts and drafts via the ami tools.",
    });
    return c.json({ runId });
  });

  app.post("/:id/start", async (c) => {
    const todoId = c.req.param("id");
    const body = await c.req
      .json<{ context?: string; projectId?: string; policy?: string }>()
      .catch(() => ({}) as { context?: string; projectId?: string; policy?: string });
    if (body.context?.trim()) {
      insertFeedback(db, { todoId, scope: "execution", text: body.context.trim() });
    }
    const hadProject = !!getTodo(db, todoId)?.projectId;
    if (body.projectId !== undefined) updateTodo(db, todoId, { projectId: body.projectId || null });
    // Same auto-attach as /plan: never start unattached when a repo matches.
    if (!body.projectId && !hadProject) {
      const { ensureProjectResolved } = await import("@ami/engine");
      await ensureProjectResolved(db, publish, todoId);
    }
    const runId = startRun(db, publish, { todoId, mode: "auto", policy: body.policy as any });
    return c.json({ runId });
  });

  app.post("/:id/resolve", async (c) => {
    const draftId = await resolveTodo(db, publish, c.req.param("id"));
    return c.json({ draftId });
  });

  // A dismissal is an explicit triage correction (handled in dismissTodo):
  // this shouldn't have become a task/fyi, so similar signals get deprioritized.
  app.post("/:id/dismiss", async (c) => {
    await dismissTodo(db, publish, c.req.param("id"));
    return c.json({ ok: true });
  });

  // Edit the due date from the card. Body: { dueAt: "YYYY-MM-DD" | null }.
  app.post("/:id/due", async (c) => {
    const todoId = c.req.param("id");
    const body = await c.req.json<{ dueAt?: string | null }>().catch(() => ({}) as { dueAt?: string | null });
    const dueAt = normalizeDueDate(body.dueAt);
    if (body.dueAt && !dueAt) return c.json({ ok: false, error: "invalid date" }, 400);
    updateTodo(db, todoId, { dueAt });
    publish({ type: "todo.updated", todoId });
    return c.json({ ok: true, dueAt });
  });

  // Undo for a just-dismissed/snoozed/resolved todo: put it back on the list.
  // (The triage deprioritization a dismissal recorded stays — undo restores
  // the item, not the feedback signal.)
  app.post("/:id/reopen", (c) => {
    const todoId = c.req.param("id");
    updateTodo(db, todoId, { status: "open", snoozedUntil: null });
    publish({ type: "todo.updated", todoId });
    return c.json({ ok: true });
  });

  app.post("/:id/snooze", (c) => {
    const todoId = c.req.param("id");
    const tomorrow9 = new Date();
    tomorrow9.setDate(tomorrow9.getDate() + 1);
    tomorrow9.setHours(9, 0, 0, 0);
    updateTodo(db, todoId, { status: "snoozed", snoozedUntil: tomorrow9.toISOString() });
    publish({ type: "todo.updated", todoId });
    return c.json({ ok: true, until: tomorrow9.toISOString() });
  });

  return app;
}
