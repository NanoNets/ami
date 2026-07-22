import { type Db } from "@ami/db";
import { buildKnowledgeIndex, invalidateKnowledgeIndex, type KnowledgeIndex } from "./knowledge-index.js";
import { loadState, saveState } from "./graph-state.js";
import { buildOwnerBlock } from "./owner.js";
import { noteMergePrompt } from "./prompts/note-merge.js";
import { runKnowledgeAgent } from "./agent-runner.js";
import { readNote } from "./search.js";
import { commitKnowledge } from "./version-history.js";

/** Entity-resolution pass: the classic failure of note-per-entity memories is
 * the same person/org/project accumulating two files (one from an email, one
 * from a display name). Candidate pairs are found deterministically; an agent
 * run decides same-vs-distinct and performs the merge; verdicts are recorded
 * so no pair is ever re-litigated. */

export interface DuplicateCandidate {
  a: string;
  b: string;
  reason: string;
}

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function aliasSet(name: string, aliases: string[]): Set<string> {
  return new Set([normName(name), ...aliases.map(normName)].filter((s) => s.length > 2));
}

function overlap(a: Set<string>, b: Set<string>): boolean {
  for (const v of a) if (b.has(v)) return true;
  return false;
}

function pairsIn<T extends { file: string }>(
  entries: T[],
  match: (x: T, y: T) => string | null,
  out: DuplicateCandidate[],
): void {
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const reason = match(entries[i], entries[j]);
      if (reason) out.push({ a: entries[i].file, b: entries[j].file, reason });
    }
  }
}

export function findDuplicateCandidates(index: KnowledgeIndex = buildKnowledgeIndex()): DuplicateCandidate[] {
  const out: DuplicateCandidate[] = [];

  pairsIn(
    index.people,
    (x, y) => {
      if (x.email && y.email && x.email.toLowerCase() === y.email.toLowerCase())
        return `same email (${x.email})`;
      const ax = aliasSet(x.name, x.aliases);
      const ay = aliasSet(y.name, y.aliases);
      if (normName(x.name) === normName(y.name)) return "same name";
      if (overlap(ax, ay)) return "overlapping aliases";
      return null;
    },
    out,
  );

  pairsIn(
    index.organizations,
    (x, y) => {
      if (x.domain && y.domain && x.domain.toLowerCase() === y.domain.toLowerCase())
        return `same domain (${x.domain})`;
      if (normName(x.name) === normName(y.name)) return "same name";
      if (overlap(aliasSet(x.name, x.aliases), aliasSet(y.name, y.aliases))) return "overlapping aliases";
      return null;
    },
    out,
  );

  pairsIn(
    index.projects,
    (x, y) => {
      if (normName(x.name) === normName(y.name)) return "same name";
      if (overlap(aliasSet(x.name, x.aliases), aliasSet(y.name, y.aliases))) return "overlapping aliases";
      return null;
    },
    out,
  );

  return out;
}

const DEDUPE_MAX_PAIRS_PER_RUN = 2;

/** Resolve up to DEDUPE_MAX_PAIRS_PER_RUN undecided duplicate pairs. Runs on
 * the daily curation cadence. */
export async function runDedupePass(db: Db): Promise<{ merged: number; distinct: number }> {
  const outcome = { merged: 0, distinct: 0 };
  const decisions = loadState().mergeDecisions ?? {};
  const pending = findDuplicateCandidates().filter((c) => !decisions[pairKey(c.a, c.b)]);
  if (pending.length === 0) return outcome;

  for (const pair of pending.slice(0, DEDUPE_MAX_PAIRS_PER_RUN)) {
    const contentA = readNote(pair.a);
    const contentB = readNote(pair.b);
    if (!contentA || !contentB) continue;

    let message = buildOwnerBlock(db);
    message += `\n---\n\n`;
    message += `A deterministic scan flagged these two notes as possible duplicates of one entity (${pair.reason}). Decide and act per your instructions.\n\n`;
    message += `## Note A: knowledge/${pair.a}\n\n${contentA}\n\n---\n\n`;
    message += `## Note B: knowledge/${pair.b}\n\n${contentB}\n`;

    const res = await runKnowledgeAgent(db, {
      systemPrompt: noteMergePrompt(),
      message,
      useCase: "note_dedupe",
      maxTurns: 20,
    });
    if (!res.ok) {
      console.error(`[graph] dedupe run failed for ${pair.a} / ${pair.b}:`, res.error);
      continue;
    }
    const verdict = /VERDICT:\s*merged/i.test(res.resultText) ? "merged" : "distinct";
    outcome[verdict as "merged" | "distinct"]++;

    // Re-load: the agent run took time and other writers save this state too.
    const fresh = loadState();
    fresh.mergeDecisions = {
      ...(fresh.mergeDecisions ?? {}),
      [pairKey(pair.a, pair.b)]: { verdict, at: new Date().toISOString() },
    };
    saveState(fresh);
    if (verdict === "merged") invalidateKnowledgeIndex();
  }

  if (outcome.merged > 0) {
    await commitKnowledge("Merged duplicate notes").catch((e) =>
      console.error("[knowledge-git] commit failed:", e),
    );
  }
  return outcome;
}
