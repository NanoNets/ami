import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { amiHome } from "@ami/db";

const exec = promisify(execFile);

/** Git worktree + status helpers for coding runs, shelling out to the git CLI. */

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

export async function repoInfo(cwd: string): Promise<{
  isGitRepo: boolean;
  branch: string | null;
  dirtyCount: number;
}> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { isGitRepo: false, branch: null, dirtyCount: 0 };
  }
  const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim() || null;
  const status = await git(cwd, ["status", "--porcelain=v1"]).catch(() => "");
  return { isGitRepo: true, branch, dirtyCount: status.split("\n").filter(Boolean).length };
}

/** "owner/repo" from the origin remote, however it's cloned (ssh/https). */
export async function originSlug(cwd: string): Promise<string | null> {
  try {
    const url = (await git(cwd, ["config", "--get", "remote.origin.url"])).trim();
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(\.git)?\/?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export interface ChangedFile {
  path: string;
  state: string; // M|A|D|R|??
}

/** Committed + uncommitted changes since the fork point from baseRef. */
export async function changedSinceBase(cwd: string, baseRef: string): Promise<ChangedFile[]> {
  const out = new Map<string, string>();
  try {
    const base = (await git(cwd, ["merge-base", baseRef, "HEAD"])).trim();
    const committed = await git(cwd, ["diff", "--name-status", base, "HEAD"]);
    for (const line of committed.split("\n").filter(Boolean)) {
      const [state, ...rest] = line.split("\t");
      out.set(rest[rest.length - 1], state[0]);
    }
  } catch {
    // no commits yet / detached — fall through to working tree only
  }
  const wt = await git(cwd, ["status", "--porcelain=v1"]).catch(() => "");
  for (const line of wt.split("\n").filter(Boolean)) {
    const state = line.slice(0, 2).trim() || "M";
    const p = line.slice(3).trim();
    if (p) out.set(p, state);
  }
  return [...out.entries()].map(([p, state]) => ({ path: p, state }));
}

export function worktreeRoot(): string {
  const dir = path.join(amiHome(), "worktrees");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create an isolated worktree on a fresh branch from the project's HEAD.
 * Reuses an existing worktree dir (iteration runs share it). */
export async function ensureWorktree(
  projectPath: string,
  worktreePath: string,
  branch: string,
): Promise<{ path: string; branch: string; baseBranch: string | null }> {
  const info = await repoInfo(projectPath);
  if (!info.isGitRepo) throw new Error(`${projectPath} is not a git repository`);
  if (fs.existsSync(path.join(worktreePath, ".git"))) {
    return { path: worktreePath, branch, baseBranch: info.branch };
  }
  await git(projectPath, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  return { path: worktreePath, branch, baseBranch: info.branch };
}

export async function removeWorktree(
  projectPath: string,
  worktreePath: string,
  opts: { force?: boolean; deleteBranch?: string } = {},
): Promise<void> {
  try {
    await git(projectPath, ["worktree", "remove", ...(opts.force ? ["--force"] : []), worktreePath]);
  } catch {
    await git(projectPath, ["worktree", "prune"]).catch(() => {});
  }
  if (opts.deleteBranch) {
    await git(projectPath, ["branch", "-D", opts.deleteBranch]).catch(() => {});
  }
}

/** Merge a worktree branch back into the project's current branch (no-edit;
 * conflict-safe: aborts and reports). */
export async function mergeBack(
  projectPath: string,
  branch: string,
): Promise<{ ok: boolean; message: string }> {
  const info = await repoInfo(projectPath);
  if (!info.isGitRepo) return { ok: false, message: "not a git repository" };
  if (info.dirtyCount > 0) {
    return { ok: false, message: `working tree has ${info.dirtyCount} uncommitted change(s) — commit or stash first` };
  }
  try {
    await git(projectPath, ["merge", "--no-edit", branch]);
    return { ok: true, message: `merged ${branch} into ${info.branch}` };
  } catch (e: any) {
    await git(projectPath, ["merge", "--abort"]).catch(() => {});
    return { ok: false, message: `merge conflict — aborted (${String(e.message).slice(0, 200)})` };
  }
}
