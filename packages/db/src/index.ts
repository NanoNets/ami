import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as schema from "./schema.js";

export * as schema from "./schema.js";
export * from "./schema.js";
export * from "./repos.js";

export type Db = BetterSQLite3Database<typeof schema>;

let _db: Db | null = null;
let _sqlite: Database.Database | null = null;

export function amiHome(): string {
  const home = process.env.AMI_HOME ?? path.join(os.homedir(), ".ami");
  fs.mkdirSync(home, { recursive: true });
  return home;
}

export function openDb(dbPath?: string): Db {
  if (_db) return _db;
  const file = dbPath ?? process.env.AMI_DB_PATH ?? path.join(amiHome(), "ami.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  migrate(sqlite);
  verifySchema(sqlite, file);
  _sqlite = sqlite;
  _db = drizzle(sqlite, { schema });
  return _db;
}

export function rawSqlite(): Database.Database {
  if (!_sqlite) throw new Error("db not opened");
  return _sqlite;
}

/** For tests: open an isolated in-memory database. */
export function openTestDb(): Db {
  const sqlite = new Database(":memory:");
  migrate(sqlite);
  _sqlite = sqlite;
  _db = drizzle(sqlite, { schema });
  return _db;
}

export function closeDb(): void {
  _sqlite?.close();
  _sqlite = null;
  _db = null;
}

/** Columns that must exist per table. Catches the case where the DB file was
 * created by another application: CREATE TABLE IF NOT EXISTS silently keeps a
 * foreign table, and we'd otherwise crash mid-request with "no such column". */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  settings: ["key", "value"],
  connector_accounts: ["id", "connector", "auth_json", "status"],
  sync_cursors: ["id", "account_id", "stream", "cursor"],
  signals: ["id", "connector", "external_id", "thread_ref", "triaged_at"],
  todos: ["id", "signal_id", "status", "task_kind", "plan_md", "entity_ids_json"],
  task_runs: ["id", "todo_id", "session_id", "mode", "parent_run_id"],
  task_steps: ["id", "run_id", "seq", "kind", "detail_json"],
  artifacts: ["id", "run_id", "type", "content_md"],
  drafts: ["id", "todo_id", "channel", "target_ref", "edited_body"],
  feedback: ["id", "todo_id", "scope", "text"],
  memory_nodes: ["id", "type", "name", "salience"],
  memory_edges: ["id", "src_id", "dst_id", "rel", "weight"],
  decision_traces: ["id", "kind", "situation", "decision", "entity_ids_json"],
  style_profiles: ["id", "channel", "profile_md"],
  llm_usage: ["id", "use_case", "model", "input_tokens", "cost_usd"],
  questions: ["id", "kind", "question", "status", "answer"],
  code_projects: ["id", "name", "path", "default_branch"],
  chat_sessions: ["id", "title", "sdk_session_id", "archived"],
  chat_turns: ["id", "session_id", "seq", "role", "content_json"],
};

function verifySchema(sqlite: Database.Database, file: string): void {
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = new Set(
      (sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    const missing = cols.filter((c) => !actual.has(c));
    if (missing.length > 0) {
      throw new Error(
        `Database ${file} has an incompatible "${table}" table (missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}). ` +
          `It was likely created by another application. Either rename the conflicting table ` +
          `(sqlite3 ${file} 'ALTER TABLE ${table} RENAME TO ${table}_legacy') and restart, ` +
          `or point Ami at a fresh file with AMI_DB_PATH.`,
      );
    }
  }
}

function migrate(sqlite: Database.Database): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS connector_accounts (
  id TEXT PRIMARY KEY,
  connector TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  auth_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_cursors (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  cursor TEXT,
  last_polled_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_cursors_account_stream ON sync_cursors(account_id, stream);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  connector TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  url TEXT,
  thread_ref TEXT,
  raw_json TEXT,
  received_at TEXT NOT NULL,
  triaged_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS signals_connector_external ON signals(connector, external_id);
CREATE INDEX IF NOT EXISTS signals_untriaged ON signals(triaged_at);

CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  signal_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 3,
  task_kind TEXT NOT NULL DEFAULT 'other',
  due_at TEXT,
  snoozed_until TEXT,
  plan_md TEXT,
  plan_approved_at TEXT,
  entity_ids_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS todos_status ON todos(status);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  todo_id TEXT NOT NULL,
  session_id TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  workspace_dir TEXT,
  prompt TEXT,
  error TEXT,
  parent_run_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_runs_todo ON task_runs(todo_id);

CREATE TABLE IF NOT EXISTS task_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_steps_run ON task_steps(run_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  content_md TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_run ON artifacts(run_id);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  todo_id TEXT NOT NULL,
  run_id TEXT,
  channel TEXT NOT NULL,
  target_ref TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  edited_body TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  sent_external_id TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS drafts_todo ON drafts(todo_id);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  todo_id TEXT NOT NULL,
  run_id TEXT,
  scope TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  attrs_json TEXT,
  salience REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_nodes_type_name ON memory_nodes(type, name);

CREATE TABLE IF NOT EXISTS memory_edges (
  id TEXT PRIMARY KEY,
  src_id TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  rel TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  evidence_signal_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_edges_src_dst_rel ON memory_edges(src_id, dst_id, rel);

CREATE TABLE IF NOT EXISTS decision_traces (
  id TEXT PRIMARY KEY,
  todo_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  situation TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  entity_ids_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decision_traces_kind ON decision_traces(kind);

CREATE TABLE IF NOT EXISTS style_profiles (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL UNIQUE,
  profile_md TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  sdk_session_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_turns_session ON chat_turns(session_id);

CREATE TABLE IF NOT EXISTS code_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  todo_id TEXT,
  session_id TEXT,
  kind TEXT NOT NULL DEFAULT 'question',
  question TEXT NOT NULL,
  options_json TEXT,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS questions_status ON questions(status);
CREATE INDEX IF NOT EXISTS questions_run ON questions(run_id);

CREATE TABLE IF NOT EXISTS llm_usage (
  id TEXT PRIMARY KEY,
  use_case TEXT NOT NULL,
  sub_use_case TEXT,
  model TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  run_id TEXT,
  todo_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS llm_usage_use_case ON llm_usage(use_case);
CREATE INDEX IF NOT EXISTS llm_usage_run ON llm_usage(run_id);

-- FTS5 mirrors, kept in sync by the repo layer (rowid-mapped via content-less tables)
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(node_id UNINDEXED, name, summary);
CREATE VIRTUAL TABLE IF NOT EXISTS traces_fts USING fts5(trace_id UNINDEXED, situation, decision, rationale, outcome);
CREATE VIRTUAL TABLE IF NOT EXISTS signals_fts USING fts5(signal_id UNINDEXED, title, body);
`);

  // Additive columns on pre-existing tables (CREATE TABLE IF NOT EXISTS won't add them).
  ensureColumn(sqlite, "todos", "project_id", "TEXT");
  ensureColumn(sqlite, "todos", "due_at", "TEXT");
  ensureColumn(sqlite, "task_runs", "policy", "TEXT");
  ensureColumn(sqlite, "connector_accounts", "bootstrapped_at", "TEXT");
}

function ensureColumn(sqlite: Database.Database, table: string, column: string, type: string): void {
  const cols = sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
