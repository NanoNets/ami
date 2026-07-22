import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { toast, errMsg } from "../lib/toast";
import { Markdown } from "../components/Markdown";
import { StepTimeline } from "../components/StepTimeline";
import { ConfirmButton, Switch } from "../components/ui";

/** Background agents: standing tasks with cron/window/event triggers,
 * optionally pinned to a code project. Live notes get their own section. */

export default function Agents() {
  const { data: tasks = [] } = useQuery({ queryKey: ["bgTasks"], queryFn: api.bgTasks });
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-center gap-3 mb-3">
          <h2 className="text-sm uppercase tracking-wider text-mut">Background agents ({tasks.length})</h2>
          <button className="btn text-xs ml-auto" onClick={() => setCreating((v) => !v)}>
            {creating ? "Cancel" : "New agent"}
          </button>
        </div>
        {creating && <TaskForm onDone={() => setCreating(false)} />}
        <div className="space-y-2 mt-3">
          {tasks.length === 0 && !creating && (
            <div className="card p-8 text-center text-mut text-sm">
              Agents that run on a schedule or react to events <br/><br/> "summarize #growth every
              morning" <br/> "update the pricing FAQ after every important email about pricing" <br/> "send an email with next steps after every discovery call"
            </div>
          )}
          {tasks.map((t) => (
            <div key={t.slug} className="card p-4">
              <div className="flex items-center gap-3">
                <button
                  className="font-medium text-left hover:text-acc cursor-pointer"
                  onClick={() => setOpenSlug(openSlug === t.slug ? null : t.slug)}
                >
                  {t.name}
                </button>
                <span className="text-xs text-mut">{triggerSummary(t.triggers)}</span>
                {t.projectId && <span className="chip text-[10px]">coding</span>}
                <span className="ml-auto flex items-center gap-2.5">
                  <RunNowButton slug={t.slug} />
                  <ActiveToggle slug={t.slug} active={t.active} />
                </span>
              </div>
              {(t.lastRunSummary || t.lastRunError) && (
                <p className={`text-xs mt-2 ${t.lastRunError ? "text-bad" : "text-mut"}`}>
                  {t.lastRunError ? `Last run failed: ${t.lastRunError}` : t.lastRunSummary}
                  {t.lastRunAt && <span className="text-mut"> · {new Date(t.lastRunAt).toLocaleString()}</span>}
                </p>
              )}
              {openSlug === t.slug && <TaskDetailPanel slug={t.slug} onDeleted={() => setOpenSlug(null)} />}
            </div>
          ))}
        </div>
      </section>

      <LiveNotesSection />
    </div>
  );
}

