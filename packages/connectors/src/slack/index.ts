import { z } from "zod";
import type { AuthBlob, NormalizedSignal } from "@ami/shared";
import type { AmiConnector, ActionResult } from "../types.js";
import { extractFileText } from "../file-text.js";

const API = "https://slack.com/api";

async function slackCall(
  token: string,
  method: string,
  params: Record<string, string> = {},
): Promise<any> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  const json: any = await res.json();
  if (!json.ok) throw new Error(`slack ${method}: ${json.error}`);
  return json;
}

async function whoami(token: string): Promise<{ userId: string; team: string; user: string }> {
  const j = await slackCall(token, "auth.test");
  return { userId: j.user_id, team: j.team, user: j.user };
}

// ---------- conversation context for mentions ----------
// A bare mention ("it's down again") is useless without the thread it sits in.
// At poll time we attach: the full thread when the mention is threaded, or the
// preceding channel messages when it isn't — so triage, pre-drafts, task runs
// and knowledge notes all see the conversation, not just the last message.

const CONTEXT_MAX_MSGS = 25;
const CONTEXT_MAX_CHARS = 3500;

const nameCache = new Map<string, string>();

async function userName(token: string, userId: string): Promise<string> {
  if (!userId) return "unknown";
  const cached = nameCache.get(userId);
  if (cached) return cached;
  let name = userId;
  try {
    const j = await slackCall(token, "users.info", { user: userId });
    name = j.user?.profile?.display_name || j.user?.real_name || j.user?.name || userId;
  } catch {
    /* keep the id */
  }
  nameCache.set(userId, name);
  return name;
}

