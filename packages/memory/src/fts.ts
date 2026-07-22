import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { amiHome } from "@ami/db";

/** FTS5 mirror of the knowledge notes for ranked content retrieval.
 * Lives in its own sqlite file (~/.ami/knowledge_fts.db) — it is a rebuildable
 * cache of the markdown, not state, so it stays out of ami.db and its schema
 * guard. Sync is mtime-based and driven by the knowledge index rebuild; every
 * query falls back gracefully when FTS5 is unavailable. */

let ftsDb: Database.Database | null = null;
let ftsDbPath: string | null = null;
let ftsUnavailable = false;

function openFts(): Database.Database | null {
  if (ftsUnavailable) return null;
  const dbPath = path.join(amiHome(), "knowledge_fts.db");
  if (ftsDb && ftsDbPath === dbPath) return ftsDb;
  closeFts();
  try {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(file UNINDEXED, name, content, tokenize='porter unicode61');
       CREATE TABLE IF NOT EXISTS synced (file TEXT PRIMARY KEY, mtime REAL NOT NULL);`,
    );
    ftsDb = db;
    ftsDbPath = dbPath;
    return ftsDb;
  } catch (e) {
    console.error("[memory-fts] unavailable, falling back to scan search:", e);
    ftsUnavailable = true;
    return null;
  }
}

/** Bring the FTS mirror in line with the notes on disk. `files` is the full
 * current set of knowledge-relative paths with their absolute locations. */
export function syncFts(files: { rel: string; abs: string }[]): void {
  const db = openFts();
  if (!db) return;
  try {
    const synced = new Map<string, number>(
      (db.prepare("SELECT file, mtime FROM synced").all() as { file: string; mtime: number }[]).map(
        (r) => [r.file, r.mtime],
      ),
    );
    const seen = new Set<string>();
    const delNote = db.prepare("DELETE FROM notes WHERE file = ?");
    const insNote = db.prepare("INSERT INTO notes (file, name, content) VALUES (?, ?, ?)");
    const upsSync = db.prepare("INSERT OR REPLACE INTO synced (file, mtime) VALUES (?, ?)");
    const delSync = db.prepare("DELETE FROM synced WHERE file = ?");

    const apply = db.transaction(() => {
      for (const { rel, abs } of files) {
        seen.add(rel);
        let mtime: number;
        let content: string;
        try {
          mtime = fs.statSync(abs).mtimeMs;
          if (synced.get(rel) === mtime) continue;
          content = fs.readFileSync(abs, "utf-8");
        } catch {
          continue;
        }
        const name = content.match(/^#\s+(.+?)$/m)?.[1]?.trim() ?? path.basename(rel, ".md");
        delNote.run(rel);
        insNote.run(rel, name, content);
        upsSync.run(rel, mtime);
      }
      for (const rel of synced.keys()) {
        if (!seen.has(rel)) {
          delNote.run(rel);
          delSync.run(rel);
        }
      }
    });
    apply();
  } catch (e) {
    console.error("[memory-fts] sync failed:", e);
  }
}

export interface FtsHit {
  file: string;
  /** Positive, larger = better (negated bm25 rank). */
  score: number;
  snippet: string;
}

/** Ranked content search. Terms are OR-ed so partial matches still surface. */
export function searchFts(terms: string[], limit = 24): FtsHit[] | null {
  const db = openFts();
  if (!db || terms.length === 0) return db ? [] : null;
  const match = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
  try {
    const rows = db
      .prepare(
        `SELECT file, bm25(notes) AS rank, snippet(notes, 2, '', '', '…', 14) AS snip
         FROM notes WHERE notes MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as { file: string; rank: number; snip: string }[];
    return rows.map((r) => ({ file: r.file, score: Math.max(0, -r.rank), snippet: r.snip }));
  } catch (e) {
    console.error("[memory-fts] query failed:", e);
    return null;
  }
}

/** Close the current handle (openFts re-opens against the current AMI_HOME). */
export function closeFts(): void {
  try {
    ftsDb?.close();
  } catch {
    // already closed
  }
  ftsDb = null;
  ftsDbPath = null;
  ftsUnavailable = false;
}
