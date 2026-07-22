import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { amiHome } from "@ami/db";
import type { TimedTriggers } from "@ami/shared";

/** Background task storage:
 * ~/.ami/bg-tasks/<slug>/{task.yaml,index.md,runs.log}. task.yaml is
 * runtime-owned config+state; index.md is the agent-owned visible artifact. */

export interface BackgroundTask {
  name: string;
  instructions: string;
  active: boolean;
  triggers?: TimedTriggers;
  /** Pinned code project — makes this a coding task (launch_code_task enabled). */
  projectId?: string;
  model?: string;
  createdAt: string;
  lastAttemptAt?: string;
  lastRunAt?: string;
  lastRunId?: string;
  lastRunSummary?: string;
  lastRunError?: string;
  /** Consecutive failures; the runner pauses the task when it hits the cap. */
  failCount?: number;
}

export interface BackgroundTaskSummary extends BackgroundTask {
  slug: string;
}

export function bgTasksRoot(): string {
  const dir = path.join(amiHome(), "bg-tasks");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Slugs come from slugify(), but they also arrive as route params — validate
// before joining so "../.." can never escape the bg-tasks root.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function taskDir(slug: string): string {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid bg-task slug: ${JSON.stringify(slug)}`);
  return path.join(bgTasksRoot(), slug);
}

function yamlPath(slug: string): string {
  return path.join(taskDir(slug), "task.yaml");
}

export function indexPath(slug: string): string {
  return path.join(taskDir(slug), "index.md");
}

function slugify(name: string): string {
  return (
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "task"
  );
}

export function createTask(input: {
  name: string;
  instructions: string;
  triggers?: TimedTriggers;
  projectId?: string;
  model?: string;
}): string {
  let slug = slugify(input.name);
  let n = 2;
  while (fs.existsSync(taskDir(slug))) slug = `${slugify(input.name)}-${n++}`;
  fs.mkdirSync(taskDir(slug), { recursive: true });
  const task: BackgroundTask = {
    name: input.name,
    instructions: input.instructions,
    active: true,
    triggers: input.triggers,
    projectId: input.projectId,
    model: input.model,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(yamlPath(slug), YAML.stringify(task), "utf-8");
  fs.writeFileSync(indexPath(slug), `# ${input.name}\n\n_No runs yet._\n`, "utf-8");
  return slug;
}

export function fetchTask(slug: string): BackgroundTask | null {
  try {
    return YAML.parse(fs.readFileSync(yamlPath(slug), "utf-8")) as BackgroundTask;
  } catch {
    return null;
  }
}

export function patchTask(slug: string, patch: Partial<BackgroundTask>): void {
  const task = fetchTask(slug);
  if (!task) return;
  const merged: Record<string, unknown> = { ...task, ...patch };
  // Explicit undefined in a patch clears the key.
  for (const k of Object.keys(merged)) {
    if (merged[k] === undefined) delete merged[k];
  }
  fs.writeFileSync(yamlPath(slug), YAML.stringify(merged), "utf-8");
}

export function deleteTask(slug: string): void {
  if (!SLUG_RE.test(slug)) return;
  fs.rmSync(taskDir(slug), { recursive: true, force: true });
}

export function listTasks(): BackgroundTaskSummary[] {
  const root = bgTasksRoot();
  const out: BackgroundTaskSummary[] = [];
  for (const entry of fs.readdirSync(root)) {
    const task = fetchTask(entry);
    if (task) out.push({ slug: entry, ...task });
  }
  return out.sort((a, b) => (b.lastRunAt ?? b.createdAt).localeCompare(a.lastRunAt ?? a.createdAt));
}

export function prependRunId(slug: string, runId: string): void {
  const p = path.join(taskDir(slug), "runs.log");
  const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
  fs.writeFileSync(p, `${runId}\n${existing}`, "utf-8");
}

export function readRunIds(slug: string, limit = 20): string[] {
  const p = path.join(taskDir(slug), "runs.log");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8").split("\n").filter(Boolean).slice(0, limit);
}

export function readIndexMd(slug: string): string {
  try {
    return fs.readFileSync(indexPath(slug), "utf-8");
  } catch {
    return "";
  }
}
