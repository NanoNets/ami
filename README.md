# Ami - your AI clone

https://github.com/user-attachments/assets/c32129ab-b041-44ac-bfe4-d3b6386c7dcd

Ami is a local agent harness that acts as your clone, not a separate co-worker. It connects to apps, data, repositories, tools with your personal tokens, maintains a live to-do list, learns how you do tasks, and executes the "busy work" tasks on your behalf. It contructs a context graph memory of you and updates entities, relationships, feedback, decisions, writing style, to get more autonomous the more you use it.

Ami runs on your machine. Data lives under `~/.ami/` (SQLite + markdown memory). Nothing is shared with your org. Ami has exactly the access you have, i.e., it can only reach what you can reach. And nothing ships or gets sent without your click.

## Quick start

The only prerequisite is Node ≥ 20.

```sh
git clone https://github.com/NanoNets/ami.git && cd ami
./ami
```

`./ami` bootstraps everything on first run. 
- It installs dependencies (pnpm via corepack)
- builds the console and starts the server

Open http://localhost:4141 and walk through onboarding. Configure your model and connect tools using personal tokens. Both are stored only on this machine.

Ami speaks the Anthropic Messages API as a protocol. Switching provider is a single change in Settings → Models:

- API key — your provider's key (Anthropic's by default).
- Base URL — leave blank for Anthropic, or point it at any Anthropic-compatible endpoint.
- Model for triage & task runs — the main model (default `claude-opus-4-8`). Free-text: any model name your endpoint serves.
- Model for memory agents — the cheap/utility model (default `claude-sonnet-4-6`). It runs on every substantive signal, so on a local setup this is the knob to point at a small model.

The Claude Agent SDK honors the base URL, and its internal small-model calls are remapped to your utility model. Structured outputs automatically fall back to schema-prompted JSON on non-Anthropic endpoints, so compat providers work without tweaks.

Hosted open models - Kimi, GLM, DeepSeek, and MiniMax all publish Anthropic-compatible base URLs (e.g. `https://api.moonshot.ai/anthropic` for Kimi). Set the base URL, their key, and their model names.

Fully local — put a LiteLLM proxy in front of Ollama / vLLM / llama.cpp; it exposes the Anthropic protocol:

```sh
ollama pull qwen3:32b
pip install 'litellm[proxy]'
litellm --model ollama/qwen3:32b     # Anthropic-compatible endpoint on :4000
```

Then in Settings → Models: base URL `http://localhost:4000`, model `ollama/qwen3:32b` for both knobs (or a smaller model for memory agents), and any placeholder key if the proxy has no auth. With connectors polling local-first, nothing leaves your machine at all.

```sh
./ami update       # pull the latest, reinstall, rebuild
./ami build        # force-rebuild the console
```

Optional extras, install if you want the matching feature:

- **`gh` CLI** — coding tasks need it to open PRs (`brew install gh`)
- **`ffmpeg` + `whisper-cpp`** — a local meeting recorder with on-device transcription (`brew install ffmpeg whisper-cpp`)

## The console

| Page | What it does |
|---|---|
| **Home** | A homescreen with to-dos and meetings |
| **To-do** | A universal list of to-dos from every connected tool |
| **Chat** | A copilot chat with the same tool surface as to-do runs. You can ask questions, fire off work, create to-dos, update memory |
| **Agents** | A page to create agents that run on a schedule |
| **History** | An archive of past to-dos |
| **Memory** | A visualization of the current memory as a context graph |
| **Settings** | Connectors, models, knobs, usage data |

Global search and notifications live in the header navbar.

## How it works

1. **Ingest** — a poller pulls new mentions, DMs, emails, invites, notifications through each connector using your personal tokens / API keys.
2. **Triage** — a Claude call classifies each signal as task / FYI / ignore with a due date. Entities and relationships flow into the knowledge base. Your feedback (corrections, dismissals, overrides) become decision traces in the knowledge base that steer future triage.
3. **Act** — each to-do item has five actions:
   - **Plan** — explores read-only and proposes an editable plan.
   - **Start** — runs the task in an isolated Claude Agent SDK session.
   - **Resolve** — indicates you did it yourself and updates knowledge base
   - **Dismiss / Snooze** — dismissals discourages future triage of similar tasks, snoozed tasks return tomorrow.
