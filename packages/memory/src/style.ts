import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { insertLlmUsage, styleProfiles, type Db } from "@ami/db";
import { WRITING_STYLE } from "@ami/shared";
import { agentNotesDir } from "./paths.js";
import { anthropicClient, kgModel } from "./llm.js";

/** Style profiles now live as files in the knowledge base
 * (knowledge/Agent Notes/style/<channel>.md) so the curation
 * and agent-notes agents can maintain them. The legacy style_profiles table is
 * read as a fallback for pre-migration data. */

function stylePath(channel: string): string {
  const dir = path.join(agentNotesDir(), "style");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${channel}.md`);
}

export function getStyleProfile(db: Db, channel: string): string | null {
  try {
    const content = fs.readFileSync(stylePath(channel), "utf-8").trim();
    if (content) return content;
  } catch {
    // fall through to legacy table
  }
  const row = db.select().from(styleProfiles).where(eq(styleProfiles.channel, channel)).get();
  return row?.profileMd ?? null;
}

export function setStyleProfile(_db: Db, channel: string, profileMd: string, _sampleCount = 0): void {
  fs.writeFileSync(stylePath(channel), profileMd, "utf-8");
}

export function styleProfileAgeMs(db: Db, channel: string): number | null {
  try {
    return Date.now() - fs.statSync(stylePath(channel)).mtimeMs;
  } catch {
    const row = db.select().from(styleProfiles).where(eq(styleProfiles.channel, channel)).get();
    return row ? Date.now() - new Date(row.updatedAt).getTime() : null;
  }
}

/** The enforcement iteration: after a draft is written, a second pass rewrites
 * it to match the user's voice card for that channel — rigorously (casing,
 * punctuation, greetings, characteristic phrases), while every fact, link and
 * mention token survives unchanged. Fails open: any problem returns the
 * original body, so drafting never breaks on a style pass. */
export async function enforceStyleOnDraft(db: Db, channel: string, body: string): Promise<string> {
  const card = getStyleProfile(db, channel === "gmail" ? "email" : channel);
  if (!card || !body.trim()) return body;
  const client = anthropicClient(db);
  if (!client) return body;
  try {
    const model = kgModel(db);
    const res = await client.messages.create({
      model,
      max_tokens: 1200,
      system: `You rewrite a drafted message so it reads exactly like the user typed it themselves, following their style card rigorously: casing, punctuation, greeting/sign-off habits, sentence length, characteristic phrases. Preserve ALL content and meaning — every fact, number, link, mention token (<@U123>, #channel) and question must survive unchanged. Do not add new content. If the draft already matches the card perfectly, return it unchanged. Output ONLY the message text, no commentary.\n\nThe general style below is the baseline; the user's style card wins wherever they conflict.\n\n${WRITING_STYLE}`,
      messages: [{ role: "user", content: `Style card:\n${card}\n\nDrafted message:\n${body}` }],
    });
    insertLlmUsage(db, {
      useCase: "style_pass",
      subUseCase: channel,
      model,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    });
    const text = res.content.find((b) => b.type === "text")?.text?.trim();
    return text || body;
  } catch {
    return body;
  }
}

/** Distill a style card from samples of the user's own messages.
 * `corrections` are past draft edits (Ami's wording → the user's rewrite) —
 * the strongest signal of what the user wants changed. */
export async function learnStyleProfile(
  db: Db,
  channel: "slack" | "email" | "generic",
  samples: string[],
  corrections: string[] = [],
): Promise<string | null> {
  if (samples.length < 3) return null;
  const client = anthropicClient(db);
  if (!client) return null;
  const model = kgModel(db);
  const correctionsBlock = corrections.length
    ? `\n\nThe user also corrected drafts written in their name — weigh these heavily, they show exactly what to change:\n${corrections
        .slice(0, 15)
        .map((c, i) => `${i + 1}. ${c.slice(0, 400)}`)
        .join("\n")}`
    : "";
  const res = await client.messages.create({
    model,
    max_tokens: 1500,
    system:
      "You analyze writing samples and produce a concise style card another writer can follow to imitate the author. Cover: greeting/sign-off habits, formality, sentence length, emoji/punctuation habits, characteristic phrases, and tone. Output markdown, max 25 lines.",
    messages: [
      {
        role: "user",
        content: `Here are ${samples.length} ${channel} messages written by the user:\n\n${samples
          .slice(0, 200)
          .map((s, i) => `${i + 1}. ${s.slice(0, 500)}`)
          .join("\n")}${correctionsBlock}\n\nProduce the style card.`,
      },
    ],
  });
  insertLlmUsage(db, {
    useCase: "style_learner",
    subUseCase: channel,
    model,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
  });
  const text = res.content.find((b) => b.type === "text")?.text ?? null;
  if (text) setStyleProfile(db, channel, text, samples.length);
  return text;
}
