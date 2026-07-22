import fs from "node:fs";
import path from "node:path";
import { desc, eq, inArray } from "drizzle-orm";
import { chatSessions, chatTurns, decisionTraces, feedback, type Db } from "@ami/db";
import { loadState, saveState } from "./graph-state.js";
import { agentNotesDir, inboxPath } from "./paths.js";
import { agentNotesPrompt } from "./prompts/agent-notes.js";
import { buildOwnerBlock } from "./owner.js";
import { runKnowledgeAgent } from "./agent-runner.js";
import { writeSourceDoc } from "./source-writer.js";

/** The Agent Notes service: mines the
 * save-to-memory inbox, the user's sent messages, and the user's task
 * feedback / draft edits into knowledge/Agent Notes/. Two paths: moments that
 * produce new information — a task resolved, a chat left — trigger a run
 * immediately via requestAgentNotesRun (deduplicated sources make it a
 * no-LLM no-op when nothing is new); the scheduler's ~nightly cycle remains
 * as the catch-all and carries the sent-message style mining, which has no
 * dedup and would be pure cost to re-run more often. */

const AGENT_NOTES_STALE_MS = 20 * 60 * 60 * 1000;
const STYLE_MINING_STALE_MS = 20 * 60 * 60 * 1000;
const FEEDBACK_BATCH = 10;
const CORRECTIONS_BATCH = 10;

function readInbox(): string[] {
  try {
    const content = fs.readFileSync(inboxPath(), "utf-8").trim();
    return content ? content.split("\n").filter((l) => l.trim()) : [];
  } catch {
    return [];
  }
}

function clearInbox(): void {
  try {
    if (fs.existsSync(inboxPath())) fs.writeFileSync(inboxPath(), "");
  } catch {
    // best effort
  }
}

export function agentNotesDue(): boolean {
  const state = loadState();
  const last = state.lastAgentNotesTime ? new Date(state.lastAgentNotesTime).getTime() : 0;
  return Date.now() - last > AGENT_NOTES_STALE_MS;
}

/** Sent-message mining has no dedup (same messages would be re-mined each
 * run), so it rides along only on the nightly cycle. */
export function styleMiningDue(): boolean {
  const state = loadState();
  const last = state.lastStyleMiningTime ? new Date(state.lastStyleMiningTime).getTime() : 0;
  return Date.now() - last > STYLE_MINING_STALE_MS;
}

