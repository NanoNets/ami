import { eq, desc } from "drizzle-orm";
import { connectorAccounts, decisionTraces, type Db } from "@ami/db";
import { googleApi } from "@ami/connectors";
import { learnStyleProfile, styleProfileAgeMs } from "@ami/memory";
import type { AuthBlob } from "@ami/shared";

const STALE_MS = 20 * 3600_000; // refresh roughly nightly

/** Learn/refresh the user's writing style from their own sent messages.
 * Runs per channel when the profile is missing or stale (or force=true). */
export async function refreshStyleProfiles(db: Db, force = false): Promise<Record<string, string>> {
  const outcome: Record<string, string> = {};
  const corrections = draftEditCorrections(db);

  for (const [connector, channel, gather] of [
    ["slack", "slack", slackSamples],
    ["gmail", "email", gmailSamples],
  ] as const) {
    const acct = db
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.connector, connector))
      .get();
    if (!acct || acct.status === "disabled") {
      outcome[channel] = "no account";
      continue;
    }
    const age = styleProfileAgeMs(db, channel);
    if (!force && age !== null && age < STALE_MS) {
      outcome[channel] = "fresh";
      continue;
    }
    try {
      const samples = await gather(JSON.parse(acct.authJson));
      if (samples.length < 3) {
        outcome[channel] = `too few samples (${samples.length})`;
        continue;
      }
      const card = await learnStyleProfile(db, channel, samples, corrections);
      outcome[channel] = card ? `learned from ${samples.length} samples` : "no api key";
    } catch (e: any) {
      outcome[channel] = `error: ${e.message}`;
      console.error(`[style ${channel}]`, e.message);
    }
  }
  return outcome;
}

/** Sent-message samples for the agent-notes agent (style evidence). */
export async function gatherSentSamples(db: Db): Promise<{ channel: string; texts: string[] }[]> {
  const out: { channel: string; texts: string[] }[] = [];
  for (const [connector, channel, gather] of [
    ["slack", "slack", slackSamples],
    ["gmail", "email", gmailSamples],
  ] as const) {
    const acct = db
      .select()
      .from(connectorAccounts)
      .where(eq(connectorAccounts.connector, connector))
      .get();
    if (!acct || acct.status === "disabled") continue;
    try {
      const samples = await gather(JSON.parse(acct.authJson));
      if (samples.length > 0) out.push({ channel, texts: samples.slice(0, 20) });
    } catch (e: any) {
      console.error(`[agent-notes samples ${channel}]`, e.message);
    }
  }
  return out;
}

function draftEditCorrections(db: Db): string[] {
  return db
    .select()
    .from(decisionTraces)
    .where(eq(decisionTraces.kind, "draft_edit"))
    .orderBy(desc(decisionTraces.createdAt))
    .limit(15)
    .all()
    .map((t) => `${t.situation} || ${t.decision}`);
}

async function slackSamples(auth: AuthBlob): Promise<string[]> {
  const call = async (method: string, params: Record<string, string>) => {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
    });
    const j: any = await res.json();
    if (!j.ok) throw new Error(`slack ${method}: ${j.error}`);
    return j;
  };
  const me = await call("auth.test", {});
  const samples: string[] = [];
  for (let page = 1; page <= 2; page++) {
    const j = await call("search.messages", {
      query: `from:<@${me.user_id}>`,
      sort: "timestamp",
      sort_dir: "desc",
      count: "100",
      page: String(page),
    });
    for (const m of j.messages?.matches ?? []) {
      const text = String(m.text ?? "")
        .replace(/<@[A-Z0-9]+>/g, "@teammate")
        .replace(/<(https?:[^|>]+)(\|[^>]*)?>/g, "$1")
        .trim();
      if (text.length >= 25 && text.length <= 1500) samples.push(text);
    }
    if ((j.messages?.paging?.pages ?? 1) <= page) break;
  }
  return samples.slice(0, 200);
}

async function gmailSamples(auth: AuthBlob): Promise<string[]> {
  const G = "https://gmail.googleapis.com/gmail/v1/users/me";
  const list = await googleApi(auth, `${G}/messages?q=in:sent&maxResults=40`);
  const samples: string[] = [];
  for (const m of list.messages ?? []) {
    try {
      const msg = await googleApi(auth, `${G}/messages/${m.id}?format=full`);
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
      let body = findText(msg.payload) ?? "";
      // Keep only the user's own words: cut quoted history and signatures.
      body = body.split(/\r?\nOn .{10,80} wrote:\r?\n/)[0];
      body = body
        .split(/\r?\n/)
        .filter((l) => !l.startsWith(">"))
        .join("\n")
        .trim();
      if (body.length >= 40 && body.length <= 3000) samples.push(body);
    } catch {
      /* skip unreadable message */
    }
  }
  return samples.slice(0, 100);
}
