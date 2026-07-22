import { z } from "zod";
import type { NormalizedSignal } from "@ami/shared";
import type { AmiConnector, ActionResult, BootstrapResult } from "../types.js";
import { msGraph, stripHtml } from "../microsoft-auth.js";

/** Microsoft 365 mail + calendar via Graph (the Outlook twin of gmail/gcal).
 * OAuth happens through /oauth/microsoft/callback, which registers this
 * connector and msteams with the same token blob. */

const MAIL_SELECT = "id,subject,from,toRecipients,receivedDateTime,conversationId,webLink,body";

function fromLine(m: any): string {
  const f = m.from?.emailAddress;
  return f ? `${f.name ?? ""} <${f.address ?? ""}>`.trim() : "unknown";
}

function mailSignal(m: any): NormalizedSignal {
  return {
    externalId: m.id,
    kind: "email",
    title: `${m.subject || "(no subject)"} — from ${m.from?.emailAddress?.name ?? m.from?.emailAddress?.address ?? "unknown"}`,
    body: `From: ${fromLine(m)}\n\n${stripHtml(m.body?.content ?? "").slice(0, 4000)}`,
    author: m.from?.emailAddress?.address ?? "",
    url: m.webLink,
    threadRef: m.id, // reply target: the message id (Graph reply endpoint)
    raw: { id: m.id, conversationId: m.conversationId },
    occurredAt: m.receivedDateTime,
  };
}

