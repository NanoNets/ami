import { CronExpressionParser } from "cron-parser";

/** Trigger/backoff math shared by background agents and live notes.
 *
 * Semantics:
 * - Cron: fires when the previous cron occurrence at-or-before now is within a
 *   2-minute grace window AND the last successful run predates that occurrence.
 * - Windows: daily once-per-window bands; fires when now is inside the band and
 *   the last successful run predates today's window start.
 * - The cycle anchor is lastRunAt (bumped only on success) so failed runs don't
 *   advance the cycle — the next scan retries, gated by backoff.
 */

export interface TimedTriggers {
  cronExpr?: string;
  windows?: { startTime: string; endTime: string }[]; // "HH:MM" local
  eventMatchCriteria?: string;
}

const CRON_GRACE_MS = 2 * 60 * 1000;
export const RETRY_BACKOFF_MS = 5 * 60 * 1000;

function parseHm(hm: string, base: Date): Date | null {
  const m = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(base);
  d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
  return d;
}

export function dueTimedTrigger(
  triggers: TimedTriggers | undefined,
  lastRunAt: string | null,
  now = new Date(),
): "cron" | "window" | null {
  if (!triggers) return null;
  const last = lastRunAt ? new Date(lastRunAt).getTime() : 0;

  if (triggers.cronExpr) {
    try {
      const it = CronExpressionParser.parse(triggers.cronExpr, { currentDate: now });
      const prev = it.prev().toDate();
      const withinGrace = now.getTime() - prev.getTime() <= CRON_GRACE_MS;
      if (withinGrace && last < prev.getTime()) return "cron";
    } catch {
      // invalid cron — ignore rather than crash the scheduler
    }
  }

  for (const w of triggers.windows ?? []) {
    const start = parseHm(w.startTime, now);
    const end = parseHm(w.endTime, now);
    if (!start || !end) continue;
    if (now >= start && now <= end && last < start.getTime()) return "window";
  }

  return null;
}

/** Milliseconds of retry backoff remaining since the last attempt (0 = clear). */
export function backoffRemainingMs(lastAttemptAt: string | null, now = Date.now()): number {
  if (!lastAttemptAt) return 0;
  const elapsed = now - new Date(lastAttemptAt).getTime();
  return Math.max(0, RETRY_BACKOFF_MS - elapsed);
}