export async function runAgentNotes(
  db: Db,
  sentMessages: { channel: string; texts: string[] }[],
): Promise<{ ran: boolean }> {
  const state = loadState();
  const processed = state.processedAgentNoteSources ?? {};

  const messageParts: string[] = [];

  // 1. The user's sent messages (style evidence).
  for (const { channel, texts } of sentMessages) {
    if (texts.length === 0) continue;
    messageParts.push(
      `## ${channel} messages sent by the user\n\n${texts
        .slice(0, 20)
        .map((t) => `---\n${t.slice(0, 1200)}\n---`)
        .join("\n\n")}`,
    );
  }

  // 2. Save-to-memory inbox entries.
  const inboxEntries = readInbox();
  if (inboxEntries.length > 0) {
    messageParts.push(`## Notes from the assistant (save-to-memory inbox)\n\n${inboxEntries.join("\n")}`);
  }

  // 3. Task feedback the user gave (context prompts, plan feedback).
  const fbRows = db.select().from(feedback).orderBy(desc(feedback.createdAt)).limit(50).all();
  const newFb = fbRows.filter((f) => !processed[`fb:${f.id}`]).slice(0, FEEDBACK_BATCH);
  if (newFb.length > 0) {
    messageParts.push(
      `## Instructions the user gave when starting/reviewing tasks\n\n${newFb
        .map((f) => `- (${f.scope}) ${f.text.slice(0, 500)}`)
        .join("\n")}`,
    );
  }

  // 4. Draft edits (Ami's wording → the user's rewrite).
  const editRows = db
    .select()
    .from(decisionTraces)
    .where(eq(decisionTraces.kind, "draft_edit"))
    .orderBy(desc(decisionTraces.createdAt))
    .limit(30)
    .all();
  const newEdits = editRows.filter((t) => !processed[`edit:${t.id}`]).slice(0, CORRECTIONS_BATCH);
  if (newEdits.length > 0) {
    messageParts.push(
      `## Draft replies the user edited before sending (assistant draft → user's version)\n\n${newEdits
        .map((t) => `- ${t.situation.slice(0, 300)} → ${t.decision.slice(0, 300)}`)
        .join("\n")}`,
    );
  }

  // 5. Recent copilot chat conversations (lasting facts about the user).
  const recentSessions = db
    .select()
    .from(chatSessions)
    .orderBy(desc(chatSessions.updatedAt))
    .limit(10)
    .all()
    .filter((s) => !processed[`chat:${s.id}:${s.updatedAt}`])
    .slice(0, 5);
  if (recentSessions.length > 0) {
    const turns = db
      .select()
      .from(chatTurns)
      .where(inArray(chatTurns.sessionId, recentSessions.map((s) => s.id)))
      .all();
    let convoText = "";
    for (const s of recentSessions) {
      const sTurns = turns.filter((t) => t.sessionId === s.id).sort((a, b) => a.seq - b.seq);
      if (sTurns.length === 0) continue;
      let sessionText = "";
      for (const t of sTurns.slice(-20)) {
        const c = JSON.parse(t.contentJson);
        const text =
          t.role === "user"
            ? c.text
            : (c.blocks ?? [])
                .filter((b: any) => b.kind === "text" && b.text)
                .map((b: any) => b.text)
                .join("\n");
        if (text) sessionText += `${t.role}: ${String(text).slice(0, 800)}\n\n`;
      }
      if (!sessionText.trim()) continue;
      convoText += `\n--- Conversation: ${s.title ?? "untitled"} ---\n${sessionText}`;
      // Chats discuss the user's projects, people and decisions — feed each
      // mined session to the entity-graph builder too, not just Agent Notes.
      // Same file per session: an updated conversation overwrites, the mtime
      // change re-queues it for processing.
      writeSourceDoc(
        "ami-chats",
        s.id,
        `Chat with the assistant: ${s.title ?? "untitled"}`,
        `_A conversation between the user and their assistant (${(s.updatedAt ?? "").slice(0, 10)}). The "user" lines are the owner speaking; extract entities and facts from what was DISCUSSED — the assistant's own suggestions are not facts unless the user confirmed them._\n\n${sessionText}`,
      );
    }
    if (convoText.trim()) {
      messageParts.push(`## Recent copilot conversations\n${convoText}`);
    }
  }

  if (messageParts.length === 0) {
    state.lastAgentNotesTime = new Date().toISOString();
    saveState(state);
    return { ran: false };
  }

  const message = `${buildOwnerBlock(db)}\n---\n\nCurrent timestamp: ${new Date().toISOString()}\n\nProcess the following source material and update the Agent Notes folder accordingly.\n\n${messageParts.join("\n\n")}`;

  const res = await runKnowledgeAgent(db, {
    systemPrompt: agentNotesPrompt(),
    message,
    useCase: "agent_notes",
    maxTurns: 30,
  });

  if (res.ok) {
    const { commitKnowledge } = await import("./version-history.js");
    await commitKnowledge("Agent notes").catch(() => {});
    if (inboxEntries.length > 0) clearInbox();
    const fresh = loadState();
    fresh.processedAgentNoteSources = {
      ...(fresh.processedAgentNoteSources ?? {}),
      ...Object.fromEntries(newFb.map((f) => [`fb:${f.id}`, f.createdAt])),
      ...Object.fromEntries(newEdits.map((t) => [`edit:${t.id}`, t.createdAt])),
      ...Object.fromEntries(recentSessions.map((s) => [`chat:${s.id}:${s.updatedAt}`, s.updatedAt])),
    };
    fresh.lastAgentNotesTime = new Date().toISOString();
    if (sentMessages.some((s) => s.texts.length > 0)) {
      fresh.lastStyleMiningTime = fresh.lastAgentNotesTime;
    }
    saveState(fresh);
  }
  return { ran: res.ok };
}

/** The user's learned preferences (Agent Notes/preferences.md) — explicit
 * rules the agent-notes agent has accumulated ("keep replies short", "no
 * meetings before 11am"). Injected into chat/task/draft prompts. */
export function getPreferences(maxChars = 4000): string | null {
  try {
    const text = fs.readFileSync(path.join(agentNotesDir(), "preferences.md"), "utf-8").trim();
    return text ? text.slice(0, maxChars) : null;
  } catch {
    return null;
  }
}

/** Append a save-to-memory line for the agent-notes agent to route later. */
export function appendToInbox(line: string): void {
  fs.appendFileSync(inboxPath(), `- [${new Date().toISOString()}] ${line.replace(/\n+/g, " ").trim()}\n`);
}

let notesRunInFlight = false;
let notesRunAgain = false;

/** Fire-and-forget trigger for moments that produce new information (a task
 * resolved, a chat navigated away from): routes inbox/feedback/chat sources
 * into the knowledge base now instead of waiting for the nightly cycle.
 * Serialized — concurrent requests coalesce into one follow-up run. Style
 * mining (sentMessages) never rides on this path. */
export function requestAgentNotesRun(db: Db, reason: string): void {
  if (process.env.AMI_FAKE_LLM === "1") return;
  if (notesRunInFlight) {
    notesRunAgain = true;
    return;
  }
  notesRunInFlight = true;
  void (async () => {
    try {
      do {
        notesRunAgain = false;
        const out = await runAgentNotes(db, []);
        if (out.ran) console.log(`[agent-notes] ran (${reason})`);
      } while (notesRunAgain);
    } catch (e) {
      console.error(`[agent-notes] trigger (${reason}) failed:`, e);
    } finally {
      notesRunInFlight = false;
    }
  })();
}
