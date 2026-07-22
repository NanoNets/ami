import {
  getSignal,
  insertDraft,
  insertLlmUsage,
  insertTodo,
  insertTrace,
  listTodos,
  markTriaged,
  normalizeDueDate,
  untriagedSignals,
  updateTodo,
  type Db,
} from "@ami/db";
import {
  buildOwnerBlock,
  combinedMemoryContext,
  getPreferences,
  parseWithSchema,
  renderEmailTagsForTriage,
  writeSignalArtifact,
} from "@ami/memory";
import { TriageResultSchema, WRITING_STYLE, type TriageItem, type TriageResult, type AmiEvent } from "@ami/shared";
import { anthropicClient, currentModel, fakeLlm } from "./llm.js";
import { prefilterSignal } from "./prefilter.js";
import { formatTriageFeedbackForPrompt, maybeDistillTriageRules } from "./feedback.js";
import { upcomingCalendarBlock } from "./calendar.js";

const SYSTEM = `You are Ami, the user's AI shadow. You triage incoming signals (Slack messages, emails, calendar invites, tickets, notifications) into the user's universal to-do list — and, when a reply is clearly expected, you pre-draft it in the user's voice.

For each signal decide:
- verdict: "task" (the user or Ami needs to act), "fyi" (worth knowing given who this user is and what they work on, no action), or "ignore" (noise: automated notifications with no action, things clearly for someone else).
- title: short imperative title as the user would write it.
- summary: 1-2 sentences with the key facts needed to act.
- dueBy: the task's due date as YYYY-MM-DD. Explicit beats inferred: if the signal states a date ("Due date:" lines from ticket systems, "by Friday", "EOD tomorrow", "before the launch on the 20th"), use exactly that, resolving relative phrasings against the current date given below. With no stated date, reason one out only when the content clearly implies a deadline (the meeting it prepares for, a launch date, a customer SLA). Otherwise null — the system applies a 7-day default.
- duplicateOfTodoId: id of an existing open todo this signal belongs to (e.g. a follow-up message in the same thread), else null.
- duplicateUpdate: when duplicateOfTodoId is set, one sentence carrying only the NEW information this signal adds to that todo — a decision made, a new deadline, a blocker, someone taking it over. It is appended to the todo so the card stays current. Null when there's nothing genuinely new.
- duplicateResolves: set true only when the follow-up clearly shows the existing todo is already handled or moot (done, cancelled, someone else finished it) — the todo will be auto-resolved with a trace. When in doubt, false.
- labels: for EMAIL signals only, tags from the tag list below that describe the email (relationship, topic, type, noise, action). Non-email signals get an empty list. Noise labels (newsletter, promotion, cold-outreach, notification, receipt, …) matter most — they keep junk out of the user's memory.
- draftResponse: for communication tasks where the sender clearly expects a reply from the user, write a complete draft reply they could send as-is. Format it like a real message with actual line breaks: greeting on its own line, blank line between paragraphs, sign-off on its own line. If you include a name in the sign-off, use only the user's first name. When a style guide is provided, follow it for greeting, tone, sign-off, length, and phrasing. For scheduling threads, use the user's upcoming calendar (provided below) to propose 2-3 specific windows from genuinely free slots, or confirm/decline a proposed time based on conflicts — in the timezone the user appears to operate in. Omit (null) when: no reply is expected, the latest message is from the user, or you can't write a meaningful reply without information you don't have (don't fabricate).

The Owner block below says exactly who the user is — messages FROM the user's own address are their own actions, never things to reply to.

FYI discipline: every "fyi" lands on the user's to-do list, so it must earn its place. Mark a signal "fyi" only when it meaningfully touches this user's own work or interests — their projects, deals, customers, team, or topics evidenced in the Owner block/profile, the knowledge notes below, or their open todos. Being visible to the user (posted in a channel or thread they're in) is NOT enough: general chatter, other teams' updates, and broad announcements are "ignore". If you cannot point at something in the provided context that makes the signal matter to this specific user, choose "ignore" over "fyi".

Past knowledge notes show what Ami already knows — use them for context and to spot duplicates.

${WRITING_STYLE}`;

type Publish = (e: AmiEvent) => void;

interface TriagedOutcome {
  createdTodoIds: string[];
}

