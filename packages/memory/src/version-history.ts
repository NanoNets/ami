import fs from "node:fs";
import path from "node:path";
import git from "isomorphic-git";
import { knowledgeDir } from "./paths.js";

/** Git version history for the knowledge dir. Every memory write
 * commits, so the curation agent's
 * in-place rewrites are always revertable. */

// Serialize commits — concurrent index writes corrupt the repo.
let commitLock: Promise<void> = Promise.resolve();

function withCommitLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = commitLock.then(fn, fn);
  commitLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const AUTHOR = { name: "Ami", email: "ami@localhost" };

function dirOf(): string {
  return knowledgeDir();
}

async function listMarkdownFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (entry === ".git") continue;
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...(await listMarkdownFiles(full, base)));
    else if (stat.isFile() && entry.endsWith(".md")) out.push(path.relative(base, full));
  }
  return out;
}

/** Create the repo if missing; stage all existing notes and snapshot. */
export async function initKnowledgeRepo(): Promise<void> {
  const dir = dirOf();
  if (fs.existsSync(path.join(dir, ".git"))) return;
  await withCommitLock(async () => {
    await git.init({ fs, dir, defaultBranch: "main" });
    const files = await listMarkdownFiles(dir);
    for (const filepath of files) {
      await git.add({ fs, dir, filepath });
    }
    await git.commit({ fs, dir, message: "Initial snapshot", author: AUTHOR });
  });
  console.log("[knowledge-git] initialized repo");
}

/** Stage every changed/added/deleted .md and commit. No-ops when clean. */
export async function commitKnowledge(message: string): Promise<boolean> {
  const dir = dirOf();
  if (!fs.existsSync(path.join(dir, ".git"))) await initKnowledgeRepo();
  return withCommitLock(async () => {
    const matrix = await git.statusMatrix({ fs, dir, filter: (f) => f.endsWith(".md") });
    let changed = 0;
    for (const [filepath, head, workdir] of matrix) {
      if (head === 1 && workdir === 1) continue; // unmodified fast-path (stage may differ; add is idempotent)
      if (workdir === 0) {
        await git.remove({ fs, dir, filepath });
        changed++;
      } else {
        await git.add({ fs, dir, filepath });
        changed++;
      }
    }
    if (changed === 0) return false;
    await git.commit({ fs, dir, message, author: AUTHOR });
    return true;
  });
}

export interface CommitInfo {
  oid: string;
  message: string;
  timestamp: number; // seconds
  author: string;
}

async function blobOidAt(dir: string, oid: string, filepath: string): Promise<string | null> {
  try {
    const { oid: blobOid } = await git.readBlob({ fs, dir, oid, filepath });
    return blobOid;
  } catch {
    return null;
  }
}

/** Commits where this note changed (newest first, max 50). */
export async function getNoteHistory(relPath: string): Promise<CommitInfo[]> {
  const dir = dirOf();
  if (!fs.existsSync(path.join(dir, ".git"))) return [];
  let commits;
  try {
    commits = await git.log({ fs, dir });
  } catch {
    return [];
  }
  const out: CommitInfo[] = [];
  for (let i = 0; i < commits.length && out.length < 50; i++) {
    const current = commits[i];
    const parent = commits[i + 1];
    const currentBlob = await blobOidAt(dir, current.oid, relPath);
    const parentBlob = parent ? await blobOidAt(dir, parent.oid, relPath) : null;
    if (currentBlob !== parentBlob) {
      out.push({
        oid: current.oid,
        message: current.commit.message.trim(),
        timestamp: current.commit.author.timestamp,
        author: current.commit.author.name,
      });
    }
  }
  return out;
}

export interface RecentCommit extends CommitInfo {
  /** knowledge-relative paths changed in this commit. */
  files: string[];
}

async function changedFilesBetween(dir: string, oid: string, parentOid: string | null): Promise<string[]> {
  const trees = parentOid
    ? [git.TREE({ ref: oid }), git.TREE({ ref: parentOid })]
    : [git.TREE({ ref: oid }), git.TREE({ ref: oid })];
  const results = await git.walk({
    fs,
    dir,
    trees,
    map: async (filepath, [a, b]) => {
      if (filepath === ".") return;
      if ((a && (await a.type()) === "tree") || (b && (await b.type()) === "tree")) return;
      if (!filepath.endsWith(".md")) return;
      const aOid = a ? await a.oid() : null;
      const bOid = b ? await b.oid() : null;
      // Root commit (no parent): every file counts as changed.
      if (parentOid !== null && aOid === bOid) return;
      return filepath;
    },
  });
  return (results as (string | undefined)[]).filter((f): f is string => !!f);
}

/** The knowledge base's recent write history — what memory learned, when, and
 * which dossiers it touched. Powers the console's "recent memory updates". */
export async function getRecentCommits(limit = 20): Promise<RecentCommit[]> {
  const dir = dirOf();
  if (!fs.existsSync(path.join(dir, ".git"))) return [];
  let commits;
  try {
    commits = await git.log({ fs, dir, depth: limit + 1 });
  } catch {
    return [];
  }
  const out: RecentCommit[] = [];
  for (let i = 0; i < Math.min(commits.length, limit); i++) {
    const current = commits[i];
    const parent = commits[i + 1] ?? null;
    let files: string[] = [];
    try {
      files = await changedFilesBetween(dir, current.oid, parent?.oid ?? null);
    } catch {
      // diff failure on one commit shouldn't hide the rest
    }
    out.push({
      oid: current.oid,
      message: current.commit.message.trim(),
      timestamp: current.commit.author.timestamp,
      author: current.commit.author.name,
      files,
    });
  }
  return out;
}

export async function getNoteAtCommit(relPath: string, oid: string): Promise<string | null> {
  const dir = dirOf();
  try {
    const { blob } = await git.readBlob({ fs, dir, oid, filepath: relPath });
    return new TextDecoder().decode(blob);
  } catch {
    return null;
  }
}

/** Restore a note to its content at a commit (writes + commits the restore). */
export async function restoreNote(relPath: string, oid: string): Promise<boolean> {
  const content = await getNoteAtCommit(relPath, oid);
  if (content === null) return false;
  const abs = path.join(dirOf(), relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  await commitKnowledge(`Restored ${path.basename(relPath)}`);
  return true;
}