export const m365Connector: AmiConnector = {
  id: "m365",
  meta: {
    label: "Outlook + Calendar",
    authKind: "oauth",
    authFields: [
      { key: "client_id", label: "Entra application (client) ID", placeholder: "00000000-0000-…" },
      { key: "tenant", label: "Tenant (or 'common')", placeholder: "common", optional: true },
    ],
    setupHelp:
      "Register an app at entra.microsoft.com (App registrations → New): supported accounts as fits your org, add a \"Mobile and desktop applications\" redirect URI of http://localhost:4141/oauth/microsoft/callback, and enable \"Allow public client flows\". No client secret needed. Paste the Application (client) ID; tenant is your directory ID or 'common'.",
  },
  async validateAuth(auth) {
    try {
      const me = await msGraph(auth, "/me?$select=displayName,mail,userPrincipalName");
      return { ok: true, accountLabel: me.mail ?? me.userPrincipalName };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
  async identity(auth) {
    const me = await msGraph(auth, "/me?$select=displayName,mail,userPrincipalName");
    return { name: me.displayName, email: me.mail ?? me.userPrincipalName };
  },
  streams() {
    return [
      { name: "mail", intervalSec: 120 },
      { name: "calendar", intervalSec: 300 },
    ];
  },
  async poll({ auth, stream, cursor }) {
    const signals: NormalizedSignal[] = [];
    if (stream === "mail") {
      const since = cursor ?? new Date(Date.now() - 24 * 3600_000).toISOString();
      const me = await msGraph(auth, "/me?$select=mail,userPrincipalName");
      const myAddress = String(me.mail ?? me.userPrincipalName ?? "").toLowerCase();
      const j = await msGraph(
        auth,
        `/me/mailFolders/Inbox/messages?$filter=receivedDateTime gt ${since}&$orderby=receivedDateTime asc&$top=25&$select=${MAIL_SELECT}`,
      );
      let max = since;
      for (const m of j.value ?? []) {
        if (m.receivedDateTime > max) max = m.receivedDateTime;
        if ((m.from?.emailAddress?.address ?? "").toLowerCase() === myAddress) continue;
        signals.push(mailSignal(m));
      }
      return { signals, nextCursor: max };
    }
    if (stream === "calendar") {
      // New/updated events in the coming 2 weeks — invites and reschedules.
      const since = cursor ?? new Date(Date.now() - 24 * 3600_000).toISOString();
      const now = new Date().toISOString();
      const end = new Date(Date.now() + 14 * 24 * 3600_000).toISOString();
      const j = await msGraph(
        auth,
        `/me/calendarView?startDateTime=${now}&endDateTime=${end}&$top=50&$select=id,subject,organizer,start,end,lastModifiedDateTime,webLink,bodyPreview,attendees`,
      );
      let max = since;
      for (const e of j.value ?? []) {
        const mod = e.lastModifiedDateTime ?? "";
        if (mod <= since) continue;
        if (mod > max) max = mod;
        const attendees = (e.attendees ?? [])
          .slice(0, 10)
          .map((a: any) => a.emailAddress?.name ?? a.emailAddress?.address)
          .filter(Boolean)
          .join(", ");
        signals.push({
          externalId: `event:${e.id}:${mod}`,
          kind: "event",
          title: `Calendar: ${e.subject ?? "(no title)"} — ${e.start?.dateTime?.slice(0, 16) ?? ""}`,
          body: [
            `Organizer: ${e.organizer?.emailAddress?.name ?? ""} <${e.organizer?.emailAddress?.address ?? ""}>`,
            `When: ${e.start?.dateTime ?? ""} → ${e.end?.dateTime ?? ""} (UTC)`,
            attendees ? `Attendees: ${attendees}` : "",
            e.bodyPreview ? `\n${String(e.bodyPreview).slice(0, 800)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          author: e.organizer?.emailAddress?.address ?? "",
          url: e.webLink,
          threadRef: e.id,
          raw: { id: e.id, lastModified: mod },
          occurredAt: mod,
        });
      }
      return { signals, nextCursor: max };
    }
    return { signals: [], nextCursor: cursor };
  },
  async bootstrap(auth, onProgress): Promise<BootstrapResult> {
    const docs: { name: string; title: string; body: string }[] = [];

    // Sent mail → who the user actually talks to (the gmail bootstrap's shape).
    onProgress?.("reading sent mail");
    try {
      const j = await msGraph(
        auth,
        `/me/mailFolders/SentItems/messages?$top=100&$orderby=sentDateTime desc&$select=subject,toRecipients,sentDateTime`,
      );
      const tally = new Map<string, { name: string; count: number }>();
      const lines: string[] = [];
      for (const m of j.value ?? []) {
        for (const r of m.toRecipients ?? []) {
          const addr = (r.emailAddress?.address ?? "").toLowerCase();
          if (!addr) continue;
          const t = tally.get(addr) ?? { name: r.emailAddress?.name ?? addr, count: 0 };
          t.count++;
          tally.set(addr, t);
        }
        lines.push(`- To ${(m.toRecipients ?? []).map((r: any) => r.emailAddress?.address).join(", ")}: "${m.subject ?? ""}" (${(m.sentDateTime ?? "").slice(0, 10)})`);
      }
      const frequent = [...tally.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 30)
        .map(([addr, t]) => `- ${t.name} <${addr}> — ${t.count} email(s)`);
      if (lines.length) {
        docs.push({
          name: "sent-mail-digest",
          title: "Outlook: recent sent mail",
          body: `The user's own outbound email — who they talk to and about what.\n\n## Frequent correspondents\n\n${frequent.join("\n")}\n\n## Recent sent messages\n\n${lines.slice(0, 100).join("\n")}`,
        });
      }
    } catch (e: any) {
      console.error(`[m365 bootstrap] sent: ${e.message}`);
    }

    // Calendar: -60d to +28d — collaborators and rhythms.
    onProgress?.("reading calendar");
    try {
      const start = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
      const end = new Date(Date.now() + 28 * 24 * 3600_000).toISOString();
      const j = await msGraph(
        auth,
        `/me/calendarView?startDateTime=${start}&endDateTime=${end}&$top=250&$select=subject,organizer,start,attendees`,
      );
      const me = await msGraph(auth, "/me?$select=mail,userPrincipalName");
      const myAddress = String(me.mail ?? me.userPrincipalName ?? "").toLowerCase();
      const attendeeTally = new Map<string, { name: string; count: number }>();
      const lines: string[] = [];
      for (const e of j.value ?? []) {
        lines.push(`- ${(e.start?.dateTime ?? "").slice(0, 16)} — ${e.subject ?? "(no title)"}`);
        for (const a of e.attendees ?? []) {
          const addr = (a.emailAddress?.address ?? "").toLowerCase();
          if (!addr || addr === myAddress) continue;
          const t = attendeeTally.get(addr) ?? { name: a.emailAddress?.name ?? addr, count: 0 };
          t.count++;
          attendeeTally.set(addr, t);
        }
      }
      const frequent = [...attendeeTally.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 25)
        .map(([addr, t]) => `- ${t.name} <${addr}> — ${t.count} meeting(s)`);
      if (lines.length) {
        docs.push({
          name: "calendar-digest",
          title: "Outlook calendar: last 60 days and next 4 weeks",
          body: `## People the user meets most\n\n${frequent.join("\n")}\n\n## Events\n\n${lines.join("\n")}`,
        });
      }
    } catch (e: any) {
      console.error(`[m365 bootstrap] calendar: ${e.message}`);
    }

    // First task list: last 7 days of inbox through normal triage.
    onProgress?.("reading last 7 days of inbox");
    const triage: NormalizedSignal[] = [];
    try {
      const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
      const j = await msGraph(
        auth,
        `/me/mailFolders/Inbox/messages?$filter=receivedDateTime gt ${since}&$orderby=receivedDateTime desc&$top=50&$select=${MAIL_SELECT}`,
      );
      for (const m of j.value ?? []) triage.push(mailSignal(m));
    } catch (e: any) {
      console.error(`[m365 bootstrap] inbox: ${e.message}`);
    }

    return { docs, triage };
  },
  actions: [
    {
      name: "m365_thread_context",
      readOnly: true,
      description:
        "Fetch the conversation an Outlook message belongs to. Input is the message id (threadRef of an m365 signal).",
      schema: { threadRef: z.string() },
      async run(auth, input): Promise<ActionResult> {
        try {
          const msg = await msGraph(auth, `/me/messages/${encodeURIComponent(String(input.threadRef))}?$select=conversationId`);
          const j = await msGraph(
            auth,
            `/me/messages?$filter=conversationId eq '${msg.conversationId}'&$top=20&$select=subject,from,receivedDateTime,body`,
          );
          const msgs = (j.value ?? [])
            .sort((a: any, b: any) => String(a.receivedDateTime).localeCompare(String(b.receivedDateTime)))
            .map((m: any) => ({
              from: fromLine(m),
              at: m.receivedDateTime,
              text: stripHtml(m.body?.content ?? "").slice(0, 2000),
            }));
          return { ok: true, output: msgs };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "m365_search_mail",
      readOnly: true,
      description:
        'Search the user\'s Outlook mail (plain terms plus KQL like from:, subject:, received:YYYY-MM-DD, "exact phrase"). Returns matching messages — pass a threadRef (message id) to m365_thread_context for the whole conversation.',
      schema: {
        query: z.string(),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const top = Math.min(Number(input.limit) || 10, 25);
          const q = String(input.query).replace(/"/g, '\\"');
          const j = await msGraph(
            auth,
            `/me/messages?$search="${encodeURIComponent(q)}"&$top=${top}&$select=id,subject,from,receivedDateTime,bodyPreview,webLink`,
          );
          const msgs = (j.value ?? []).map((m: any) => ({
            threadRef: m.id,
            from: fromLine(m),
            subject: m.subject ?? "(no subject)",
            at: m.receivedDateTime,
            preview: String(m.bodyPreview ?? "").slice(0, 300),
            url: m.webLink,
          }));
          return { ok: true, output: msgs };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "m365_send_mail",
      description:
        "Send an Outlook email on behalf of the user: a reply when targetRef (message id) is given, otherwise a new message to `to`.",
      isSend: true,
      schema: {
        targetRef: z.string().nullable().describe("Message id to reply to (threadRef of the signal), or null for a new email"),
        to: z.string().nullable().describe("Recipient email for a new message (ignored for replies)"),
        subject: z.string().nullable().describe("Subject for a new message (ignored for replies)"),
        body: z.string().describe("Plain-text body"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          if (input.targetRef) {
            await msGraph(auth, `/me/messages/${encodeURIComponent(String(input.targetRef))}/reply`, {
              method: "POST",
              body: JSON.stringify({ comment: String(input.body) }),
            });
            return { ok: true, output: { replied: true } };
          }
          if (!input.to) return { ok: false, output: null, error: "need targetRef or to" };
          await msGraph(auth, "/me/sendMail", {
            method: "POST",
            body: JSON.stringify({
              message: {
                subject: String(input.subject ?? ""),
                body: { contentType: "Text", content: String(input.body) },
                toRecipients: [{ emailAddress: { address: String(input.to) } }],
              },
            }),
          });
          return { ok: true, output: { sent: true } };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
  ],
};
