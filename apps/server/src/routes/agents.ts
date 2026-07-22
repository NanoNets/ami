import { Hono } from "hono";
import { desc, eq, inArray } from "drizzle-orm";
import { taskRuns, listSteps, type Db } from "@ami/db";
import {
  createLiveNote,
  createTask,
  deleteLiveNote,
  deleteTask,
  fetchTask,
  listLiveNotes,
  listTasks,
  patchTask,
  readIndexMd,
  readRunIds,
  runBackgroundTask,
  runLiveNoteAgent,
  updateLiveNote,
} from "@ami/engine";
import { publish } from "../sse.js";

export function agentRoutes(db: Db) {
  const app = new Hono();

  const runWithSteps = (r: typeof taskRuns.$inferSelect) => ({
    id: r.id,
    status: r.status,
    error: r.error,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    steps: listSteps(db, r.id).map((s) => ({
      id: s.id,
      seq: s.seq,
      kind: s.kind,
      label: s.label,
      detail: s.detailJson,
      createdAt: s.createdAt,
      runId: s.runId,
    })),
  });

  app.get("/", (c) => c.json(listTasks()));

  // ── Live notes (registered before /:slug so the paths don't collide) ──
  app.get("/live-notes", (c) => c.json(listLiveNotes()));

  app.get("/live-notes/runs", (c) => {
    const file = c.req.query("file");
    if (!file) return c.json({ error: "file required" }, 400);
    const runs = db
      .select()
      .from(taskRuns)
      .where(eq(taskRuns.todoId, `bg:live:${file}`))
      .orderBy(desc(taskRuns.createdAt))
      .limit(10)
      .all()
      .map(runWithSteps);
    return c.json({ runs });
  });

  app.post("/live-notes", async (c) => {
    const body = await c.req.json<{
      title: string;
      objective: string;
      triggers?: { cronExpr?: string; windows?: { startTime: string; endTime: string }[]; eventMatchCriteria?: string };
    }>();
    if (!body.title?.trim() || !body.objective?.trim()) {
      return c.json({ ok: false, error: "title and objective are required" }, 400);
    }
    const file = createLiveNote({
      title: body.title.trim(),
      objective: body.objective.trim(),
      triggers: sanitizeTriggers(body.triggers),
    });
    return c.json({ ok: true, file });
  });

  app.post("/live-notes/update", async (c) => {
    const body = await c.req.json<{
      file: string;
      objective?: string;
      active?: boolean;
      triggers?: { cronExpr?: string; windows?: { startTime: string; endTime: string }[]; eventMatchCriteria?: string };
    }>();
    const patch: Parameters<typeof updateLiveNote>[1] = {};
    if (body.objective !== undefined) patch.objective = body.objective;
    if (body.active !== undefined) patch.active = body.active;
    if ("triggers" in body) patch.triggers = sanitizeTriggers(body.triggers);
    updateLiveNote(body.file, patch);
    return c.json({ ok: true });
  });

  app.post("/live-notes/run", async (c) => {
    const { file } = await c.req.json<{ file: string }>();
    void runLiveNoteAgent(db, publish, file, "manual").catch((e) =>
      console.error(`[live-note manual ${file}]`, e),
    );
    return c.json({ ok: true });
  });

  app.post("/live-notes/delete", async (c) => {
    const { file } = await c.req.json<{ file: string }>();
    deleteLiveNote(file);
    return c.json({ ok: true });
  });

  app.post("/", async (c) => {
    const body = await c.req.json<{
      name: string;
      instructions: string;
      triggers?: { cronExpr?: string; windows?: { startTime: string; endTime: string }[]; eventMatchCriteria?: string };
      projectId?: string;
      model?: string;
    }>();
    if (!body.name?.trim() || !body.instructions?.trim()) {
      return c.json({ ok: false, error: "name and instructions are required" }, 400);
    }
    const slug = createTask({
      name: body.name.trim(),
      instructions: body.instructions.trim(),
      triggers: sanitizeTriggers(body.triggers),
      projectId: body.projectId || undefined,
      model: body.model || undefined,
    });
    publish({ type: "bgtask.updated", slug });
    return c.json({ ok: true, slug });
  });

  app.get("/:slug", (c) => {
    const slug = c.req.param("slug");
    const task = fetchTask(slug);
    if (!task) return c.json({ error: "not found" }, 404);
    const runIds = readRunIds(slug, 10);
    const runs = runIds.length
      ? db.select().from(taskRuns).where(inArray(taskRuns.id, runIds)).all()
      : [];
    const runsSorted = runIds
      .map((id) => runs.find((r) => r.id === id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map(runWithSteps);
    return c.json({ slug, ...task, indexMd: readIndexMd(slug), runs: runsSorted });
  });

  app.post("/:slug", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.json<Record<string, unknown>>();
    const patch: Record<string, unknown> = {};
    for (const k of ["name", "instructions", "active", "projectId", "model"]) {
      if (k in body) patch[k] = body[k] === "" ? undefined : body[k];
    }
    if ("triggers" in body) patch.triggers = sanitizeTriggers(body.triggers as any);
    patchTask(slug, patch);
    publish({ type: "bgtask.updated", slug });
    return c.json({ ok: true });
  });

  app.post("/:slug/run", (c) => {
    const slug = c.req.param("slug");
    void runBackgroundTask(db, publish, slug, "manual").catch((e) =>
      console.error(`[bg-task manual ${slug}]`, e),
    );
    return c.json({ ok: true });
  });

  app.delete("/:slug", (c) => {
    deleteTask(c.req.param("slug"));
    return c.json({ ok: true });
  });

  return app;
}

function sanitizeTriggers(t?: {
  cronExpr?: string;
  windows?: { startTime: string; endTime: string }[];
  eventMatchCriteria?: string;
}) {
  if (!t) return undefined;
  const out: typeof t = {};
  if (t.cronExpr?.trim()) out.cronExpr = t.cronExpr.trim();
  if (t.windows?.length) out.windows = t.windows.filter((w) => w.startTime && w.endTime);
  if (t.eventMatchCriteria?.trim()) out.eventMatchCriteria = t.eventMatchCriteria.trim();
  return Object.keys(out).length > 0 ? out : undefined;
}
