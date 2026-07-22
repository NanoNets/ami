import {
  connectorAccounts,
  getCursor,
  getSetting,
  insertSignal,
  setCursor,
  upsertAccount,
  wakeSnoozedTodos,
  type Db,
} from "@ami/db";
import { eq } from "drizzle-orm";
import { getConnector } from "@ami/connectors";
import { triageBatch } from "@ami/triage";
import type { AuthBlob } from "@ami/shared";
import { llmApiKey } from "@ami/memory";
import { publish } from "./sse.js";

const TICK_MS = 15_000;
const KNOWLEDGE_TICK_MS = 20_000;
let ticking = false;
let knowledgeTicking = false;

function llmAgentsEnabled(db: Db): boolean {
  if (process.env.AMI_FAKE_LLM === "1") return false;
  return !!llmApiKey(db);
}

export function startScheduler(db: Db): void {
  // Crash recovery: unstick runs (and their todos) orphaned by a restart,
  // and transcribe any recording the restart killed mid-meeting.
  void (async () => {
    const { recoverOrphanedRuns, recoverOrphanedChatTurns, recoverRecordings } = await import("@ami/engine");
    try {
      recoverOrphanedRuns(db, publish);
      recoverOrphanedChatTurns(db);
    } catch (e) {
      console.error("[engine recover]", e);
    }
    try {
      recoverRecordings(db, publish);
    } catch (e) {
      console.error("[recorder recover]", e);
    }
  })();

  // The code-project registry fills itself from the user's local git clones,
  // so coding tasks can auto-attach their repo (checked again every 6h).
  void (async () => {
    const { discoverCodeProjects } = await import("@ami/engine");
    const discover = () => void discoverCodeProjects(db).catch((e) => console.error("[projects discover]", e));
    discover();
    setInterval(discover, 6 * 3600 * 1000);
  })();

  // First-connect history backfill for any account that never completed one
  // (new installs, upgrades, bootstraps interrupted by a restart).
  void (async () => {
    const { bootstrapPendingAccounts } = await import("@ami/engine");
    await bootstrapPendingAccounts(db, publish).catch((e) => console.error("[bootstrap]", e));
  })();

  // One-time: convert the legacy SQLite memory graph into knowledge notes,
  // and make sure the knowledge dir is a git repo (every memory write commits).
  void (async () => {
    const { migrateSqliteMemory, initKnowledgeRepo } = await import("@ami/memory");
    try {
      migrateSqliteMemory(db);
    } catch (e) {
      console.error("[memory migrate]", e);
    }
    try {
      await initKnowledgeRepo();
    } catch (e) {
      console.error("[knowledge-git]", e);
    }
  })();

  setInterval(() => void tick(db), TICK_MS);
  void tick(db);

  // Knowledge graph builder: processes new source artifacts (one agent run per
  // source file), then the daily curation pass (no-ops off-schedule).
  setInterval(() => void knowledgeTick(db), KNOWLEDGE_TICK_MS);

  // Background agents: register event consumers, then run the schedule tick
  // (cron/window triggers with backoff) and the durable event processor.
  void (async () => {
    const engine = await import("@ami/engine");
    const memory = await import("@ami/memory");
    engine.registerEventConsumer(
      {
        name: "bg-task",
        listEligibleTargets: async () =>
          engine
            .listTasks()
            .filter((t) => t.active && t.triggers?.eventMatchCriteria)
            .map((t) => ({
              id: t.slug,
              instructions: t.instructions,
              eventMatchCriteria: t.triggers!.eventMatchCriteria!,
            })),
        fireCandidate: async (event, slug) => {
          const res = await engine.runBackgroundTask(db, publish, slug, "event", event.payload);
          return { runId: res.runId, error: res.error };
        },
      },
      { singular: "background task", plural: "background tasks" },
    );
    void memory;
    engine.registerEventConsumer(
      {
        name: "live-note",
        listEligibleTargets: async () =>
          engine
            .listLiveNotes()
            .filter((n) => n.live.active !== false && n.live.triggers?.eventMatchCriteria)
            .map((n) => ({
              id: n.file,
              instructions: n.live.objective,
              eventMatchCriteria: n.live.triggers!.eventMatchCriteria!,
            })),
        fireCandidate: async (event, file) => {
          const res = await engine.runLiveNoteAgent(db, publish, file, "event", event.payload);
          return { runId: res.runId ?? null, error: res.error };
        },
      },
      { singular: "live note", plural: "live notes" },
    );

    setInterval(() => void bgTick(db), TICK_MS);
    setInterval(() => {
      if (llmAgentsEnabled(db)) void engine.processPendingEvents(db).catch((e) => console.error("[events]", e));
    }, 5_000);

    // Meeting prep: briefs land 6h before meetings; checked every 15 min.
    const prep = () => void engine.meetingPrepTick(db, publish).catch((e) => console.error("[meeting-prep]", e));
    setTimeout(prep, 45_000);
    setInterval(prep, 15 * 60 * 1000);

    // Granola meeting notes: pulled every 5 min when enabled; new meetings
    // spawn action-item todos + a meeting.notes_ready event, and the graph
    // builder absorbs the notes into dossiers.
    const granola = () => void engine.granolaSync(db, publish).catch((e) => console.error("[granola]", e));
    setTimeout(granola, 20_000);
    setInterval(granola, 5 * 60 * 1000);
  })();

  // Style learner + agent-notes nightly catch-all. New information normally
  // routes immediately via requestAgentNotesRun (task resolved, chat left);
  // this cycle sweeps anything those missed and carries the sent-message
  // style mining. styleMiningDue is checked independently because event
  // triggers keep refreshing lastAgentNotesTime.
  const learn = async () => {
    const { refreshStyleProfiles, gatherSentSamples } = await import("./style.js");
    const res = await refreshStyleProfiles(db).catch((e) => ({ error: String(e) }));
    console.log("[style]", JSON.stringify(res));
    const { agentNotesDue, styleMiningDue, runAgentNotes } = await import("@ami/memory");
    if (llmAgentsEnabled(db) && (agentNotesDue() || styleMiningDue())) {
      const samples = styleMiningDue() ? await gatherSentSamples(db).catch(() => []) : [];
      const out = await runAgentNotes(db, samples).catch((e) => ({ ran: false, error: String(e) }));
      console.log("[agent-notes]", JSON.stringify(out));
    }
  };
  setTimeout(() => void learn(), 30_000);
  setInterval(() => void learn(), 3600_000);
}

