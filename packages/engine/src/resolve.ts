import {
  getSetting,
  getSignal,
  getTodo,
  insertDraft,
  listDraftsForTodo,
  insertLlmUsage,
  insertTrace,
  updateTodo,
  type Db,
} from "@ami/db";
import {
  anthropicClient,
  getPreferences,
  getStyleProfile,
  memoryContextBlock,
  requestAgentNotesRun,
  writeSourceDoc,
} from "@ami/memory";
import { WRITING_STYLE, type AmiEvent } from "@ami/shared";

type Publish = (e: AmiEvent) => void;

/** "Resolve task": the work is done — mark the todo resolved and (by default,
 * as the console's Resolve button does) generate an editable wrap-up reply for
 * the originating thread. Chat closes todos with draftReply=false unless the
 * user wants the thread answered. */
export async function resolveTodo(
  db: Db,
  publish: Publish,
  todoId: string,
  opts: { draftReply?: boolean } = {},
): Promise<string | null> {
  const todo = getTodo(db, todoId);
  if (!todo) throw new Error(`todo ${todoId} not found`);
  const signal = todo.signalId ? getSignal(db, todo.signalId) : undefined;

  let draftId: string | null = null;
  // Only draft a wrap-up when the thread was never answered — a todo that
  // already has drafts (sent or pending) doesn't need a second reply.
  const hasDrafts = listDraftsForTodo(db, todoId).some((d) => d.status !== "discarded");
  if ((opts.draftReply ?? true) && signal?.threadRef && !hasDrafts) {
    const body = await generateResolveMessage(db, {
      title: todo.title,
      summary: todo.summary,
      signalBody: `${signal.title}\nFrom: ${signal.author}\n${signal.body}`,
      channel: signal.connector,
    });
    draftId = insertDraft(db, {
      todoId,
      channel: signal.connector,
      targetRef: signal.threadRef,
      body,
    });
    publish({ type: "draft.created", draftId, todoId });
  }

  updateTodo(db, todoId, { status: "resolved" });
  insertTrace(db, {
    todoId,
    kind: "resolution",
    situation: `Task: ${todo.title}`,
    decision: "user resolved it themselves",
  });
  publish({ type: "todo.updated", todoId });
  // Feed the outcome to the entity-graph builder — a resolved task is a fact
  // about the projects/people it touched, not just a closed card.
  writeSourceDoc(
    "ami-tasks",
    todoId,
    `Task resolved: ${todo.title}`,
    [
      `**Outcome:** the user resolved this task themselves on ${new Date().toISOString().slice(0, 10)}.`,
      ``,
      `**Task summary:** ${todo.summary}`,
      signal ? `\n**Originating ${signal.connector} message** (from ${signal.author}): ${signal.title}\n${signal.body.slice(0, 1500)}` : "",
    ].join("\n"),
  );
  // A closed task is a moment of new information — route any pending
  // learnings (inbox notes, feedback, chat facts) into the knowledge base now.
  requestAgentNotesRun(db, "task resolved");
  return draftId;
}

/** Dismiss: this should never have been a todo (noise, someone else's, not
 * relevant). Distinct from resolve — a dismissal is a triage correction that
 * deprioritizes similar signals in future triage passes. */
export async function dismissTodo(
  db: Db,
  publish: Publish,
  todoId: string,
  reason?: string,
): Promise<void> {
  const todo = getTodo(db, todoId);
  if (!todo) throw new Error(`todo ${todoId} not found`);
  updateTodo(db, todoId, { status: "dismissed" });
  insertTrace(db, {
    todoId,
    kind: "dismissal",
    situation: `Todo: ${todo.title} (from ${todo.signalId ? "signal" : "manual"})`,
    decision: `user dismissed — deprioritize similar signals in future triage${reason ? ` (${reason})` : ""}`,
  });
  if (todo.signalId && (todo.type === "task" || todo.type === "fyi")) {
    const signal = getSignal(db, todo.signalId);
    if (signal) {
      const { recordTriageCorrection } = await import("@ami/triage");
      recordTriageCorrection({
        signalId: signal.id,
        connector: signal.connector,
        title: todo.title,
        author: signal.author,
        agentVerdict: todo.type as "task" | "fyi",
        userVerdict: "ignore",
        at: new Date().toISOString(),
      });
    }
  }
  publish({ type: "todo.updated", todoId });
}

async function generateResolveMessage(
  db: Db,
  args: { title: string; summary: string; signalBody: string; channel: string },
): Promise<string> {
  const client = anthropicClient(db);
  if (!client || process.env.AMI_FAKE_LLM === "1") {
    return `Done — this is handled now. Let me know if anything else comes up.`;
  }
  const style = getStyleProfile(db, args.channel === "gmail" ? "email" : "slack");
  const prefs = getPreferences();
  const memory = memoryContextBlock(`${args.title} ${args.summary}`, 4, 4000);
  const model = getSetting(db, "model") ?? "claude-opus-4-8";
  const res = await client.messages.create({
    model,
    max_tokens: 600,
    system: `You draft a short reply the user will post in the originating conversation to say the request has been handled. Write in the user's voice, first person, no signature unless email. Output only the message text.\n\n${WRITING_STYLE}${style ? `\n\nUser's style (wins over the general style where they conflict):\n${style}` : ""}${prefs ? `\n\nUser's learned preferences (respect any that apply to messaging):\n${prefs}` : ""}`,
    messages: [
      {
        role: "user",
        content: `The user completed this task themselves and wants to reply to the original ${args.channel} message.\n\nTask: ${args.title}\n${args.summary}\n\nOriginal message:\n${args.signalBody}\n${memory ? `\n${memory}` : ""}`,
      },
    ],
  });
  insertLlmUsage(db, {
    useCase: "resolve",
    model,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
  });
  return res.content.find((b) => b.type === "text")?.text?.trim() ?? "Done — handled.";
}
