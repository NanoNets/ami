# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Ami is

A local AI clone: connectors poll the user's tools with their personal tokens, signals get triaged into a to-do list, and Claude Agent SDK sessions execute tasks, draft replies, and grow a markdown knowledge base. Everything runs on the user's machine; all state lives under `~/.ami/` (override with `AMI_HOME` — tests do this with temp dirs).

## Commands

```sh
pnpm dev                 # build console once, run server (tsx watch — restarts on file change) on :4141
pnpm dev:console         # Vite dev server with HMR (proxies API to the server)
pnpm -r typecheck        # tsc across all packages — run after any change
pnpm -r test             # vitest (suites live in packages/{shared,db,memory}/test/)
pnpm --filter @ami/memory exec vitest run test/llm.test.ts        # one file
pnpm --filter @ami/memory exec vitest run -t "parses clean JSON"  # one test
```

There is no build step for packages — every `package.json` points `main` at `src/index.ts` and the server runs via `tsx`. Only the console builds (Vite). Server port: `AMI_PORT` (default 4141). `AMI_FAKE_LLM=1` disables LLM agents and uses deterministic fakes (UI dev without tokens).

## Architecture

pnpm workspace, TypeScript ESM throughout. Dependency layering (lower → higher):

- **`packages/shared`** — types, zod schemas, the `AmiEvent` SSE union, `WRITING_STYLE`. Imported by the browser console too, so it must stay free of Node-only deps.
- **`packages/db`** — better-sqlite3 + drizzle. Schema in `src/schema.ts`; **every new table/column must also be added to `verifySchema`'s REQUIRED_COLUMNS** (a boot-time guard that throws when the DB file doesn't match). Repos in `src/repos.ts`, including `insertLlmUsage` (call it for every LLM call, with a per-feature `useCase`; unknown models record cost 0). Settings are DB rows via `getSetting`/`setSetting`.
- **`packages/memory`** — the knowledge base (`~/.ami/knowledge/`, Obsidian-style markdown with `[[wiki-links]]`, git-versioned via `version-history.ts`), knowledge agents (`runKnowledgeAgent`), deterministic search, style profiles, **and the LLM provider module `src/llm.ts`** (see below).
- **`packages/connectors`** — one `AmiConnector` per tool (contract in `src/types.ts`): cursor-based `poll` streams, `bootstrap`, and actions named `<id>_*` flagged `readOnly`, `isSend`, or `needsApproval`. Custom connectors are user-built ESM modules at `~/.ami/connectors/<id>/connector.mjs`, loaded into the same registry (`custom.ts`).
- **`packages/triage`** — classifies each signal as task/FYI/ignore; user corrections become few-shot examples and distilled rules (`feedback.ts`).
- **`packages/engine`** — task runner (`runner.ts`), copilot chat (`chat.ts`), the `ami` MCP server (`mcp-server.ts`), background agents (`bg-tasks/`, file-based state in `~/.ami/bg-tasks/`), durable event queue (`events/`), coding support (`coding/`: worktrees at `~/.ami/worktrees/<runId>`, managed clones at `~/.ami/repos/<owner>/<name>`, permission broker, project auto-resolution), connector builder.
- **`apps/server`** — Hono API + SSE bus (`sse.ts`) + `scheduler.ts` (the heartbeat: connector polling, triage, knowledge agents, bg-tasks, events, meeting prep). Serves the built console.
- **`apps/console`** — React + Vite + Tailwind + react-query; talks HTTP + SSE only (`lib/api.ts`, `lib/useSse.ts`).

### LLM calls — one provider module

All model access goes through `packages/memory/src/llm.ts`. Never `new Anthropic(...)` or set `ANTHROPIC_API_KEY` env manually elsewhere:

- `anthropicClient(db)` — direct SDK calls (returns null when no key).
- `llmEnv(db)` — spread into `env` for every Agent SDK `query()` run.
- `parseWithSchema(db, client, params, schema)` — structured output; uses native `output_config` on Anthropic and falls back to schema-in-prompt + validated JSON parse on custom endpoints.
- `kgModel(db)` — the cheap/utility model knob (`kg_model` setting); the main knob is the `model` setting (triage + task runs).

The `llm_base_url` setting points everything at any Anthropic-compatible endpoint (LiteLLM proxy, Kimi, GLM, DeepSeek); blank = Anthropic.

### Invariants

- **Ami never sends anything without user approval.** `isSend` actions (contract: `run(auth, { targetRef, body })`) execute only through the draft-approval flow (`report_draft` → approval card → send). All other non-`isSend` actions are auto-exposed as MCP tools to task runs and chat by `mcp-server.ts` — adding a connector action requires no extra wiring.
- Tokens and keys live only in the settings/connector tables of `~/.ami/ami.db` or `~/.ami/` files — never hardcoded, never logged, never in argv (git auth uses env-based credential helpers, see `coding/managed-repos.ts`).
- Coding runs (`coding = !!project` in `runner.ts`) get worktree/git/Bash; non-coding runs are guarded against editing code via the browser.
- Long-running agent work streams progress as `task_steps` rows + SSE events; follow that pattern (`appendStep`/`persistMessage`) for anything user-visible.

## Repo conventions

- Commits here are authored by the user (Karan) only — no `Co-Authored-By: Claude` trailers.
- The gitignored personal assets (`videos/`, `*.mp4`, `scripts/`, `.claude/`, `agent/`, design-iteration folders) are working material, never to be committed.
- The public history starts at the single `v0.1` commit; full development history is on the local `pre-v01-history` branch.
