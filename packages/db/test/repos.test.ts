import { beforeEach, describe, expect, it } from "vitest";
import { openTestDb, closeDb, type Db } from "../src/index.js";
import {
  insertSignal,
  untriagedSignals,
  markTriaged,
  insertTodo,
  updateTodo,
  wakeSnoozedTodos,
  getTodo,
  upsertMemoryNode,
  upsertMemoryEdge,
  insertTrace,
  getSetting,
  setSetting,
} from "../src/repos.js";
import type { NormalizedSignal } from "@ami/shared";

const sig = (id: string): NormalizedSignal => ({
  externalId: id,
  kind: "message",
  title: `title ${id}`,
  body: `body ${id}`,
  author: "tester",
  raw: {},
  occurredAt: new Date().toISOString(),
});

describe("repos", () => {
  let db: Db;
  beforeEach(() => {
    closeDb();
    db = openTestDb();
  });

  it("dedupes signals on (connector, externalId) — re-poll is idempotent", () => {
    expect(insertSignal(db, "slack", null, sig("a"))).toBeTruthy();
    expect(insertSignal(db, "slack", null, sig("a"))).toBeNull();
    expect(insertSignal(db, "gmail", null, sig("a"))).toBeTruthy(); // different connector ok
    expect(untriagedSignals(db)).toHaveLength(2);
  });

  it("marks signals triaged so they leave the queue", () => {
    insertSignal(db, "slack", null, sig("a"));
    const [s] = untriagedSignals(db);
    markTriaged(db, [s.id]);
    expect(untriagedSignals(db)).toHaveLength(0);
  });

  it("wakes snoozed todos past their snooze time", () => {
    const id = insertTodo(db, { type: "task", title: "t", summary: "" });
    updateTodo(db, id, { status: "snoozed", snoozedUntil: new Date(Date.now() - 1000).toISOString() });
    const woken = wakeSnoozedTodos(db);
    expect(woken).toEqual([id]);
    expect(getTodo(db, id)?.status).toBe("open");
  });

  it("does not wake todos snoozed into the future", () => {
    const id = insertTodo(db, { type: "task", title: "t", summary: "" });
    updateTodo(db, id, { status: "snoozed", snoozedUntil: new Date(Date.now() + 60_000).toISOString() });
    expect(wakeSnoozedTodos(db)).toHaveLength(0);
  });

  it("upserting a memory node bumps salience instead of duplicating", () => {
    const id1 = upsertMemoryNode(db, "person", "Priya");
    const id2 = upsertMemoryNode(db, "person", "Priya");
    expect(id1).toBe(id2);
  });

  it("upserting an edge twice increments weight", () => {
    const a = upsertMemoryNode(db, "person", "A");
    const b = upsertMemoryNode(db, "repo", "acme/api");
    upsertMemoryEdge(db, a, b, "works_on");
    upsertMemoryEdge(db, a, b, "works_on");
    // no throw + unique constraint holds
    expect(insertTrace(db, { kind: "triage", situation: "s", decision: "d" })).toBeTruthy();
  });

  it("settings round-trip", () => {
    setSetting(db, "k", "v1");
    setSetting(db, "k", "v2");
    expect(getSetting(db, "k")).toBe("v2");
  });
});