let bgTicking = false;

/** Fire background agents (tasks + live notes — same trigger semantics) whose
 * cron/window triggers are due, with backoff and disk-persistent in-flight
 * detection (lastAttemptAt > lastRunAt). */
async function bgTick(db: Db): Promise<void> {
  if (bgTicking) return;
  bgTicking = true;
  try {
    const { listTasks, listLiveNotes, runBackgroundTask, runLiveNoteAgent } = await import("@ami/engine");
    const { dueTimedTrigger, backoffRemainingMs } = await import("@ami/shared");
    type TimedTriggers = import("@ami/shared").TimedTriggers;
    interface ScheduledTarget {
      kind: string;
      id: string;
      lastAttemptAt: string | null;
      lastRunAt: string | null;
      triggers?: TimedTriggers;
      fire: (source: "cron" | "window") => Promise<unknown>;
    }
    const targets: ScheduledTarget[] = [
      ...listTasks()
        .filter((t) => t.active)
        .map((t) => ({
          kind: "bg-task",
          id: t.slug,
          lastAttemptAt: t.lastAttemptAt ?? null,
          lastRunAt: t.lastRunAt ?? null,
          triggers: t.triggers,
          fire: (source: "cron" | "window") => runBackgroundTask(db, publish, t.slug, source),
        })),
      ...(llmAgentsEnabled(db)
        ? listLiveNotes()
            .filter((n) => n.live.active !== false)
            .map((n) => ({
              kind: "live-note",
              id: n.file,
              lastAttemptAt: n.live.lastAttemptAt ?? null,
              lastRunAt: n.live.lastRunAt ?? null,
              triggers: n.live.triggers,
              fire: (source: "cron" | "window") => runLiveNoteAgent(db, publish, n.file, source),
            }))
        : []),
    ];
    for (const t of targets) {
      // In-flight/crashed attempt: wait out the backoff window before retrying.
      if (t.lastAttemptAt && (!t.lastRunAt || t.lastAttemptAt > t.lastRunAt) && backoffRemainingMs(t.lastAttemptAt) > 0) continue;
      const source = dueTimedTrigger(t.triggers, t.lastRunAt);
      if (!source) continue;
      if (backoffRemainingMs(t.lastAttemptAt) > 0) continue;
      console.log(`[${t.kind}] ${t.id} — firing (${source})`);
      void t.fire(source).catch((e) => console.error(`[${t.kind}] ${t.id}:`, e));
    }
  } catch (e) {
    console.error("[bg-task tick]", e);
  } finally {
    bgTicking = false;
  }
}

