import { z } from "zod";
import type { AuthBlob } from "@ami/shared";
import type { AmiConnector, ActionResult } from "../types.js";

async function zoomToken(auth: AuthBlob): Promise<string> {
  const basic = Buffer.from(`${auth.client_id}:${auth.client_secret}`).toString("base64");
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${auth.account_id}`,
    { method: "POST", headers: { Authorization: `Basic ${basic}` } },
  );
  const j: any = await res.json();
  if (!res.ok || !j.access_token) throw new Error(`zoom token: ${j.reason ?? res.status}`);
  return j.access_token;
}

export const zoomConnector: AmiConnector = {
  id: "zoom",
  meta: {
    label: "Zoom",
    authKind: "token",
    authFields: [
      { key: "account_id", label: "Account ID" },
      { key: "client_id", label: "Client ID" },
      { key: "client_secret", label: "Client secret", secret: true },
    ],
    setupHelp:
      "The button opens Zoom's app builder. Create a Server-to-Server OAuth app, add the meeting:write:meeting scope, activate it, and paste the account ID, client ID and client secret from its credentials page.",
    setupActions: [{ label: "Create the Zoom app", url: "https://marketplace.zoom.us/develop/create" }],
  },
  async validateAuth(auth) {
    try {
      const token = await zoomToken(auth);
      const res = await fetch("https://api.zoom.us/v2/users/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j: any = await res.json();
      if (!res.ok) return { ok: false, error: j.message ?? String(res.status) };
      return { ok: true, accountLabel: j.email };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
  streams() {
    return []; // meetings surface via Calendar
  },
  async poll() {
    return { signals: [], nextCursor: null };
  },
  actions: [
    {
      name: "zoom_create_meeting",
      description: "Create a Zoom meeting and return its join URL. Use the join URL when creating the calendar event.",
      schema: {
        topic: z.string(),
        startIso: z.string().describe("Start time ISO 8601"),
        durationMinutes: z.number().int().default(30),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const token = await zoomToken(auth);
          const res = await fetch("https://api.zoom.us/v2/users/me/meetings", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              topic: input.topic,
              type: 2,
              start_time: input.startIso,
              duration: input.durationMinutes ?? 30,
            }),
          });
          const j: any = await res.json();
          if (!res.ok) return { ok: false, output: null, error: j.message ?? String(res.status) };
          return { ok: true, url: j.join_url, externalId: String(j.id), output: { joinUrl: j.join_url, id: j.id } };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
  ],
};
