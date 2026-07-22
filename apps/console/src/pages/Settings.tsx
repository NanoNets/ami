import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { toast, errMsg } from "../lib/toast";
import { useIngestProgress } from "../lib/ingest";
import { ConnectorIcon } from "../components/ConnectorIcon";
import { CheckIcon, ExternalIcon, LockIcon, Spinner, XIcon } from "../components/icons";
import { Disclosure } from "../components/ui";

const MODEL_OPTIONS = [
  { id: "claude-opus-4-8", label: "Opus — most capable" },
  { id: "claude-sonnet-4-6", label: "Sonnet — balanced" },
  { id: "claude-haiku-4-5", label: "Haiku — fastest, cheapest" },
];

export default function Settings() {
  const setup = useQuery({ queryKey: ["setup"], queryFn: api.setupStatus });
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState("");

  return (
    <div className="max-w-2xl space-y-8">
      <section>
        <h2 className="text-sm uppercase tracking-wider text-mut mb-3">Who you are</h2>
        <IdentityCard />
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wider text-mut mb-3">Connectors</h2>
        <ConnectorCards />
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wider text-mut mb-3">Model provider</h2>
        <div className="card p-4 space-y-3">
          <div className="flex gap-2">
            <input
              className="input"
              type="password"
              placeholder={setup.data?.hasApiKey ? "API key set — paste to rotate" : "sk-ant-… (or your provider's key)"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button
              className="btn btn-primary shrink-0"
              disabled={!apiKey.trim()}
              onClick={async () => {
                try {
                  const res = await api.saveApiKey(apiKey.trim());
                  if (!res.ok) throw new Error(res.error ?? "validation failed");
                  toast("API key saved");
                } catch (e) {
                  toast.error(`Failed: ${errMsg(e)}`);
                }
                setApiKey("");
                void qc.invalidateQueries({ queryKey: ["setup"] });
              }}
            >
              Save key
            </button>
          </div>
          <BaseUrlRow
            key={`base-${setup.data?.baseUrl ?? ""}`}
            current={setup.data?.baseUrl ?? ""}
            onSaved={() => void qc.invalidateQueries({ queryKey: ["setup"] })}
          />
          <ModelField
            key={`model-${setup.data?.model ?? ""}`}
            label="Model for triage & task runs:"
            value={setup.data?.model ?? "claude-opus-4-8"}
            onSave={async (m) => {
              await api.saveModel(m);
              toast("Model updated");
              void qc.invalidateQueries({ queryKey: ["setup"] });
            }}
          />
          <ModelField
            key={`kg-${setup.data?.kgModel ?? ""}`}
            label="Model for memory agents:"
            value={setup.data?.kgModel ?? "claude-sonnet-4-6"}
            hint="runs on every substantive signal"
            onSave={async (m) => {
              await api.saveKgModel(m);
              toast("Model updated");
              void qc.invalidateQueries({ queryKey: ["setup"] });
            }}
          />
          <p className="text-xs text-mut">
            Leave the endpoint blank to use Anthropic. Any Anthropic-compatible endpoint works: hosted
            open models (Kimi, GLM, DeepSeek) or a local LiteLLM proxy in front of Ollama / vLLM — set
            the endpoint, the model names your provider serves, and its key.
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wider text-mut mb-3">Meetings</h2>
        <div className="space-y-3">
          <GranolaCard />
          <RecorderCard />
        </div>
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wider text-mut mb-3">Code projects</h2>
        <ProjectsCard />
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wider text-mut mb-3">LLM usage</h2>
        <UsageCard />
      </section>
    </div>
  );
}

/** Anthropic-compatible endpoint override; empty = api.anthropic.com. */
function BaseUrlRow({ current, onSaved }: { current: string; onSaved: () => void }) {
  const [value, setValue] = useState(current);
  const dirty = value.trim().replace(/\/+$/, "") !== current;
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-mut shrink-0">API endpoint:</span>
      <input
        className="input"
        placeholder="https://api.anthropic.com (default)"
        defaultValue={current}
        onChange={(e) => setValue(e.target.value)}
      />
      <button
        className="btn shrink-0"
        disabled={!dirty}
        onClick={async () => {
          try {
            const res = await api.saveBaseUrl(value.trim());
            if (!res.ok) throw new Error(res.error ?? "save failed");
            toast(value.trim() ? "Endpoint saved — re-save your key to validate it" : "Back to Anthropic");
          } catch (e) {
            toast.error(`Failed: ${errMsg(e)}`);
          }
          onSaved();
        }}
      >
        Save
      </button>
    </div>
  );
}

