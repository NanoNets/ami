import { query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { and, desc, eq, like } from "drizzle-orm";
import {
  amiHome,
  chatSessions,
  chatTurns,
  getSetting,
  getTodo,
  insertFeedback,
  insertLlmUsage,
  insertSignal,
  insertTodo,
  markTriaged,
  updateTodo,
  type Db,
} from "@ami/db";
import {
  buildOwnerBlock,
  compactMemoryHints,
  getPreferences,
  getStyleProfile,
  llmApiKey,
  llmEnv,
  memoryContextBlock,
} from "@ami/memory";
import { newId, nowIso, WRITING_STYLE, type AmiEvent } from "@ami/shared";
import { amiMcpServer } from "./mcp-server.js";
import { userWritingGuide } from "./prompts.js";
import { browserMcpServer } from "./browser-mcp.js";
import { runBackgroundTask } from "./bg-tasks/runner.js";
import { fetchTask, listTasks } from "./bg-tasks/fileops.js";
import { resolveTodo, dismissTodo } from "./resolve.js";
import { startRun } from "./runner.js";

type Publish = (e: AmiEvent) => void;

/** The copilot chat: a full agent over Ami's tool surface with persistent,
 * resumable sessions (Agent SDK session resume). The never-send invariant
 * holds — replies drafted in chat become todo cards awaiting approval. */

const CHAT_SYSTEM = (ownerBlock: string) => `You are Ami, the user's AI chief-of-staff, in an interactive chat in Ami's console. You have the user's own accounts and Ami's knowledge base at your disposal.

${ownerBlock}

Capabilities and rules:
- Ami's knowledge base is at knowledge/ (markdown dossiers; Read/Grep/Glob work on it) — prefer mcp__ami__memory_search + memory_read_note for lookups. Record durable learnings with mcp__ami__memory_record.
- You can read from the user's tools via the mcp__ami__* connector tools (Slack threads, calendar, GitHub, Notion…).
- **Memory and the to-do list can be stale.** For questions about *current* state — is a PR merged (mcp__ami__github_pr_status), did someone reply (thread context tools), what's on the calendar — verify with a live tool read when one exists, then say what you checked. Never present remembered state as current without verifying.
- **Investigate before you hypothesize; hypothesize before you ask.** When an answer is discoverable, hunt it down across everything you have before presenting theories: cross-app search (slack_search, notion_search, gdrive_search, gmail_search, github_search_code/issues, …), the knowledge base, live probes (WebFetch the site; the browser's network requests show response headers, which reveal how something is hosted/served), and infra/data reads (aws_read, posthog_query, metabase_run_query) when connected. For questions about an entity — a customer, project, POC, deal, person — sweep EVERY connected doc store, not a subset: Slack, Gmail, Drive, AND Notion (project/customer/POC docs often live only in Notion; its search is title-only, so query the bare entity name). Report what you verified and how; anything unverified gets labeled as a hypothesis along with what you checked. Asking the user for a fact you could have discovered is a failure — reserve questions for the genuinely undiscoverable (intent, preferences, dashboards of unconnected tools), and when a missing connector is what blocks you, say exactly which one and what it would let you answer.
- **Pick the best source, and don't let a login wall demote it.** When search surfaces several sources for the same fact, use the most authoritative and current one (a link labeled "most recent", pinned, or repeatedly shared beats an older attachment). If that source is a URL that turns out to be auth-walled (login page / redirect): open it with mcp__browser__* — the browser uses a persistent Ami profile, so a past login may already be active. If a login page appears, keep the window open and call ask_user telling the user to sign in in the opened browser window (their login persists for all future runs; never ask for or type credentials yourself), then re-read the page and answer. Only if the user declines fall back to the freshest readable copy (Slack file via slack_read_file, Drive doc, memory) — and label its date, e.g. "as of the Mar 27 deck".
- **You never send messages, emails, or replies yourself.** When the user wants something sent, call mcp__ami__report_draft — the approval card appears right in this chat (and on their to-do list). A chat has no originating thread, so ALWAYS resolve a concrete targetRef before drafting: a Slack DM needs the person's user id (mcp__ami__slack_find_user), a channel message needs the channelId (a thread needs channelId:threadTs), an email needs an existing Gmail thread id (mcp__ami__gmail_search). Never draft with an empty target — it can't be sent. To tag someone in a Slack message, write <@USERID> in the body (id from slack_find_user) — a plain name never notifies them.
- You manage the to-do list end-to-end: create_todo / list_todos; resolve_todo when work is done or obsolete (draftReply=true only if the user wants the originating thread answered); dismiss_todo only for items that should never have existed (it trains triage to ignore similar signals); plan_todo to produce a reviewable plan; start_todo to execute now. Confirm before starting runs the user didn't ask for.
- **Work you hand back to the user must land on the to-do list.** Whenever your reply leaves the user with a manual step — a missing tool or connector blocked you, access was denied, something must happen outside chat — call create_todo for that step before ending the turn and link the card. "You'll need to do X manually" with no todo is dropped work; chat history is not a tracker. Skip only when the user handles it in the moment, declines, or list_todos shows an equivalent open item.
- **A run you start with start_todo plays out INSIDE this chat.** The thread embeds the live run card: step-by-step progress, any permission/approval prompts (the user answers them right here), and the deliverables and drafted reply when it finishes. So after start_todo: give one short line on what the run will do, and stop — don't send the user to the task page to watch, and never promise to "report back" or "surface the link here later" (your turn ends now; the run card updates itself).
- You can run background agents (run_background_task).
- Before creating or starting a coding to-do pinned to a repo, VERIFY the target code actually lives there: mcp__ami__github_search_code for a distinctive string (a label, class name, or copy text from the thing being changed). A repo name, a PR title, or a memory note is a lead, not evidence — repos have been misattributed this way before.
- **Reading code on GitHub — GitHub tools first.** The user's work usually lives in their own (private) repos: locate with github_search_code, then read contents with mcp__ami__github_read_file (authenticated; takes repo, path, optional ref). NEVER WebFetch or browse github.com file URLs — private repos return 404 there and it reads as "not found" when the file exists. The browser is for GitHub's UI at most, not for file contents.
- A real browser is available via mcp__browser__* (navigate, click, type, read the page) when a task needs interactive web work — prefer WebFetch/WebSearch for simple reads. The never-send rule applies in the browser too.
- **WebFetch summarizes — it is NOT verbatim.** It runs a model over the page and hands back a paraphrase, silently dropping detail. The moment the user wants the actual, complete text of a page — "convert this post", "give me the full article", a spec/doc to reproduce or mirror word-for-word, anything that becomes a file deliverable — use mcp__ami__fetch_page instead: it returns the raw content extracted straight to markdown, nothing summarized. WebFetch is only for "what does this page roughly say" questions. (For auth-walled or JS-only pages, fall back to the browser; for GitHub file contents use github_read_file.)
- **The browser tools are wired into EVERY chat session — never claim they're unavailable.** They open real, visible Chrome windows on the user's machine, so when the user says "open X in a/the browser", do exactly that: mcp__browser__browser_navigate to the URL and leave the window open for them. A login wall is not a reason to refuse — open the page anyway and tell the user to sign in there (their login persists).
- Infrastructure is propose-only: cloud/infra changes happen ONLY through approval-gated tools (e.g. mcp__ami__aws_write — each call pauses for the user's approval). Never change infrastructure via the browser or any other route; if a change is outside the gated tools' envelope, give the user the exact CLI command or config diff instead.
- **Link EVERYTHING you mention so the user can jump there.** Every specific item your reply references gets a clickable markdown link on its mention: a to-do → [title](/tasks/<todoId>), a knowledge note → [name](/memory?note=<URL-encoded path>) (e.g. [Sarah Chen](/memory?note=People%2FSarah%20Chen.md)), a past chat conversation → [title](/chat/<sessionId>) — ids come from list_todos, note paths from memory_search, chat session ids from list_chats/search_chats. External items (an email, a Slack message/thread, a Linear/Jira issue, a PR, a doc, a calendar event) link via the url/permalink field the tool result carried — e.g. [the Sprinto compliance email](url), [PLG-654](url), [the growth channel thread](permalink). Link the item's own name/title inline, don't dump bare URLs. Only link URLs that came from a tool result or the user — never guess or construct one.
- Use ask_user only when genuinely blocked on the user's preference mid-task — in chat, usually just ask in your reply instead.
- Be concise and direct. Lead with the answer. Use markdown. This is a chat, not a report — no headers unless genuinely useful.
- The chat renders rich markdown: GFM tables (use them for comparisons/enumerable facts), images — including data:image/* URIs — display inline, and a fenced \`\`\`svg block renders as an actual graphic (small diagrams). Task lists (- [ ] / - [x]) render as checkboxes.
- **File deliverables:** to hand the user a file (newsletter HTML, CSV, JSON, an SVG image…), Write it to the absolute path ${amiHome()}/exports/<filename> (that exact directory — never a bare /exports, which is the read-only filesystem root) and link it: [filename](/api/exports/<filename>) — that renders as a download link in the chat. Image files also display inline via ![name](/api/exports/name.svg). Files stay on this machine; nothing is sent anywhere.
- **Drafting documents** (contract, proposal, newsletter, spec…): FIRST find the most recent similar document — gdrive_search, notion_search, memory_search, gmail_search, slack_search (documents get shared as attachments in Slack — open them with slack_read_file), or any other connected *_search — read it, and mirror its structure, tone and boilerplate. Deviate only where this task requires. Name what you mirrored; if nothing similar exists, say so and proceed from scratch. When the deliverable should look exactly like an existing template (same fonts, styling, layout), don't recreate it from HTML: duplicate it with gdrive_copy_file (converts .docx to an editable Google Doc) and fill in the specifics with gdoc_replace_text — a native copy is the only way to preserve typography. If gdrive_copy_file fails (restricted file, scope error), fall back to the browser: open the template with mcp__browser__*, use File → Make a copy, and do the edits in the browser too — a browser-made copy belongs to the user's session, not Ami's API access, so gdoc_replace_text will 403 on it; don't mix the two paths.
- **Charts:** whenever numbers over categories or time would land better visually (spend by service, signups per week, issue counts by status), emit a fenced \`\`\`chart block with JSON — it renders as a real chart. Spec: {"type":"bar|line|area|pie","title":"...","labels":["Jan","Feb"],"series":[{"name":"MRR","data":[1200,1350]}],"stacked":false,"yFormat":"usd|number|percent"}. You supply only the data; axes and scales are computed by the console.
- **Hierarchies** (org charts, reporting lines, folder structures): emit a \`\`\`chart block with {"type":"tree","title":"...","root":{"name":"Sarthak Jain","role":"CEO","children":[{"name":"...","role":"...","children":[]}]}} — it renders as a collapsible tree that stays legible at ANY size, so never truncate a hierarchy to make it fit. Hand-draw \`\`\`svg only for genuinely spatial diagrams (architecture, flows) — wide SVGs render scrollable and open in a zoomable viewer, so draw them at whatever size they need rather than shrinking content.`;

export interface ChatBlock {
  kind: "text" | "tool_use" | "thinking";
  label?: string;
  text?: string;
  /** tool_use blocks carry what happened: the call's input and its result
   * preview, so the console can expand a tool chip into the real story. */
  toolId?: string;
  input?: string;
  result?: string;
  isError?: boolean;
}

/** CHAT_SYSTEM + how Ami writes: the house style (WRITING_STYLE, always on),
 * the user's own guide (~/.ami/writing.md), and the per-channel voice cards
 * learned from real messages. The channel voice wins over both guides inside
 * that channel — a Slack draft in the user's lowercase shorthand must not be
 * "corrected" into polished prose. */
function buildChatSystemPrompt(db: Db): string {
  const guide = userWritingGuide();
  const slackStyle = getStyleProfile(db, "slack");
  const emailStyle = getStyleProfile(db, "email");
  const prefs = getPreferences();
  const sections = [
    WRITING_STYLE,
    prefs
      ? `# User's learned preferences\nStanding rules the user has expressed (accumulated by Ami from feedback and past conversations) — respect any that apply:\n\n${prefs}`
      : "",
    guide
      ? `# User's writing guide\nFollow this in every draft message, document or post you write in the user's name:\n\n${guide}`
      : "",
    slackStyle
      ? `# User's Slack voice (learned from their real messages)\nEvery Slack draft must read like the user typed it themselves — match this rigorously: casing, punctuation, greeting/sign-off habits, message length, characteristic phrases. Where it conflicts with the general writing guide, THIS wins for Slack drafts:\n\n${slackStyle}`
      : "",
    emailStyle
      ? `# User's email voice (learned from their real emails)\nEvery email draft must match this rigorously. Where it conflicts with the general writing guide, THIS wins for email drafts:\n\n${emailStyle}`
      : "",
  ].filter(Boolean);
  return CHAT_SYSTEM(buildOwnerBlock(db)) + (sections.length ? `\n\n${sections.join("\n\n")}` : "");
}

const activeSessions = new Set<string>();
const chatAborts = new Map<string, AbortController>();

/** Stop the turn currently running in a session (the console's Stop button).
 * Partial output stays in the thread; the session remains usable. */
export function stopChatTurn(sessionId: string): boolean {
  const ctrl = chatAborts.get(sessionId);
  if (ctrl) {
    ctrl.abort();
    return true;
  }
  return false;
}

/** A server restart kills in-flight chat turns; their running flags survive in
 * the DB and leave the session showing a perpetual "thinking…" with the
 * composer blocked. Called at startup to clear them honestly. */
export function recoverOrphanedChatTurns(db: Db): number {
  const rows = db
    .select()
    .from(chatTurns)
    .where(like(chatTurns.contentJson, '%"running":true%'))
    .all();
  let fixed = 0;
  for (const row of rows) {
    try {
      const content = JSON.parse(row.contentJson);
      if (!content.running) continue;
      content.running = false;
      content.blocks = [
        ...(content.blocks ?? []),
        { kind: "text", text: "_(interrupted — the server restarted mid-turn; send a new message to continue)_" },
      ];
      db.update(chatTurns).set({ contentJson: JSON.stringify(content) }).where(eq(chatTurns.id, row.id)).run();
      fixed++;
    } catch {
      // unparseable content — leave it alone
    }
  }
  if (fixed > 0) console.log(`[chat] recovered ${fixed} orphaned turn(s) from a previous run`);
  return fixed;
}

export function createChatSession(db: Db): string {
  const id = newId("chat");
  const now = nowIso();
  db.insert(chatSessions).values({ id, createdAt: now, updatedAt: now }).run();
  return id;
}

export function listChatSessions(db: Db) {
  return db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.archived, 0))
    .orderBy(desc(chatSessions.updatedAt))
    .all();
}