async function formatContextLines(token: string, msgs: any[]): Promise<string> {
  const lines: string[] = [];
  let used = 0;
  for (const m of msgs) {
    const name = m.bot_id ? (m.username ?? "bot") : await userName(token, m.user ?? "");
    const text = String(m.text ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (!text) continue;
    const line = `${name}: ${text}`;
    if (used + line.length > CONTEXT_MAX_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}

/** Conversation context for a mention. Returns the context text plus the
 * correct reply target ts (the thread parent when the mention is threaded).
 * Failure-safe: any API error degrades to no context, never a failed poll. */
async function mentionContext(
  token: string,
  channel: string,
  ts: string,
): Promise<{ context: string; parentTs: string } | null> {
  try {
    // conversations.replies accepts any message ts in a thread; a lone
    // unthreaded message comes back as a single-element array.
    const j = await slackCall(token, "conversations.replies", {
      channel,
      ts,
      limit: String(CONTEXT_MAX_MSGS),
    });
    const msgs: any[] = j.messages ?? [];
    if (msgs.length > 1) {
      // Everything in the thread before the mention (the mention itself is
      // already the signal body).
      const before = msgs.filter((m) => parseFloat(m.ts) < parseFloat(ts));
      const context = await formatContextLines(token, before);
      return { context, parentTs: msgs[0].thread_ts ?? msgs[0].ts };
    }
    // Unthreaded: pull the preceding channel messages for ambient context.
    const h = await slackCall(token, "conversations.history", {
      channel,
      latest: ts,
      inclusive: "false",
      limit: "8",
    });
    const prior: any[] = (h.messages ?? []).reverse(); // history is newest-first
    const context = await formatContextLines(token, prior);
    return { context, parentTs: ts };
  } catch {
    return null;
  }
}

/** Channels the user is a member of — powers the Settings "read every message"
 * tagging UI. Queried per type so a token minted before groups:read was in the
 * setup instructions still lists public channels; private ones report as
 * unavailable instead of failing the whole call. */
export async function listSlackChannels(auth: AuthBlob): Promise<{
  channels: { id: string; name: string; isPrivate: boolean; topic: string }[];
  privateUnavailable: boolean;
}> {
  const fetchType = async (types: string) => {
    const j = await slackCall(auth.token, "users.conversations", {
      types,
      exclude_archived: "true",
      limit: "200",
    });
    return (j.channels ?? []).map((c: any) => ({
      id: c.id,
      name: c.name,
      isPrivate: !!c.is_private,
      topic: c.topic?.value ?? c.purpose?.value ?? "",
    }));
  };
  const channels = await fetchType("public_channel");
  let privateUnavailable = false;
  try {
    channels.push(...(await fetchType("private_channel")));
  } catch (e: any) {
    if (!String(e.message).includes("missing_scope")) throw e;
    privateUnavailable = true; // token lacks groups:read
  }
  channels.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
  return { channels, privateUnavailable };
}

/** Shape of the slack connector config passed via PollContext.config. */
export interface SlackConfig {
  /** Channels tagged "read every message" (everything else is mentions-only). */
  readAllChannels?: { id: string; name: string }[];
  /** Read direct messages (default true). Off = the DM stream is skipped. */
  readDms?: boolean;
}

/** Every user scope Ami needs, baked into a create-app manifest so setup is
 * click-through: Slack opens with the app fully preconfigured — no manual
 * scope-picking, no missed scopes, no reinstall dance. (Slack requires HTTPS
 * OAuth redirect URLs with no localhost exception, so a classic loopback
 * OAuth flow isn't possible for a local app — this is the closest thing.) */
const SLACK_USER_SCOPES = [
  "search:read",
  "files:read",
  "im:read",
  "im:history",
  "channels:history",
  "groups:history",
  "mpim:history",
  "chat:write",
  "users:read",
  "users:read.email",
  "channels:read",
  "groups:read",
];

const SLACK_APP_MANIFEST = {
  display_information: {
    name: "Ami",
    description: "Ami",
    background_color: "#131315",
  },
  oauth_config: { scopes: { user: SLACK_USER_SCOPES } },
  settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
};

const SLACK_CREATE_APP_URL = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(
  JSON.stringify(SLACK_APP_MANIFEST),
)}`;

export const slackConnector: AmiConnector = {
  id: "slack",
  meta: {
    label: "Slack",
    authKind: "token",
    authFields: [
      { key: "token", label: "User OAuth token (xoxp-…)", placeholder: "xoxp-…", secret: true },
    ],
    setupHelp:
      "Click the button below — Slack opens with Ami's app fully preconfigured (all permissions included). Click Create → pick your workspace → Install to Workspace → Allow. Slack then shows a \"User OAuth Token\" starting with xoxp- on the same page: copy it and paste it here. One-time setup; the token is stored only on this machine.",
    setupActions: [{ label: "Create the Slack app", url: SLACK_CREATE_APP_URL }],
  },
  async validateAuth(auth) {
    if (auth.token?.startsWith("xoxb-")) {
      return {
        ok: false,
        error:
          "This is a Bot token (xoxb-). Ami needs the User OAuth Token (xoxp-) with User Token Scopes — search.messages does not work with bot tokens.",
      };
    }
    try {
      const me = await whoami(auth.token);
      return { ok: true, accountLabel: `${me.user} @ ${me.team}` };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
  async identity(auth) {
    const me = await whoami(auth.token);
    try {
      const j = await slackCall(auth.token, "users.info", { user: me.userId });
      return {
        name: j.user?.profile?.real_name || j.user?.real_name || me.user,
        // Profile email needs the users:read.email scope — absent is fine.
        email: j.user?.profile?.email,
      };
    } catch {
      return { name: me.user };
    }
  },
  streams() {
    return [
      { name: "mentions", intervalSec: 60 },
      { name: "dms", intervalSec: 90 },
      { name: "channels", intervalSec: 120 },
      { name: "threads", intervalSec: 180 },
    ];
  },
  async poll({ auth, stream, cursor, config }) {
    const token = auth.token;
    const me = await whoami(token);
    const signals: NormalizedSignal[] = [];
    let nextCursor = cursor;

    if (stream === "mentions") {
      const oldest = cursor ? parseFloat(cursor) : Date.now() / 1000 - 24 * 3600;
      const j = await slackCall(token, "search.messages", {
        query: `<@${me.userId}>`,
        sort: "timestamp",
        sort_dir: "desc",
        count: "20",
      });
      const matches: any[] = j.messages?.matches ?? [];
      let maxTs = oldest;
      for (const m of matches) {
        const ts = parseFloat(m.ts);
        if (ts <= oldest) continue;
        if (m.user === me.userId) continue;
        maxTs = Math.max(maxTs, ts);

        // Attach the surrounding conversation (thread or preceding channel
        // messages) and reply into the real thread, not a fork off the mention.
        const ctx = m.channel?.id ? await mentionContext(token, m.channel.id, m.ts) : null;
        const body =
          ctx?.context && ctx.context.trim()
            ? `${m.text ?? ""}\n\n--- Conversation context (${ctx.parentTs !== m.ts ? "thread" : "recent channel messages"}) ---\n${ctx.context}`
            : (m.text ?? "");

        signals.push({
          externalId: `${m.channel?.id}:${m.ts}`,
          kind: "message",
          title: `#${m.channel?.name ?? "unknown"} — mention from ${m.username ?? m.user}`,
          body,
          author: m.username ?? m.user ?? "",
          url: m.permalink,
          threadRef: `${m.channel?.id}:${ctx?.parentTs ?? m.ts}`,
          raw: m,
          occurredAt: new Date(ts * 1000).toISOString(),
        });
      }
      nextCursor = String(maxTs);
    } else if (stream === "dms") {
      if ((config as SlackConfig | undefined)?.readDms === false) {
        // Toggled off: skip, but keep the cursor at "now" so re-enabling
        // starts fresh instead of backfilling the gap.
        return { signals: [], nextCursor: String(Date.now() / 1000) };
      }
      const oldest = cursor ?? String(Date.now() / 1000 - 24 * 3600);
      const convs = await slackCall(token, "conversations.list", { types: "im", limit: "50" });
      let maxTs = parseFloat(oldest);
      for (const ch of (convs.channels ?? []).slice(0, 20)) {
        // Fetch past the cursor so older messages in the same response can
        // serve as conversation context for the new ones — no extra API calls.
        const hist = await slackCall(token, "conversations.history", {
          channel: ch.id,
          limit: "30",
        });
        const all: any[] = (hist.messages ?? []).slice().reverse(); // oldest-first
        for (let i = 0; i < all.length; i++) {
          const m = all[i];
          const ts = parseFloat(m.ts);
          if (ts <= parseFloat(oldest)) continue;
          if (m.user === me.userId || m.bot_id) continue;
          maxTs = Math.max(maxTs, ts);
          const from = await userName(token, m.user ?? "");
          const context = await formatContextLines(token, all.slice(Math.max(0, i - 8), i));
          const body = context
            ? `${m.text ?? ""}\n\n--- Conversation context (recent messages) ---\n${context}`
            : (m.text ?? "");
          signals.push({
            externalId: `${ch.id}:${m.ts}`,
            kind: "message",
            title: `DM from ${from}`,
            body,
            author: from,
            threadRef: `${ch.id}:${m.ts}`,
            raw: m,
            occurredAt: new Date(ts * 1000).toISOString(),
          });
        }
      }
      nextCursor = String(maxTs);
    } else if (stream === "channels") {
      // Read-all channels: every message (not just mentions) from channels the
      // user tagged in Settings. Cursor is a per-channel ts map.
      const channels = (config as SlackConfig | undefined)?.readAllChannels ?? [];
      const tsByChannel: Record<string, string> = cursor ? JSON.parse(cursor) : {};
      for (const ch of channels.slice(0, 30)) {
        const oldest = parseFloat(tsByChannel[ch.id] ?? String(Date.now() / 1000 - 24 * 3600));
        let maxTs = oldest;
        try {
          const hist = await slackCall(token, "conversations.history", {
            channel: ch.id,
            limit: "50",
          });
          const all: any[] = (hist.messages ?? []).slice().reverse(); // oldest-first
          for (let i = 0; i < all.length; i++) {
            const m = all[i];
            const ts = parseFloat(m.ts);
            if (ts <= oldest) continue;
            maxTs = Math.max(maxTs, ts);
            if (m.user === me.userId || m.bot_id || m.subtype) continue;
            const from = await userName(token, m.user ?? "");
            const context = await formatContextLines(token, all.slice(Math.max(0, i - 8), i));
            const body = context
              ? `${m.text ?? ""}\n\n--- Conversation context (recent messages) ---\n${context}`
              : (m.text ?? "");
            signals.push({
              externalId: `${ch.id}:${m.ts}`,
              kind: "message",
              title: `#${ch.name} — message from ${from}`,
              body,
              author: from,
              threadRef: `${ch.id}:${m.thread_ts ?? m.ts}`,
              raw: { ...m, channel: { id: ch.id, name: ch.name } },
              occurredAt: new Date(ts * 1000).toISOString(),
            });
          }
          tsByChannel[ch.id] = String(maxTs);
        } catch (e: any) {
          // One unreadable channel (left/archived) shouldn't fail the poll.
          console.error(`[slack channels] #${ch.name}: ${e.message}`);
        }
      }
      nextCursor = JSON.stringify(tsByChannel);
    } else if (stream === "threads") {
      // Threads the user has participated in — even without a mention, new
      // replies there are the user's business, so they go through triage
      // (tasks/FYIs). Overlap with the mentions/channels streams is fine: the
      // externalId dedup index keeps each message a single signal.
      const readDms = (config as SlackConfig | undefined)?.readDms !== false;
      interface ThreadCursor {
        search: number;
        threads: Record<string, { last: number; name: string }>; // "channel:parentTs"
      }
      let tc: ThreadCursor;
      try {
        tc = JSON.parse(cursor ?? "");
        tc.threads ??= {};
      } catch {
        tc = { search: Date.now() / 1000 - 24 * 3600, threads: {} };
      }

      // 1. Discover threads from the user's own recent messages. A root message
      // with no replies yet is tracked too — replies to it later count as a
      // thread the user is in.
      try {
        const j = await slackCall(token, "search.messages", {
          query: `from:<@${me.userId}>`,
          sort: "timestamp",
          sort_dir: "desc",
          count: "20",
        });
        let maxSearch = tc.search;
        for (const m of j.messages?.matches ?? []) {
          const ts = parseFloat(m.ts);
          if (ts <= tc.search) continue;
          maxSearch = Math.max(maxSearch, ts);
          const chId = m.channel?.id;
          if (!chId) continue;
          if (chId.startsWith("D") && !readDms) continue;
          // Resolve the thread parent (any message ts works for replies).
          let parentTs = m.ts;
          try {
            const r = await slackCall(token, "conversations.replies", {
              channel: chId,
              ts: m.ts,
              limit: "1",
            });
            const first = r.messages?.[0];
            parentTs = first?.thread_ts ?? first?.ts ?? m.ts;
          } catch {
            /* left channel etc. — track under the message itself */
          }
          const key = `${chId}:${parentTs}`;
          // `last` starts at the user's message: only activity after they
          // participated becomes signals.
          if (!tc.threads[key]) tc.threads[key] = { last: ts, name: m.channel?.name ?? chId };
        }
        tc.search = maxSearch;
      } catch (e: any) {
        console.error(`[slack threads] search: ${e.message}`);
      }

      // 2. Poll tracked threads for new replies. Bounded: newest 25 threads,
      // and threads quiet for 7 days fall out of the map.
      const pruneBefore = Date.now() / 1000 - 7 * 24 * 3600;
      const keys = Object.keys(tc.threads)
        .sort((a, b) => tc.threads[b].last - tc.threads[a].last)
        .slice(0, 25);
      const alive: ThreadCursor["threads"] = {};
      for (const key of keys) {
        const t = tc.threads[key];
        if (t.last < pruneBefore) continue;
        alive[key] = t;
        const [chId, parentTs] = key.split(":");
        if (chId.startsWith("D") && !readDms) continue;
        try {
          const r = await slackCall(token, "conversations.replies", {
            channel: chId,
            ts: parentTs,
            limit: "50",
          });
          const msgs: any[] = r.messages ?? [];
          for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            const ts = parseFloat(m.ts);
            if (ts <= t.last) continue;
            t.last = ts; // advance over own/bot messages too
            if (m.user === me.userId || m.bot_id || m.subtype) continue;
            const from = await userName(token, m.user ?? "");
            const context = await formatContextLines(token, msgs.slice(Math.max(0, i - 8), i));
            const body = context
              ? `${m.text ?? ""}\n\n--- Conversation context (thread) ---\n${context}`
              : (m.text ?? "");
            signals.push({
              externalId: `${chId}:${m.ts}`,
              kind: "message",
              title: `#${t.name} — ${from} replied in a thread you're in`,
              body,
              author: from,
              threadRef: `${chId}:${parentTs}`,
              raw: { ...m, channel: { id: chId, name: t.name } },
              occurredAt: new Date(ts * 1000).toISOString(),
            });
          }
        } catch (e: any) {
          console.error(`[slack threads] ${key}: ${e.message}`);
        }
      }
      tc.threads = alive;
      nextCursor = JSON.stringify(tc);
    }
    return { signals, nextCursor };
  },
  async bootstrap(auth, onProgress) {
    const token = auth.token;
    const me = await whoami(token);

    // Knowledge: who's in this workspace and where the user hangs out — the
    // backbone of the people graph (names ↔ handles ↔ emails).
    onProgress?.("reading workspace directory");
    const sections: string[] = [];
    try {
      const j = await slackCall(token, "users.list", { limit: "200" });
      const members = (j.members ?? []).filter(
        (u: any) => !u.deleted && !u.is_bot && u.id !== "USLACKBOT",
      );
      const lines = members.map((u: any) => {
        const parts = [
          `- **${u.profile?.real_name || u.name}** (@${u.name})`,
          u.profile?.title ? u.profile.title : "",
          u.profile?.email ? `<${u.profile.email}>` : "",
        ].filter(Boolean);
        return parts.join(" — ");
      });
      sections.push(`## People in the workspace (${me.team})\n\n${lines.join("\n")}`);
    } catch (e: any) {
      console.error(`[slack bootstrap] users.list: ${e.message}`);
    }
    try {
      const { channels } = await listSlackChannels(auth);
      const lines = channels.map(
        (c) => `- #${c.name}${c.isPrivate ? " (private)" : ""}${c.topic ? ` — ${c.topic.slice(0, 120)}` : ""}`,
      );
      sections.push(`## Channels the user is in\n\n${lines.join("\n")}`);
    } catch (e: any) {
      console.error(`[slack bootstrap] channels: ${e.message}`);
    }
    const docs = sections.length
      ? [
          {
            name: "workspace-directory",
            title: `Slack workspace: ${me.team}`,
            body: `The user is @${me.user} in the ${me.team} Slack workspace.\n\n${sections.join("\n\n")}`,
          },
        ]
      : [];

    // First task list: mentions from the last 7 days through normal triage.
    onProgress?.("reading last 7 days of mentions");
    const oldest = Date.now() / 1000 - 7 * 24 * 3600;
    const afterDate = new Date(oldest * 1000).toISOString().slice(0, 10);
    const triage: NormalizedSignal[] = [];
    try {
      const j = await slackCall(token, "search.messages", {
        query: `<@${me.userId}> after:${afterDate}`,
        sort: "timestamp",
        sort_dir: "desc",
        count: "50",
      });
      for (const m of (j.messages?.matches ?? []).slice(0, 30)) {
        const ts = parseFloat(m.ts);
        if (ts <= oldest || m.user === me.userId) continue;
        const ctx = m.channel?.id ? await mentionContext(token, m.channel.id, m.ts) : null;
        const body =
          ctx?.context && ctx.context.trim()
            ? `${m.text ?? ""}\n\n--- Conversation context (${ctx.parentTs !== m.ts ? "thread" : "recent channel messages"}) ---\n${ctx.context}`
            : (m.text ?? "");
        triage.push({
          externalId: `${m.channel?.id}:${m.ts}`,
          kind: "message",
          title: `#${m.channel?.name ?? "unknown"} — mention from ${m.username ?? m.user}`,
          body,
          author: m.username ?? m.user ?? "",
          url: m.permalink,
          threadRef: `${m.channel?.id}:${ctx?.parentTs ?? m.ts}`,
          raw: m,
          occurredAt: new Date(ts * 1000).toISOString(),
        });
      }
    } catch (e: any) {
      console.error(`[slack bootstrap] mentions: ${e.message}`);
    }
    return { docs, triage };
  },
  actions: [
    {
      name: "slack_post_message",
      description: "Post a message to a Slack channel or thread on behalf of the user.",
      isSend: true,
      schema: {
        targetRef: z.string().describe("channelId:threadTs reference (reply target)"),
        body: z.string().describe("Message text (Slack mrkdwn)"),
      },
      async run(auth, input): Promise<ActionResult> {
        const [channel, ts] = String(input.targetRef).split(":");
        try {
          const j = await slackCall(auth.token, "chat.postMessage", {
            channel,
            text: String(input.body),
            ...(ts ? { thread_ts: ts } : {}),
          });
          return { ok: true, externalId: `${channel}:${j.ts}`, output: j };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "slack_thread_context",
      readOnly: true,
      description:
        "Fetch the full message thread for context. Input is the channelId:threadTs reference of the originating message.",
      schema: { threadRef: z.string() },
      async run(auth, input): Promise<ActionResult> {
        const [channel, ts] = String(input.threadRef).split(":");
        try {
          const [j, link] = await Promise.all([
            slackCall(auth.token, "conversations.replies", {
              channel,
              ts,
              limit: "50",
            }),
            // Permalink is best-effort: the thread text is the payload.
            slackCall(auth.token, "chat.getPermalink", { channel, message_ts: ts }).catch(() => null),
          ]);
          const msgs = (j.messages ?? []).map((m: any) => ({ user: m.user, text: m.text, ts: m.ts }));
          return { ok: true, output: { url: link?.permalink ?? null, messages: msgs } };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "slack_find_user",
      readOnly: true,
      description:
        "Find a Slack user's id by name or email. The returned id (U…) is the targetRef for DMing them (report_draft with channel 'slack'). Matches real name, display name, handle and email, case-insensitively.",
      schema: {
        query: z.string().describe("Name, handle or email (substring ok)"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const q = String(input.query).toLowerCase();
          const matches: any[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 5 && matches.length < 10; page++) {
            const j = await slackCall(auth.token, "users.list", {
              limit: "200",
              ...(cursor ? { cursor } : {}),
            });
            for (const u of j.members ?? []) {
              if (u.deleted || u.is_bot || u.id === "USLACKBOT") continue;
              const hay = [u.name, u.real_name, u.profile?.display_name, u.profile?.real_name, u.profile?.email]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
              if (hay.includes(q)) {
                matches.push({
                  id: u.id,
                  handle: u.name,
                  realName: u.profile?.real_name ?? u.real_name,
                  displayName: u.profile?.display_name || undefined,
                  email: u.profile?.email,
                });
              }
            }
            cursor = j.response_metadata?.next_cursor || undefined;
            if (!cursor) break;
          }
          return { ok: true, output: matches.slice(0, 10) };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "slack_search",
      readOnly: true,
      description:
        'Search messages AND shared files (docs, decks, sheets, PDFs) across the Slack workspace, relevance-ranked like Slack\'s own search. Supports Slack search modifiers (from:@user, in:#channel, before:/after:YYYY-MM-DD, "exact phrase"). Message matches carry a channelId:ts threadRef for slack_thread_context; file matches carry an id to open with slack_read_file. Pass sort "newest" only when recency matters more than relevance.',
      schema: {
        query: z.string().describe("Search terms, optionally with Slack modifiers"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
        sort: z
          .enum(["relevance", "newest"])
          .optional()
          .describe("relevance (default — like the Slack UI) or newest-first"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const count = Math.min(Number(input.limit) || 10, 25);
          // Relevance by default: timestamp sort buries an old-but-canonical
          // post (an org chart, a policy doc) under recent word-match noise.
          const sort = input.sort === "newest" ? "timestamp" : "score";
          const [j, fj] = await Promise.all([
            slackCall(auth.token, "search.messages", {
              query: String(input.query),
              sort,
              sort_dir: "desc",
              count: String(count),
            }),
            // Files are half of workspace knowledge (org charts, decks,
            // specs) — surface them alongside messages, best effort.
            slackCall(auth.token, "search.files", {
              query: String(input.query),
              sort,
              sort_dir: "desc",
              count: String(Math.min(count, 10)),
            }).catch(() => null),
          ]);
          const matches = (j.messages?.matches ?? []).map((m: any) => ({
            channel: m.channel?.name ? `#${m.channel.name}` : m.channel?.id,
            from: m.username ?? m.user ?? "",
            at: m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString() : "",
            text: String(m.text ?? "").replace(/\s+/g, " ").slice(0, 300),
            threadRef: `${m.channel?.id}:${m.ts}`,
            permalink: m.permalink,
            files: (m.files ?? []).map((f: any) => ({ id: f.id, name: f.name })),
          }));
          const fileMatches = (fj?.files?.matches ?? []).map((f: any) => ({
            id: f.id,
            name: f.name,
            type: f.filetype,
            at: f.timestamp ? new Date(f.timestamp * 1000).toISOString().slice(0, 10) : "",
            permalink: f.permalink,
          }));
          return {
            ok: true,
            output: {
              total: j.messages?.total ?? matches.length,
              matches,
              filesTotal: fj?.files?.total ?? 0,
              fileMatches,
            },
          };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "slack_read_file",
      readOnly: true,
      description:
        "Download and read a file shared in Slack — docx, pptx, xlsx, pdf, and text formats — returning its extracted text. Input: a file id (F…) from slack_search results or thread context, a Slack file permalink URL, or a filename/keywords to search files by. Use this to open document attachments (contracts, decks, specs) found via slack_search.",
      schema: {
        file: z.string().describe("File id (F…), file permalink URL, or filename keywords"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const ref = String(input.file).trim();
          let id = ref.match(/\bF[A-Z0-9]{8,}\b/)?.[0] ?? null;
          if (!id) {
            const s = await slackCall(auth.token, "search.files", { query: ref, count: "5" });
            const hit = (s.files?.matches ?? [])[0];
            if (!hit) return { ok: false, output: null, error: `no Slack file matched "${ref}"` };
            id = hit.id;
          }
          const info = await slackCall(auth.token, "files.info", { file: id! });
          const f = info.file;
          if ((f.size ?? 0) > 20 * 1024 * 1024) {
            return { ok: false, output: null, error: `file too large (${Math.round(f.size / 1048576)} MB, cap 20 MB)` };
          }
          const url = f.url_private_download ?? f.url_private;
          if (!url) return { ok: false, output: null, error: "file has no downloadable URL" };
          const res = await fetch(url, { headers: { Authorization: `Bearer ${auth.token}` } });
          if (!res.ok) return { ok: false, output: null, error: `download failed: ${res.status}` };
          const buf = Buffer.from(await res.arrayBuffer());
          const text = await extractFileText(buf, f.mimetype ?? "", f.name ?? "");
          return {
            ok: true,
            url: f.permalink,
            output: {
              id: f.id,
              name: f.name,
              mimetype: f.mimetype,
              sharedAt: f.timestamp ? new Date(f.timestamp * 1000).toISOString() : null,
              sharedBy: f.user,
              text: text.slice(0, 20000),
              truncated: text.length > 20000,
            },
          };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
  ],
};
