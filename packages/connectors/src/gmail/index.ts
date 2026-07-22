import { z } from "zod";
import type { NormalizedSignal } from "@ami/shared";
import type { AmiConnector, ActionResult } from "../types.js";
import { googleApi } from "../google-auth.js";

const G = "https://gmail.googleapis.com/gmail/v1/users/me";

function header(msg: any, name: string): string {
  return msg.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBody(msg: any): string {
  const findText = (part: any): string | null => {
    if (part?.mimeType === "text/plain" && part.body?.data) {
      return Buffer.from(part.body.data, "base64url").toString("utf8");
    }
    for (const p of part?.parts ?? []) {
      const t = findText(p);
      if (t) return t;
    }
    return null;
  };
  return (findText(msg.payload) ?? msg.snippet ?? "").slice(0, 4000);
}

/** Earlier messages of the thread, condensed — so triage judges a reply with
 * the conversation it belongs to (the Slack connector's mentionContext twin).
 * Failure-safe: any API error degrades to no context. */
async function gmailThreadContext(auth: any, threadId: string, beforeMs: number): Promise<string> {
  try {
    const t = await googleApi(auth, `${G}/threads/${threadId}?format=full`);
    const prior: any[] = (t.messages ?? []).filter((m: any) => parseInt(m.internalDate, 10) < beforeMs);
    if (prior.length === 0) return "";
    const lines = prior.slice(-5).map((m: any) => {
      const from = header(m, "From") || "unknown";
      const text = decodeBody(m).replace(/\s+/g, " ").trim().slice(0, 280);
      return `${from}: ${text}`;
    });
    return lines.join("\n").slice(0, 1600);
  } catch {
    return "";
  }
}

async function fetchMessageSignal(auth: any, id: string): Promise<NormalizedSignal | null> {
  const msg = await googleApi(auth, `${G}/messages/${id}?format=full`);
  if ((msg.labelIds ?? []).includes("SENT")) return null;
  // Replies get the earlier thread messages attached (References/In-Reply-To
  // marks a reply; most inbox mail is a single-message thread and skips this).
  const isReply = !!(header(msg, "In-Reply-To") || header(msg, "References"));
  const context = isReply
    ? await gmailThreadContext(auth, msg.threadId, parseInt(msg.internalDate, 10))
    : "";
  const body = context
    ? `${decodeBody(msg).slice(0, 3000)}\n\n--- Earlier messages in this thread ---\n${context}`
    : decodeBody(msg);
  return {
    externalId: msg.id,
    kind: "email",
    title: header(msg, "Subject") || "(no subject)",
    body,
    author: header(msg, "From"),
    url: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
    threadRef: msg.threadId,
    raw: { id: msg.id, threadId: msg.threadId, messageIdHeader: header(msg, "Message-ID") },
    occurredAt: new Date(parseInt(msg.internalDate, 10)).toISOString(),
  };
}

const SENT_LOOKBACK = "90d";
const SENT_CAP = 200;
const DIGEST_CHUNK = 25;
const INBOX_TRIAGE_CAP = 50;

/** Tally recipients across sent mail — who the user actually writes to. */
function tallyCorrespondents(messages: { to: string }[]): string {
  const counts = new Map<string, { display: string; n: number }>();
  for (const m of messages) {
    for (const addr of m.to.split(",")) {
      const email = addr.match(/<([^>]+)>/)?.[1] ?? addr.trim();
      if (!email || !email.includes("@")) continue;
      const key = email.toLowerCase();
      const cur = counts.get(key);
      if (cur) cur.n++;
      else counts.set(key, { display: addr.trim(), n: 1 });
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 30);
  return top.map(([email, { display, n }]) => `- ${display.includes("<") ? display : email} — ${n} email(s)`).join("\n");
}

export const gmailConnector: AmiConnector = {
  id: "gmail",
  meta: {
    label: "Gmail",
    authKind: "oauth",
    authFields: [
      { key: "client_id", label: "Google OAuth client ID" },
      { key: "client_secret", label: "Google OAuth client secret", secret: true },
    ],
    setupHelp:
      "Button 1 enables APIs for Gmail, Calendar, Drive, Slides. Button 2 opens OAuth client (choose type: Desktop app). Paste the client ID/secret, then click on Connect Google to authorize in the browser.",
    setupActions: [
      {
        label: "1 · Enable Google APIs",
        url: "https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com,slides.googleapis.com",
      },
      { label: "2 · Create OAuth client", url: "https://console.cloud.google.com/apis/credentials/oauthclient" },
    ],
  },
  async validateAuth(auth) {
    try {
      const p = await googleApi(auth, `${G}/profile`);
      return { ok: true, accountLabel: p.emailAddress };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
  streams() {
    return [{ name: "inbox", intervalSec: 90 }];
  },
  async poll({ auth, cursor }) {
    const signals: NormalizedSignal[] = [];
    if (!cursor) {
      // Baseline: recent primary inbox, then track by historyId.
      const list = await googleApi(auth, `${G}/messages?q=in:inbox+newer_than:1d&maxResults=15`);
      for (const m of list.messages ?? []) {
        const s = await fetchMessageSignal(auth, m.id);
        if (s) signals.push(s);
      }
      const profile = await googleApi(auth, `${G}/profile`);
      return { signals, nextCursor: String(profile.historyId) };
    }
    try {
      const hist = await googleApi(
        auth,
        `${G}/history?startHistoryId=${cursor}&historyTypes=messageAdded&labelId=INBOX`,
      );
      const seen = new Set<string>();
      for (const h of hist.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          if (!seen.has(added.message.id)) {
            seen.add(added.message.id);
            const s = await fetchMessageSignal(auth, added.message.id).catch(() => null);
            if (s) signals.push(s);
          }
        }
      }
      return { signals, nextCursor: String(hist.historyId ?? cursor) };
    } catch (e: any) {
      if (e.status === 404 || e.status === 410) {
        // History expired — re-baseline.
        const profile = await googleApi(auth, `${G}/profile`);
        return { signals: [], nextCursor: String(profile.historyId) };
      }
      throw e;
    }
  },
  async bootstrap(auth, onProgress) {
    // Knowledge: ~3 months of sent mail, condensed into digest docs. Sent mail
    // is the highest-signal source for the people graph — who the user writes
    // to, about what, in what tone.
    onProgress?.(`reading sent mail (last ${SENT_LOOKBACK})`);
    const profile = await googleApi(auth, `${G}/profile`);
    const ownEmail: string = profile.emailAddress ?? "";
    const list = await googleApi(
      auth,
      `${G}/messages?q=in:sent+newer_than:${SENT_LOOKBACK}&maxResults=${SENT_CAP}`,
    );
    const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
    const sent: { subject: string; to: string; date: string; body: string }[] = [];
    for (let i = 0; i < ids.length; i++) {
      if (i > 0 && i % 50 === 0) onProgress?.(`reading sent mail (${i}/${ids.length})`);
      try {
        const msg = await googleApi(auth, `${G}/messages/${ids[i]}?format=full`);
        const to = [header(msg, "To"), header(msg, "Cc")].filter(Boolean).join(", ");
        if (!to) continue;
        sent.push({
          subject: header(msg, "Subject") || "(no subject)",
          to,
          date: new Date(parseInt(msg.internalDate, 10)).toISOString().slice(0, 10),
          body: decodeBody(msg).slice(0, 500),
        });
      } catch {
        // One unreadable message shouldn't sink the backfill.
      }
    }

    const docs: { name: string; title: string; body: string }[] = [];
    if (sent.length > 0) {
      const intro = [
        `Digest of email the user (${ownEmail}) sent over the last ${SENT_LOOKBACK.replace("d", " days")}. Everything below was written BY the user; recipients are the people the user works with.`,
        ``,
        `## Frequent correspondents`,
        ``,
        tallyCorrespondents(sent),
      ].join("\n");
      for (let i = 0; i < sent.length; i += DIGEST_CHUNK) {
        const chunk = sent.slice(i, i + DIGEST_CHUNK);
        const part = Math.floor(i / DIGEST_CHUNK) + 1;
        const entries = chunk
          .map((m) => `## ${m.subject} — ${m.date}\nTo: ${m.to}\n\n${m.body}`)
          .join("\n\n---\n\n");
        docs.push({
          name: `sent-mail-digest-${part}`,
          title: `Sent mail digest (part ${part})`,
          body: part === 1 ? `${intro}\n\n---\n\n${entries}` : entries,
        });
      }
    }

    // First task list: the last 7 days of inbox through normal triage. Primary
    // category first so the first impression isn't a pile of newsletters.
    onProgress?.("reading last 7 days of inbox");
    const triage: NormalizedSignal[] = [];
    let inbox = await googleApi(
      auth,
      `${G}/messages?q=in:inbox+category:primary+newer_than:7d&maxResults=${INBOX_TRIAGE_CAP}`,
    );
    if (!inbox.messages?.length) {
      // Workspace accounts without inbox tabs return nothing for category:primary.
      inbox = await googleApi(auth, `${G}/messages?q=in:inbox+newer_than:7d&maxResults=${INBOX_TRIAGE_CAP}`);
    }
    for (const m of inbox.messages ?? []) {
      const s = await fetchMessageSignal(auth, m.id).catch(() => null);
      if (s) triage.push(s);
    }
    return { docs, triage };
  },
  actions: [
    {
      name: "gmail_thread_context",
      readOnly: true,
      description: "Fetch all messages in a Gmail thread for context. Input is the thread id.",
      schema: { threadRef: z.string() },
      async run(auth, input): Promise<ActionResult> {
        try {
          const t = await googleApi(auth, `${G}/threads/${input.threadRef}?format=full`);
          const msgs = (t.messages ?? []).map((m: any) => ({
            from: header(m, "From"),
            date: header(m, "Date"),
            subject: header(m, "Subject"),
            body: decodeBody(m),
          }));
          return {
            ok: true,
            output: { url: `https://mail.google.com/mail/u/0/#all/${input.threadRef}`, messages: msgs },
          };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "gmail_search",
      readOnly: true,
      description:
        'Search the user\'s Gmail with standard Gmail query operators (from:, to:, subject:, after:YYYY/MM/DD, has:attachment, "exact phrase"). Returns matching messages with their thread id — pass it to gmail_thread_context for the full thread.',
      schema: {
        query: z.string().describe("Gmail search query"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const max = Math.min(Number(input.limit) || 10, 25);
          const list = await googleApi(
            auth,
            `${G}/messages?q=${encodeURIComponent(String(input.query))}&maxResults=${max}`,
          );
          const results: unknown[] = [];
          for (const m of list.messages ?? []) {
            try {
              const msg = await googleApi(
                auth,
                `${G}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
              );
              results.push({
                threadRef: msg.threadId,
                from: header(msg, "From"),
                subject: header(msg, "Subject") || "(no subject)",
                date: new Date(parseInt(msg.internalDate, 10)).toISOString(),
                snippet: msg.snippet ?? "",
                // #all, not #inbox — search hits are often archived.
                url: `https://mail.google.com/mail/u/0/#all/${msg.id}`,
              });
            } catch {
              // One unreadable message shouldn't sink the search.
            }
          }
          return { ok: true, output: results };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "gmail_send_reply",
      description: "Send an email reply in an existing thread on behalf of the user.",
      isSend: true,
      schema: {
        targetRef: z.string().describe("Gmail thread id"),
        body: z.string().describe("Plain-text reply body"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const t = await googleApi(auth, `${G}/threads/${input.targetRef}?format=metadata`);
          const last = t.messages?.[t.messages.length - 1];
          const from = header(last, "From");
          const subject = header(last, "Subject");
          const messageId = header(last, "Message-ID");
          const raw = [
            `To: ${from}`,
            `Subject: ${subject.startsWith("Re:") ? subject : `Re: ${subject}`}`,
            `In-Reply-To: ${messageId}`,
            `References: ${messageId}`,
            "Content-Type: text/plain; charset=utf-8",
            "",
            String(input.body),
          ].join("\r\n");
          const j = await googleApi(auth, `${G}/messages/send`, {
            method: "POST",
            body: JSON.stringify({
              raw: Buffer.from(raw).toString("base64url"),
              threadId: String(input.targetRef),
            }),
          });
          return { ok: true, externalId: j.id, output: j };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
  ],
};