/** Free-text model name (any name the configured endpoint serves), with the
 * Claude models offered as suggestions. Saves on Enter or blur. */
function ModelField({
  label,
  value,
  hint,
  onSave,
}: {
  label: string;
  value: string;
  hint?: string;
  onSave: (model: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const listId = useId();
  const commit = () => {
    const m = draft.trim();
    if (m && m !== value) void onSave(m);
  };
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-mut shrink-0">{label}</span>
      <input
        className="input w-64"
        list={listId}
        defaultValue={value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      <datalist id={listId}>
        {MODEL_OPTIONS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </datalist>
      {hint && <span className="text-xs text-mut">{hint}</span>}
    </div>
  );
}

/** "reading your history…" upgraded to the live ingest line when the SSE
 * stream has one for this connector ("Gmail: scanned 214 emails"). */
function BootstrapBadge({ label }: { label: string }) {
  const progress = useIngestProgress();
  const line = progress?.startsWith(label) ? progress : "reading your history…";
  return (
    <span className="text-xs text-acc inline-flex items-center gap-1.5 min-w-0">
      <Spinner /> <span className="truncate">{line}</span>
    </span>
  );
}

function GranolaCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["granola"], queryFn: api.granolaStatus });
  return (
    <div className="card p-4">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <p className="text-sm font-medium">Granola meeting notes</p>
          <p className="text-xs text-mut mt-1">
            Reads your local Granola meetings into memory.
            {data && !data.available && (
              <span className="text-bad"> Granola not detected on this Mac (install + sign in first).</span>
            )}
          </p>
        </div>
        <button
          className={`btn shrink-0 ${data?.enabled ? "btn-primary" : ""}`}
          disabled={!data?.available && !data?.enabled}
          onClick={async () => {
            await api.setGranola(!data?.enabled);
            toast(data?.enabled ? "Granola disabled" : "Granola enabled");
            void qc.invalidateQueries({ queryKey: ["granola"] });
          }}
        >
          {data?.enabled ? "Enabled" : "Enable"}
        </button>
      </div>
      <div className="mt-2">
        <Disclosure>
          <p>
            Notes flow into memory dossiers, action items you committed to become tasks, and new
            meetings can wake background agents.
          </p>
        </Disclosure>
      </div>
    </div>
  );
}

function RecorderCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["recorderStatus"],
    queryFn: api.recorderStatus,
    refetchInterval: (q) => (q.state.data?.modelDownload.inProgress ? 2_000 : false),
  });
  const download = useMutation({
    mutationFn: api.recorderDownloadModel,
    onSettled: () => void qc.invalidateQueries({ queryKey: ["recorderStatus"] }),
  });
  const config = useMutation({
    mutationFn: api.recorderConfig,
    onSettled: () => void qc.invalidateQueries({ queryKey: ["recorderStatus"] }),
  });
  if (!data) return null;
  const { deps, modelDownload } = data;
  const ready = deps.ffmpeg && deps.whisper && deps.model;
  const pct =
    modelDownload.totalBytes > 0
      ? Math.round((modelDownload.receivedBytes / modelDownload.totalBytes) * 100)
      : 0;

  const Check = ({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) => (
    <span className="text-xs inline-flex items-center gap-1">
      <span className={ok ? "text-ok" : "text-bad"}>{ok ? <CheckIcon /> : <XIcon />}</span> {label}
      {!ok && hint && <span className="text-mut"> — {hint}</span>}
    </span>
  );

  return (
    <div className="card p-4">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <p className="text-sm font-medium">Local recorder</p>
          <p className="text-xs text-mut mt-1">
            Record meetings from the To-do page, transcribed fully on this Mac.
            {ready && (
              <span className="text-ok inline-flex items-center gap-1 ml-1">
                <CheckIcon /> Ready.
              </span>
            )}
          </p>
        </div>
        {!deps.model && !modelDownload.inProgress && deps.whisper && (
          <button className="btn btn-primary shrink-0" onClick={() => download.mutate()}>
            Download model (~{(data.modelSizeMb / 1000).toFixed(1)} GB)
          </button>
        )}
        {modelDownload.inProgress && (
          <span className="text-xs text-mut shrink-0 inline-flex items-center gap-1.5">
            <Spinner /> downloading… {pct}%
          </span>
        )}
      </div>
      {/* the dependency checklist only appears while something is missing */}
      {!ready || !deps.systemAudioDevice ? (
        <div className="flex gap-4 flex-wrap mt-3">
          {!deps.ffmpeg && <Check ok={false} label="ffmpeg" hint="brew install ffmpeg" />}
          {!deps.whisper && <Check ok={false} label="whisper.cpp" hint="brew install whisper-cpp" />}
          {!deps.model && <Check ok={false} label="whisper model" hint={modelDownload.error ?? "download it here"} />}
          {!deps.systemAudioDevice && (
            <Check
              ok={false}
              label="system audio"
              hint="needs macOS 14.4+ (or a BlackHole device) to caption the other side of calls"
            />
          )}
        </div>
      ) : null}
      <div className="mt-2">
        <Disclosure>
          <p>
            Audio never leaves this Mac: Whisper transcribes on-device and transcripts land in memory
            like Granola notes do.
          </p>
          <p>
            System audio uses macOS's built-in audio tap — no driver to install. The first recording
            triggers one-time Microphone and System Audio Recording permission prompts for the app
            running Ami. With both streams the transcript is labeled Me/Them; without system audio
            the mic still hears the whole room, so speakerphone meetings transcribe fine.
          </p>
          <p>Language auto-detect works well; pin one if a transcript ever comes back wrong.</p>
        </Disclosure>
      </div>

      <div className="mt-3 pt-3 border-t border-edge">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-xs text-mut">Language</span>
          <select
            className="input w-auto text-sm py-1"
            value={data.language}
            onChange={(e) => config.mutate({ language: e.target.value })}
          >
            <option value="auto">Auto-detect</option>
            <option value="en">English</option>
            <option value="hi">Hindi</option>
            <option value="es">Spanish</option>
            <option value="fr">French</option>
            <option value="de">German</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function ProjectsCard() {
  const qc = useQueryClient();
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const [path, setPath] = useState("");
  const [mergeBranch, setMergeBranch] = useState<Record<string, string>>({});

  return (
    <div className="card p-4 space-y-3">
      <p className="text-xs text-mut">
        Registered local repos. Coding tasks pinned to a project run in an isolated git worktree on an
        ami/&lt;task&gt; branch — your checkout stays untouched until you merge back.
      </p>
      {projects.map((p) => (
        <div key={p.id} className="flex items-center gap-2 text-sm border-t border-edge pt-2">
          <span className="font-medium">{p.name}</span>
          <span className="text-xs text-mut truncate flex-1">{p.path}</span>
          <input
            className="input w-40 h-7 text-xs"
            placeholder="ami/… branch to merge"
            value={mergeBranch[p.id] ?? ""}
            onChange={(e) => setMergeBranch((m) => ({ ...m, [p.id]: e.target.value }))}
          />
          <button
            className="btn text-xs"
            disabled={!(mergeBranch[p.id] ?? "").trim()}
            onClick={async () => {
              try {
                const res = await api.mergeBack(p.id, mergeBranch[p.id].trim());
                if (res.ok) toast(res.message);
                else toast.error(res.message);
              } catch (e) {
                toast.error(errMsg(e));
              }
            }}
          >
            Merge back
          </button>
          <button
            className="btn text-xs"
            onClick={async () => {
              await api.removeProject(p.id);
              toast(`Removed ${p.name}`);
              void qc.invalidateQueries({ queryKey: ["projects"] });
            }}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <input
          className="input"
          placeholder="/path/to/local/repo"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <button
          className="btn btn-primary shrink-0"
          disabled={!path.trim()}
          onClick={async () => {
            try {
              const res = await api.addProject(path.trim());
              if (!res.ok) throw new Error(res.error ?? "failed");
              toast(`Added ${res.project?.name ?? "repo"}`);
            } catch (e) {
              toast.error(`Failed: ${errMsg(e)}`);
            }
            setPath("");
            void qc.invalidateQueries({ queryKey: ["projects"] });
          }}
        >
          Add repo
        </button>
      </div>
    </div>
  );
}

function IdentityCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["identity"], queryFn: api.identity });
  const [form, setForm] = useState<{ name: string; email: string; domain: string } | null>(null);
  const value = form ?? data ?? { name: "", email: "", domain: "" };

  return (
    <div className="card p-4 space-y-2">
      <p className="text-xs text-mut">This is who "you" are to Ami. Leave domain blank to derive it from the email.</p>
      <div className="flex gap-2 flex-wrap">
        <input
          className="input flex-1 min-w-40"
          placeholder="Your name"
          value={value.name}
          onChange={(e) => setForm({ ...value, name: e.target.value })}
        />
        <input
          className="input flex-1 min-w-56"
          placeholder="you@company.com"
          value={value.email}
          onChange={(e) => setForm({ ...value, email: e.target.value })}
        />
        <input
          className="input flex-1 min-w-40"
          placeholder="company.com (optional)"
          value={value.domain}
          onChange={(e) => setForm({ ...value, domain: e.target.value })}
        />
        <button
          className="btn btn-primary shrink-0"
          disabled={!form}
          onClick={async () => {
            await api.saveIdentity(value);
            setForm(null);
            toast("Identity saved");
            void qc.invalidateQueries({ queryKey: ["identity"] });
          }}
        >
          Save
        </button>
      </div>
      <Disclosure summary="Why this matters">
        <p>
          Ami injects this identity into triage, memory building and task runs — it's how it knows
          your own messages are yours, which senders are teammates, and that you never get a dossier
          about yourself.
        </p>
      </Disclosure>
    </div>
  );
}

function UsageCard() {
  const { data = [] } = useQuery({ queryKey: ["usage"], queryFn: api.usage, refetchInterval: 30000 });
  if (data.length === 0)
    return <div className="card p-4 text-sm text-mut">No LLM calls recorded yet.</div>;
  const total = data.reduce((s, r) => s + r.costUsd, 0);
  return (
    <div className="card p-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-mut text-left">
            <th className="pb-2 font-medium">Use case</th>
            <th className="pb-2 font-medium text-right">Calls</th>
            <th className="pb-2 font-medium text-right">Tokens in / out</th>
            <th className="pb-2 font-medium text-right">Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.useCase} className="border-t border-edge">
              <td className="py-1.5">{r.useCase.replace(/_/g, " ")}</td>
              <td className="py-1.5 text-right text-mut">{r.calls}</td>
              <td className="py-1.5 text-right text-mut">
                {(r.inputTokens / 1000).toFixed(1)}k / {(r.outputTokens / 1000).toFixed(1)}k
              </td>
              <td className="py-1.5 text-right">${r.costUsd.toFixed(2)}</td>
            </tr>
          ))}
          <tr className="border-t border-edge font-medium">
            <td className="py-1.5">Total</td>
            <td />
            <td />
            <td className="py-1.5 text-right">${total.toFixed(2)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function ConnectorCards({
  exclude = [],
  only,
  autoOpenSlackChannels = false,
  compact = false,
}: {
  exclude?: string[];
  only?: string[];
  /** Onboarding: pop the channel/DM controls open as soon as Slack connects. */
  autoOpenSlackChannels?: boolean;
  /** Two-up grid of slim tiles (onboarding's optional-tools list) — the open
   * tile expands to full width. */
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const { data: connectors = [] } = useQuery({
    queryKey: ["connectors"],
    queryFn: api.connectors,
    // Poll while a first-connect backfill is running so the badge clears itself.
    refetchInterval: (q) => (q.state.data?.some((c) => c.bootstrapping) ? 3000 : false),
  });
  const [open, setOpen] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [channelsOpen, setChannelsOpen] = useState(false);
  const slackConnected = connectors.some((c) => c.connector === "slack" && c.connected);
  useEffect(() => {
    if (autoOpenSlackChannels && slackConnected) setChannelsOpen(true);
  }, [autoOpenSlackChannels, slackConnected]);

  async function connect(id: string) {
    setMsg((m) => ({ ...m, [id]: "Connecting…" }));
    try {
      const res = await api.connect(id, fields);
      if (res.authUrl) {
        window.open(res.authUrl, "_blank");
        setMsg((m) => ({ ...m, [id]: "Complete the Google consent in the opened tab…" }));
        return;
      }
      if (!res.ok) throw new Error(res.error ?? "failed");
      toast(`Connected as ${res.accountLabel}`);
      setMsg((m) => ({ ...m, [id]: "" }));
      setOpen(null);
      setFields({});
      void qc.invalidateQueries({ queryKey: ["connectors"] });
    } catch (e: any) {
      setMsg((m) => ({ ...m, [id]: `Failed: ${e.message}` }));
    }
  }

  return (
    <div className={compact ? "grid grid-cols-1 sm:grid-cols-2 gap-2" : "space-y-2"}>
      {connectors
        .filter(
          (c) =>
            // gcal/gdrive ride along with gmail's Google connect; msteams with m365's.
            !["gcal", "gdrive", "msteams"].includes(c.connector) &&
            !exclude.includes(c.connector) &&
            (!only || only.includes(c.connector)),
        )
        .map((c) => (
          <div key={c.connector} className={`card p-3 ${compact && open === c.connector ? "sm:col-span-2" : ""}`}>
            <div className="flex items-center gap-3">
              <span className={`flex items-center gap-2 font-medium text-sm shrink-0 ${compact ? "" : "w-36"}`}>
                <ConnectorIcon id={c.connector} size={16} />
                {c.label}
              </span>
              {c.connected ? (
                <span className="text-xs text-ok inline-flex items-center gap-1 min-w-0">
                  <span className="shrink-0"><CheckIcon /></span>
                  <span className="truncate" title={c.accountLabel ?? undefined}>{c.accountLabel}</span>
                  {c.status === "error" && <span className="text-bad shrink-0">(poll error)</span>}
                </span>
              ) : (
                !compact && <span className="text-xs text-mut">not connected</span>
              )}
              {c.bootstrapping && <BootstrapBadge label={c.label} />}
              <div className="ml-auto flex gap-2 shrink-0">
                {c.custom && (
                  <button
                    className="btn text-xs"
                    title="Delete this connector and its saved credentials"
                    onClick={async () => {
                      if (!window.confirm(`Remove the ${c.label} connector? Its code and credentials are deleted.`)) return;
                      await api.deleteCustomConnector(c.connector);
                      void qc.invalidateQueries({ queryKey: ["connectors"] });
                    }}
                  >
                    Remove
                  </button>
                )}
                {c.connected && c.connector === "slack" && (
                  <button className="btn text-xs" onClick={() => setChannelsOpen((v) => !v)}>
                    Channels
                  </button>
                )}
                {c.connected ? (
                  <button
                    className="btn text-xs"
                    onClick={async () => {
                      await api.disconnect(c.connector);
                      void qc.invalidateQueries({ queryKey: ["connectors"] });
                    }}
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    className="btn btn-primary text-xs"
                    onClick={() => {
                      setOpen(open === c.connector ? null : c.connector);
                      setFields({});
                    }}
                  >
                    Connect
                  </button>
                )}
              </div>
            </div>
            {c.lastPolledAt && (
              <p className="text-xs text-mut mt-1">last poll {new Date(c.lastPolledAt).toLocaleTimeString()}</p>
            )}
            {c.error && <p className="text-xs text-bad mt-1">{c.error}</p>}
            {open === c.connector && (
              <div className="mt-3 space-y-2 rise">
                {c.connector === "slack" ? (
                  // Slack is the one connector with a real multi-step dance —
                  // spell it out so the paste-a-token ending isn't a surprise.
                  <ol className="space-y-1.5 text-xs text-mut">
                    <li className="flex gap-2">
                      <span className="chip shrink-0">1</span>
                      <span>
                        Open the button below. Slack loads Ami's app fully preconfigured. Pick workspace and
                        click <b>Create</b>.
                      </span>
                    </li>
                    <li className="flex gap-2">
                      <span className="chip shrink-0">2</span>
                      <span>
                        On the app page, click <b>Install App</b> → <b>Install to Workspace</b> → <b>Allow</b>.
                      </span>
                    </li>
                    <li className="flex gap-2">
                      <span className="chip shrink-0">3</span>
                      <span>
                        Paste the <b>User OAuth Token</b> (starts with <code>xoxp-</code>) below. Stored only on this machine.
                      </span>
                    </li>
                  </ol>
                ) : (
                  <p className="text-xs text-mut">{c.setupHelp}</p>
                )}
                {(c.setupActions ?? []).length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    {(c.setupActions ?? []).map((a) => {
                      // {field} placeholders resolve from what the user typed
                      // (e.g. Ghost's admin URL needs the blog domain).
                      const url = a.url.replace(/\{(\w+)\}/g, (_m, k) =>
                        (fields[k] ?? "").trim().replace(/\/+$/, ""),
                      );
                      const ready = /^https?:\/\//.test(url) && !/\{\w+\}/.test(url);
                      return ready ? (
                        <a
                          key={a.label}
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="btn btn-primary text-xs inline-flex items-center gap-1.5"
                        >
                          {a.label} <ExternalIcon size={11} />
                        </a>
                      ) : (
                        <button
                          key={a.label}
                          className="btn text-xs"
                          disabled
                          title="Fill in the field it depends on first (e.g. your blog URL)"
                        >
                          {a.label}
                        </button>
                      );
                    })}
                  </div>
                )}
                {c.authFields.map((f) => (
                  <input
                    key={f.key}
                    className="input"
                    type={f.secret ? "password" : "text"}
                    placeholder={f.placeholder ?? f.label}
                    value={fields[f.key] ?? ""}
                    onChange={(e) => setFields((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                ))}
                <button
                  className="btn btn-primary text-xs"
                  onClick={() => connect(c.connector)}
                  disabled={c.authFields.some((f) => !f.optional && !(fields[f.key] ?? "").trim())}
                >
                  {c.authKind === "oauth"
                    ? `Connect ${c.connector === "gmail" ? "Google" : c.label} →`
                    : "Validate & connect"}
                </button>
                {msg[c.connector] && <p className="text-xs text-mut">{msg[c.connector]}</p>}
              </div>
            )}
            {c.connector === "slack" && channelsOpen && (
              <SlackChannelsPanel
                onSaved={autoOpenSlackChannels ? () => setChannelsOpen(false) : undefined}
              />
            )}
          </div>
        ))}
      {!only && <ConnectorBuilderCard compact={compact} />}
    </div>
  );
}

/** Build-your-own connector: name + homepage + intended usage, then Claude
 * writes and validates a connector module with the user's own API key. The
 * finished connector appears as a normal card above, ready for its token. */
function ConnectorBuilderCard({ compact }: { compact?: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [homepage, setHomepage] = useState("");
  const [usage, setUsage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data: builds = [] } = useQuery({
    queryKey: ["connectorBuilds"],
    queryFn: api.connectorBuilds,
    // Poll while a build runs; SSE invalidation covers the transitions.
    refetchInterval: (q) => (q.state.data?.some((b) => b.status === "running") ? 5000 : false),
  });
  const running = builds.filter((b) => b.status === "running");
  const failed = builds.filter((b) => b.status === "failed");

  const start = useMutation({
    mutationFn: () => api.buildConnector({ name, homepage, usage }),
    onSuccess: (res) => {
      if (!res.ok) {
        setError(res.error ?? "failed to start");
        return;
      }
      setError(null);
      setName("");
      setHomepage("");
      setUsage("");
      setOpen(false);
      toast("Building your connector — this takes a few minutes");
      void qc.invalidateQueries({ queryKey: ["connectorBuilds"] });
    },
    onError: (e) => setError(errMsg(e)),
  });

  return (
    <div className={`card p-3 ${compact ? "sm:col-span-2" : ""}`}>
      <div className="flex items-center gap-3">
        <span className="font-medium text-sm">Something else?</span>
        <span className="text-xs text-mut">Ami can build a connector for any app with an API.</span>
        <button
          className="btn btn-primary text-xs ml-auto shrink-0"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Close" : "Build a connector"}
        </button>
      </div>
      {running.map((b) => (
        <p key={b.id} className="text-xs text-acc mt-2 flex items-center gap-2">
          <Spinner size={12} /> Building {b.name}… Claude is reading the app's API docs and writing the
          connector. It appears above when it's ready (usually 3-10 minutes).
        </p>
      ))}
      {failed.map((b) => (
        <p key={b.id} className="text-xs text-bad mt-2">
          {b.name} build failed: {b.message ?? "unknown error"} — adjust the description and try again.
        </p>
      ))}
      {open && (
        <div className="mt-3 space-y-2 rise">
          <div className="grid sm:grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-xs text-mut mb-1">App name</span>
              <input className="input" placeholder="Intercom" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="block">
              <span className="block text-xs text-mut mb-1">Homepage</span>
              <input
                className="input"
                placeholder="https://intercom.com"
                value={homepage}
                onChange={(e) => setHomepage(e.target.value)}
              />
            </label>
          </div>
          <label className="block">
            <span className="block text-xs text-mut mb-1">What should Ami do with it?</span>
            <textarea
              className="input min-h-20"
              placeholder="Watch for new customer conversations assigned to me, read conversation history, and draft replies for my approval."
              value={usage}
              onChange={(e) => setUsage(e.target.value)}
            />
          </label>
          <p className="text-xs text-mut">
            Claude researches the app's public API and writes the connector on your machine, with your
            Anthropic key. You'll paste the app's API token after it's built — reads run freely, writes ask
            first, and nothing sends without your approval.
          </p>
          <button
            className="btn btn-primary text-xs"
            disabled={!name.trim() || !usage.trim() || start.isPending}
            onClick={() => start.mutate()}
          >
            {start.isPending ? "Starting…" : "Build it"}
          </button>
          {error && <p className="text-xs text-bad">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** Tag channels as "read every message" — everything else stays mentions-only. */
function SlackChannelsPanel({ onSaved }: { onSaved?: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["slackChannels"],
    queryFn: api.slackChannels,
    retry: false,
  });
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [dms, setDms] = useState<boolean | null>(null);
  const ids = selected ?? new Set(data?.readAllIds ?? []);
  const readDms = dms ?? data?.readDms ?? true;

  const save = useMutation({
    mutationFn: () =>
      api.saveSlackChannels(
        (data?.channels ?? []).filter((ch) => ids.has(ch.id)).map((ch) => ({ id: ch.id, name: ch.name })),
        readDms,
      ),
    onSuccess: () => {
      toast("Channel modes saved");
      onSaved?.();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (isLoading) return <p className="text-xs text-mut mt-3">Loading channels…</p>;
  if (error || !data?.channels)
    return (
      <p className="text-xs text-bad mt-3">
        Couldn't list channels: {error instanceof Error ? error.message : "unknown error"}
      </p>
    );

  return (
    <div className="mt-3 border-t border-edge pt-3">
      <p className="text-xs text-mut mb-2">
        Ami always sees your mentions, but tick channels where it should read <em>every</em> message
        (alerts, exec, your team). Busy social channels are better left mentions-only to save costs.
      </p>
      <label className="flex items-center gap-2 text-sm cursor-pointer mb-2 pb-2 border-b border-edge">
        <input type="checkbox" checked={readDms} onChange={(e) => setDms(e.target.checked)} />
        <span>Read direct messages</span>
      </label>
      {data.privateUnavailable && (
        <p className="text-xs text-mut mb-2">
          Private channels are hidden — your Slack app's user token lacks the <code>groups:read</code>{" "}
          scope. Add it under OAuth &amp; Permissions → User Token Scopes, reinstall the app, and paste
          the new token.
        </p>
      )}
      <div className="max-h-56 overflow-y-auto space-y-1 mb-2">
        {data.channels.map((ch) => (
          <label key={ch.id} className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={ids.has(ch.id)}
              onChange={(e) => {
                const next = new Set(ids);
                if (e.target.checked) next.add(ch.id);
                else next.delete(ch.id);
                setSelected(next);
              }}
            />
            <span className="inline-flex items-center gap-1">
              #{ch.name}
              {ch.isPrivate && <LockIcon size={11} className="text-mut" />}
            </span>
            {ch.topic && <span className="text-xs text-mut truncate">{ch.topic}</span>}
          </label>
        ))}
      </div>
      <button className="btn btn-primary text-xs" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save channel modes"}
      </button>
    </div>
  );
}
