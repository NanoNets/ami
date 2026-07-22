import fs from "node:fs";
import path from "node:path";
import { knowledgeDir } from "./paths.js";
import { getKnowledgeIndex } from "./knowledge-index.js";
import { searchFts } from "./fts.js";

/** Deterministic retrieval over the markdown knowledge base (no LLM):
 * index-based name/alias/email matching (strong signal) + FTS5 content
 * ranking (falls back to a full-file scan when FTS5 is unavailable) +
 * recency. Used by the memory_search tool and by triage/run context blocks. */

export interface KnowledgeHit {
  /** knowledge-relative path, e.g. "People/Sarah Chen.md" */
  file: string;
  name: string;
  folder: string;
  score: number;
  excerpt: string;
}

function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9@.#-]+/).filter((t) => t.length > 2))].slice(0, 16);
}

function recencyBoost(mtimeMs: number): number {
  const ageDays = (Date.now() - mtimeMs) / 86_400_000;
  return Math.exp(-ageDays / 90);
}

const ARCHIVED_PENALTY = 0.3;

interface RegisteredNote {
  name: string;
  fields: string[];
  archived: boolean;
}

function registerIndexFields(): Map<string, RegisteredNote> {
  const index = getKnowledgeIndex();
  const archived = new Set(index.archivedFiles);
  const nameFields = new Map<string, RegisteredNote>();
  const register = (file: string, name: string, fields: (string | undefined)[]) => {
    nameFields.set(file, {
      name: name || path.basename(file, ".md"),
      fields: fields.filter((f): f is string => !!f).map((f) => f.toLowerCase()),
      archived: archived.has(file),
    });
  };
  for (const p of index.people) register(p.file, p.name, [p.name, p.email, p.organization, p.role, ...p.aliases]);
  for (const o of index.organizations) register(o.file, o.name, [o.name, o.domain, ...o.aliases]);
  for (const p of index.projects) register(p.file, p.name, [p.name, p.status, ...p.aliases]);
  for (const t of index.topics) register(t.file, t.name, [t.name, ...t.keywords, ...t.aliases]);
  for (const n of index.other) register(n.file, n.name, [n.name, ...n.aliases]);
  return nameFields;
}

/** Legacy content scoring: read and scan every note. Only used when FTS5
 * can't be opened (e.g. a better-sqlite3 build without it). */
function scanContentHits(
  qterms: string[],
  files: Iterable<string>,
): Map<string, { score: number; excerpt: string }> {
  const root = knowledgeDir();
  const out = new Map<string, { score: number; excerpt: string }>();
  for (const file of files) {
    let content = "";
    try {
      content = fs.readFileSync(path.join(root, file), "utf-8");
    } catch {
      continue;
    }
    const lower = content.toLowerCase();
    let score = 0;
    let firstHitLine = -1;
    for (const t of qterms) {
      const occurrences = lower.split(t).length - 1;
      if (occurrences > 0) {
        score += Math.min(3, occurrences);
        if (firstHitLine === -1) {
          const idx = lower.indexOf(t);
          firstHitLine = content.slice(0, idx).split("\n").length - 1;
        }
      }
    }
    if (score === 0) continue;
    const lines = content.split("\n");
    const start = Math.max(0, firstHitLine - 1);
    out.set(file, { score, excerpt: lines.slice(start, start + 4).join("\n").slice(0, 400) });
  }
  return out;
}

export function searchKnowledge(query: string, k = 8): KnowledgeHit[] {
  const qterms = terms(query);
  if (qterms.length === 0) return [];
  const root = knowledgeDir();
  const nameFields = registerIndexFields();

  // Content relevance: FTS5 ranked match, or the full scan as fallback.
  const ftsHits = searchFts(qterms, Math.max(24, k * 3));
  const contentHits =
    ftsHits !== null
      ? new Map(
          ftsHits.map((h) => [
            h.file,
            // bm25 magnitudes vary with corpus size; clamp so field matches
            // (exact names/emails) keep dominating topical text matches.
            { score: Math.min(8, h.score), excerpt: h.snippet.slice(0, 400) },
          ]),
        )
      : scanContentHits(qterms, nameFields.keys());

  const candidates = new Set<string>([...contentHits.keys()]);
  for (const [file, { fields }] of nameFields) {
    if (qterms.some((t) => fields.some((f) => f.includes(t)))) candidates.add(file);
  }

  const hits: KnowledgeHit[] = [];
  for (const file of candidates) {
    const registered = nameFields.get(file);
    // Files present in FTS but not the index (merged stubs) stay out.
    if (!registered) continue;
    let mtimeMs = Date.now();
    try {
      mtimeMs = fs.statSync(path.join(root, file)).mtimeMs;
    } catch {
      continue;
    }

    let score = 0;
    for (const t of qterms) {
      if (registered.fields.some((f) => f.includes(t))) score += 5;
    }
    const content = contentHits.get(file);
    score += content?.score ?? 0;
    if (score === 0) continue;
    score *= 0.5 + recencyBoost(mtimeMs);
    if (registered.archived) score *= ARCHIVED_PENALTY;

    let excerpt = content?.excerpt ?? "";
    if (!excerpt) {
      excerpt = (readNote(file) ?? "").split("\n").slice(0, 4).join("\n").slice(0, 400);
    }
    const folder = file.includes(path.sep) ? file.split(path.sep)[0] : "root";
    hits.push({ file, name: registered.name, folder, score, excerpt });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, k);
}

