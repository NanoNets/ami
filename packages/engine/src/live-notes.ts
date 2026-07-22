import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { appendStep, insertRun, updateRun, type Db } from "@ami/db";
import {
  buildOwnerBlock,
  commitKnowledge,
  invalidateKnowledgeIndex,
  knowledgeDir,
  runKnowledgeAgent,
  safeSegment,
} from "@ami/memory";
import { WRITING_STYLE, type AmiEvent, type TimedTriggers } from "@ami/shared";
import { amiMcpServer } from "./mcp-server.js";
import { persistMessage } from "./runner.js";
import {
  createUnattendedGuard,
  extractRunSummary,
  MAX_CONSECUTIVE_FAILURES,
  notifyAgentPaused,
  releaseUnattendedSlot,
  tryAcquireUnattendedSlot,
} from "./unattended.js";
import { buildTriggerBlock, type TriggerType } from "./bg-tasks/trigger-block.js";

type Publish = (e: AmiEvent) => void;

/** Live notes: knowledge notes with a
 * `live:` frontmatter block. The user owns the objective + triggers, the
 * runtime owns the run-state fields, and the agent owns the body. They show up
 * in the Brain graph like any other note.
 *
 * The agent runs on a read-only research tier: file tools, WebSearch/WebFetch,
 * and the readOnly connector actions — it can observe everything and change
 * nothing but its own note body. Every run gets a task_runs row
 * (todoId `bg:live:<file>`) with streamed steps, like background tasks. */

export interface LiveNoteConfig {
  objective: string;
  active?: boolean;
  triggers?: TimedTriggers;
  lastAttemptAt?: string;
  lastRunAt?: string;
  lastRunId?: string;
  lastRunSummary?: string;
  lastRunError?: string;
  /** Consecutive failures; the runner pauses the note when it hits the cap. */
  failCount?: number;
}

export interface LiveNote {
  /** knowledge-relative path, e.g. "Live Notes/Competitor watch.md" */
  file: string;
  title: string;
  live: LiveNoteConfig;
  body: string;
}

function liveNotesDir(): string {
  const dir = path.join(knowledgeDir(), "Live Notes");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve a knowledge-relative note path, refusing anything that escapes the
 * knowledge dir ("Live Notes/../../…" arrives as an API param). */
function notePath(file: string): string | null {
  const root = path.resolve(knowledgeDir());
  const abs = path.resolve(root, file);
  return abs.startsWith(root + path.sep) ? abs : null;
}

function splitFrontmatter(content: string): { fm: string | null; body: string } {
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end !== -1) return { fm: content.slice(4, end), body: content.slice(end + 4).replace(/^\n/, "") };
  }
  return { fm: null, body: content };
}

function parseNote(abs: string): LiveNote | null {
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
  const { fm, body } = splitFrontmatter(content);
  if (fm === null) return null;
  let parsed: any;
  try {
    parsed = YAML.parse(fm);
  } catch {
    return null;
  }
  if (!parsed?.live?.objective) return null;
  const title = body.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(abs, ".md");
  return {
    file: path.relative(knowledgeDir(), abs),
    title,
    live: parsed.live as LiveNoteConfig,
    body,
  };
}

function writeNote(abs: string, live: LiveNoteConfig, body: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const fm: Record<string, unknown> = { live: { ...live } };
  for (const k of Object.keys((fm.live as any) ?? {})) {
    if ((fm.live as any)[k] === undefined) delete (fm.live as any)[k];
  }
  fs.writeFileSync(abs, `---\n${YAML.stringify(fm).trimEnd()}\n---\n\n${body.replace(/^\n+/, "")}`, "utf-8");
}

export function listLiveNotes(): LiveNote[] {
  const dir = liveNotesDir();
  const out: LiveNote[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const note = parseNote(path.join(dir, entry));
    if (note) out.push(note);
  }
  return out;
}

export function getLiveNote(file: string): LiveNote | null {
  const abs = notePath(file);
  return abs ? parseNote(abs) : null;
}

/** Patch the runtime-owned frontmatter fields, preserving the body verbatim. */
function patchLive(file: string, patch: Partial<LiveNoteConfig>): void {
  const abs = notePath(file);
  if (!abs) return;
  const note = parseNote(abs);
  if (!note) return;
  writeNote(abs, { ...note.live, ...patch }, note.body);
}

export function createLiveNote(args: {
  title: string;
  objective: string;
  triggers?: TimedTriggers;
}): string {
  const file = path.join("Live Notes", `${safeSegment(args.title)}.md`);
  const abs = path.join(knowledgeDir(), file);
  writeNote(abs, { objective: args.objective, active: true, triggers: args.triggers }, `# ${args.title}\n\n_Nothing yet — the agent fills this in._\n`);
  invalidateKnowledgeIndex();
  return file;
}

export function updateLiveNote(
  file: string,
  patch: { objective?: string; active?: boolean; triggers?: TimedTriggers },
): void {
  patchLive(file, patch);
}

export function deleteLiveNote(file: string): void {
  const abs = notePath(file);
  if (!abs || !file.startsWith("Live Notes/")) return;
  fs.rmSync(abs, { force: true });
  invalidateKnowledgeIndex();
}

