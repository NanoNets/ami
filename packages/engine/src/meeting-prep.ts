import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  amiHome,
  connectorAccounts,
  getSetting,
  insertLlmUsage,
  insertSignal,
  insertTodo,
  listTodos,
  markTriaged,
  type Db,
} from "@ami/db";
import { googleApi } from "@ami/connectors";
import {
  anthropicClient,
  commitKnowledge,
  getKnowledgeIndex,
  invalidateKnowledgeIndex,
  kgModel,
  knowledgeDir,
  ownerIdentity,
  readNote,
  safeSegment,
} from "@ami/memory";
import { WRITING_STYLE, type AmiEvent } from "@ami/shared";

type Publish = (e: AmiEvent) => void;

/** Meeting-prep briefs:
 * attendees of upcoming meetings resolved deterministically to knowledge
 * dossiers; a brief lands in knowledge/Meetings/prep/ (and the Brain graph);
 * substantial preps also become FYI todos. */

const PREP_LEAD_MS = 6 * 60 * 60 * 1000;
const STATE_GC_MS = 24 * 60 * 60 * 1000;

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end?: string;
  organizer?: string;
  attendees: { email?: string; displayName?: string; self?: boolean; responseStatus?: string }[];
  description?: string;
  allDay: boolean;
  cancelled: boolean;
  joinLink?: string;
}

