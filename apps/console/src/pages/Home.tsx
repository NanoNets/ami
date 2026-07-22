import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { TodoDto } from "@ami/shared";
import { api } from "../lib/api";
import { timeAgo } from "../lib/time";
import { toast, errMsg } from "../lib/toast";
import { useIngestProgress } from "../lib/ingest";
import { TodayPanel } from "../components/TodayPanel";
import { CheckIcon, SproutIcon, Spinner } from "../components/icons";
import { SkeletonRows } from "../components/ui";

/** Home: ask ami anything, then what needs you and what's happening today.
 * Page navigation lives in the header nav — no duplicate link grid here. */

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type AttentionItem = {
  key: string;
  kind: string;
  color: string;
  text: string;
  to: string;
};

const KIND_COLOR = {
  question: "#546fff",
  review: "#b45309",
  draft: "#546fff",
  overdue: "#dc2626",
  plan: "#b45309",
  tool: "#dc2626",
};

/** Counts tick up over ~400ms when the page lands — numbers that move read as
 * a system that's alive, numbers that appear read as a report. */
function CountUp({ n }: { n: number }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (n <= 0) {
      setV(n);
      return;
    }
    let raf: number;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 400);
      setV(Math.round(n * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [n]);
  return <>{v}</>;
}

export default function Home() {
  const { data: todos = [], isLoading } = useQuery({ queryKey: ["todos"], queryFn: api.todos });
  const { data: questions = [] } = useQuery({
    queryKey: ["questions"],
    queryFn: api.questions,
    refetchInterval: 10000,
  });
  const { data: identity } = useQuery({ queryKey: ["identity"], queryFn: api.identity });
  const { data: connectors = [] } = useQuery({
    queryKey: ["connectors"],
    queryFn: api.connectors,
    // Poll while a first-connect backfill runs so the progress card retires itself.
    refetchInterval: (q) => (q.state.data?.some((c) => c.bootstrapping) ? 3000 : false),
  });

  const today = localDate();
  const active = todos.filter((t) => !["dismissed", "resolved"].includes(t.status));
  const activeTasks = active.filter((t) => t.type === "task" && t.status !== "snoozed");
  const running = activeTasks.filter((t) => t.status === "running");

  // One row per todo, most urgent facet wins; questions and failing
  // connectors ride alongside.
  const attention: AttentionItem[] = [];
  for (const q of questions) {
    attention.push({
      key: `q-${q.id}`,
      kind: q.kind === "permission" ? "permission" : "question",
      color: KIND_COLOR.question,
      text: q.question,
      to: q.todoId ? `/tasks/${q.todoId}` : q.sessionId ? `/chat/${q.sessionId}` : "/agents",
    });
  }
  for (const t of activeTasks) {
    const overdue = !!t.dueAt && t.dueAt < today;
    if (t.status === "awaiting_review") {
      attention.push({ key: t.id, kind: "review", color: KIND_COLOR.review, text: t.title, to: `/tasks/${t.id}` });
    } else if (t.hasPendingDraft) {
      attention.push({ key: t.id, kind: "draft ready", color: KIND_COLOR.draft, text: t.title, to: `/tasks/${t.id}` });
    } else if (overdue && t.status !== "running") {
      attention.push({ key: t.id, kind: "overdue", color: KIND_COLOR.overdue, text: t.title, to: `/tasks/${t.id}` });
    } else if (t.status === "planned") {
      attention.push({ key: t.id, kind: "plan ready", color: KIND_COLOR.plan, text: t.title, to: `/tasks/${t.id}` });
    }
  }
  for (const c of connectors) {
    if (c.connected && c.status === "error") {
      attention.push({
        key: `c-${c.connector}`,
        kind: "tool",
        color: KIND_COLOR.tool,
        text: `${c.label} is failing to poll — check the connection`,
        to: "/settings",
      });
    }
  }

  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const resolvedWeek = todos.filter((t) => t.status === "resolved" && t.updatedAt >= weekAgo);
  const recentlyClosed = [...resolvedWeek].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);
  const connected = connectors.filter((c) => c.connected).length;
  const bootstrapping = connectors.filter((c) => c.bootstrapping);

  const firstName = identity?.name?.trim().split(/\s+/)[0];

  if (isLoading)
    return (
      <div className="space-y-8">
        <SkeletonRows count={3} />
      </div>
    );

  return (
    <div className="space-y-8">
      {/* greeting */}
      <div className="flex items-end justify-between gap-4 flex-wrap rise">
        <div>
          <h1 className="text-2xl font-semibold">
            {greeting()}
            {firstName ? `, ${firstName}` : ""}.
          </h1>
          <p className="text-sm text-mut mt-1">
            {attention.length > 0 ? (
              <>
                <CountUp n={attention.length} /> thing{attention.length === 1 ? "" : "s"} need
                {attention.length === 1 ? "s" : ""} you
              </>
            ) : (
              "all clear"
            )}
          </p>
        </div>
        <span className="text-sm text-mut">
          {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
        </span>
      </div>

      <AskBar />

      {/* first-run: ami is still reading history from a fresh connector */}
      {bootstrapping.length > 0 && <BootstrapCard labels={bootstrapping.map((c) => c.label)} />}

      {/* needs your attention */}
      <section className="rise">
        <h2 className="text-sm uppercase tracking-wider text-mut mb-3">
          Needs your attention {attention.length > 0 && `(${attention.length})`}
        </h2>
        {attention.length === 0 ? (
          <div className="card border-dashed p-4 text-sm text-mut flex items-center gap-2.5">
            <span className="text-ok">
              <CheckIcon />
            </span>
            Nothing needs you right now — ami will flag it here the moment something does.
          </div>
        ) : (
          <div className="card divide-y divide-edge rise-stagger">
            {attention.slice(0, 8).map((a) => (
              <Link key={a.key} to={a.to} className="row-link flex items-center gap-3 px-4 py-2.5 hover:bg-panel2">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: a.color }} />
                <span className="text-[10px] uppercase tracking-wide text-mut w-20 shrink-0">{a.kind}</span>
                <span className="text-sm truncate">{a.text}</span>
              </Link>
            ))}
            {attention.length > 8 && (
              <Link to="/todos" className="row-link block px-4 py-2 text-xs text-mut hover:bg-panel2">
                +{attention.length - 8} more on the to-do list
              </Link>
            )}
          </div>
        )}
      </section>

      {/* in flight */}
      {running.length > 0 && (
        <section className="rise">
          <h2 className="text-sm uppercase tracking-wider text-mut mb-3">In flight ({running.length})</h2>
          <div className="card divide-y divide-edge rise-stagger">
            {running.map((t: TodoDto) => (
              <Link key={t.id} to={`/tasks/${t.id}`} className="row-link flex items-center gap-3 px-4 py-2.5 hover:bg-panel2">
                <Spinner className="text-acc shrink-0" />
                <span className="text-sm truncate">{t.title}</span>
                <span className="text-xs text-mut ml-auto shrink-0">watch</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <TodayPanel />

      {/* recently closed */}
      {recentlyClosed.length > 0 && (
        <section className="rise">
          <div className="flex items-center gap-3 mb-3">
            <h2 className="text-sm uppercase tracking-wider text-mut">Recently closed</h2>
            <Link to="/history" className="text-xs text-mut hover:text-hi ml-auto">
              all history →
            </Link>
          </div>
          <div className="card divide-y divide-edge">
            {recentlyClosed.map((t) => (
              <Link key={t.id} to={`/tasks/${t.id}`} className="row-link flex items-center gap-3 px-4 py-2.5 hover:bg-panel2">
                <span className="text-ok shrink-0">
                  <CheckIcon />
                </span>
                <span className="text-sm truncate">{t.title}</span>
                <span className="text-xs text-mut ml-auto shrink-0">{timeAgo(t.updatedAt)}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** Fresh connectors backfilling history — the one moment the product visibly
 * learns. The SSE ingest line makes it concrete ("Gmail: scanned 214 emails"). */
function BootstrapCard({ labels }: { labels: string[] }) {
  const progress = useIngestProgress();
  return (
    <div className="card p-4 flex items-center gap-3 rise">
      <Spinner className="text-acc shrink-0" />
      <div className="min-w-0">
        <p className="text-sm font-medium">ami is reading your world</p>
        <p className="text-xs text-mut mt-0.5 truncate">
          {progress ?? `Backfilling history from ${labels.join(", ")} — your to-do list fills in as it reads.`}
        </p>
      </div>
    </div>
  );
}

const PLACEHOLDERS = [
  "Ask ami anything — it can search your tools, draft replies, run tasks…",
  "What's due this week?",
  "What did I miss on Slack today?",
  "Draft a reply to the latest email from…",
  "Who's waiting on me right now?",
];

const STARTERS = ["What's on my plate this week?", "Summarize what I missed today", "Who's waiting on me?"];

/** The homepage's command line: type, hit Enter, and you're looking at a live
 * chat before the round-trip finishes (the message rides router state and the
 * thread renders it optimistically). */
function AskBar() {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [ph, setPh] = useState(0);

  // The placeholder cycles only while the field is empty and unfocused-ish —
  // it stops the moment there's real text to respect.
  useEffect(() => {
    if (text) return;
    const t = setInterval(() => setPh((p) => (p + 1) % PLACEHOLDERS.length), 4000);
    return () => clearInterval(t);
  }, [text]);

  const go = async (prompt?: string) => {
    const t = (prompt ?? text).trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const s = await api.newChatSession();
      navigate(`/chat/${s.id}`, { state: { pending: t } });
    } catch (e) {
      toast.error(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <div className="rise">
      <div className="flex gap-2 items-stretch rounded-soft transition-shadow focus-within:shadow-[0_0_0_3px_rgb(84_111_255_/_0.15)]">
        <input
          className="input h-12 text-base"
          placeholder={PLACEHOLDERS[ph]}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void go();
          }}
        />
        <button className="btn btn-primary shrink-0 px-6" disabled={!text.trim() || busy} onClick={() => void go()}>
          {busy ? "Starting…" : "Ask"}
        </button>
      </div>
      {!text && (
        <div className="flex gap-2 flex-wrap mt-2">
          {STARTERS.map((s) => (
            <button
              key={s}
              className="chip hover:border-acc hover:text-acc cursor-pointer transition-colors"
              disabled={busy}
              onClick={() => void go(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
