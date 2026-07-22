import { z } from "zod";
import type { NormalizedSignal } from "@ami/shared";
import type { AmiConnector, ActionResult } from "../types.js";
import { googleApi } from "../google-auth.js";

const CAL = "https://www.googleapis.com/calendar/v3";

export const gcalConnector: AmiConnector = {
  id: "gcal",
  meta: {
    label: "Google Calendar",
    authKind: "oauth",
    authFields: [],
    setupHelp: "Connected automatically alongside Gmail via the Connect Google flow.",
  },
  async validateAuth(auth) {
    try {
      const j = await googleApi(auth, `${CAL}/calendars/primary`);
      return { ok: true, accountLabel: j.id };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
  streams() {
    return [{ name: "events", intervalSec: 300 }];
  },
  async poll({ auth, cursor }) {
    const signals: NormalizedSignal[] = [];
    const base = `${CAL}/calendars/primary/events`;
    let url: string;
    if (cursor) {
      url = `${base}?syncToken=${encodeURIComponent(cursor)}`;
    } else {
      const timeMin = new Date().toISOString();
      const timeMax = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
      url = `${base}?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&maxResults=50`;
    }
    try {
      let nextSyncToken: string | null = null;
      let pageToken: string | null = null;
      do {
        const j: any = await googleApi(auth, pageToken ? `${url}&pageToken=${pageToken}` : url);
        for (const ev of j.items ?? []) {
          if (ev.status === "cancelled") continue;
          // Only surface invites needing a response from the user.
          const selfAttendee = (ev.attendees ?? []).find((a: any) => a.self);
          if (!selfAttendee || selfAttendee.responseStatus !== "needsAction") continue;
          signals.push({
            externalId: `${ev.id}:${ev.updated}`,
            kind: "event",
            title: `Invite: ${ev.summary ?? "(untitled)"}`,
            body: `${ev.summary ?? ""} — ${ev.start?.dateTime ?? ev.start?.date ?? ""}, organizer ${ev.organizer?.email ?? ""}. ${ev.description ?? ""}`.slice(0, 2000),
            author: ev.organizer?.email ?? "",
            url: ev.htmlLink,
            threadRef: ev.id,
            raw: { id: ev.id },
            occurredAt: ev.updated ?? new Date().toISOString(),
          });
        }
        pageToken = j.nextPageToken ?? null;
        if (j.nextSyncToken) nextSyncToken = j.nextSyncToken;
      } while (pageToken);
      return { signals, nextCursor: nextSyncToken ?? cursor };
    } catch (e: any) {
      if (e.status === 410) return { signals: [], nextCursor: null }; // full resync next tick
      throw e;
    }
  },
  async bootstrap(auth, onProgress) {
    // Knowledge: ~2 months of calendar history plus the next 4 weeks. Recurring
    // meetings and their attendees reveal the user's working relationships.
    onProgress?.("reading calendar (past 60 days + next 4 weeks)");
    const timeMin = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
    const timeMax = new Date(Date.now() + 28 * 24 * 3600_000).toISOString();
    const j: any = await googleApi(
      auth,
      `${CAL}/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=250`,
    );
    const events: any[] = (j.items ?? []).filter((ev: any) => ev.status !== "cancelled");
    if (events.length === 0) return { docs: [], triage: [] };

    // Frequent attendees (excluding the user and resource rooms).
    const counts = new Map<string, { display: string; n: number }>();
    for (const ev of events) {
      for (const a of ev.attendees ?? []) {
        if (a.self || a.resource || !a.email) continue;
        const key = a.email.toLowerCase();
        const cur = counts.get(key);
        if (cur) cur.n++;
        else counts.set(key, { display: a.displayName ? `${a.displayName} <${a.email}>` : a.email, n: 1 });
      }
    }
    const frequent = [...counts.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 30)
      .map((c) => `- ${c.display} — ${c.n} meeting(s)`)
      .join("\n");

    const lines = events.map((ev: any) => {
      const start = ev.start?.dateTime ?? ev.start?.date ?? "";
      const attendees = (ev.attendees ?? [])
        .filter((a: any) => !a.self && !a.resource && a.email)
        .map((a: any) => a.displayName ?? a.email)
        .slice(0, 8)
        .join(", ");
      const parts = [
        `- ${start.slice(0, 16)} — **${ev.summary ?? "(untitled)"}**`,
        ev.recurringEventId ? "(recurring)" : "",
        attendees ? `with ${attendees}` : "",
      ].filter(Boolean);
      return parts.join(" ");
    });

    const docs = [];
    const CHUNK = 60;
    for (let i = 0; i < lines.length; i += CHUNK) {
      const part = Math.floor(i / CHUNK) + 1;
      const entries = lines.slice(i, i + CHUNK).join("\n");
      docs.push({
        name: `calendar-digest-${part}`,
        title: `Calendar digest (part ${part})`,
        body:
          part === 1
            ? `The user's calendar from the last 60 days through the next 4 weeks (${events.length} events). Recurring meetings and frequent attendees are the user's core working relationships.\n\n## Frequent attendees\n\n${frequent}\n\n## Events\n\n${entries}`
            : entries,
      });
    }
    return { docs, triage: [] };
  },
  actions: [
    {
      name: "gcal_create_event",
      description:
        "Create a Google Calendar event on the user's primary calendar, optionally with guests and a meeting link in the location.",
      schema: {
        summary: z.string(),
        startIso: z.string().describe("Start time, ISO 8601 with timezone offset"),
        endIso: z.string().describe("End time, ISO 8601 with timezone offset"),
        guests: z.array(z.string()).describe("Guest email addresses").optional(),
        description: z.string().optional(),
        location: z.string().describe("Location or meeting link").optional(),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const j = await googleApi(
            auth,
            `${CAL}/calendars/primary/events?sendUpdates=all`,
            {
              method: "POST",
              body: JSON.stringify({
                summary: input.summary,
                description: input.description,
                location: input.location,
                start: { dateTime: input.startIso },
                end: { dateTime: input.endIso },
                attendees: ((input.guests as string[]) ?? []).map((email) => ({ email })),
              }),
            },
          );
          return { ok: true, url: j.htmlLink, externalId: j.id, output: j };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "gcal_list_events",
      readOnly: true,
      description: "List the user's calendar events in a time range (to check availability).",
      schema: { timeMinIso: z.string(), timeMaxIso: z.string() },
      async run(auth, input): Promise<ActionResult> {
        try {
          const j = await googleApi(
            auth,
            `${CAL}/calendars/primary/events?timeMin=${input.timeMinIso}&timeMax=${input.timeMaxIso}&singleEvents=true&orderBy=startTime`,
          );
          const events = (j.items ?? []).map((e: any) => ({
            summary: e.summary,
            start: e.start,
            end: e.end,
            attendees: (e.attendees ?? []).map((a: any) => a.email),
          }));
          return { ok: true, output: events };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "gcal_search_events",
      readOnly: true,
      description:
        "Free-text search over the user's calendar events (matches title, description, attendees, location). Defaults to the past 90 days through the next 180 days unless a time range is given.",
      schema: {
        query: z.string(),
        timeMinIso: z.string().optional(),
        timeMaxIso: z.string().optional(),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const max = Math.min(Number(input.limit) || 10, 25);
          const timeMin = String(input.timeMinIso ?? new Date(Date.now() - 90 * 24 * 3600_000).toISOString());
          const timeMax = String(input.timeMaxIso ?? new Date(Date.now() + 180 * 24 * 3600_000).toISOString());
          const j = await googleApi(
            auth,
            `${CAL}/calendars/primary/events?q=${encodeURIComponent(String(input.query))}&timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=${max}`,
          );
          const events = (j.items ?? []).map((e: any) => ({
            summary: e.summary,
            start: e.start?.dateTime ?? e.start?.date,
            end: e.end?.dateTime ?? e.end?.date,
            organizer: e.organizer?.email,
            attendees: (e.attendees ?? []).map((a: any) => a.email).slice(0, 10),
            url: e.htmlLink,
          }));
          return { ok: true, output: events };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
  ],
};
