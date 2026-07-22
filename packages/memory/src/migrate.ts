import fs from "node:fs";
import path from "node:path";
import { decisionTraces, memoryEdges, memoryNodes, type Db } from "@ami/db";
import { knowledgeDir, ENTITY_FOLDERS, safeSegment } from "./paths.js";
import { invalidateKnowledgeIndex } from "./knowledge-index.js";

/** One-time migration: convert Ami's legacy SQLite memory graph
 * (memory_nodes / memory_edges / decision_traces) into markdown dossiers so
 * existing knowledge survives the move to the file-based memory. Runs only
 * when the knowledge base has no entity notes yet. */

const TYPE_TO_FOLDER: Record<string, (typeof ENTITY_FOLDERS)[number]> = {
  person: "People",
  customer: "Organizations",
  channel: "Topics",
  repo: "Projects",
  project: "Projects",
  topic: "Topics",
  artifact: "Topics",
  tool: "Topics",
};

function hasEntityNotes(): boolean {
  for (const folder of ENTITY_FOLDERS) {
    const dir = path.join(knowledgeDir(), folder);
    if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".md"))) return true;
  }
  return false;
}

export function migrateSqliteMemory(db: Db): { migrated: number } {
  if (hasEntityNotes()) return { migrated: 0 };
  const nodes = db.select().from(memoryNodes).all();
  if (nodes.length === 0) return { migrated: 0 };

  const edges = db.select().from(memoryEdges).all();
  const traces = db.select().from(decisionTraces).all();

  // Assign each node a note path; disambiguate name collisions within a folder.
  const pathById = new Map<string, string>();
  const taken = new Set<string>();
  for (const n of nodes) {
    const folder = TYPE_TO_FOLDER[n.type] ?? "Topics";
    let name = safeSegment(n.name);
    if (taken.has(`${folder}/${name}`)) name = safeSegment(`${n.name} (${n.type})`);
    taken.add(`${folder}/${name}`);
    pathById.set(n.id, `${folder}/${name}`);
  }

  const tracesByNode = new Map<string, typeof traces>();
  for (const t of traces) {
    const ids: string[] = JSON.parse(t.entityIdsJson ?? "[]");
    for (const id of ids) {
      const list = tracesByNode.get(id) ?? [];
      list.push(t);
      tracesByNode.set(id, list);
    }
  }

  let migrated = 0;
  for (const n of nodes) {
    const notePath = pathById.get(n.id)!;
    const folder = notePath.split("/")[0];
    const outEdges = edges.filter((e) => e.srcId === n.id && pathById.has(e.dstId));
    const inEdges = edges.filter((e) => e.dstId === n.id && pathById.has(e.srcId));
    const nodeTraces = (tracesByNode.get(n.id) ?? []).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );

    const connected = [
      ...outEdges.map((e) => `- [[${pathById.get(e.dstId)}]] — ${e.rel.replace(/_/g, " ")}`),
      ...inEdges.map((e) => `- [[${pathById.get(e.srcId)}]] — ${e.rel.replace(/_/g, " ")} (inbound)`),
    ];
    const activity = nodeTraces
      .slice(0, 30)
      .map((t) => {
        const date = t.createdAt.slice(0, 10);
        const outcome = t.outcome ? ` Outcome: ${t.outcome.slice(0, 160)}` : "";
        return `- **${date}** (${t.kind}): ${t.situation.slice(0, 200)} → ${t.decision.slice(0, 200)}.${outcome}`;
      });

    const lines: string[] = [`# ${n.name}`, ``];
    lines.push(`## Info`);
    if (folder === "Organizations") lines.push(`**Type:** company`);
    if (n.type === "repo") lines.push(`**Type:** product`);
    lines.push(`**First met:** ${n.createdAt.slice(0, 10)}`);
    lines.push(`**Last update:** ${n.updatedAt.slice(0, 10)}`, ``);
    if (n.summary) lines.push(`## Summary`, n.summary, ``);
    if (connected.length) lines.push(`## Connected to`, ...connected, ``);
    lines.push(`## Activity`, ...(activity.length ? activity : []), ``);
    lines.push(`## Key facts`, ``);
    lines.push(`## Open items`, ``);
    lines.push(
      `## Assistant notes`,
      `- [${new Date().toISOString()}] Migrated from Ami's legacy memory graph (salience ${n.salience.toFixed(1)}).`,
      ``,
    );

    const abs = path.join(knowledgeDir(), `${notePath}.md`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, lines.join("\n"), "utf-8");
    migrated++;
  }

  invalidateKnowledgeIndex();
  void import("./version-history.js").then(({ commitKnowledge }) =>
    commitKnowledge("Legacy memory migration").catch(() => {}),
  );
  console.log(`[memory] migrated ${migrated} legacy memory nodes into knowledge notes`);
  return { migrated };
}
