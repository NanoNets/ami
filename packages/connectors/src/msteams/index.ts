import { z } from "zod";
import type { NormalizedSignal } from "@ami/shared";
import type { AmiConnector, ActionResult, BootstrapResult } from "../types.js";
import { msGraph, stripHtml } from "../microsoft-auth.js";

/** Microsoft Teams chats (1:1 and group) via Graph — registered together with
 * m365 by the Microsoft OAuth callback (same token blob, Chat.Read scope).
 * Channel messages need admin-consented scopes; chats cover the DM half of
 * Teams, which is where the direct asks live. */

function chatLabel(chat: any, myId: string): string {
  if (chat.topic) return chat.topic;
  const others = (chat.members ?? [])
    .filter((m: any) => m.userId !== myId)
    .map((m: any) => m.displayName)
    .filter(Boolean);
  return others.slice(0, 3).join(", ") || "chat";
}

export const msteamsConnector: AmiConnector = {
  id: "msteams",
  meta: {
    label: "Microsoft Teams",
    authKind: "oauth",
    authFields: [],
    setupHelp: "Connected automatically with Outlook + Calendar (same Microsoft consent) — no separate setup.",
  },
  async validateAuth(auth) {
    try {
      const me = await msGraph(auth, "/me?$select=displayName,mail,userPrincipalName");
      return { ok: true, accountLabel: `${me.displayName} (Teams)` };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
  streams() {
    return [{ name: "chats", intervalSec: 120 }];
  },
  async poll({ auth, cursor }) {
    const signals: NormalizedSignal[] = [];
    const since = cursor ?? new Date(Date.now() - 24 * 3600_000).toISOString();
    let max = since;

    const me = await msGraph(auth, "/me?$select=id");
    const chats = await msGraph(
      auth,
      "/me/chats?$top=25&$expand=members,lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc",
    );
    for (const chat of (chats.value ?? []).slice(0, 20)) {
      // Cheap skip: nothing new in this chat since the cursor.
      const previewAt = chat.lastMessagePreview?.createdDateTime;
      if (previewAt && previewAt <= since) continue;
      try {
        const j = await msGraph(auth, `/me/chats/${chat.id}/messages?$top=20`);
        const msgs: any[] = (j.value ?? [])
          .filter((m: any) => m.messageType === "message")
          .sort((a: any, b: any) => String(a.createdDateTime).localeCompare(String(b.createdDateTime)));
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i];
          if (m.createdDateTime <= since) continue;
          if (m.createdDateTime > max) max = m.createdDateTime;
          if (m.from?.user?.id === me.id || m.from?.application) continue;
          const from = m.from?.user?.displayName ?? "someone";
          const context = msgs
            .slice(Math.max(0, i - 8), i)
            .map((p: any) => `${p.from?.user?.id === me.id ? "Me" : (p.from?.user?.displayName ?? "someone")}: ${stripHtml(p.body?.content ?? "").slice(0, 300)}`)
            .filter((l: string) => l.split(": ")[1])
            .join("\n");
          const text = stripHtml(m.body?.content ?? "");
          signals.push({
            externalId: m.id,
            kind: "message",
            title: `Teams: ${from} in ${chatLabel(chat, me.id)}`,
            body: context ? `${text}\n\n--- Conversation context (recent messages) ---\n${context}` : text,
            author: from,
            threadRef: chat.id,
            raw: { chatId: chat.id, messageId: m.id },
            occurredAt: m.createdDateTime,
          });
        }
      } catch (e: any) {
        console.error(`[msteams] chat ${chat.id}: ${e.message}`);
      }
    }
    return { signals, nextCursor: max };
  },
  async bootstrap(auth, onProgress): Promise<BootstrapResult> {
    // Knowledge: the user's Teams surface — joined teams and active chats.
    onProgress?.("reading teams and chats");
    const sections: string[] = [];
    try {
      const j = await msGraph(auth, "/me/joinedTeams");
      const lines = (j.value ?? []).map((t: any) => `- **${t.displayName}**${t.description ? ` — ${String(t.description).slice(0, 120)}` : ""}`);
      if (lines.length) sections.push(`## Teams the user is in\n\n${lines.join("\n")}`);
    } catch (e: any) {
      console.error(`[msteams bootstrap] teams: ${e.message}`);
    }
    try {
      const me = await msGraph(auth, "/me?$select=id");
      const j = await msGraph(auth, "/me/chats?$top=30&$expand=members");
      const lines = (j.value ?? []).map((c: any) => `- ${chatLabel(c, me.id)}${c.chatType ? ` (${c.chatType})` : ""}`);
      if (lines.length) sections.push(`## Active chats\n\n${lines.join("\n")}`);
    } catch (e: any) {
      console.error(`[msteams bootstrap] chats: ${e.message}`);
    }
    return {
      docs: sections.length
        ? [
            {
              name: "teams-directory",
              title: "Microsoft Teams: teams and chats",
              body: sections.join("\n\n"),
            },
          ]
        : [],
      triage: [],
    };
  },
  actions: [
    {
      name: "teams_chat_context",
      readOnly: true,
      description: "Fetch recent messages of a Teams chat. Input is the chat id (threadRef of an msteams signal).",
      schema: { threadRef: z.string() },
      async run(auth, input): Promise<ActionResult> {
        try {
          const j = await msGraph(auth, `/me/chats/${encodeURIComponent(String(input.threadRef))}/messages?$top=30`);
          const msgs = (j.value ?? [])
            .filter((m: any) => m.messageType === "message")
            .sort((a: any, b: any) => String(a.createdDateTime).localeCompare(String(b.createdDateTime)))
            .map((m: any) => ({
              from: m.from?.user?.displayName ?? "app",
              at: m.createdDateTime,
              text: stripHtml(m.body?.content ?? "").slice(0, 1000),
            }));
          return { ok: true, output: msgs };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "teams_search",
      readOnly: true,
      description:
        "Search the user's Teams chat messages by keyword. Returns matches with the chat id — pass it to teams_chat_context for the surrounding conversation.",
      schema: {
        query: z.string(),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const size = Math.min(Number(input.limit) || 10, 25);
          const j = await msGraph(auth, "/search/query", {
            method: "POST",
            body: JSON.stringify({
              requests: [
                { entityTypes: ["chatMessage"], query: { queryString: String(input.query) }, from: 0, size },
              ],
            }),
          });
          const hits = j.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
          const msgs = hits.map((h: any) => {
            const r = h.resource ?? {};
            return {
              threadRef: r.chatId ?? r.channelIdentity?.channelId ?? "",
              from: r.from?.emailAddress?.name ?? r.from?.user?.displayName ?? "",
              at: r.createdDateTime,
              preview: stripHtml(String(h.summary ?? r.body?.content ?? "")).slice(0, 300),
            };
          });
          return { ok: true, output: msgs };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "teams_send_chat",
      description: "Send a message in a Teams chat on behalf of the user.",
      isSend: true,
      schema: {
        targetRef: z.string().describe("Chat id (threadRef of the signal)"),
        body: z.string().describe("Message text"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const j = await msGraph(auth, `/me/chats/${encodeURIComponent(String(input.targetRef))}/messages`, {
            method: "POST",
            body: JSON.stringify({ body: { content: String(input.body) } }),
          });
          return { ok: true, externalId: j.id, output: j };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
  ],
};
