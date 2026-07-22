import { z } from "zod";

export * from "./schedule.js";

// ---------- Core enums ----------

export const ConnectorIds = [
  "slack",
  "gmail",
  "gcal",
  "gdrive",
  "github",
  "linear",
  "jira",
  "hubspot",
  "stripe",
  "posthog",
  "metabase",
  "m365",
  "msteams",
  "zoom",
  "notion",
  "ghost",
  "aws",
] as const;
/** Built-in ids keep autocomplete; the open string arm admits user-built
 * custom connectors, whose ids are minted at build time. */
export type ConnectorId = (typeof ConnectorIds)[number] | (string & {});

export const SignalKinds = ["message", "email", "event", "issue", "ticket"] as const;
export type SignalKind = (typeof SignalKinds)[number];

export const TodoTypes = ["task", "fyi"] as const;
export type TodoType = (typeof TodoTypes)[number];

export const TodoStatuses = [
  "open",
  "planned",
  "running",
  "awaiting_review",
  "resolved",
  "dismissed",
  "snoozed",
] as const;
export type TodoStatus = (typeof TodoStatuses)[number];

export const RunModes = ["plan", "auto"] as const;
export type RunMode = (typeof RunModes)[number];

export const RunStatuses = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunStatus = (typeof RunStatuses)[number];

export const StepKinds = ["thinking", "tool_use", "tool_result", "text", "status"] as const;
export type StepKind = (typeof StepKinds)[number];

export const ArtifactTypes = [
  "pr",
  "doc",
  "calendar_event",
  "meeting_link",
  "post",
  "file",
  "other",
] as const;
export type ArtifactType = (typeof ArtifactTypes)[number];

export const DraftStatuses = ["pending", "approved", "sent", "discarded"] as const;
export type DraftStatus = (typeof DraftStatuses)[number];

export const MemoryNodeTypes = [
  "person",
  "channel",
  "repo",
  "project",
  "customer",
  "topic",
  "artifact",
  "tool",
] as const;
export type MemoryNodeType = (typeof MemoryNodeTypes)[number];

export const TraceKinds = [
  "triage",
  "plan_approval",
  "plan_feedback",
  "execution_choice",
  "draft_edit",
  "override",
  "dismissal",
  "resolution",
] as const;
export type TraceKind = (typeof TraceKinds)[number];

// ---------- Connector abstraction ----------

/** Opaque per-account auth blob; shape depends on the connector. */
export type AuthBlob = Record<string, string>;

export interface NormalizedSignal {
  externalId: string;
  kind: SignalKind;
  title: string;
  body: string;
  author: string;
  url?: string;
  /** Where a reply should go, e.g. "C012345:1699999999.000100" or a Gmail threadId. */
  threadRef?: string;
  raw: unknown;
  occurredAt: string; // ISO 8601
}

export interface StreamDef {
  name: string;
  /** Polling interval in seconds. */
  intervalSec: number;
}

// ---------- SSE event bus ----------

export type AmiEvent =
  | { type: "todo.created"; todoId: string }
  | { type: "todo.updated"; todoId: string }
  | { type: "run.status"; runId: string; todoId: string; status: RunStatus }
  | { type: "step.appended"; runId: string; todoId: string; stepId: string }
  | { type: "draft.created"; draftId: string; todoId: string }
  | { type: "draft.updated"; draftId: string; todoId: string }
  | { type: "artifact.created"; artifactId: string; runId: string; todoId: string }
  | { type: "connector.status"; connector: ConnectorId; status: string }
  | { type: "connector.build"; connector: string; status: "running" | "succeeded" | "failed"; message?: string }
  | { type: "ingest.progress"; message: string }
  | { type: "question.created"; questionId: string; todoId: string | null; sessionId: string | null }
  | { type: "question.answered"; questionId: string }
  | { type: "chat.delta"; sessionId: string }
  | { type: "chat.done"; sessionId: string }
  | { type: "bgtask.updated"; slug: string };

// ---------- Triage LLM output ----------

export const TriageItemSchema = z.object({
  signalId: z.string(),
  verdict: z.enum(["task", "fyi", "ignore"]),
  title: z.string(),
  summary: z.string(),
  /** Due date extracted or inferred from the signal (date-only). */
  dueBy: z
    .string()
    .nullable()
    .describe(
      "Date the task is due, as YYYY-MM-DD. Use an explicit date when the signal states one (a 'Due date:' line, 'by Friday', 'EOD tomorrow', 'before the launch on the 20th') — resolve relative phrasings against the current time given in the prompt. When no date is stated but the content clearly implies a natural deadline (a meeting being prepped for, a launch, a customer SLA), reason one out. Null when nothing suggests a date (a 7-day default applies).",
    )
    .default(null),
  duplicateOfTodoId: z.string().nullable(),
  /** When duplicateOfTodoId is set: the NEW information this signal adds. */
  duplicateUpdate: z
    .string()
    .nullable()
    .describe(
      "When duplicateOfTodoId is set: one sentence with only the NEW information this signal adds to that todo (a decision, deadline, blocker, someone taking over). Null otherwise.",
    )
    .default(null),
  /** The follow-up indicates the existing todo is already handled/moot. */
  duplicateResolves: z
    .boolean()
    .describe(
      "True only when the signal clearly indicates the existing todo is already handled or moot (done, cancelled, someone else finished it).",
    )
    .default(false),
  /** Email tag labels (gmail signals only) — stamped into the knowledge source
   * artifact's frontmatter; noise labels keep the email out of memory. */
  labels: z
    .array(z.string())
    .describe("For email signals: tags from the tag list (relationship/topic/type/noise/action). Empty for non-email signals.")
    .default([]),
  /** Pre-drafted reply for communication tasks (never sent without approval). */
  draftResponse: z
    .string()
    .nullable()
    .describe(
      "For communication tasks where a reply is clearly expected: a complete draft reply the user could send as-is, formatted with real line breaks. Null when no reply is appropriate, when the latest message is from the user, or when you cannot write a meaningful reply without information you don't have (don't fabricate).",
    )
    .default(null),
});
export const TriageResultSchema = z.object({ items: z.array(TriageItemSchema) });
export type TriageItem = z.infer<typeof TriageItemSchema>;
export type TriageResult = z.infer<typeof TriageResultSchema>;

