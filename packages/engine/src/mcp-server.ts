import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  connectorAccounts,
  insertArtifact,
  insertDraft,
  insertTrace,
  type Db,
} from "@ami/db";
import { appendToInbox, enforceStyleOnDraft, readNote, searchKnowledge } from "@ami/memory";
import { ArtifactTypes, type AmiEvent, type AuthBlob } from "@ami/shared";
import { allConnectors } from "@ami/connectors";
import { askUser } from "./questions.js";
import { fetchPageMarkdown } from "./fetch-page.js";

type Publish = (e: AmiEvent) => void;

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function accountAuth(db: Db, connector: string): AuthBlob | null {
  const row = db
    .select()
    .from(connectorAccounts)
    .where(eq(connectorAccounts.connector, connector))
    .get();
  return row ? (JSON.parse(row.authJson) as AuthBlob) : null;
}

/** In-process MCP server exposing Ami's world to the agent: memory, reporting,
 * and non-send connector actions bound to the user's accounts. */
export function amiMcpServer(args: {
  db: Db;
  publish: Publish;
  todoId: string;
  runId: string;
  defaultChannel: string | null;
  defaultTargetRef: string | null;
  /** Chat session id when the server is bound to a chat turn. */
  sessionId?: string | null;
  /** Background/full-auto contexts get no ask_user tool. */
  allowAskUser?: boolean;
  /** Read-only surface for unattended derived-content agents (live notes):
   * memory search/read plus readOnly connector actions only — no reporting,
   * no recording, no asking, no side-effect actions. */
  readOnly?: boolean;
  /** Caller-specific tools registered on the same server so everything shares the mcp__ami__ prefix (models guess that prefix for any ami tool). */
  extraTools?: unknown[];
}) {
  const { db, publish, todoId, runId } = args;

  const tools: any[] = [
    ...(args.readOnly || args.allowAskUser === false
      ? []
      : [
          tool(
            "ask_user",
            "Ask the user a question and wait for their answer in Ami's console. Use ONLY when you are blocked on a decision that is genuinely the user's to make — one you cannot resolve from the task, the context, or sensible defaults. Provide 2-4 suggested options when the choice is enumerable. If the user doesn't answer in time you'll be told to proceed with your best judgment.",
            {
              question: z.string(),
              options: z.array(z.string()).max(4).optional(),
            },
            async (input) => {
              const answer = await askUser(db, publish, {
                runId,
                todoId: todoId.startsWith("bg:") ? null : todoId,
                sessionId: args.sessionId ?? null,
                kind: "question",
                question: input.question,
                options: input.options,
              });
              return ok({ answer });
            },
          ),
        ]),
    tool(
      "memory_search",
      "Search Ami's knowledge base: markdown dossiers on people, organizations, projects and topics built from the user's tools. Returns matching notes with excerpts. Use this before starting work to pull context and precedents; use memory_read_note to load a full dossier.",
      { query: z.string() },
      async ({ query }) =>
        ok(
          searchKnowledge(query, 10).map((h) => ({
            note: h.file,
            name: h.name,
            excerpt: h.excerpt,
          })),
        ),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "memory_read_note",
      "Read a full knowledge note (dossier) by its path as returned from memory_search, e.g. 'People/Sarah Chen.md'.",
      { note: z.string() },
      async ({ note }) => {
        const content = readNote(note);
        return ok(content ?? { error: "note not found" });
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "fetch_page",
      "Fetch a web page and return its main content as VERBATIM markdown (raw HTML → readability extraction → markdown, no LLM in the loop). Use this instead of WebFetch whenever you need the actual, complete text — a full article/post, an exact spec or doc to mirror, anything the user wants word-for-word. WebFetch summarizes and silently drops detail; fetch_page does not. Public URLs only; for auth-walled pages or JS-rendered apps use the browser tools. Not for GitHub file contents — use github_read_file.",
      { url: z.string().describe("Absolute http(s) URL of the page to capture") },
      async ({ url }) => {
        try {
          const page = await fetchPageMarkdown(url);
          return ok(page);
        } catch (e: any) {
          return ok({ error: String(e?.message ?? e), url });
        }
      },
      { annotations: { readOnlyHint: true } },
    ),
    ...(args.readOnly
      ? []
      : [
    tool(
      "memory_record",
      "Save a durable learning to Ami's memory (repo locations, preferences, decisions and their rationale, facts about people/projects worth reusing). It lands in the save-to-memory inbox and is routed into the knowledge base by a background agent.",
      {
        note: z.string().describe("One self-contained fact or decision, with enough context to be useful later"),
        decision: z
          .object({ situation: z.string(), decision: z.string(), rationale: z.string().optional() })
          .optional(),
      },
      async (input) => {
        appendToInbox(input.note);
        if (input.decision) {
          insertTrace(db, {
            todoId,
            runId,
            kind: "execution_choice",
            situation: input.decision.situation,
            decision: input.decision.decision,
            rationale: input.decision.rationale,
          });
        }
        return ok({ recorded: true });
      },
    ),
    tool(
      "report_artifact",
      "Report a task deliverable so it shows on the task page: a PR, document, calendar event, meeting link, post or file. Call once per artifact.",
      {
        type: z.enum(ArtifactTypes),
        title: z.string(),
        url: z.string().optional(),
        contentMd: z.string().describe("Full content for docs/posts, if not URL-addressable").optional(),
      },
      async (input) => {
        const id = insertArtifact(db, {
          runId,
          type: input.type,
          title: input.title,
          url: input.url,
          contentMd: input.contentMd,
        });
        publish({ type: "artifact.created", artifactId: id, runId, todoId });
        return ok({ artifactId: id });
      },
    ),
    tool(
      "report_draft",
      "Propose a reply message to the originating conversation. The user reviews, edits and approves it before it is sent. Never try to send messages any other way.",
      {
        body: z.string(),
        channel: z.string().describe("Connector to send through; defaults to the originating one").optional(),
        targetRef: z
          .string()
          .describe(
            "Reply target; defaults to the originating thread. REQUIRED when there is none (chat): slack = user id U… for a DM (slack_find_user) or channelId[:threadTs]; gmail = existing thread id",
          )
          .optional(),
      },
      async (input) => {
        const channel = input.channel ?? args.defaultChannel;
        const targetRef = input.targetRef ?? args.defaultTargetRef ?? "";
        if (!channel) {
          return ok({
            error:
              'no channel — this task has no originating conversation, so pass channel explicitly (e.g. "slack" or "gmail") together with a concrete targetRef.',
          });
        }
        // An empty target makes an unsendable draft — the approve button would
        // fail. Chat-born drafts have no originating thread, so the model must
        // resolve a concrete target before drafting.
        if (!targetRef) {
          return ok({
            error:
              "no reply target — this draft would fail on approval. Resolve a concrete targetRef first, then call report_draft again: slack = a user id (U…) for a DM (find it with mcp__ami__slack_find_user) or channelId / channelId:threadTs for a channel or thread; gmail = an existing thread id (find it with mcp__ami__gmail_search).",
          });
        }
        // The enforcement iteration: every draft body gets a second pass
        // against the user's voice card for the channel before it's stored.
        const body = await enforceStyleOnDraft(db, channel, input.body);
        // Drafts proposed from chat get a todo card so the approval flow has a
        // home on the to-do list ("reply drafted — review & send").
        let draftTodoId = todoId;
        if (todoId.startsWith("chat:")) {
          const { insertTodo, insertSignal, markTriaged } = await import("@ami/db");
          // A synthetic chat signal gives the card its source: the ami chat
          // icon and a link back to the conversation the draft came from.
          const chatSession = todoId.slice("chat:".length);
          const sigId = insertSignal(db, "chat", null, {
            externalId: `chat:${chatSession}:draft:${Date.now()}`,
            kind: "message",
            title: `Send reply via ${channel}`,
            body: `Drafted in chat: ${body.slice(0, 600)}`,
            author: "ami chat",
            url: `/chat/${chatSession}`,
            threadRef: chatSession,
            raw: null,
            occurredAt: new Date().toISOString(),
          });
          if (sigId) markTriaged(db, [sigId]);
          draftTodoId = insertTodo(db, {
            signalId: sigId,
            type: "task",
            title: `Send reply via ${channel}${targetRef ? ` (${targetRef.slice(0, 40)})` : ""}`,
            summary: `Drafted in chat: ${body.slice(0, 140)}`,
            entityIds: [],
          });
          publish({ type: "todo.created", todoId: draftTodoId });
        }
        const id = insertDraft(db, {
          todoId: draftTodoId,
          runId: todoId.startsWith("chat:") ? null : runId,
          channel,
          targetRef,
          body,
        });
        publish({ type: "draft.created", draftId: id, todoId: draftTodoId });
        // Echo the final body — the style pass may have reworded the input.
        return ok({ draftId: id, todoId: draftTodoId, body });
      },
    ),
        ]),
  ];

  // Connector actions (excluding send-type ones) with the account auth bound in.
  for (const connector of allConnectors()) {
    const auth = accountAuth(db, connector.id);
    if (!auth && connector.meta.authKind !== "none") continue;
    for (const action of connector.actions) {
      if (action.isSend) continue;
      // Read-only surface: side-effect actions don't exist at all.
      if (args.readOnly && !action.readOnly) continue;
      // Approval-gated actions need a human on the other end — unattended runs
      // (background agents) don't get the tool at all.
      if (action.needsApproval && args.allowAskUser === false) continue;
      tools.push(
        tool(
          action.name,
          action.description,
          action.schema,
          async (input: any) => {
            if (action.needsApproval) {
              const detail = JSON.stringify(input, null, 1).slice(0, 800);
              const answer = await askUser(db, publish, {
                runId,
                todoId: todoId.startsWith("bg:") ? null : todoId,
                sessionId: args.sessionId ?? null,
                kind: "permission",
                question: `Approve ${action.name}?${typeof input?.reason === "string" ? `\n\n${input.reason}` : ""}\n\n\`\`\`json\n${detail}\n\`\`\``,
                options: ["approve", "deny"],
              });
              if (answer.trim().toLowerCase() !== "approve") {
                return ok({ ok: false, error: `the user did not approve this call (answer: ${answer}) — do not retry it; continue without it or propose the change as an artifact` });
              }
            }
            const result = await action.run(auth ?? {}, input);
            return ok(result);
          },
          action.readOnly ? { annotations: { readOnlyHint: true } } : undefined,
        ),
      );
    }
  }

  if (args.extraTools) tools.push(...args.extraTools);
  return createSdkMcpServer({ name: "ami", tools });
}