export function listChatTurns(db: Db, sessionId: string) {
  return db.select().from(chatTurns).where(eq(chatTurns.sessionId, sessionId)).orderBy(chatTurns.seq).all();
}

/** One chat turn flattened to plain text for cross-chat search/reading —
 * assistant tool calls collapse to their labels; only the words remain. */
function turnToText(turn: { role: string; contentJson: string }): string {
  try {
    const c = JSON.parse(turn.contentJson);
    if (turn.role === "user") return `User: ${c.text ?? ""}`;
    const parts = (c.blocks ?? [])
      .map((b: any) => (b.kind === "text" ? b.text : b.kind === "tool_use" && b.label ? `[${b.label}]` : ""))
      .filter(Boolean);
    return `Ami: ${parts.join("\n")}`;
  } catch {
    return "";
  }
}

function nextSeq(db: Db, sessionId: string): number {
  const rows = listChatTurns(db, sessionId);
  return rows.length ? rows[rows.length - 1].seq + 1 : 1;
}

export async function runChatTurn(
  db: Db,
  publish: Publish,
  sessionId: string,
  userText: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
  if (!session) return { ok: false, error: "session not found" };
  if (activeSessions.has(sessionId)) return { ok: false, error: "a turn is already running" };
  activeSessions.add(sessionId);

  if (!llmApiKey(db)) {
    activeSessions.delete(sessionId);
    return { ok: false, error: "no API key configured" };
  }

  // Persist the user turn immediately; the first message names the session.
  db.insert(chatTurns)
    .values({
      id: newId("turn"),
      sessionId,
      seq: nextSeq(db, sessionId),
      role: "user",
      contentJson: JSON.stringify({ text: userText }),
      createdAt: nowIso(),
    })
    .run();
  if (!session.title) {
    db.update(chatSessions).set({ title: titleFromMessage(userText) }).where(eq(chatSessions.id, sessionId)).run();
  }
  publish({ type: "chat.delta", sessionId });

  const assistantTurnId = newId("turn");
  const blocks: ChatBlock[] = [];
  db.insert(chatTurns)
    .values({
      id: assistantTurnId,
      sessionId,
      seq: nextSeq(db, sessionId),
      role: "assistant",
      contentJson: JSON.stringify({ blocks, running: true }),
      createdAt: nowIso(),
    })
    .run();

  const flush = (running: boolean) => {
    db.update(chatTurns)
      .set({ contentJson: JSON.stringify({ blocks, running }) })
      .where(eq(chatTurns.id, assistantTurnId))
      .run();
    publish({ type: "chat.delta", sessionId });
  };

  const chatTools = [
    tool(
      "create_todo",
      "Add a task or FYI to the user's to-do list.",
      {
        title: z.string(),
        summary: z.string(),
        type: z.enum(["task", "fyi"]).default("task"),
        dueBy: z
          .string()
          .nullable()
          .describe("Due date as YYYY-MM-DD when the user stated or implied one; null defaults to 7 days out.")
          .default(null),
      },
      async (input) => {
        const { dueBy, ...rest } = input;
        // Chat-created todos get a synthetic, pre-triaged signal so the card
        // carries a source like connector-sourced ones: the chat icon and a
        // link back to the conversation that created it.
        const sigId = insertSignal(db, "chat", null, {
          externalId: `chat:${sessionId}:${newId("sig")}`,
          kind: "message",
          title: rest.title,
          body: `Created in chat at the user's request:\n${userText.slice(0, 600)}`,
          author: "ami chat",
          url: `/chat/${sessionId}`,
          threadRef: sessionId,
          raw: null,
          occurredAt: nowIso(),
        });
        if (sigId) markTriaged(db, [sigId]);
        const todoId = insertTodo(db, { ...rest, dueAt: dueBy, signalId: sigId, entityIds: [] });
        publish({ type: "todo.created", todoId });
        return { content: [{ type: "text" as const, text: JSON.stringify({ todoId }) }] };
      },
    ),
    tool(
      "list_todos",
      "List the user's current to-dos (open/planned/running/awaiting review).",
      {},
      async () => {
        const { listTodos } = await import("@ami/db");
        const rows = listTodos(db)
          .filter((t) => !["dismissed", "resolved"].includes(t.status))
          .map((t) => ({ id: t.id, title: t.title, status: t.status }));
        return { content: [{ type: "text" as const, text: JSON.stringify(rows) }] };
      },
    ),
    tool(
      "resolve_todo",
      "Mark a to-do resolved: the work is done or the item is obsolete/overtaken by events. Set draftReply=true only when the user also wants a wrap-up reply drafted for the originating thread (it goes to draft approval, never auto-sent).",
      { todoId: z.string(), draftReply: z.boolean().default(false) },
      async ({ todoId, draftReply }) => {
        if (!getTodo(db, todoId)) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "todo not found" }) }] };
        }
        const draftId = await resolveTodo(db, publish, todoId, { draftReply });
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, resolved: todoId, draftId }) }] };
      },
    ),
    tool(
      "dismiss_todo",
      "Dismiss a to-do that should never have been created (noise, not the user's, irrelevant). This records a triage correction so similar signals get deprioritized — for work that's genuinely done or obsolete, use resolve_todo instead.",
      { todoId: z.string(), reason: z.string().optional() },
      async ({ todoId, reason }) => {
        if (!getTodo(db, todoId)) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "todo not found" }) }] };
        }
        await dismissTodo(db, publish, todoId, reason);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, dismissed: todoId }) }] };
      },
    ),
    tool(
      "plan_todo",
      "Start a planning run for a to-do: an agent produces an execution plan the user reviews and approves on the task page (/tasks/<todoId>) before anything runs. Optional context is passed to the planner; projectId pins a registered code project.",
      { todoId: z.string(), context: z.string().optional(), projectId: z.string().optional() },
      async ({ todoId, context, projectId }) => {
        const todo = getTodo(db, todoId);
        if (!todo) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "todo not found" }) }] };
        }
        if (todo.status === "running") {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "a run is already active for this todo" }) }] };
        }
        if (context?.trim()) insertFeedback(db, { todoId, scope: "plan", text: context.trim() });
        if (projectId) updateTodo(db, todoId, { projectId });
        const runId = startRun(db, publish, { todoId, mode: "plan" });
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, runId, reviewAt: `/tasks/${todoId}` }) }] };
      },
    ),
    tool(
      "start_todo",
      "Execute a to-do now: an agent works it end-to-end (coding runs default to the ask-risky permission policy; outbound messages still go through draft approval). Progress is on the task page (/tasks/<todoId>). Optional context is passed to the agent; projectId pins a registered code project.",
      {
        todoId: z.string(),
        context: z.string().optional(),
        projectId: z.string().optional(),
        policy: z.enum(["full-auto", "ask-risky", "ask-all"]).optional(),
      },
      async ({ todoId, context, projectId, policy }) => {
        const todo = getTodo(db, todoId);
        if (!todo) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "todo not found" }) }] };
        }
        if (todo.status === "running") {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "a run is already active for this todo" }) }] };
        }
        if (context?.trim()) insertFeedback(db, { todoId, scope: "execution", text: context.trim() });
        if (projectId) updateTodo(db, todoId, { projectId });
        const runId = startRun(db, publish, { todoId, mode: "auto", policy });
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, runId, progressAt: `/tasks/${todoId}` }) }] };
      },
    ),
    tool(
      "run_background_task",
      "Trigger one of the user's background agents now. Use list format 'slug' from list_background_tasks.",
      { slug: z.string() },
      async ({ slug }) => {
        if (!fetchTask(slug)) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "unknown slug" }) }] };
        }
        void runBackgroundTask(db, publish, slug, "manual").catch(() => {});
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, started: slug }) }] };
      },
    ),
    tool(
      "list_background_tasks",
      "List the user's background agents (slug, name, triggers, last run).",
      {},
      async () => {
        const rows = listTasks().map((t) => ({
          slug: t.slug,
          name: t.name,
          active: t.active,
          lastRunSummary: t.lastRunSummary,
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify(rows) }] };
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "list_chats",
      "List the user's chat conversations in this console, newest first (id, title, timestamps). THE tool for 'all chats today / this week' — no keywords needed; read any of them with read_chat. For keyword lookups use search_chats instead.",
      {
        limit: z.number().int().min(1).max(50).optional().describe("Max sessions (default 20)"),
        since: z.string().optional().describe("Only sessions updated on/after this ISO date, e.g. 2026-07-17"),
      },
      async ({ limit, since }) => {
        const out = db
          .select()
          .from(chatSessions)
          .where(eq(chatSessions.archived, 0))
          .orderBy(desc(chatSessions.updatedAt))
          .all()
          .filter((s) => s.id !== sessionId && (!since || s.updatedAt >= since))
          .slice(0, limit ?? 20)
          .map((s) => ({ sessionId: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt }));
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "search_chats",
      "Search the user's past chat conversations in this console (titles and transcripts). Use when the user references an earlier conversation ('what did we decide about X', 'the chat where we…'). Returns session ids + a matching snippet — read the full conversation with read_chat. To enumerate chats by date instead, use list_chats.",
      {
        query: z.string().describe("Search terms"),
        limit: z.number().int().min(1).max(25).optional().describe("Max sessions (default 6)"),
      },
      async ({ query: q, limit }) => {
        const max = limit ?? 6;
        const needle = q.toLowerCase();
        const pat = `%${q.replace(/[%_]/g, " ")}%`;
        const sessions = db
          .select()
          .from(chatSessions)
          .where(eq(chatSessions.archived, 0))
          .orderBy(desc(chatSessions.updatedAt))
          .all();
        const out: { sessionId: string; title: string | null; updatedAt: string; snippet: string }[] = [];
        for (const s of sessions) {
          if (out.length >= max) break;
          if (s.id === sessionId) continue; // this conversation is already in context
          let snippet = "";
          const hit = db
            .select()
            .from(chatTurns)
            .where(and(eq(chatTurns.sessionId, s.id), like(chatTurns.contentJson, pat)))
            .limit(1)
            .all()[0];
          if (hit) {
            const text = turnToText(hit);
            const idx = text.toLowerCase().indexOf(needle);
            snippet = (idx >= 0 ? text.slice(Math.max(0, idx - 80), idx + 120) : text.slice(0, 200)).replace(/\s+/g, " ");
          } else if (!(s.title ?? "").toLowerCase().includes(needle)) {
            continue;
          }
          out.push({ sessionId: s.id, title: s.title, updatedAt: s.updatedAt, snippet });
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "read_chat",
      "Read a past chat conversation as a transcript (session id from search_chats). Tool calls appear as [labels]; the words are verbatim.",
      { sessionId: z.string().describe("Chat session id from search_chats") },
      async (input) => {
        const turns = listChatTurns(db, input.sessionId);
        const session = db.select().from(chatSessions).where(eq(chatSessions.id, input.sessionId)).all()[0];
        if (!session) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "no such chat session" }) }] };
        let transcript = turns.map(turnToText).filter(Boolean).join("\n\n");
        const CAP = 8000;
        const truncated = transcript.length > CAP;
        if (truncated) transcript = transcript.slice(0, CAP) + "\n\n[transcript truncated]";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ title: session.title, updatedAt: session.updatedAt, truncated, transcript }),
            },
          ],
        };
      },
      { annotations: { readOnlyHint: true } },
    ),
  ];

  let failed: string | null = null;
  let stopped = false;
  let finalText = "";
  let model = getSetting(db, "model") ?? "claude-opus-4-8";
  const abort = new AbortController();
  chatAborts.set(sessionId, abort);

  try {
    // First turn gets full dossiers; resumed turns get one-line hints so the
    // conversation can drift topics without losing memory entirely (the model
    // loads anything promising via memory_read_note).
    const memory = session.sdkSessionId
      ? compactMemoryHints(userText, 4)
      : memoryContextBlock(userText, 4, 3500);
    const prompt = `${memory ? `${memory}\n\n---\n\n` : ""}${userText}`;

    const browser = await browserMcpServer();
    const q = query({
      prompt,
      options: {
        cwd: amiHome(),
        resume: session.sdkSessionId ?? undefined,
        abortController: abort,
        model,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        tools: ["Read", "Write", "Glob", "Grep", "WebSearch", "WebFetch"],
        mcpServers: {
          ami: amiMcpServer({
            db,
            publish,
            todoId: `chat:${sessionId}`,
            runId: assistantTurnId,
            defaultChannel: null,
            defaultTargetRef: null,
            sessionId,
            extraTools: chatTools,
          }),
          browser,
        },
        systemPrompt: buildChatSystemPrompt(db),
        env: { ...process.env, ...llmEnv(db) },
        maxTurns: 40,
      },
    });

    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        model = msg.model;
        if (!session.sdkSessionId) {
          db.update(chatSessions).set({ sdkSessionId: msg.session_id }).where(eq(chatSessions.id, sessionId)).run();
        }
      } else if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) {
            blocks.push({ kind: "text", text: block.text });
            finalText = block.text;
          } else if (block.type === "tool_use") {
            blocks.push({
              kind: "tool_use",
              label: toolChip(block.name, block.input),
              toolId: block.id,
              input: fmtToolInput(block.input),
            });
          }
        }
        flush(true);
      } else if (msg.type === "user") {
        // Tool results stream back as user messages — attach each to its call.
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          let touched = false;
          for (const block of content) {
            if (block?.type !== "tool_result" || !block.tool_use_id) continue;
            const call = blocks.find((b) => b.toolId === block.tool_use_id);
            if (!call) continue;
            call.result = fmtToolResult(block.content);
            call.isError = block.is_error === true || undefined;
            touched = true;
          }
          if (touched) flush(true);
        }
      } else if (msg.type === "result") {
        if (msg.subtype !== "success") failed = msg.subtype;
        const u: any = (msg as any).usage;
        insertLlmUsage(db, {
          useCase: "chat",
          model,
          inputTokens: u?.input_tokens ?? 0,
          outputTokens: u?.output_tokens ?? 0,
          cacheReadTokens: u?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
          costUsd: (msg as any).total_cost_usd ?? undefined,
        });
      }
    }
  } catch (e: any) {
    if (abort.signal.aborted) stopped = true;
    else failed = String(e?.message ?? e);
  } finally {
    if (abort.signal.aborted) stopped = true;
    if (stopped) blocks.push({ kind: "text", text: "_(stopped by you)_" });
    else if (failed) blocks.push({ kind: "text", text: `_(turn failed: ${failed})_` });
    flush(false);
    db.update(chatSessions).set({ updatedAt: nowIso() }).where(eq(chatSessions.id, sessionId)).run();
    publish({ type: "chat.done", sessionId });
    activeSessions.delete(sessionId);
    chatAborts.delete(sessionId);
  }

  return failed ? { ok: false, error: failed } : { ok: true };
}

