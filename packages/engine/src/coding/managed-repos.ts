import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { amiHome, connectorAccounts, type Db } from "@ami/db";

const exec = promisify(execFile);

/** Managed clones: when a task's repo has no local clone, Ami clones it
 * itself under ~/.ami/repos/<owner>/<name> and worktrees branch from that.
 * The path encodes the GitHub slug, so no extra bookkeeping is needed. */

export function managedReposDir(): string {
  return path.join(amiHome(), "repos");
}

export function managedRepoSlug(projectPath: string): string | null {
  const root = managedReposDir() + path.sep;
  if (!projectPath.startsWith(root)) return null;
  const seg = projectPath.slice(root.length).split(path.sep).filter(Boolean);
  return seg.length === 2 ? seg.join("/") : null;
}

/** Clone with the user's GitHub token over HTTPS. The token rides in env for
 * the credential helper — it never lands in argv or .git/config. */
export async function cloneManagedRepo(db: Db, projectPath: string): Promise<void> {
  const slug = managedRepoSlug(projectPath);
  if (!slug) throw new Error(`${projectPath} is not a managed repo path`);
  const row = db.select().from(connectorAccounts).where(eq(connectorAccounts.connector, "github")).get();
  const token = row ? (JSON.parse(row.authJson).token as string) : "";
  fs.mkdirSync(path.dirname(projectPath), { recursive: true });
  const helper = 'credential.helper=!f(){ echo username=x-access-token; echo "password=$AMI_GH_TOKEN"; };f';
  await exec(
    "git",
    ["-c", helper, "clone", "--quiet", `https://github.com/${slug}.git`, projectPath],
    {
      env: { ...process.env, AMI_GH_TOKEN: token },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    },
  );
}
