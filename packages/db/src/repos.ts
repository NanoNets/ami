import { and, desc, eq, isNull, lt, asc, inArray } from "drizzle-orm";
import { newId, nowIso, type NormalizedSignal } from "@ami/shared";
import type { Db } from "./index.js";
import { rawSqlite } from "./index.js";
import {
  connectorAccounts,
  decisionTraces,
  drafts,
  feedback,
  memoryEdges,
  memoryNodes,
  settings,
  signals,
  syncCursors,
  taskRuns,
  taskSteps,
  todos,
  artifacts,
  llmUsage,
} from "./schema.js";

// ---------- settings ----------

export function getSetting(db: Db, key: string): string | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

// ---------- connector accounts & cursors ----------

export function upsertAccount(
  db: Db,
  connector: string,
  auth: Record<string, string>,
  label: string,
): string {
  const existing = db
    .select()
    .from(connectorAccounts)
    .where(eq(connectorAccounts.connector, connector))
    .get();
  const now = nowIso();
  if (existing) {
    db.update(connectorAccounts)
      .set({ authJson: JSON.stringify(auth), label, status: "connected", error: null, updatedAt: now })
      .where(eq(connectorAccounts.id, existing.id))
      .run();
    return existing.id;
  }
  const id = newId("acct");
  db.insert(connectorAccounts)
    .values({
      id,
      connector,
      label,
      authJson: JSON.stringify(auth),
      status: "connected",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

export function getCursor(db: Db, accountId: string, stream: string) {
  return db
    .select()
    .from(syncCursors)
    .where(and(eq(syncCursors.accountId, accountId), eq(syncCursors.stream, stream)))
    .get();
}

export function setCursor(
  db: Db,
  accountId: string,
  stream: string,
  cursor: string | null,
): void {
  const now = nowIso();
  const existing = getCursor(db, accountId, stream);
  if (existing) {
    db.update(syncCursors)
      .set({ cursor, lastPolledAt: now })
      .where(eq(syncCursors.id, existing.id))
      .run();
  } else {
    db.insert(syncCursors)
      .values({ id: newId("cur"), accountId, stream, cursor, lastPolledAt: now })
      .run();
  }
}

// ---------- signals ----------

/** Insert a normalized signal; returns the new id, or null when it was a duplicate. */
export function insertSignal(
  db: Db,
  connector: string,
  accountId: string | null,
  sig: NormalizedSignal,
): string | null {
  const id = newId("sig");
  const res = db
    .insert(signals)
    .values({
      id,
      accountId,
      connector,
      externalId: sig.externalId,
      kind: sig.kind,
      title: sig.title,
      body: sig.body,
      author: sig.author,
      url: sig.url,
      threadRef: sig.threadRef,
      rawJson: JSON.stringify(sig.raw ?? null),
      receivedAt: nowIso(),
    })
    .onConflictDoNothing()
    .run();
  if (res.changes === 0) return null;
  rawSqlite()
    .prepare("INSERT INTO signals_fts (signal_id, title, body) VALUES (?, ?, ?)")
    .run(id, sig.title, sig.body);
  return id;
}

export function untriagedSignals(db: Db, limit = 10) {
  return db
    .select()
    .from(signals)
    .where(isNull(signals.triagedAt))
    .orderBy(asc(signals.receivedAt))
    .limit(limit)
    .all();
}

export function markTriaged(db: Db, signalIds: string[]): void {
  if (signalIds.length === 0) return;
  db.update(signals).set({ triagedAt: nowIso() }).where(inArray(signals.id, signalIds)).run();
}

export function getSignal(db: Db, id: string) {
  return db.select().from(signals).where(eq(signals.id, id)).get();
}

// ---------- todos ----------

/** Normalizes any date-ish string to date-only YYYY-MM-DD, or null. */
export function normalizeDueDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function insertTodo(
  db: Db,
  t: {
    signalId?: string | null;
    type: string;
    title: string;
    summary: string;
    entityIds?: string[];
    /** Date-only YYYY-MM-DD. Tasks without one default to +7 days; FYIs to none. */
    dueAt?: string | null;
  },
): string {
  const id = newId("todo");
  const now = nowIso();
  const dueAt =
    normalizeDueDate(t.dueAt) ??
    (t.type === "task" ? new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10) : null);
  db.insert(todos)
    .values({
      id,
      signalId: t.signalId ?? null,
      type: t.type,
      status: "open",
      title: t.title,
      summary: t.summary,
      dueAt,
      entityIdsJson: JSON.stringify(t.entityIds ?? []),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

export function getTodo(db: Db, id: string) {
  return db.select().from(todos).where(eq(todos.id, id)).get();
}

export function listTodos(db: Db) {
  return db.select().from(todos).orderBy(desc(todos.updatedAt)).all();
}

export function updateTodo(
  db: Db,
  id: string,
  patch: Partial<typeof todos.$inferInsert>,
): void {
  db.update(todos)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(todos.id, id))
    .run();
}

export function wakeSnoozedTodos(db: Db): string[] {
  const due = db
    .select()
    .from(todos)
    .where(and(eq(todos.status, "snoozed"), lt(todos.snoozedUntil, nowIso())))
    .all();
  for (const t of due) {
    updateTodo(db, t.id, { status: "open", snoozedUntil: null });
  }
  return due.map((t) => t.id);
}

// ---------- runs / steps / artifacts ----------

export function insertRun(
  db: Db,
  r: {
    todoId: string;
    mode: string;
    parentRunId?: string | null;
    prompt?: string;
    workspaceDir?: string;
    policy?: string;
  },
): string {
  const id = newId("run");
  db.insert(taskRuns)
    .values({
      id,
      todoId: r.todoId,
      mode: r.mode,
      status: "queued",
      parentRunId: r.parentRunId ?? null,
      prompt: r.prompt,
      workspaceDir: r.workspaceDir,
      policy: r.policy ?? null,
      createdAt: nowIso(),
    })
    .run();
  return id;
}

export function updateRun(db: Db, id: string, patch: Partial<typeof taskRuns.$inferInsert>): void {
  db.update(taskRuns).set(patch).where(eq(taskRuns.id, id)).run();
}

export function getRun(db: Db, id: string) {
  return db.select().from(taskRuns).where(eq(taskRuns.id, id)).get();
}

export function listRunsForTodo(db: Db, todoId: string) {
  return db.select().from(taskRuns).where(eq(taskRuns.todoId, todoId)).orderBy(asc(taskRuns.createdAt)).all();
}

export function latestRunForTodo(db: Db, todoId: string) {
  return db
    .select()
    .from(taskRuns)
    .where(eq(taskRuns.todoId, todoId))
    .orderBy(desc(taskRuns.createdAt))
    .limit(1)
    .get();
}

let stepSeq = 0;
export function appendStep(
  db: Db,
  runId: string,
  kind: string,
  label: string,
  detail?: unknown,
): string {
  const id = newId("step");
  db.insert(taskSteps)
    .values({
      id,
      runId,
      seq: ++stepSeq,
      kind,
      label,
      detailJson: detail === undefined ? null : JSON.stringify(detail),
      createdAt: nowIso(),
    })
    .run();
  return id;
}

export function listSteps(db: Db, runId: string) {
  return db.select().from(taskSteps).where(eq(taskSteps.runId, runId)).orderBy(asc(taskSteps.seq)).all();
}

export function insertArtifact(
  db: Db,
  a: { runId: string; type: string; title: string; url?: string; contentMd?: string; meta?: unknown },
): string {
  const id = newId("art");
  db.insert(artifacts)
    .values({
      id,
      runId: a.runId,
      type: a.type,
      title: a.title,
      url: a.url,
      contentMd: a.contentMd,
      metaJson: a.meta === undefined ? null : JSON.stringify(a.meta),
      createdAt: nowIso(),
    })
    .run();
  return id;
}

export function listArtifactsForRuns(db: Db, runIds: string[]) {
  if (runIds.length === 0) return [];
  return db.select().from(artifacts).where(inArray(artifacts.runId, runIds)).all();
}

// ---------- drafts & feedback ----------

export function insertDraft(
  db: Db,
  d: { todoId: string; runId?: string | null; channel: string; targetRef: string; body: string },
): string {
  const id = newId("draft");
  db.insert(drafts)
    .values({
      id,
      todoId: d.todoId,
      runId: d.runId ?? null,
      channel: d.channel,
      targetRef: d.targetRef,
      body: d.body,
      status: "pending",
      createdAt: nowIso(),
    })
    .run();
  return id;
}

export function getDraft(db: Db, id: string) {
  return db.select().from(drafts).where(eq(drafts.id, id)).get();
}

export function updateDraft(db: Db, id: string, patch: Partial<typeof drafts.$inferInsert>): void {
  db.update(drafts).set(patch).where(eq(drafts.id, id)).run();
}

export function listDraftsForTodo(db: Db, todoId: string) {
  return db.select().from(drafts).where(eq(drafts.todoId, todoId)).orderBy(desc(drafts.createdAt)).all();
}

export function insertFeedback(
  db: Db,
  f: { todoId: string; runId?: string | null; scope: string; text: string },
): string {
  const id = newId("fb");
  db.insert(feedback)
    .values({ id, todoId: f.todoId, runId: f.runId ?? null, scope: f.scope, text: f.text, createdAt: nowIso() })
    .run();
  return id;
}

export function listFeedbackForTodo(db: Db, todoId: string) {
  return db.select().from(feedback).where(eq(feedback.todoId, todoId)).orderBy(asc(feedback.createdAt)).all();
}

// ---------- memory graph ----------

export function upsertMemoryNode(
  db: Db,
  type: string,
  name: string,
  summary?: string,
): string {
  const existing = db
    .select()
    .from(memoryNodes)
    .where(and(eq(memoryNodes.type, type), eq(memoryNodes.name, name)))
    .get();
  const now = nowIso();
  if (existing) {
    db.update(memoryNodes)
      .set({
        salience: existing.salience + 1,
        summary: summary && summary.length > (existing.summary?.length ?? 0) ? summary : existing.summary,
        updatedAt: now,
      })
      .where(eq(memoryNodes.id, existing.id))
      .run();
    rawSqlite().prepare("DELETE FROM memory_fts WHERE node_id = ?").run(existing.id);
    rawSqlite()
      .prepare("INSERT INTO memory_fts (node_id, name, summary) VALUES (?, ?, ?)")
      .run(existing.id, name, summary ?? existing.summary ?? "");
    return existing.id;
  }
  const id = newId("node");
  db.insert(memoryNodes)
    .values({ id, type, name, summary: summary ?? "", salience: 1, createdAt: now, updatedAt: now })
    .run();
  rawSqlite()
    .prepare("INSERT INTO memory_fts (node_id, name, summary) VALUES (?, ?, ?)")
    .run(id, name, summary ?? "");
  return id;
}

export function upsertMemoryEdge(
  db: Db,
  srcId: string,
  dstId: string,
  rel: string,
  evidenceSignalId?: string,
): void {
  const existing = db
    .select()
    .from(memoryEdges)
    .where(and(eq(memoryEdges.srcId, srcId), eq(memoryEdges.dstId, dstId), eq(memoryEdges.rel, rel)))
    .get();
  if (existing) {
    db.update(memoryEdges)
      .set({ weight: existing.weight + 1 })
      .where(eq(memoryEdges.id, existing.id))
      .run();
    return;
  }
  db.insert(memoryEdges)
    .values({
      id: newId("edge"),
      srcId,
      dstId,
      rel,
      weight: 1,
      evidenceSignalId: evidenceSignalId ?? null,
      createdAt: nowIso(),
    })
    .run();
}

export function insertTrace(
  db: Db,
  t: {
    todoId?: string | null;
    runId?: string | null;
    kind: string;
    situation: string;
    decision: string;
    rationale?: string;
    outcome?: string;
    entityIds?: string[];
  },
): string {
  const id = newId("trace");
  db.insert(decisionTraces)
    .values({
      id,
      todoId: t.todoId ?? null,
      runId: t.runId ?? null,
      kind: t.kind,
      situation: t.situation,
      decision: t.decision,
      rationale: t.rationale ?? "",
      outcome: t.outcome ?? "",
      entityIdsJson: JSON.stringify(t.entityIds ?? []),
      createdAt: nowIso(),
    })
    .run();
  rawSqlite()
    .prepare("INSERT INTO traces_fts (trace_id, situation, decision, rationale, outcome) VALUES (?, ?, ?, ?, ?)")
    .run(id, t.situation, t.decision, t.rationale ?? "", t.outcome ?? "");
  return id;
}

// ---------- llm usage ----------

/** $/MTok pricing for cost estimates; unknown models record tokens with cost 0. */
const MODEL_PRICING: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-4-8": { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-6": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

function priceFor(model: string) {
  const key = Object.keys(MODEL_PRICING).find((k) => model.startsWith(k));
  return key ? MODEL_PRICING[key] : null;
}

export function insertLlmUsage(
  db: Db,
  u: {
    useCase: string;
    subUseCase?: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    /** Pass when the caller already knows the exact cost (Agent SDK result). */
    costUsd?: number;
    runId?: string;
    todoId?: string;
  },
): string {
  const id = newId("use");
  const p = priceFor(u.model);
  const cost =
    u.costUsd ??
    (p
      ? (u.inputTokens * p.in +
          u.outputTokens * p.out +
          (u.cacheReadTokens ?? 0) * p.cacheRead +
          (u.cacheWriteTokens ?? 0) * p.cacheWrite) /
        1_000_000
      : 0);
  db.insert(llmUsage)
    .values({
      id,
      useCase: u.useCase,
      subUseCase: u.subUseCase ?? null,
      model: u.model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens ?? 0,
      cacheWriteTokens: u.cacheWriteTokens ?? 0,
      costUsd: cost,
      runId: u.runId ?? null,
      todoId: u.todoId ?? null,
      createdAt: nowIso(),
    })
    .run();
  return id;
}

export function usageForRun(db: Db, runId: string) {
  const rows = db.select().from(llmUsage).where(eq(llmUsage.runId, runId)).all();
  return {
    costUsd: rows.reduce((s, r) => s + r.costUsd, 0),
    inputTokens: rows.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: rows.reduce((s, r) => s + r.outputTokens, 0),
  };
}

export function usageSummary(db: Db, sinceIso?: string) {
  const sqlite = rawSqlite();
  return sqlite
    .prepare(
      `SELECT use_case AS useCase, COUNT(*) AS calls, SUM(input_tokens) AS inputTokens,
              SUM(output_tokens) AS outputTokens, SUM(cost_usd) AS costUsd
       FROM llm_usage ${sinceIso ? "WHERE created_at >= ?" : ""}
       GROUP BY use_case ORDER BY costUsd DESC`,
    )
    .all(...(sinceIso ? [sinceIso] : [])) as {
    useCase: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }[];
}