export function readNote(relPath: string): string | null {
  const root = knowledgeDir();
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(root + path.sep) && abs !== root) return null; // no escaping the knowledge dir
  try {
    return fs.readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

/** The signal author's own dossiers, resolved by structured keys instead of
 * text matching: their People note by email (or exact name), plus their
 * Organization note by email domain. These are the strongest context for any
 * triage/task/draft touching the signal, so callers pin them into the block. */
export function entityFilesForAuthor(author: string | null | undefined): string[] {
  if (!author) return [];
  const index = getKnowledgeIndex();
  const email = author.match(/<?([\w.+-]+@[\w.-]+\.\w+)>?/)?.[1]?.toLowerCase() ?? null;
  const name = author.replace(/<[^>]*>/g, "").trim().toLowerCase();
  const files: string[] = [];

  const person = index.people.find((p) =>
    email
      ? p.email?.toLowerCase() === email || p.aliases.some((a) => a.toLowerCase() === email)
      : !!name && p.name.toLowerCase() === name,
  );
  if (person) files.push(person.file);

  const domain = email?.split("@")[1];
  if (domain) {
    const org = index.organizations.find((o) => o.domain?.toLowerCase() === domain);
    if (org) files.push(org.file);
  } else if (person?.organization) {
    const orgName = person.organization.toLowerCase();
    const org = index.organizations.find((o) => o.name.toLowerCase() === orgName);
    if (org) files.push(org.file);
  }
  return files;
}

function renderContextBlock(
  ordered: { file: string; excerpt: string }[],
  maxChars: number,
  maxFull: number,
): string {
  if (ordered.length === 0) return "";
  const parts: string[] = ["Relevant knowledge notes (the user's memory — dossiers on people, orgs, projects, topics):"];
  let used = 0;
  let full = 0;
  for (const hit of ordered) {
    const content = readNote(hit.file);
    if (!content) continue;
    if (full < maxFull && used + content.length <= maxChars) {
      parts.push(`\n--- ${hit.file} ---\n${content.trim()}`);
      used += content.length;
      full++;
    } else {
      parts.push(`- ${hit.file}: ${hit.excerpt.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  return parts.join("\n");
}

/** Context block for triage/run prompts: full dossiers for the top matches
 * (capped), plus one-line pointers for the rest. `mustInclude` files (e.g. the
 * signal author's dossiers from entityFilesForAuthor) rank first regardless of
 * text-match score. */
export function memoryContextBlock(
  query: string,
  k = 6,
  maxChars = 9000,
  opts: { mustInclude?: string[] } = {},
): string {
  const hits = searchKnowledge(query, k);
  const pinned = (opts.mustInclude ?? []).filter((f) => readNote(f) !== null);
  const ordered = [
    ...pinned.map((file) => ({ file, excerpt: "" })),
    ...hits.filter((h) => !pinned.includes(h.file)),
  ].slice(0, Math.max(k, pinned.length));
  return renderContextBlock(ordered, maxChars, 3);
}

/** One merged context block for a whole triage batch: hits are collected per
 * signal, deduped by file (best score wins), author dossiers pinned first —
 * instead of N overlapping per-signal blocks repeating the same dossiers. */
export function combinedMemoryContext(
  queries: { query: string; author?: string | null }[],
  kPerQuery = 4,
  maxChars = 9000,
): string {
  const pinned: string[] = [];
  const best = new Map<string, KnowledgeHit>();
  for (const q of queries) {
    for (const file of entityFilesForAuthor(q.author)) {
      if (!pinned.includes(file)) pinned.push(file);
    }
    for (const hit of searchKnowledge(q.query, kPerQuery)) {
      const prev = best.get(hit.file);
      if (!prev || hit.score > prev.score) best.set(hit.file, hit);
    }
  }
  const ranked = [...best.values()]
    .filter((h) => !pinned.includes(h.file))
    .sort((a, b) => b.score - a.score);
  const ordered = [...pinned.map((file) => ({ file, excerpt: "" })), ...ranked].slice(0, 12);
  return renderContextBlock(ordered, maxChars, 4);
}

/** Cheap per-turn memory for resumed chat sessions: one line per hit, so the
 * conversation can drift topics without losing memory entirely. The model
 * loads anything promising via memory_read_note. */
export function compactMemoryHints(query: string, k = 4): string {
  const hits = searchKnowledge(query, k);
  if (hits.length === 0) return "";
  const lines = hits.map(
    (h) => `- ${h.file}: ${h.excerpt.replace(/\s+/g, " ").slice(0, 140)}`,
  );
  return `Possibly relevant memory notes (load with mcp__ami__memory_read_note if useful):\n${lines.join("\n")}`;
}