export async function triageBatch(db: Db, limit = 10, publish?: Publish): Promise<TriagedOutcome> {
  const batch = untriagedSignals(db, limit);
  if (batch.length === 0) return { createdTodoIds: [] };

  // Deterministic noise pre-filter: drop before any tokens are spent. Filtered
  // signals are marked triaged and never reach the LLM or the knowledge base.
  const kept: typeof batch = [];
  const dropped: { id: string; reason: string; connector: string; title: string }[] = [];
  for (const s of batch) {
    const verdict = prefilterSignal(s);
    if (verdict.drop) dropped.push({ id: s.id, reason: verdict.reason ?? "noise", connector: s.connector, title: s.title });
    else kept.push(s);
  }
  if (dropped.length > 0) {
    markTriaged(db, dropped.map((d) => d.id));
    for (const d of dropped) {
      insertTrace(db, {
        kind: "triage",
        situation: `Signal from ${d.connector}: ${d.title}`,
        decision: `filtered (${d.reason})`,
      });
    }
  }
  if (kept.length === 0) return { createdTodoIds: [] };

  // Opportunistically distill accumulated corrections into rules (no-ops
  // unless enough new corrections exist).
  await maybeDistillTriageRules(db);

  const openTodos = listTodos(db).filter((t) => ["open", "planned", "running"].includes(t.status));
  const result = fakeLlm() ? fakeTriage(kept) : await llmTriage(db, kept, openTodos);
  if (!result) return { createdTodoIds: [] };

  const createdTodoIds: string[] = [];
  for (const item of result.items) {
    const signal = kept.find((s) => s.id === item.signalId);
    if (!signal) continue;

    // Feed the signal into memory: write the knowledge source artifact
    // (gmail gets its triage labels stamped so noise stays out of the graph).
    const gmailLabels =
      signal.connector === "gmail" && item.labels.length > 0
        ? groupLabels(item.labels)
        : undefined;
    writeSignalArtifact(signal, { gmailLabels });

    if (item.verdict === "ignore") {
      insertTrace(db, {
        kind: "triage",
        situation: `Signal from ${signal.connector}: ${signal.title}`,
        decision: "ignored",
        rationale: item.summary,
      });
      continue;
    }

    const existing = item.duplicateOfTodoId
      ? openTodos.find((t) => t.id === item.duplicateOfTodoId)
      : undefined;
    if (existing) {
      // Genuine merge: enrich the card with what's new, resolve when the
      // thread says it's handled (but never yank in-flight work).
      const patch: Record<string, unknown> = {};
      if (item.duplicateUpdate) {
        const stamp = (signal.receivedAt ?? new Date().toISOString()).slice(5, 10);
        let summary = `${existing.summary}\nUpdate (${stamp}, ${signal.connector}): ${item.duplicateUpdate}`;
        if (summary.length > 2200) summary = `${summary.slice(0, 700)}…\n${summary.slice(-1300)}`;
        patch.summary = summary;
      }
      // Follow-ups can move the deadline ("now needed by Thursday").
      const mergedDue = signalDueDate(signal) ?? normalizeDueDate(item.dueBy);
      if (mergedDue && mergedDue !== existing.dueAt) patch.dueAt = mergedDue;
      const resolves = item.duplicateResolves && ["open", "planned"].includes(existing.status);
      if (resolves) patch.status = "resolved";
      updateTodo(db, existing.id, patch);
      insertTrace(db, {
        todoId: existing.id,
        kind: "triage",
        situation: `Signal from ${signal.connector}: ${signal.title}`,
        decision: resolves
          ? "auto-resolved — follow-up in the thread indicates this is handled"
          : "merged into existing todo",
        rationale: item.duplicateUpdate ?? undefined,
      });
      publish?.({ type: "todo.updated", todoId: existing.id });
      continue;
    }

    // Due date: a structured date from the connector (e.g. Linear's dueDate)
    // beats the LLM's read of the text; insertTodo applies the 7-day default.
    const todoId = insertTodo(db, {
      signalId: signal.id,
      type: item.verdict,
      title: item.title,
      summary: item.summary,
      dueAt: signalDueDate(signal) ?? normalizeDueDate(item.dueBy),
      entityIds: [],
    });
    createdTodoIds.push(todoId);
    insertTrace(db, {
      todoId,
      kind: "triage",
      situation: `Signal from ${signal.connector}: ${signal.title}`,
      decision: `${item.verdict}: ${item.title}`,
    });

    // Pre-drafted reply: lands as a pending draft on the todo, so the card
    // arrives with a reply already waiting for review. Never auto-sent.
    if (item.verdict === "task" && item.draftResponse && signal.threadRef) {
      const draftId = insertDraft(db, {
        todoId,
        runId: null,
        channel: signal.connector,
        targetRef: signal.threadRef,
        body: item.draftResponse,
      });
      publish?.({ type: "draft.created", draftId, todoId });
    }
  }

  markTriaged(db, kept.map((s) => s.id));
  return { createdTodoIds };
}