const LIVE_NOTE_SYSTEM = `You are Ami's live-note agent. A live note is a markdown document whose body you keep in line with a user-authored objective. You run in the background — no clarifying questions, no hedging, no chat prose.

Research tools: WebSearch/WebFetch for the open web, the read-only mcp__ami__* connector tools (search Slack, Gmail, calendar, Drive, Notion, GitHub… whatever is connected), mcp__ami__memory_search + memory_read_note for the knowledge base. You observe; you never send, post, create, or change anything anywhere — your only write is this note's body.

Rules:
- The note path is given in the message. Start by Reading it.
- **Never modify the YAML frontmatter** (everything between the --- markers) — the user and the runtime own it. You own only the body below it.
- Prefer patch-style Edits (small targeted changes) over wholesale rewrites.
- Keep the H1 title untouched. Directly under it, maintain a rolling 1-3 sentence summary of the current state. Below that, H2 sub-topics, freshest first, deduplicated.
- Optimize for information density and scannability. Absolute dates, not relative words.
- If the trigger is an event that turns out to be irrelevant, or there is genuinely nothing to change, make NO edit.
- End with ONE short factual sentence describing what you changed and the substance (e.g. "Updated — pricing page A/B result added, variant B +12%."), or "No update — <reason>."

${WRITING_STYLE}`;

const EVENT_DECISION =
  "**Decision:** Determine whether this event genuinely warrants updating the note per the objective. If not meaningfully relevant on closer inspection, make no edit and say so.";

const runningNotes = new Set<string>();

export async function runLiveNoteAgent(
  db: Db,
  publish: Publish,
  file: string,
  trigger: TriggerType,
  context?: string,
): Promise<{ ok: boolean; runId?: string; summary?: string; error?: string }> {
  if (runningNotes.has(file)) return { ok: false, error: "already running" };
  const abs = notePath(file);
  const note = abs ? parseNote(abs) : null;
  if (!abs || !note) return { ok: false, error: "not a live note" };
  if (note.live.active === false && trigger !== "manual") return { ok: false, error: "paused" };
  // Scheduled/event runs skip without bumping lastAttemptAt when the global
  // cap is hit — the next tick simply retries. Manual runs always go through.
  if (!tryAcquireUnattendedSlot({ force: trigger === "manual" })) {
    return { ok: false, error: "unattended concurrency cap reached" };
  }
  runningNotes.add(file);
  try {
    // The agent owns only the body; everything in `live:` is restored after
    // the run regardless of what the agent did to the file.
    const liveSnapshot: LiveNoteConfig = { ...note.live };
    const todoId = `bg:live:${file}`;

    let message = `Update the live note at \`knowledge/${file}\`.\n\n`;
    message += `**Time:** ${new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "long" })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})\n\n`;
    message += buildOwnerBlock(db);
    message += `\n**Objective:**\n${note.live.objective}\n`;
    message += buildTriggerBlock({
      trigger,
      triggers: note.live.triggers,
      context: trigger === "event" ? undefined : context,
      eventPayload: trigger === "event" ? context : undefined,
      targetNoun: "live note",
      decisionDirective: EVENT_DECISION,
    });

    const runId = insertRun(db, { todoId, mode: "auto", prompt: message, policy: "full-auto" });
    const attemptAt = new Date().toISOString();
    patchLive(file, { lastAttemptAt: attemptAt, lastRunId: runId });
    liveSnapshot.lastAttemptAt = attemptAt;
    liveSnapshot.lastRunId = runId;
    updateRun(db, runId, { status: "running", startedAt: new Date().toISOString() });
    publish({ type: "bgtask.updated", slug: `live:${file}` });

    const step = (kind: string, label: string, detail?: unknown) => {
      const stepId = appendStep(db, runId, kind, label, detail);
      publish({ type: "step.appended", runId, todoId, stepId });
    };

    const res = await runKnowledgeAgent(db, {
      systemPrompt: LIVE_NOTE_SYSTEM,
      message,
      useCase: "live_note",
      subUseCase: trigger,
      maxTurns: 50,
      timeoutMs: 20 * 60 * 1000,
      tools: ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"],
      mcpServers: {
        ami: amiMcpServer({
          db,
          publish,
          todoId,
          runId,
          defaultChannel: null,
          defaultTargetRef: null,
          allowAskUser: false,
          readOnly: true,
        }),
      },
      canUseTool: createUnattendedGuard({ writableRoots: [abs] }),
      runId,
      onMessage: (msg) => persistMessage(step, db, runId, msg),
    });

    // Restore the runtime-owned frontmatter over whatever the agent left,
    // keeping its body edits.
    try {
      const { body } = splitFrontmatter(fs.readFileSync(abs, "utf-8"));
      writeNote(abs, liveSnapshot, body);
    } catch {
      // note deleted mid-run — nothing to restore
    }

    const doneAt = new Date().toISOString();
    if (res.ok) {
      const summary = extractRunSummary(res.resultText) ?? undefined;
      patchLive(file, { lastRunAt: doneAt, lastRunSummary: summary, lastRunError: undefined, failCount: undefined });
      updateRun(db, runId, { status: "succeeded", finishedAt: doneAt });
      invalidateKnowledgeIndex();
      await commitKnowledge("Live note update").catch(() => {});
      publish({ type: "bgtask.updated", slug: `live:${file}` });
      return { ok: true, runId, summary };
    }
    const failCount = (liveSnapshot.failCount ?? 0) + 1;
    const pause = failCount >= MAX_CONSECUTIVE_FAILURES;
    patchLive(file, { lastRunError: res.error ?? "failed", failCount, ...(pause ? { active: false } : {}) });
    updateRun(db, runId, { status: "failed", error: res.error ?? "failed", finishedAt: doneAt });
    if (pause) {
      notifyAgentPaused(db, publish, { kind: "live note", name: note.title, lastError: res.error ?? "failed" });
    }
    publish({ type: "bgtask.updated", slug: `live:${file}` });
    return { ok: false, runId, error: res.error };
  } finally {
    runningNotes.delete(file);
    releaseUnattendedSlot();
  }
}
