# Ami

https://github.com/user-attachments/assets/c32129ab-b041-44ac-bfe4-d3b6386c7dcd

Ami is your AI clone + copilot chat.

It connects to apps, data, repositories, tools with your personal tokens, maintains a live to-do list, learns how you do tasks, executes the "busy work" tasks on your behalf. It constructs a context graph memory of you, with entities, relationships, feedbacks, decisions, writing styles maintained in memory so it can get more autonomous the more you use it.

It runs on your machine. Data lives under `~/.ami/` (SQLite + markdown memory). Ami has exactly the access you have, i.e., it can only reach what you can reach. And nothing ships or gets sent without your click.


## Quick start

```sh
git clone https://github.com/NanoNets/ami.git && cd ami

./ami
```

`./ami` bootstraps everything on first run. 
- installs dependencies (pnpm via corepack)
- builds the console and starts the server

http://localhost:4141 opens with the onboarding screen. 
- Configure your model (Claude API Key / BYO hosted model / Local model).
- Connect tools (Slack is mandatory, connecting others is optional, but highly recommended to get any meaningful output with Ami). You connect using personal tokens.

Both are stored only on this machine.

Optional extras, install if you want the matching feature:

- **`gh` CLI** — coding tasks need it to open PRs (`brew install gh`)
- **`ffmpeg` + `whisper-cpp`** — a local meeting recorder with on-device transcription (`brew install ffmpeg whisper-cpp`)


## Model config

Ami speaks the Anthropic Messages API as a protocol. 

Claude models - Enter your Claude API key.

Hosted open models - Kimi, GLM, DeepSeek, and MiniMax all publish Anthropic-compatible base URLs (e.g. `https://api.moonshot.ai/anthropic` for Kimi). Set the base URL, their key, and their model names.

Fully local — put a LiteLLM proxy in front of Ollama / vLLM / llama.cpp; it exposes the Anthropic protocol:

```sh
ollama pull qwen3:32b
pip install 'litellm[proxy]'
litellm --model ollama/qwen3:32b     # Anthropic-compatible endpoint on :4000
```

Then in Settings → Models: base URL `http://localhost:4000`, model `ollama/qwen3:32b` for both knobs (or a smaller model for memory agents), and any placeholder key if the proxy has no auth. With connectors polling local-first, nothing leaves your machine at all.


## Updating Ami

```sh
./ami update       # pull the latest, reinstall, rebuild
./ami build        # force-rebuild the console
```


## Ami console

| Page | What it does |
|---|---|
| **Home** | A homescreen with to-dos and meetings |
| **To-do** | A universal list of to-dos maintained from every connected tool. You can plan or start to-do task runs here. |
| **Chat** | A copilot chat with the same tool surface as to-do runs. You can ask questions, fire off work, create to-dos, update memory |
| **Agents** | A page to create agents that run on a schedule |
| **History** | An archive of past to-dos |
| **Memory** | A visualization of the current memory as a context graph |
| **Settings** | Connectors, models, knobs, usage data |

Global search and notifications live in the header navbar.

## How it works

1. **Ingest**: a poller pulls new mentions, DMs, emails, invites, notifications through each connector.
2. **Triage**: an LLM call classifies each signal as task / FYI / ignore with a due date. Your context graph updates. Your feedback (corrections, dismissals, overrides) become decision traces in the context graph that steer future triage.
3. **Act**: each to-do item has five possible actions:
   - **Plan**: explores the task read-only and proposes an editable plan.
   - **Start**: runs the task in an isolated agent session.
   - **Resolve**: indicates to Ami you did it yourself, simply updates context graph
   - **Dismiss / Snooze**: dismissals discourages future triage of similar tasks, snoozed tasks return tomorrow.
4. **Review**: deliverables (PR link, doc, event, meeting link) land on the task page after task runs, along with a drafted reply. Ami never sends anything itself. You edit/approve, then it posts to the originating Slack thread / email thread / Linear ticket from your account. Your feedback, task iterations, edits are diffed into memory and refine Ami's future execution and voice.
5. **Iterate**: feedback on a finished task resumes the same agent session with full context.

Every to-do run and every copilot chat grows the context graph.


## The context graph memory

Memory is an Obsidian-style markdown context graph at `~/.ami/knowledge/`. These are dossiers with wiki-links, curated by Ami note agents after each batch of activity, versioned with git so every note has history and restore. 

Besides being the first reference Ami seeks for tasks runs and chats, it also powers:

- **Meeting prep**: attendees resolved against the knowledge base, and a brief (who's coming, what matters, open items) before each meeting.
- **Meeting recorder**: record mic + system audio locally, transcribe on-device with whisper.cpp, feed the transcript into memory. No audio leaves the machine.
- **Style**: Ami learns how you write from your real messages and your edits to its drafts, so replies come out in your voice.
- **Decision traces**: past exceptions, overrides, feedbacks are retrieved when similar situations recur, so Ami auto-decides the way you manually decided earlier.


## Connectors

Currently, Ami currently has a limited number of connectors. But it is skilled to build any tool connector for you.

- Go to Settings
- Click on "Add a connector" at the bottom of the connector list.
- Specify the name, homepage url, and your intent on using the connector

Ami will build a connector (using your LLM tokens) and make it available to task runs and copilot chats.


## Data & privacy

Everything Ami knows lives under `~/.ami/`. 
- `ami.db` (SQLite — signals, todos, runs, settings, tokens)
- `knowledge/` (the markdown knowledge base, git-versioned)
- `worktrees/` (isolated coding checkouts), 
- `bg-tasks/` and `events/` (background agent state). 

Delete the directory and Ami forgets everything. The only outbound calls are to your configured model endpoint (Anthropic / Self-hosted / Local) and to the tools you connected with your tokens.


## WIP

Ami is built as an internal tool. We found it useful so wanted to share it. It's still in development stage, and we'll push a more stable release soon. Stay tuned.


## License

MIT
