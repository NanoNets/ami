import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const connectorAccounts = sqliteTable("connector_accounts", {
  id: text("id").primaryKey(),
  connector: text("connector").notNull(),
  label: text("label").notNull().default(""),
  authJson: text("auth_json").notNull(),
  status: text("status").notNull().default("connected"), // connected|error|disabled
  error: text("error"),
  /** When the one-time first-connect history backfill completed. */
  bootstrappedAt: text("bootstrapped_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const syncCursors = sqliteTable(
  "sync_cursors",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    stream: text("stream").notNull(),
    cursor: text("cursor"),
    lastPolledAt: text("last_polled_at"),
  },
  (t) => [uniqueIndex("sync_cursors_account_stream").on(t.accountId, t.stream)],
);

export const signals = sqliteTable(
  "signals",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id"),
    connector: text("connector").notNull(),
    externalId: text("external_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull().default(""),
    body: text("body").notNull().default(""),
    author: text("author").notNull().default(""),
    url: text("url"),
    threadRef: text("thread_ref"),
    rawJson: text("raw_json"),
    receivedAt: text("received_at").notNull(),
    triagedAt: text("triaged_at"),
  },
  (t) => [
    uniqueIndex("signals_connector_external").on(t.connector, t.externalId),
    index("signals_untriaged").on(t.triagedAt),
  ],
);

export const todos = sqliteTable(
  "todos",
  {
    id: text("id").primaryKey(),
    signalId: text("signal_id"),
    type: text("type").notNull(), // task|fyi
    status: text("status").notNull().default("open"),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    priority: integer("priority").notNull().default(3),
    taskKind: text("task_kind").notNull().default("other"),
    dueAt: text("due_at"), // date-only YYYY-MM-DD; tasks default to +7 days
    snoozedUntil: text("snoozed_until"),
    planMd: text("plan_md"),
    planApprovedAt: text("plan_approved_at"),
    entityIdsJson: text("entity_ids_json"),
    projectId: text("project_id"), // pinned code project (coding tasks)
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("todos_status").on(t.status)],
);

export const taskRuns = sqliteTable(
  "task_runs",
  {
    id: text("id").primaryKey(),
    todoId: text("todo_id").notNull(),
    sessionId: text("session_id"),
    mode: text("mode").notNull(), // plan|auto
    status: text("status").notNull().default("queued"),
    workspaceDir: text("workspace_dir"),
    prompt: text("prompt"),
    error: text("error"),
    parentRunId: text("parent_run_id"),
    policy: text("policy"), // full-auto|ask-risky|ask-all (coding runs)
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("task_runs_todo").on(t.todoId)],
);

export const taskSteps = sqliteTable(
  "task_steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    detailJson: text("detail_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("task_steps_run").on(t.runId)],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    contentMd: text("content_md"),
    metaJson: text("meta_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("artifacts_run").on(t.runId)],
);

export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    todoId: text("todo_id").notNull(),
    runId: text("run_id"),
    channel: text("channel").notNull(),
    targetRef: text("target_ref").notNull().default(""),
    body: text("body").notNull(),
    editedBody: text("edited_body"),
    status: text("status").notNull().default("pending"),
    sentExternalId: text("sent_external_id"),
    createdAt: text("created_at").notNull(),
    sentAt: text("sent_at"),
  },
  (t) => [index("drafts_todo").on(t.todoId)],
);

export const feedback = sqliteTable("feedback", {
  id: text("id").primaryKey(),
  todoId: text("todo_id").notNull(),
  runId: text("run_id"),
  scope: text("scope").notNull(), // plan|execution|draft
  text: text("text").notNull(),
  createdAt: text("created_at").notNull(),
});

export const memoryNodes = sqliteTable(
  "memory_nodes",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    attrsJson: text("attrs_json"),
    salience: real("salience").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("memory_nodes_type_name").on(t.type, t.name)],
);

export const memoryEdges = sqliteTable(
  "memory_edges",
  {
    id: text("id").primaryKey(),
    srcId: text("src_id").notNull(),
    dstId: text("dst_id").notNull(),
    rel: text("rel").notNull(),
    weight: real("weight").notNull().default(1),
    evidenceSignalId: text("evidence_signal_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("memory_edges_src_dst_rel").on(t.srcId, t.dstId, t.rel)],
);

export const decisionTraces = sqliteTable(
  "decision_traces",
  {
    id: text("id").primaryKey(),
    todoId: text("todo_id"),
    runId: text("run_id"),
    kind: text("kind").notNull(),
    situation: text("situation").notNull(),
    decision: text("decision").notNull(),
    rationale: text("rationale").notNull().default(""),
    outcome: text("outcome").notNull().default(""),
    entityIdsJson: text("entity_ids_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("decision_traces_kind").on(t.kind)],
);

export const styleProfiles = sqliteTable("style_profiles", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull().unique(), // slack|email|generic
  profileMd: text("profile_md").notNull(),
  sampleCount: integer("sample_count").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

/** Copilot chat sessions — resumable via the Agent SDK session id. */
export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  title: text("title"),
  sdkSessionId: text("sdk_session_id"),
  archived: integer("archived").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const chatTurns = sqliteTable(
  "chat_turns",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    role: text("role").notNull(), // user|assistant
    contentJson: text("content_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("chat_turns_session").on(t.sessionId)],
);

/** Registered local git repos that coding tasks can be pinned to. */
export const codeProjects = sqliteTable("code_projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull().unique(),
  defaultBranch: text("default_branch").notNull().default("main"),
  createdAt: text("created_at").notNull(),
});

/** Human-input requests from agents mid-run: questions and permission asks.
 * The console answers them; the awaiting agent resumes with the answer. */
export const questions = sqliteTable(
  "questions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id"),
    todoId: text("todo_id"),
    sessionId: text("session_id"), // chat session, when asked from chat
    kind: text("kind").notNull().default("question"), // question|permission
    question: text("question").notNull(),
    optionsJson: text("options_json"), // string[] of suggested answers
    answer: text("answer"),
    status: text("status").notNull().default("pending"), // pending|answered|timeout
    createdAt: text("created_at").notNull(),
    answeredAt: text("answered_at"),
  },
  (t) => [index("questions_status").on(t.status), index("questions_run").on(t.runId)],
);

/** Per-call LLM usage: tokens + estimated cost by use case, optionally tied to a run/todo. */
export const llmUsage = sqliteTable(
  "llm_usage",
  {
    id: text("id").primaryKey(),
    useCase: text("use_case").notNull(), // triage|task_run|note_creation|note_curation|agent_notes|style_learner|rule_distiller|resolve
    subUseCase: text("sub_use_case"),
    model: text("model").notNull().default(""),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    runId: text("run_id"),
    todoId: text("todo_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("llm_usage_use_case").on(t.useCase), index("llm_usage_run").on(t.runId)],
);