/** Structured due date a connector attached to the signal (e.g. Linear's
 * issue.dueDate rides in raw_json) — authoritative over any LLM inference. */
function signalDueDate(signal: { rawJson?: string | null }): string | null {
  if (!signal.rawJson) return null;
  try {
    const raw = JSON.parse(signal.rawJson);
    return normalizeDueDate(raw?.dueDate ?? null);
  } catch {
    return null;
  }
}

function groupLabels(labels: string[]): Record<string, string[]> {
  // The knowledge artifact frontmatter groups labels loosely; noise detection
  // scans all values, so one flat group is sufficient and robust.
  return { labels: labels };
}

async function llmTriage(
  db: Db,
  batch: ReturnType<typeof untriagedSignals>,
  openTodos: ReturnType<typeof listTodos>,
): Promise<TriageResult | null> {
  const client = anthropicClient(db);
  if (!client) return null;

  // One deduped context block for the whole batch (author dossiers pinned by
  // email/domain) — per-signal blocks repeated the same dossiers verbatim.
  const memoryBlock = combinedMemoryContext(
    batch.map((s) => ({ query: `${s.title} ${s.body}`.slice(0, 300), author: s.author })),
    4,
    9000,
  );
  const preferences = getPreferences(1500);
  const hasEmail = batch.some((s) => s.connector === "gmail");
  const hasComms = true; // calendar context is cheap (cached) and helps any scheduling thread
  const calendar = hasComms ? await upcomingCalendarBlock(db) : "";
  const corrections = formatTriageFeedbackForPrompt();

  const user = [
    `Current date/time: ${new Date().toString()}`,
    buildOwnerBlock(db),
    openTodos.length
      ? `Existing open todos (for duplicate detection):\n${openTodos.map((t) => `- ${t.id} [${t.status}]: ${t.title}`).join("\n")}`
      : "",
    hasEmail ? `Email tag list (for labels):\n${renderEmailTagsForTriage()}` : "",
    `User's upcoming calendar (next 7 days):\n${calendar}`,
    memoryBlock,
    preferences ? `User's learned preferences (respect any that affect triage or drafted replies):\n${preferences}` : "",
    corrections ?? "",
    `Signals to triage:\n${batch
      .map(
        (s) =>
          `<signal id="${s.id}" connector="${s.connector}" kind="${s.kind}" author="${s.author}">\ntitle: ${s.title}\n${s.body.slice(0, 4800)}\n</signal>`,
      )
      .join("\n\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const model = currentModel(db);
  const res = await parseWithSchema(
    db,
    client,
    { model, max_tokens: 12000, system: SYSTEM, messages: [{ role: "user", content: user }] },
    TriageResultSchema,
  );
  insertLlmUsage(db, {
    useCase: "triage",
    model,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
  });
  return res.parsed_output ?? null;
}

/** Deterministic heuristic triage for AMI_FAKE_LLM=1 (UI dev without burning tokens). */
function fakeTriage(batch: ReturnType<typeof untriagedSignals>): TriageResult {
  const items: TriageItem[] = batch.map((s) => {
    const text = `${s.title} ${s.body}`.toLowerCase();
    const isFyi = /no action|reminder|announcement|closed friday/.test(text);
    return {
      signalId: s.id,
      verdict: isFyi ? "fyi" : "task",
      title: s.title.slice(0, 80),
      summary: s.body.slice(0, 160),
      dueBy: null,
      duplicateOfTodoId: null,
      duplicateUpdate: null,
      duplicateResolves: false,
      labels: [],
      draftResponse: null,
    };
  });
  return { items };
}