const MEETING_URL_RE =
  /https?:\/\/[^\s<>"'`)\]]*(?:zoom\.us\/(?:j|my|w)\/|meet\.google\.com\/|teams\.microsoft\.com\/l\/meetup-join|[\w.-]*webex\.com\/(?:meet|join)\/|whereby\.com\/)[^\s<>"'`)\]]*/i;

/** Join link for any conference provider: Google's hangoutLink only covers
 * Meet — Zoom/Teams/Webex links live in conferenceData entry points or in the
 * event's location/description text. */
function extractJoinLink(e: any): string | undefined {
  if (e.hangoutLink) return e.hangoutLink;
  const video = (e.conferenceData?.entryPoints ?? []).find(
    (p: any) => p.entryPointType === "video" && p.uri,
  );
  if (video?.uri) return video.uri;
  for (const text of [e.location, e.description]) {
    const m = typeof text === "string" ? text.match(MEETING_URL_RE) : null;
    if (m) return m[0];
  }
  return undefined;
}

let eventsCache: { at: number; events: CalendarEvent[] } | null = null;

export async function upcomingEvents(db: Db, hours = 24): Promise<CalendarEvent[]> {
  if (eventsCache && Date.now() - eventsCache.at < 10 * 60 * 1000) return eventsCache.events;
  const acct = db.select().from(connectorAccounts).where(eq(connectorAccounts.connector, "gcal")).get();
  if (!acct || acct.status === "disabled") return [];
  try {
    const auth = JSON.parse(acct.authJson);
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + hours * 3_600_000).toISOString();
    const j: any = await googleApi(
      auth,
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=30`,
    );
    db.update(connectorAccounts)
      .set({ authJson: JSON.stringify(auth) })
      .where(eq(connectorAccounts.id, acct.id))
      .run();
    const events: CalendarEvent[] = (j.items ?? []).map((e: any) => ({
      id: e.id,
      title: e.summary || "(no title)",
      start: e.start?.dateTime ?? e.start?.date ?? "",
      end: e.end?.dateTime ?? e.end?.date,
      organizer: e.organizer?.email,
      attendees: (e.attendees ?? []).map((a: any) => ({
        email: a.email,
        displayName: a.displayName,
        self: a.self,
        responseStatus: a.responseStatus,
      })),
      description: e.description,
      allDay: !e.start?.dateTime,
      cancelled: e.status === "cancelled",
      joinLink: extractJoinLink(e),
    }));
    eventsCache = { at: Date.now(), events };
    return events;
  } catch (e: any) {
    console.warn("[meeting-prep] calendar fetch failed:", e.message);
    return [];
  }
}

// ── Attendee resolution ──────────────────────────────────────────────────────

export interface ResolvedAttendee {
  label: string;
  email?: string;
  noteFile?: string; // knowledge-relative
  role?: string;
  organization?: string;
}

export interface MeetingResolution {
  attendees: ResolvedAttendee[];
  organizations: { name: string; noteFile: string }[];
  matchedCount: number;
}

export function resolveAttendees(db: Db, attendees: CalendarEvent["attendees"]): MeetingResolution {
  const index = getKnowledgeIndex();
  const owner = ownerIdentity(db);
  const byEmail = new Map(index.people.filter((p) => p.email).map((p) => [p.email!.toLowerCase(), p]));
  const byName = new Map<string, typeof index.people>();
  for (const p of index.people) {
    for (const n of [p.name, ...p.aliases]) {
      const key = n.toLowerCase().trim();
      if (!key) continue;
      byName.set(key, [...(byName.get(key) ?? []), p]);
    }
  }
  const orgByDomain = new Map(
    index.organizations.filter((o) => o.domain).map((o) => [o.domain!.toLowerCase(), o]),
  );

  const seen = new Set<string>();
  const resolved: ResolvedAttendee[] = [];
  const orgs = new Map<string, { name: string; noteFile: string }>();

  for (const a of attendees) {
    if (a.self) continue;
    const email = a.email?.toLowerCase();
    if (email && (email === owner.email || seen.has(email))) continue;
    if (email) seen.add(email);

    let person = email ? byEmail.get(email) : undefined;
    if (!person && a.displayName) {
      const candidates = byName.get(a.displayName.replace(/\(.*?\)/g, "").toLowerCase().trim()) ?? [];
      if (candidates.length === 1) person = candidates[0];
    }
    resolved.push({
      label: person?.name ?? a.displayName ?? a.email ?? "unknown",
      email: a.email,
      noteFile: person?.file,
      role: person?.role,
      organization: person?.organization,
    });

    const domain = email?.split("@")[1];
    if (domain && domain !== owner.domain) {
      const org = orgByDomain.get(domain);
      if (org && !orgs.has(org.file)) orgs.set(org.file, { name: org.name, noteFile: org.file });
    }
  }

  resolved.sort((a, b) => Number(!!b.noteFile) - Number(!!a.noteFile));
  return {
    attendees: resolved,
    organizations: [...orgs.values()],
    matchedCount: resolved.filter((r) => r.noteFile).length,
  };
}

// ── Brief generation ─────────────────────────────────────────────────────────

function openItemsFrom(noteFile: string): string[] {
  const content = readNote(noteFile);
  if (!content) return [];
  return [...content.matchAll(/^- \[ \] (.+)$/gm)].map((m) => m[1]).slice(0, 5);
}

async function whatMattersBullets(db: Db, event: CalendarEvent, res: MeetingResolution): Promise<string | null> {
  const client = anthropicClient(db);
  if (!client || process.env.AMI_FAKE_LLM === "1" || res.matchedCount === 0) return null;
  const dossiers = res.attendees
    .filter((a) => a.noteFile)
    .map((a) => readNote(a.noteFile!))
    .filter(Boolean)
    .join("\n\n---\n\n")
    .slice(0, 12000);
  try {
    const model = kgModel(db);
    const r = await client.messages.create({
      model,
      max_tokens: 500,
      system: `You write a meeting-prep brief. 3-5 bullets, lead with what to focus on. Use ONLY the provided dossier content — no invention. Terse, factual, absolute dates.\n\n${WRITING_STYLE}`,
      messages: [
        {
          role: "user",
          content: `Meeting: ${event.title} at ${event.start}\n${event.description ? `Agenda/description: ${event.description.slice(0, 800)}\n` : ""}\nAttendee dossiers:\n\n${dossiers}`,
        },
      ],
    });
    insertLlmUsage(db, {
      useCase: "meeting_prep",
      model,
      inputTokens: r.usage.input_tokens,
      outputTokens: r.usage.output_tokens,
      cacheReadTokens: r.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: r.usage.cache_creation_input_tokens ?? 0,
    });
    return r.content.find((b) => b.type === "text")?.text?.trim() ?? null;
  } catch {
    return null;
  }
}

export async function renderPrepNote(db: Db, event: CalendarEvent, res: MeetingResolution): Promise<string> {
  const brief = await whatMattersBullets(db, event, res);
  const lines: string[] = [`# Prep: ${event.title}`, ``];
  lines.push(`**When:** ${event.start}${event.end ? ` – ${event.end}` : ""}`);
  if (event.joinLink) lines.push(`**Join:** ${event.joinLink}`);
  lines.push(``);
  if (brief) lines.push(`## What matters`, brief, ``);
  if (event.description) lines.push(`## Agenda`, event.description.slice(0, 1500), ``);
  lines.push(`## Who's coming`);
  for (const a of res.attendees) {
    const link = a.noteFile ? `[[${a.noteFile.replace(/\.md$/, "")}]]` : a.label;
    const extra = [a.role, a.organization].filter(Boolean).join(", ");
    lines.push(`- ${link}${extra ? ` — ${extra}` : ""}${a.noteFile ? "" : " _(no dossier yet)_"}`);
  }
  lines.push(``);
  if (res.organizations.length) {
    lines.push(`## Companies`);
    for (const o of res.organizations) lines.push(`- [[${o.noteFile.replace(/\.md$/, "")}]]`);
    lines.push(``);
  }
  const openItems = res.attendees
    .filter((a) => a.noteFile)
    .flatMap((a) => openItemsFrom(a.noteFile!).map((i) => `- ${i} _(from ${a.label})_`));
  if (openItems.length) lines.push(`## Open items with them`, ...openItems, ``);
  return lines.join("\n");
}

// ── Scheduler + state ────────────────────────────────────────────────────────

interface PrepState {
  preppedEventIds: Record<string, { preppedAt: string; startTime: string; todoCreated?: boolean }>;
}

function statePath(): string {
  return path.join(amiHome(), "meeting_prep_state.json");
}

function loadPrepState(): PrepState {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf-8"));
  } catch {
    return { preppedEventIds: {} };
  }
}

function savePrepState(s: PrepState): void {
  for (const [id, entry] of Object.entries(s.preppedEventIds)) {
    if (Date.now() - new Date(entry.startTime).getTime() > STATE_GC_MS) delete s.preppedEventIds[id];
  }
  fs.writeFileSync(statePath(), JSON.stringify(s, null, 2));
}

function prepNotePath(event: CalendarEvent): string {
  const date = event.start.slice(0, 10);
  return path.join("Meetings", "prep", `${safeSegment(event.title)}-${date}.md`);
}

export async function meetingPrepTick(db: Db, publish: Publish): Promise<void> {
  const state = loadPrepState();
  const events = await upcomingEvents(db);
  const now = Date.now();
  let wrote = false;

  for (const event of events) {
    if (state.preppedEventIds[event.id]) continue;
    if (event.cancelled || event.allDay) continue;
    const others = event.attendees.filter((a) => !a.self);
    if (others.length === 0) continue;
    const self = event.attendees.find((a) => a.self);
    if (self?.responseStatus === "declined") continue;
    const startMs = new Date(event.start).getTime();
    if (!(startMs >= now && startMs <= now + PREP_LEAD_MS)) continue;

    try {
      const res = resolveAttendees(db, event.attendees);
      const md = await renderPrepNote(db, event, res);
      const rel = prepNotePath(event);
      const abs = path.join(knowledgeDir(), rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, md, "utf-8");
      invalidateKnowledgeIndex();
      wrote = true;

      // FYI todo only when the prep has substance (≥1 real dossier matched),
      // and only once per event.
      let todoCreated = false;
      if (res.matchedCount > 0) {
        const existing = listTodos(db).some(
          (t) => t.title.startsWith("Meeting prep:") && t.summary.includes(event.id),
        );
        if (!existing) {
          const start = new Date(event.start);
          const when = start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
          const dateLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
          // Synthetic pre-triaged signal so the card shows its source like
          // connector-sourced todos: meeting name, date, and the meeting icon.
          const sigId = insertSignal(db, "meeting", null, {
            externalId: `meeting-prep:${event.id}`,
            kind: "message",
            title: `Meeting prep: ${event.title}`,
            body: `Prep brief for the upcoming meeting: knowledge/${prepNotePath(event)}`,
            author: `${event.title} · ${dateLabel}, ${when}`,
            url: event.joinLink,
            threadRef: event.id,
            raw: null,
            occurredAt: event.start,
          });
          if (sigId) markTriaged(db, [sigId]);
          const todoId = insertTodo(db, {
            type: "fyi",
            title: `Meeting prep: ${event.title} (${when})`,
            summary: `${res.matchedCount} known attendee(s): ${res.attendees
              .filter((a) => a.noteFile)
              .map((a) => a.label)
              .join(", ")}. Brief: knowledge/${prepNotePath(event)} [event:${event.id}]`,
            signalId: sigId,
            entityIds: [],
          });
          publish({ type: "todo.created", todoId });
          todoCreated = true;
        }
      }
      state.preppedEventIds[event.id] = {
        preppedAt: new Date().toISOString(),
        startTime: event.start,
        todoCreated,
      };
      console.log(`[meeting-prep] prepped "${event.title}" (${res.matchedCount} matched)`);
    } catch (e) {
      console.error(`[meeting-prep] failed for "${event.title}":`, e);
    }
  }

  savePrepState(state);
  if (wrote) await commitKnowledge("Meeting prep").catch(() => {});
}

/** Today panel data: today's meetings with resolution + brief location. */
export async function todayMeetings(db: Db) {
  const events = await upcomingEvents(db);
  const todayStr = new Date().toDateString();
  return events
    .filter((e) => !e.cancelled && !e.allDay && new Date(e.start).toDateString() === todayStr)
    .map((e) => {
      const res = resolveAttendees(db, e.attendees);
      const rel = prepNotePath(e);
      const hasBrief = fs.existsSync(path.join(knowledgeDir(), rel));
      return {
        id: e.id,
        title: e.title,
        start: e.start,
        end: e.end,
        joinLink: e.joinLink,
        attendees: res.attendees.map((a) => ({ label: a.label, noteFile: a.noteFile ?? null })),
        matchedCount: res.matchedCount,
        briefPath: hasBrief ? rel : null,
      };
    });
}
