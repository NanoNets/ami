import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  amiHome,
  codeProjects,
  connectorAccounts,
  getSetting,
  getSignal,
  getTodo,
  insertLlmUsage,
  insertTrace,
  updateTodo,
  type Db,
} from "@ami/db";
import { getConnector } from "@ami/connectors";
import { anthropicClient, kgModel } from "@ami/memory";
import { newId, nowIso, type AmiEvent, type AuthBlob } from "@ami/shared";
import { managedReposDir } from "./managed-repos.js";

type Publish = (e: AmiEvent) => void;

/** Auto-attach code projects: shortly after a task todo is created, work out
 * which of the user's local repos its change belongs to and attach it — so a
 * coding task starts as a coding run (worktree, real commits, PRs) without the
 * user picking a project by hand. Two passes: a free textual match on repo
 * slugs/names, then an LLM that locates the code with GitHub search the same
 * way a task agent would. An explicit user choice always wins — this never
 * overwrites an attached project. */

interface Candidate {
  id: string;
  name: string;
  path: string;
  slug: string | null;
}

const stateFile = () => path.join(amiHome(), "config", "project_resolve.json");

function loadAttempts(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf-8"));
  } catch {
    return {};
  }
}

function saveAttempts(a: Record<string, string>): void {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  // Entries older than a week are dead todos — stop carrying them.
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const kept = Object.fromEntries(Object.entries(a).filter(([, at]) => new Date(at).getTime() > cutoff));
  fs.writeFileSync(stateFile(), JSON.stringify(kept, null, 1));
}

async function candidates(db: Db): Promise<Candidate[]> {
  const { originSlug } = await import("./worktree.js");
  const rows = db.select().from(codeProjects).all();
  return Promise.all(
    rows.map(async (p) => ({ id: p.id, name: p.name, path: p.path, slug: await originSlug(p.path) })),
  );
}

function textualMatch(text: string, cands: Candidate[]): Candidate | null {
  const hay = text.toLowerCase();
  const bySlug = cands.filter((c) => c.slug && hay.includes(c.slug.toLowerCase()));
  if (bySlug.length === 1) return bySlug[0];
  // Repo name as a standalone word; short generic names ("web", "api") skip.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const byName = cands.filter(
    (c) => c.name.length >= 4 && new RegExp(`(^|[^a-z0-9])${esc(c.name.toLowerCase())}([^a-z0-9]|$)`).test(hay),
  );
  return byName.length === 1 ? byName[0] : null;
}

const RESOLVE_SYSTEM = `You determine which GitHub repository owns the code a task would change. You have the user's authenticated code search.

Rules:
- Search for distinctive strings the task implies: visible copy, component/class names, config keys. 1-3 searches usually settle it.
- The task must involve changing or reading code in a repo. Reports, replies, scheduling, purely operational work → repo is null.
- Only name a repo you actually confirmed via search results — a plausible name is not evidence.
- When done, reply with ONLY this JSON, nothing else: {"repo": "owner/name"} or {"repo": null}`;

/** LLM pass: locate the repo via GitHub code search. Returns the local clone
 * candidate when one matches by origin slug, else the confirmed repo slug so
 * the caller can set up a managed clone. Never guesses. */
