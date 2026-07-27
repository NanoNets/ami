import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { codeProjects, type Db } from "@ami/db";
import { newId, nowIso } from "@ami/shared";
import { repoInfo } from "./worktree.js";
import { managedReposDir } from "./managed-repos.js";

/** Fill the code-project registry by finding the user's local git clones —
 * nobody registers repos by hand. Shallow walk from $HOME (hidden dirs and
 * media/system trees skipped), stopping at the first .git so nested repos and
 * vendored trees don't multiply. Registered projects show in Settings and are
 * deletable like manually added ones. */

const SKIP = new Set([
  "node_modules",
  "Library",
  "Applications",
  "Movies",
  "Music",
  "Pictures",
  "Downloads",
  "Public",
]);

function findRepos(root: string, maxDepth: number, cap: number): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (found.length >= cap) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === ".git")) {
      found.push(dir);
      return;
    }
    if (depth <= 0) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name)) continue;
      walk(path.join(dir, e.name), depth - 1);
    }
  };
  walk(root, maxDepth);
  return found;
}

export async function discoverCodeProjects(db: Db): Promise<number> {
  // Self-heal: a registered project whose folder is gone would fail every run
  // that attaches it — drop it (rediscovered automatically if it comes back).
  // Managed repos (~/.ami/repos) are exempt: they exist by design only after
  // their first run clones them.
  for (const p of db.select().from(codeProjects).all()) {
    if (!fs.existsSync(p.path) && !p.path.startsWith(managedReposDir())) {
      db.delete(codeProjects).where(eq(codeProjects.id, p.id)).run();
      console.log(`[projects] pruned ${p.name} (folder gone: ${p.path})`);
    }
  }
  const repos = findRepos(os.homedir(), 5, 60);
  let added = 0;
  for (const p of repos) {
    if (db.select().from(codeProjects).where(eq(codeProjects.path, p)).get()) continue;
    const info = await repoInfo(p).catch(() => ({ isGitRepo: false, branch: null }));
    if (!info.isGitRepo) continue;
    db.insert(codeProjects)
      .values({
        id: newId("proj"),
        name: path.basename(p),
        path: p,
        defaultBranch: info.branch ?? "main",
        createdAt: nowIso(),
      })
      .run();
    added++;
  }
  if (added > 0) console.log(`[projects] discovered ${added} local repo(s)`);
  return added;
}