async function knowledgeTick(db: Db): Promise<void> {
  if (knowledgeTicking) return;
  knowledgeTicking = true;
  try {
    if (!llmAgentsEnabled(db)) return;
    const { processAllSources, curateNotes } = await import("@ami/memory");
    const res = await processAllSources(db);
    if (res.processed > 0 || res.errors > 0) {
      console.log(`[graph] processed ${res.processed} source file(s), ${res.errors} error(s)`);
      publish({ type: "ingest.progress", message: `memory: ${res.processed} source(s) absorbed` });
    }
    await curateNotes(db); // no-ops unless the daily interval has elapsed
  } catch (e) {
    console.error("[graph]", e);
  } finally {
    knowledgeTicking = false;
  }
}

async function tick(db: Db): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const id of wakeSnoozedTodos(db)) {
      publish({ type: "todo.updated", todoId: id });
    }
    await pollDueStreams(db);
    const { createdTodoIds } = await triageBatch(db, 10, publish);
    for (const id of createdTodoIds) {
      publish({ type: "todo.created", todoId: id });
    }
    // New coding tasks find their repo on their own (worktree runs need a
    // project attached; the user shouldn't have to pick one).
    if (llmAgentsEnabled(db)) {
      const { projectResolveTick } = await import("@ami/engine");
      void projectResolveTick(db, publish).catch((e) => console.error("[projects resolve]", e));
    }
    // Feed the durable event queue: every triaged todo is an event that can
    // wake background agents and live notes (Pass-1 routing decides which).
    if (createdTodoIds.length > 0) {
      const { createEvent } = await import("@ami/engine");
      const { getTodo, getSignal } = await import("@ami/db");
      for (const id of createdTodoIds) {
        const todo = getTodo(db, id);
        if (!todo) continue;
        const signal = todo.signalId ? getSignal(db, todo.signalId) : undefined;
        createEvent({
          source: signal?.connector ?? "ami",
          type: "signal.triaged",
          createdAt: new Date().toISOString(),
          payload: `# ${todo.title}\n\n${todo.summary}\n\n${signal ? `From: ${signal.author}\n\n${signal.body.slice(0, 1500)}` : ""}`,
        });
      }
    }
  } catch (e) {
    console.error("[scheduler]", e);
  } finally {
    ticking = false;
  }
}

async function pollDueStreams(db: Db): Promise<void> {
  const accounts = db.select().from(connectorAccounts).all();
  for (const acct of accounts) {
    if (acct.status === "disabled") continue;
    const connector = getConnector(acct.connector);
    if (!connector) continue;
    const auth: AuthBlob = JSON.parse(acct.authJson);

    // Connector-specific user configuration (Slack read-all channels, DM toggle).
    const config =
      acct.connector === "slack"
        ? {
            readAllChannels: JSON.parse(getSetting(db, "slack_read_all_channels") ?? "[]"),
            readDms: getSetting(db, "slack_read_dms") !== "0",
          }
        : undefined;

    for (const stream of connector.streams()) {
      const cur = getCursor(db, acct.id, stream.name);
      const last = cur?.lastPolledAt ? new Date(cur.lastPolledAt).getTime() : 0;
      if (Date.now() - last < stream.intervalSec * 1000) continue;

      try {
        const result = await connector.poll({
          auth,
          stream: stream.name,
          cursor: cur?.cursor ?? null,
          config,
        });
        let inserted = 0;
        for (const sig of result.signals) {
          if (insertSignal(db, acct.connector, acct.id, sig)) inserted++;
        }
        setCursor(db, acct.id, stream.name, result.nextCursor);
        // Persist refreshed OAuth tokens (google connectors mutate the blob).
        db.update(connectorAccounts)
          .set({ authJson: JSON.stringify(auth), status: "connected", error: null })
          .where(eq(connectorAccounts.id, acct.id))
          .run();
        if (inserted > 0) {
          publish({
            type: "ingest.progress",
            message: `${connector.meta.label}: ${inserted} new signal${inserted > 1 ? "s" : ""}`,
          });
        }
      } catch (e: any) {
        console.error(`[poll ${acct.connector}/${stream.name}]`, e.message);
        db.update(connectorAccounts)
          .set({ status: "error", error: String(e.message).slice(0, 500) })
          .where(eq(connectorAccounts.id, acct.id))
          .run();
        publish({ type: "connector.status", connector: connector.id, status: "error" });
      }
    }
  }
}
