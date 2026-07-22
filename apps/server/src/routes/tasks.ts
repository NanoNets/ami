import { Hono } from "hono";
import {
  getTodo,
  insertFeedback,
  latestRunForTodo,
  listArtifactsForRuns,
  listDraftsForTodo,
  listRunsForTodo,
  listSteps,
  usageForRun,
  type Db,
} from "@ami/db";
import { cancelRun, startRun } from "@ami/engine";
import type { ArtifactDto, DraftDto, TaskRunDto, TaskStepDto } from "@ami/shared";
import { publish } from "../sse.js";

export function taskRoutes(db: Db) {
  const app = new Hono();

  // Full task view: runs + steps + artifacts + drafts for a todo.
  app.get("/:todoId", (c) => {
    const todoId = c.req.param("todoId");
    const todo = getTodo(db, todoId);
    if (!todo) return c.json({ error: "not found" }, 404);
    const runs = listRunsForTodo(db, todoId);
    const runDtos: TaskRunDto[] = runs.map((r) => {
      const usage = usageForRun(db, r.id);
      return {
        id: r.id,
        todoId: r.todoId,
        mode: r.mode as TaskRunDto["mode"],
        status: r.status as TaskRunDto["status"],
        error: r.error,
        parentRunId: r.parentRunId,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        costUsd: usage.costUsd,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      };
    });
    const steps: TaskStepDto[] = runs.flatMap((r) =>
      listSteps(db, r.id).map((s) => ({
        id: s.id,
        runId: s.runId,
        seq: s.seq,
        kind: s.kind as TaskStepDto["kind"],
        label: s.label,
        detail: s.detailJson,
        createdAt: s.createdAt,
      })),
    );
    const artifacts: ArtifactDto[] = listArtifactsForRuns(
      db,
      runs.map((r) => r.id),
    ).map((a) => ({
      id: a.id,
      runId: a.runId,
      type: a.type as ArtifactDto["type"],
      title: a.title,
      url: a.url,
      contentMd: a.contentMd,
      createdAt: a.createdAt,
    }));
    const drafts: DraftDto[] = listDraftsForTodo(db, todoId).map((d) => ({
      id: d.id,
      todoId: d.todoId,
      runId: d.runId,
      channel: d.channel,
      targetRef: d.targetRef,
      body: d.body,
      editedBody: d.editedBody,
      status: d.status as DraftDto["status"],
      createdAt: d.createdAt,
      sentAt: d.sentAt,
    }));
    return c.json({ runs: runDtos, steps, artifacts, drafts });
  });

  // Feedback on a completed run → iterate by resuming the session.
  app.post("/:todoId/feedback", async (c) => {
    const todoId = c.req.param("todoId");
    const { text } = await c.req.json<{ text: string }>();
    const last = latestRunForTodo(db, todoId);
    insertFeedback(db, { todoId, runId: last?.id ?? null, scope: "execution", text });
    const runId = startRun(db, publish, {
      todoId,
      mode: "auto",
      resumeRunId: last?.id,
      extraPrompt: `The user reviewed the result and gave feedback — iterate on the task accordingly:\n${text}`,
    });
    return c.json({ runId });
  });

  app.post("/runs/:runId/cancel", (c) => {
    const ok = cancelRun(c.req.param("runId"));
    return c.json({ ok });
  });

  return app;
}
