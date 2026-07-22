import { eq } from "drizzle-orm";
import { connectorAccounts, type Db } from "@ami/db";
import { googleApi } from "@ami/connectors";

/** Upcoming-calendar context for triage-time drafting: scheduling
 * threads get drafts that propose
 * real free slots instead of "let me check my calendar". Cached ~15 min. */

const LOOKAHEAD_DAYS = 7;
const MAX_EVENTS = 25;
const CACHE_MS = 15 * 60 * 1000;

let cache: { at: number; text: string } | null = null;

export async function upcomingCalendarBlock(db: Db): Promise<string> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.text;

  let text = "(no upcoming events)";
  const acct = db.select().from(connectorAccounts).where(eq(connectorAccounts.connector, "gcal")).get();
  if (acct && acct.status !== "disabled") {
    try {
      const auth = JSON.parse(acct.authJson);
      const timeMin = new Date().toISOString();
      const timeMax = new Date(Date.now() + LOOKAHEAD_DAYS * 86_400_000).toISOString();
      const j: any = await googleApi(
        auth,
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=${MAX_EVENTS}`,
      );
      const items = (j.items ?? []).filter((e: any) => e.status !== "cancelled");
      if (items.length > 0) {
        text = items
          .map((e: any) => {
            const start = e.start?.dateTime ?? e.start?.date ?? "";
            const end = e.end?.dateTime ?? e.end?.date;
            return `- ${start}${end ? ` – ${end}` : ""}: ${e.summary || "(no title)"}`;
          })
          .join("\n");
      }
      // Persist refreshed OAuth tokens (googleApi mutates the blob).
      db.update(connectorAccounts)
        .set({ authJson: JSON.stringify(auth) })
        .where(eq(connectorAccounts.id, acct.id))
        .run();
    } catch (e: any) {
      console.warn("[triage] calendar context unavailable:", e.message);
      text = "(calendar unavailable)";
    }
  }

  cache = { at: Date.now(), text };
  return text;
}