/** Session title = the first thing the user typed, compacted. Direct and
 * predictable — no LLM call, and the sidebar labels what YOU asked, not the
 * assistant's paraphrase. */
export function titleFromMessage(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 48 ? `${t.slice(0, 47).trimEnd()}…` : t;
}

const INPUT_CAP = 1500;
const RESULT_CAP = 2500;

function fmtToolInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  try {
    const s = JSON.stringify(input, null, 2);
    if (!s || s === "{}") return undefined;
    return s.length > INPUT_CAP ? `${s.slice(0, INPUT_CAP)}\n… (truncated)` : s;
  } catch {
    return undefined;
  }
}

/** Tool results are a string or a content-block array; keep only the text. */
function fmtToolResult(content: unknown): string | undefined {
  let s: string;
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) {
    s = content
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n");
  } else return undefined;
  s = s.trim();
  if (!s) return undefined;
  return s.length > RESULT_CAP ? `${s.slice(0, RESULT_CAP)}\n… (truncated)` : s;
}

function toolChip(name: string, input: unknown): string {
  const i = input as Record<string, unknown>;
  const short = name.replace(/^mcp__ami(chat)?__/, "");
  if (name === "Read" && i?.file_path) return `Read ${String(i.file_path).split("/").slice(-2).join("/")}`;
  if (i?.query) return `${short}: ${String(i.query).slice(0, 60)}`;
  return short;
}