async function searchMatch(
  db: Db,
  text: string,
  cands: Candidate[],
): Promise<{ match: Candidate | null; repo: string | null }> {
  const none = { match: null, repo: null };
  const client = anthropicClient(db);
  if (!client || process.env.AMI_FAKE_LLM === "1") return none;
  const gh = getConnector("github")?.actions.find((a) => a.name === "github_search_code");
  const acct = db.select().from(connectorAccounts).where(eq(connectorAccounts.connector, "github")).get();
  if (!gh || !acct) return none;
  const auth: AuthBlob = JSON.parse(acct.authJson);

  const model = kgModel(db);
  const tools: Anthropic.Tool[] = [
    {
      name: gh.name,
      description: gh.description,
      input_schema: z.toJSONSchema(z.object(gh.schema)) as Anthropic.Tool.InputSchema,
    },
  ];
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Task:\n${text.slice(0, 2500)}\n\nThe user's local repos (attachable): ${
        cands.map((c) => c.slug ?? c.name).join(", ") || "none"
      }`,
    },
  ];

  for (let round = 0; round < 5; round++) {
    const res = await client.messages.create({
      model,
      max_tokens: 700,
      system: RESOLVE_SYSTEM,
      tools,
      messages,
    });
    insertLlmUsage(db, {
      useCase: "project_resolve",
      model,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    });
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (res.stop_reason === "tool_use" && uses.length > 0) {
      messages.push({ role: "assistant", content: res.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        const out = await gh.run(auth, u.input as Record<string, unknown>).catch((e) => ({
          ok: false,
          output: null,
          error: String(e?.message ?? e),
        }));
        results.push({
          type: "tool_result",
          tool_use_id: u.id,
          content: JSON.stringify(out).slice(0, 8000),
        });
      }
      messages.push({ role: "user", content: results });
      continue;
    }
    const textOut = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
    const json = textOut.match(/\{[^{}]*\}/)?.[0];
    if (!json) return none;
    try {
      const repo = (JSON.parse(json) as { repo?: string | null }).repo;
      if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return none;
      return {
        match: cands.find((c) => c.slug?.toLowerCase() === repo.toLowerCase()) ?? null,
        repo,
      };
    } catch {
      return none;
    }
  }
  return none;
}

async function resolveOne(db: Db, publish: Publish, todoId: string): Promise<void> {
  const todo = getTodo(db, todoId);
  if (!todo || todo.projectId || todo.type !== "task") return;
  const cands = await candidates(db);

  const signal = todo.signalId ? getSignal(db, todo.signalId) : undefined;
  const text = `${todo.title}\n${todo.summary}\n${signal?.body?.slice(0, 1500) ?? ""}`;

  let match = textualMatch(text, cands);
  let willClone = false;
  if (!match) {
    const found = await searchMatch(db, text, cands);
    match = found.match;
    if (!match && found.repo) {
      // Repo confirmed but no clone anywhere: register a managed project —
      // the run clones it under ~/.ami/repos on first use.
      const [owner, name] = found.repo.split("/");
      const projectPath = path.join(managedReposDir(), owner, name);
      const existing = db.select().from(codeProjects).where(eq(codeProjects.path, projectPath)).get();
      const id = existing?.id ?? newId("proj");
      if (!existing) {
        db.insert(codeProjects)
          .values({ id, name, path: projectPath, defaultBranch: "main", createdAt: nowIso() })
          .run();
      }
      match = { id, name, path: projectPath, slug: found.repo };
      willClone = !fs.existsSync(projectPath);
    }
  }
  if (!match) return;
  // Re-read: the user may have attached one while we searched — theirs wins.
  if (getTodo(db, todoId)?.projectId) return;
  updateTodo(db, todoId, { projectId: match.id });
  insertTrace(db, {
    todoId,
    kind: "execution_choice",
    situation: `Which repo does "${todo.title}" belong to?`,
    decision: `auto-attached code project ${match.name}${match.slug ? ` (${match.slug})` : ""}${willClone ? " — no local clone, Ami clones it at run start" : ""}`,
    rationale: "matched from the task text / GitHub code search; a run with a project works in a real worktree and can push",
  });
  publish({ type: "todo.updated", todoId });
  console.log(`[projects] auto-attached ${match.name} to ${todoId}${willClone ? " (will clone)" : ""}`);
}

/** Route-level: called when the user clicks Plan/Start on an unattached task,
 * so the click never races the background sweep. Bounded, one attempt per
 * todo (shared marker with the sweep). */
export async function ensureProjectResolved(
  db: Db,
  publish: Publish,
  todoId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const todo = getTodo(db, todoId);
  if (!todo || todo.projectId || todo.type !== "task") return;
  const attempts = loadAttempts();
  if (attempts[todoId]) return;
  attempts[todoId] = new Date().toISOString();
  saveAttempts(attempts);
  await Promise.race([
    resolveOne(db, publish, todoId).catch((e) => console.error(`[projects] resolve ${todoId}:`, e)),
    new Promise<void>((r) => setTimeout(r, timeoutMs)),
  ]);
}

let resolving = false;

/** Scheduler tick: resolve projects for recent unattached task todos, a few
 * per pass, each todo tried once. */
export async function projectResolveTick(db: Db, publish: Publish): Promise<void> {
  if (resolving) return;
  resolving = true;
  try {
    // Worth running when there's anything to attach to — local projects, or
    // GitHub connected (an unmatched repo becomes a managed clone).
    const hasProjects = db.select().from(codeProjects).limit(1).all().length > 0;
    const hasGithub = !!db
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.connector, "github"))
      .get();
    if (!hasProjects && !hasGithub) return;
    const attempts = loadAttempts();
    const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const { todos } = await import("@ami/db");
    const rows = db.select().from(todos).all();
    const pending = rows.filter(
      (t) =>
        t.type === "task" &&
        !t.projectId &&
        ["open", "planned"].includes(t.status) &&
        t.createdAt > cutoff &&
        !attempts[t.id],
    );
    let dirty = false;
    for (const t of pending.slice(0, 3)) {
      attempts[t.id] = new Date().toISOString();
      dirty = true;
      await resolveOne(db, publish, t.id).catch((e) => console.error(`[projects] resolve ${t.id}:`, e));
    }
    if (dirty) saveAttempts(attempts);
  } finally {
    resolving = false;
  }
}