// ---------- API DTOs (server <-> console) ----------

export interface TodoDto {
  id: string;
  signalId: string | null;
  type: TodoType;
  status: TodoStatus;
  title: string;
  summary: string;
  /** "chat" marks todos created from a chat conversation, "meeting" ones from
   * meeting notes/prep (both synthetic signals). */
  connector: ConnectorId | "chat" | "meeting" | null;
  sourceUrl: string | null;
  sourceAuthor: string | null;
  /** Date-only YYYY-MM-DD; null for FYIs. */
  dueAt: string | null;
  snoozedUntil: string | null;
  /** Attached code project (auto-resolved or user-picked) — makes runs coding runs. */
  projectId: string | null;
  planMd: string | null;
  planApprovedAt: string | null;
  entities: { type: string; name: string }[];
  /** A pending draft reply exists (e.g. pre-drafted at triage time). */
  hasPendingDraft: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStepDto {
  id: string;
  runId: string;
  seq: number;
  kind: StepKind;
  label: string;
  detail: string | null;
  createdAt: string;
}

export interface TaskRunDto {
  id: string;
  todoId: string;
  mode: RunMode;
  status: RunStatus;
  error: string | null;
  parentRunId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ArtifactDto {
  id: string;
  runId: string;
  type: ArtifactType;
  title: string;
  url: string | null;
  contentMd: string | null;
  createdAt: string;
}

export interface DraftDto {
  id: string;
  todoId: string;
  runId: string | null;
  channel: string;
  targetRef: string;
  body: string;
  editedBody: string | null;
  status: DraftStatus;
  createdAt: string;
  sentAt: string | null;
}

/** Brain graph: notes as nodes (id = knowledge-relative path), wiki-links as edges. */
export interface MemoryGraphDto {
  nodes: {
    id: string;
    label: string;
    group: string; // top-level knowledge folder (People/Organizations/…)
    degree: number;
  }[];
  links: { source: string; target: string }[];
}

export interface UsageSummaryDto {
  useCase: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ConnectorStatusDto {
  connector: ConnectorId;
  label: string;
  authKind: "token" | "oauth" | "none";
  setupHelp: string;
  connected: boolean;
  accountLabel: string | null;
  status: string;
  lastPolledAt: string | null;
  error: string | null;
  /** A first-connect history backfill is currently running. */
  bootstrapping?: boolean;
  /** Built by the user with the connector builder (deletable, generic icon). */
  custom?: boolean;
}

export const nowIso = () => new Date().toISOString();

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** Ami's house writing style — Orwell's rules plus plain-spoken developer
 * writing, distilled from the owner's writing guide. Injected into every
 * prompt surface where Ami produces prose: chat replies, drafts, summaries,
 * memory notes, task titles and descriptions, documents. Channel voice cards
 * learned from the user's real messages win over this inside their channel. */
export const WRITING_STYLE = `# Writing style (strict — applies to EVERYTHING you write: replies, drafts, summaries, notes, titles, descriptions, documents)

Orwell's rules:
1. Never use a metaphor, simile, or figure of speech you are used to seeing in print.
2. Never use a long word where a short one will do.
3. If it is possible to cut a word out, cut it out.
4. Never use the passive where you can use the active.
5. Never use jargon or a scientific word where an everyday English word works.
6. Break any of these rules sooner than write anything outright barbarous.

And:
- Write like you speak. Use the words you would use talking to a friend.
- Keep sentences under 30 words. Complete sentences with real grammar — never choppy fragments ("Tool provides value. Helps teams collaborate.").
- Get to the point immediately. No throat-clearing, no restating context the reader already has.
- Be precise, never vague: "fails when you mutate shared data across threads", not "doesn't always work".
- Don't spell out what the reader can infer, and never praise your own output ("really cool", "perfect for beginners").
- Ban the AI tells: "not only X but Y", "In today's … world", "delve", "akin", "utilize", "leverage", "seamless", "robust", "crucial", em-dash overuse.
- Get terminology exactly right; casing matters (GitHub, JavaScript). Say "writing code", not "coding".
- Short paragraphs with blank lines between them.
- A touch of personality is fine; forced formality is not.`;
