import { connectorAccounts, insertSignal, type Db } from "@ami/db";
import { eq } from "drizzle-orm";
import { getConnector } from "@ami/connectors";
import { writeSourceDoc } from "@ami/memory";
import { nowIso, type AmiEvent, type AuthBlob } from "@ami/shared";

/** First-connect history backfill. Runs once per connector account (stamped
 * via connector_accounts.bootstrapped_at):
 * - digest docs land as knowledge sources — the graph builder distills them
 *   into dossiers on its next tick (historical context, never todos);
 * - recent actionable items land as ordinary untriaged signals and seed the
 *   first task list through normal triage (dedup by external id makes the
 *   overlap with regular polling harmless). */

type Publish = (e: AmiEvent) => void;

const inFlight = new Set<string>(); // connector ids

/** Connectors whose backfill is currently running (for the console). */
export function bootstrappingConnectors(): string[] {
  return [...inFlight];
}

export async function runBootstrap(db: Db, publish: Publish, accountId: string): Promise<void> {
  const acct = db.select().from(connectorAccounts).where(eq(connectorAccounts.id, accountId)).get();
  if (!acct || acct.bootstrappedAt || inFlight.has(acct.connector)) return;
  const connector = getConnector(acct.connector);
  if (!connector) return;

  const stamp = () =>
    db
      .update(connectorAccounts)
      .set({ bootstrappedAt: nowIso() })
      .where(eq(connectorAccounts.id, accountId))
      .run();

  if (!connector.bootstrap) {
    stamp();
    return;
  }

  inFlight.add(acct.connector);
  const label = connector.meta.label;
  try {
    publish({ type: "ingest.progress", message: `${label}: reading your history…` });
    const auth: AuthBlob = JSON.parse(acct.authJson);
    const result = await connector.bootstrap(auth, (message) =>
      publish({ type: "ingest.progress", message: `${label}: ${message}` }),
    );

    for (const doc of result.docs) {
      writeSourceDoc(connector.id, doc.name, doc.title, doc.body);
    }
    // Refreshed OAuth tokens (google mutates the blob) must survive the backfill.
    db.update(connectorAccounts)
      .set({ authJson: JSON.stringify(auth) })
      .where(eq(connectorAccounts.id, accountId))
      .run();

    let queued = 0;
    for (const sig of result.triage) {
      if (insertSignal(db, acct.connector, accountId, sig)) queued++;
    }

    stamp();
    const parts = [
      result.docs.length ? `${result.docs.length} digest(s) queued for memory` : "",
      queued ? `${queued} recent item(s) queued for triage` : "",
    ].filter(Boolean);
    publish({
      type: "ingest.progress",
      message: `${label}: history backfill done${parts.length ? ` — ${parts.join(", ")}` : ""}`,
    });
    console.log(`[bootstrap] ${acct.connector}: ${result.docs.length} doc(s), ${queued} triage signal(s)`);
  } catch (e: any) {
    // Left unstamped on purpose — the startup sweep retries on next boot.
    console.error(`[bootstrap] ${acct.connector}:`, e);
    publish({ type: "ingest.progress", message: `${label}: history backfill failed — ${String(e.message ?? e).slice(0, 200)}` });
  } finally {
    inFlight.delete(acct.connector);
  }
}

/** Startup sweep: backfill any account that never completed one (new installs,
 * upgrades, interrupted bootstraps). Sequential to be polite to APIs. */
export async function bootstrapPendingAccounts(db: Db, publish: Publish): Promise<void> {
  const accounts = db.select().from(connectorAccounts).all();
  for (const acct of accounts) {
    if (acct.status === "disabled" || acct.bootstrappedAt) continue;
    await runBootstrap(db, publish, acct.id);
  }
}