function LiveNotesSection() {
  const qc = useQueryClient();
  const { data: notes = [] } = useQuery({ queryKey: ["liveNotes"], queryFn: api.liveNotes, refetchInterval: 15000 });
  const [creating, setCreating] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [runsFile, setRunsFile] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", objective: "", cronExpr: "", eventMatchCriteria: "" });

  return (
    <section>
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-sm uppercase tracking-wider text-mut">Live notes ({notes.length})</h2>
        <button className="btn text-xs ml-auto" onClick={() => setCreating((v) => !v)}>
          {creating ? "Cancel" : "New live note"}
        </button>
      </div>
      {creating && (
        <div className="card p-4 space-y-3">
          <Field label="Title">
            <input
              className="input"
              placeholder="e.g. Competitor watch"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </Field>
          <Field label="Objective" hint="what should this note always contain? The agent keeps the body in line with it">
            <textarea
              className="input h-20"
              value={form.objective}
              onChange={(e) => setForm({ ...form, objective: e.target.value })}
            />
          </Field>
          <div className="flex gap-3 flex-wrap">
            <Field label="Schedule" className="flex-1 min-w-40">
              <CronPicker value={form.cronExpr} onChange={(v) => setForm({ ...form, cronExpr: v })} />
            </Field>
            <Field
              label="Wake on events"
              hint="optional"
              className="flex-[2] min-w-56"
            >
              <input
                className="input"
                placeholder="e.g. anything about competitor launches"
                value={form.eventMatchCriteria}
                onChange={(e) => setForm({ ...form, eventMatchCriteria: e.target.value })}
              />
            </Field>
          </div>
          <button
            className="btn btn-primary text-xs"
            disabled={!form.title.trim() || !form.objective.trim()}
            onClick={async () => {
              try {
                await api.createLiveNote({
                  title: form.title,
                  objective: form.objective,
                  triggers: { cronExpr: form.cronExpr || undefined, eventMatchCriteria: form.eventMatchCriteria || undefined },
                });
                toast("Live note created");
              } catch (e) {
                toast.error(errMsg(e));
              }
              setCreating(false);
              setForm({ title: "", objective: "", cronExpr: "", eventMatchCriteria: "" });
              void qc.invalidateQueries({ queryKey: ["liveNotes"] });
            }}
          >
            Create live note
          </button>
        </div>
      )}
      <div className="space-y-2 mt-3">
        {notes.length === 0 && !creating && (
          <div className="card p-6 text-center text-mut text-sm">
            Documents that keep themselves current by refreshing on a schedule or when relevant events arrive.
            <br/>
            <br/>"status of the rust migration" 
            <br/>"top open questions from customers this week"
            <br/>"extract insights from posthog session recordings of the mobile app"
          </div>
        )}
        {notes.map((n) => (
          <div key={n.file} className="card p-4">
            <div className="flex items-center gap-3">
              <button
                className="font-medium text-left hover:text-acc cursor-pointer"
                onClick={() => setOpenFile(openFile === n.file ? null : n.file)}
              >
                {n.title}
              </button>
              <span className="text-xs text-mut">
                {[n.live.triggers?.cronExpr && `cron ${n.live.triggers.cronExpr}`, n.live.triggers?.eventMatchCriteria && "event-driven"]
                  .filter(Boolean)
                  .join(" · ") || "manual"}
              </span>
              <span className="ml-auto flex items-center gap-2.5">
                <button
                  className="btn text-xs"
                  onClick={() =>
                    api
                      .runLiveNote(n.file)
                      .then(() => qc.invalidateQueries({ queryKey: ["liveNotes"] }))
                      .catch((e) => toast.error(errMsg(e)))
                  }
                >
                  Refresh now
                </button>
                <button
                  className="btn text-xs"
                  onClick={() => setRunsFile(runsFile === n.file ? null : n.file)}
                >
                  {runsFile === n.file ? "Hide runs" : "Runs"}
                </button>
                <Switch
                  checked={n.live.active !== false}
                  label={n.live.active === false ? "Paused — click to resume" : "Active — click to pause"}
                  onChange={async (v) => {
                    await api.updateLiveNote({ file: n.file, active: v });
                    void qc.invalidateQueries({ queryKey: ["liveNotes"] });
                  }}
                />
                <ConfirmButton
                  label="Delete"
                  confirmLabel="Really delete?"
                  onConfirm={async () => {
                    await api.deleteLiveNote(n.file);
                    toast(`Deleted "${n.title}"`);
                    void qc.invalidateQueries({ queryKey: ["liveNotes"] });
                  }}
                />
              </span>
            </div>
            {(n.live.lastRunSummary || n.live.lastRunError) && (
              <p className={`text-xs mt-2 ${n.live.lastRunError ? "text-bad" : "text-mut"}`}>
                {n.live.lastRunError ? `Failed: ${n.live.lastRunError}` : n.live.lastRunSummary}
              </p>
            )}
            {runsFile === n.file && <LiveNoteRuns file={n.file} />}
            {openFile === n.file && (
              <div className="mt-3 border-t border-edge pt-3 bg-panel2 p-4 max-h-96 overflow-y-auto">
                <Markdown>{n.body}</Markdown>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function LiveNoteRuns({ file }: { file: string }) {
  const { data } = useQuery({
    queryKey: ["liveNoteRuns", file],
    queryFn: () => api.liveNoteRuns(file),
    refetchInterval: 5000,
  });
  if (!data) return <p className="text-xs text-mut mt-3">Loading…</p>;
  return (
    <div className="mt-3 space-y-3">
      {data.runs.map((r) => (
        <div key={r.id} className="bg-panel2 border border-edge p-3">
          <p className="text-xs text-mut mb-2">
            {r.status} {r.error && <span className="text-bad">— {r.error}</span>}
            {r.startedAt && ` · ${new Date(r.startedAt).toLocaleString()}`}
          </p>
          <div className="max-h-64 overflow-y-auto">
            <StepTimeline run={{ id: r.id, status: r.status } as any} steps={r.steps} />
          </div>
        </div>
      ))}
      {data.runs.length === 0 && <p className="text-xs text-mut">No runs yet.</p>}
    </div>
  );
}

function triggerSummary(t?: { cronExpr?: string; windows?: { startTime: string; endTime: string }[]; eventMatchCriteria?: string }): string {
  if (!t) return "manual only";
  const parts: string[] = [];
  if (t.cronExpr) parts.push(CRON_PRESETS.find((p) => p.value === t.cronExpr)?.label.toLowerCase() ?? `cron ${t.cronExpr}`);
  if (t.windows?.length) parts.push(t.windows.map((w) => `${w.startTime}–${w.endTime}`).join(", "));
  if (t.eventMatchCriteria) parts.push("event-driven");
  return parts.join(" · ") || "manual only";
}

function RunNowButton({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => api.runBgTask(slug),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["bgTasks"] }),
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <button className="btn text-xs" disabled={run.isPending} onClick={() => run.mutate()}>
      {run.isPending ? "Starting…" : "Run now"}
    </button>
  );
}

function ActiveToggle({ slug, active }: { slug: string; active: boolean }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (v: boolean) => api.updateBgTask(slug, { active: v }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["bgTasks"] }),
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Switch
      checked={active}
      label={active ? "Active — click to pause" : "Paused — click to resume"}
      onChange={(v) => toggle.mutate(v)}
    />
  );
}

/* ---------- form primitives: visible labels, humane schedules ---------- */

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="block text-xs text-mut mb-1">
        {label}
        {hint && <span className="text-mut/70"> — {hint}</span>}
      </span>
      {children}
    </label>
  );
}

const CRON_PRESETS = [
  { value: "", label: "No schedule" },
  { value: "0 8 * * *", label: "Every morning (8:00)" },
  { value: "0 * * * *", label: "Every hour" },
  { value: "0 9 * * 1", label: "Monday mornings (9:00)" },
  { value: "custom", label: "Custom cron…" },
];

/** Presets cover most schedules; the raw cron field only appears on demand. */
function CronPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isPreset = CRON_PRESETS.some((p) => p.value === value);
  const [custom, setCustom] = useState(!isPreset && value !== "");
  return (
    <span className="flex gap-2">
      <select
        className="input w-auto"
        value={custom ? "custom" : value}
        onChange={(e) => {
          if (e.target.value === "custom") {
            setCustom(true);
          } else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
      >
        {CRON_PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      {custom && (
        <input
          className="input flex-1 min-w-28"
          placeholder="0 8 * * *"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </span>
  );
}

function TaskForm({ onDone, initial }: { onDone: () => void; initial?: any }) {
  const qc = useQueryClient();
  const { data: projects = [] } = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    instructions: initial?.instructions ?? "",
    cronExpr: initial?.triggers?.cronExpr ?? "",
    window: initial?.triggers?.windows?.[0] ? `${initial.triggers.windows[0].startTime}-${initial.triggers.windows[0].endTime}` : "",
    eventMatchCriteria: initial?.triggers?.eventMatchCriteria ?? "",
    projectId: initial?.projectId ?? "",
  });
  const save = useMutation({
    mutationFn: () => {
      const windows = form.window.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
      const body = {
        name: form.name,
        instructions: form.instructions,
        triggers: {
          cronExpr: form.cronExpr || undefined,
          windows: windows ? [{ startTime: windows[1], endTime: windows[2] }] : undefined,
          eventMatchCriteria: form.eventMatchCriteria || undefined,
        },
        projectId: form.projectId || undefined,
      };
      return initial ? api.updateBgTask(initial.slug, body) : api.createBgTask(body);
    },
    onSuccess: () => {
      toast(initial ? "Agent saved" : "Agent created");
      void qc.invalidateQueries({ queryKey: ["bgTasks"] });
      onDone();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <div className="card p-4 space-y-3">
      <Field label="Name">
        <input
          className="input"
          placeholder="e.g. Morning growth digest"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </Field>
      <Field label="Instructions" hint="the persistent intent: what should it keep doing?">
        <textarea
          className="input h-24"
          value={form.instructions}
          onChange={(e) => setForm({ ...form, instructions: e.target.value })}
        />
      </Field>
      <div className="flex gap-3 flex-wrap">
        <Field label="Schedule" className="min-w-44">
          <CronPicker value={form.cronExpr} onChange={(v) => setForm({ ...form, cronExpr: v })} />
        </Field>
        <Field label="Daily window" hint="optional" className="min-w-36">
          <input
            className="input"
            placeholder="08:00-09:00"
            value={form.window}
            onChange={(e) => setForm({ ...form, window: e.target.value })}
          />
        </Field>
        <Field label="Code project" className="min-w-36">
          <select
            className="input w-auto"
            value={form.projectId}
            onChange={(e) => setForm({ ...form, projectId: e.target.value })}
          >
            <option value="">none</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Wake on events" hint="optional — which incoming signals should wake this agent?">
        <textarea
          className="input h-14"
          placeholder="e.g. emails or Slack messages about pricing or discounts"
          value={form.eventMatchCriteria}
          onChange={(e) => setForm({ ...form, eventMatchCriteria: e.target.value })}
        />
      </Field>
      <div className="flex gap-2">
        <button
          className="btn btn-primary text-xs"
          disabled={!form.name.trim() || !form.instructions.trim() || save.isPending}
          onClick={() => save.mutate()}
        >
          {initial ? "Save" : "Create agent"}
        </button>
      </div>
    </div>
  );
}

function TaskDetailPanel({ slug, onDeleted }: { slug: string; onDeleted: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["bgTask", slug], queryFn: () => api.bgTask(slug), refetchInterval: 5000 });
  const [editing, setEditing] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  if (!data) return <p className="text-xs text-mut mt-3">Loading…</p>;

  return (
    <div className="mt-4 border-t border-edge pt-3 space-y-3">
      <div className="flex gap-2">
        <button className="btn text-xs" onClick={() => setEditing((v) => !v)}>
          {editing ? "Close editor" : "Edit"}
        </button>
        <button className="btn text-xs" onClick={() => setShowRuns((v) => !v)}>
          {showRuns ? "Hide runs" : `Runs (${data.runs.length})`}
        </button>
        <span className="ml-auto">
          <ConfirmButton
            label="Delete"
            confirmLabel="Really delete?"
            onConfirm={async () => {
              await api.deleteBgTask(slug);
              toast(`Deleted "${data.name}"`);
              void qc.invalidateQueries({ queryKey: ["bgTasks"] });
              onDeleted();
            }}
          />
        </span>
      </div>
      {editing && <TaskForm initial={data} onDone={() => setEditing(false)} />}
      {showRuns && (
        <div className="space-y-3">
          {data.runs.map((r) => (
            <div key={r.id} className="bg-panel2 border border-edge p-3">
              <p className="text-xs text-mut mb-2">
                {r.status} {r.error && <span className="text-bad">— {r.error}</span>}
                {r.startedAt && ` · ${new Date(r.startedAt).toLocaleString()}`}
              </p>
              <div className="max-h-64 overflow-y-auto">
                <StepTimeline run={{ id: r.id, status: r.status } as any} steps={r.steps} />
              </div>
            </div>
          ))}
          {data.runs.length === 0 && <p className="text-xs text-mut">No runs yet.</p>}
        </div>
      )}
      <div className="bg-panel2 border border-edge p-4 max-h-96 overflow-y-auto">
        <Markdown>{data.indexMd || "_Empty._"}</Markdown>
      </div>
    </div>
  );
}