4. **Review** — deliverables (PR link, doc, event, meeting link) land on the task page along with a drafted reply. Ami never sends anything itself. You edit/approve, then it posts to the originating Slack thread / email thread from your account. Your edits are diffed into memory and refine Ami's execution and voice.
5. **Iterate** — feedback on a finished task resumes the same agent session with full context.

Every to-do run and every copilot chat grows the knowledge base.

## The context graph memory

Memory is an Obsidian-style markdown knowledge base at `~/.ami/knowledge/` — dossiers with wiki-links, curated by note agents after each batch of activity, versioned with git so every note has history and restore. It powers:

- **Meeting prep** — attendees resolved against the knowledge base; a brief (who's coming, what matters, open items) lands before each meeting.
- **Meeting recorder** — record mic + system audio locally, transcribe on-device with whisper.cpp, feed the transcript into memory. No audio leaves the machine.
- **Style** — Ami learns how you write from your real messages and your edits to its drafts; replies come out in your voice.
- **Decision traces** — past exceptions, overrides, and feedback are retrieved when similar situations recur, so Ami decides the way you already decided.

## Connectors

Ami currently has a limited number of connectors. But it is skilled to build any tool connector for you.

- Go to Settings
- Click on "Add a connector" at the bottom of the connector list.
- Specify the name, homepage url, and your intent on using the connector

Ami will build the connector (using your claude code and your API key) and make it available to task runs and copilot chats.

## Models — Anthropic, open source, or local

Ami speaks the Anthropic Messages API as a protocol. Every LLM call follows a single endpoint setting, so switching provider is a single change in Settings → Models:

- API key — your provider's key (Anthropic's by default).
- Base URL — leave blank for Anthropic, or point it at any Anthropic-compatible endpoint.
- Model for triage & task runs — the main model (default `claude-opus-4-8`). Free-text: any model name your endpoint serves.
- Model for memory agents — the cheap/utility model (default `claude-sonnet-4-6`). It runs on every substantive signal, so on a local setup this is the knob to point at a small model.

The Claude Agent SDK honors the base URL, and its internal small-model calls are remapped to your utility model. Structured outputs automatically fall back to schema-prompted JSON on non-Anthropic endpoints, so compat providers work without tweaks.

**Hosted open models** — Kimi, GLM, DeepSeek, and MiniMax all publish Anthropic-compatible base URLs (e.g. `https://api.moonshot.ai/anthropic` for Kimi). Set the base URL, their key, and their model names.

**Fully local** — put a LiteLLM proxy in front of Ollama / vLLM / llama.cpp; it exposes the Anthropic protocol:

```sh
ollama pull qwen3:32b
pip install 'litellm[proxy]'
litellm --model ollama/qwen3:32b     # Anthropic-compatible endpoint on :4000
```

Then in **Settings → Models**: base URL `http://localhost:4000`, model `ollama/qwen3:32b` for both knobs (or a smaller model for memory agents), and any placeholder key if the proxy has no auth. With connectors polling local-first tools, nothing leaves your machine at all.

## Data & privacy

Everything Ami knows lives under `~/.ami/`. 
- `ami.db` (SQLite — signals, todos, runs, settings, tokens)
- `knowledge/` (the markdown knowledge base, git-versioned)
- `worktrees/` (isolated coding checkouts), 
- `bg-tasks/` and `events/` (background agent state). 

Delete the directory and Ami forgets everything. The only outbound calls are to your configured model endpoint (Anthropic by default) and to the tools you connected with your tokens.

## WIP

Ami is built as an internal tool. It's still in development stage, and we'll push a stable release soon. Stay tuned.

## License

MIT
