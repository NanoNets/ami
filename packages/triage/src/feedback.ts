import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { insertLlmUsage, type Db } from "@ami/db";
import { configDir, kgModel, parseWithSchema } from "@ami/memory";
import { anthropicClient, fakeLlm } from "./llm.js";

/**
 * User-feedback loop for triage.
 *
 * "Worth my attention" is personal — no fixed rubric gets it right for
 * everyone. When the user corrects a verdict (today: dismissing a todo the
 * triage created), the correction is recorded here, and triage learns two ways:
 *  1. Immediately: recent corrections are injected as few-shot examples into
 *     every triage call.
 *  2. Generalized: once enough new corrections accumulate, an LLM pass distills
 *     them into short preference rules ("standup logistics never become
 *     tasks") that are also injected — so the learning transfers to signals
 *     the user never corrected.
 */

const MAX_CORRECTIONS = 200;
const FEW_SHOT_COUNT = 20;
const DISTILL_EVERY = 6; // distill after this many new corrections
const MAX_RULES = 12;

export interface TriageCorrection {
  signalId: string;
  connector: string;
  title: string;
  author: string;
  /** What triage had said. */
  agentVerdict: "task" | "fyi";
  /** What the user's action implies it actually was. */
  userVerdict: "ignore" | "fyi" | "task";
  at: string; // ISO
}

export interface TriageFeedback {
  corrections: TriageCorrection[];
  /** Distilled, generalized preference rules. */
  rules: string[];
  rulesUpdatedAt?: string;
  /** How many corrections had been seen at the last distillation. */
  distilledThrough: number;
}

const EMPTY: TriageFeedback = { corrections: [], rules: [], distilledThrough: 0 };

function feedbackPath(): string {
  return path.join(configDir(), "triage_feedback.json");
}

export function loadTriageFeedback(): TriageFeedback {
  try {
    if (!fs.existsSync(feedbackPath())) return { ...EMPTY };
    const parsed = JSON.parse(fs.readFileSync(feedbackPath(), "utf-8"));
    return {
      corrections: Array.isArray(parsed.corrections) ? parsed.corrections : [],
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
      rulesUpdatedAt: parsed.rulesUpdatedAt,
      distilledThrough: typeof parsed.distilledThrough === "number" ? parsed.distilledThrough : 0,
    };
  } catch (err) {
    console.warn("[triage-feedback] failed to load, starting fresh:", err);
    return { ...EMPTY };
  }
}

function saveTriageFeedback(fb: TriageFeedback): void {
  const file = feedbackPath();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(fb, null, 2));
  fs.renameSync(tmp, file);
}

/** Record a user correction. One entry per signal — flipping back and forth
 * keeps only the latest verdict (and if the user flips back to what triage
 * originally said, the correction is dropped: no disagreement left to learn). */
export function recordTriageCorrection(correction: TriageCorrection): TriageFeedback {
  const fb = loadTriageFeedback();
  const existing = fb.corrections.find((c) => c.signalId === correction.signalId);
  // The verdict triage originally produced is the stable "before".
  const agentVerdict = existing ? existing.agentVerdict : correction.agentVerdict;
  fb.corrections = fb.corrections.filter((c) => c.signalId !== correction.signalId);
  if (correction.userVerdict !== agentVerdict) {
    fb.corrections.push({ ...correction, agentVerdict });
    if (fb.corrections.length > MAX_CORRECTIONS) {
      fb.corrections = fb.corrections.slice(-MAX_CORRECTIONS);
    }
  }
  saveTriageFeedback(fb);
  return fb;
}

/** Render the user's learned preferences for the triage prompt.
 * Null when nothing has been learned yet. */
export function formatTriageFeedbackForPrompt(): string | null {
  const fb = loadTriageFeedback();
  if (fb.rules.length === 0 && fb.corrections.length === 0) return null;

  const lines: string[] = [];
  lines.push(
    `# This user's triage preferences (learned from their explicit corrections — these OVERRIDE the generic criteria above)`,
  );
  lines.push("");
  lines.push(
    `What deserves the user's attention is personal. The user has corrected past verdicts; match THEIR standard, not the generic one.`,
  );
  if (fb.rules.length > 0) {
    lines.push("");
    lines.push(`## Their rules`);
    for (const r of fb.rules) lines.push(`- ${r}`);
  }
  const recent = fb.corrections.slice(-FEW_SHOT_COUNT);
  if (recent.length > 0) {
    lines.push("");
    lines.push(`## Their recent corrections (ground truth examples)`);
    for (const c of recent) {
      lines.push(
        `- ${c.connector} from ${c.author}: "${c.title}" → user says ${c.userVerdict.toUpperCase()} (triage had said ${c.agentVerdict})`,
      );
    }
  }
  return lines.join("\n");
}

const DistilledRules = z.object({
  rules: z
    .array(z.string())
    .max(MAX_RULES)
    .describe(
      'Generalized, testable triage preferences derived from the corrections, e.g. "Standup/scheduling logistics in Slack are never tasks" or "Anything from the #incidents channel is a task". Each rule must generalize at least one correction; do not restate single signals.',
    ),
});

/** When enough new corrections have accumulated, distill them into generalized
 * rules. Cheap, rate-limited by correction count, safe to call opportunistically. */
export async function maybeDistillTriageRules(db: Db): Promise<void> {
  if (fakeLlm()) return;
  const fb = loadTriageFeedback();
  const newSince = fb.corrections.length - fb.distilledThrough;
  if (fb.corrections.length === 0 || (newSince < DISTILL_EVERY && fb.rules.length > 0)) return;
  if (newSince <= 0) return;

  const client = anthropicClient(db);
  if (!client) return;

  try {
    const correctionLines = fb.corrections
      .map(
        (c) =>
          `- ${c.connector} from ${c.author}: "${c.title}" | triage said ${c.agentVerdict}, user corrected to ${c.userVerdict}`,
      )
      .join("\n");
    const existingRules = fb.rules.length
      ? `\n\nCurrent rules (rewrite/merge as needed):\n${fb.rules.map((r) => `- ${r}`).join("\n")}`
      : "";

    const model = kgModel(db);
    const result = await parseWithSchema(
      db,
      client,
      {
        model,
        max_tokens: 1500,
        system: `You maintain a short list of triage preference rules for one user, derived from their explicit corrections of an automated triage classifier. Write at most ${MAX_RULES} rules. Rules must GENERALIZE (channels, senders, signal types, topics) — never restate a single signal. Where corrections conflict, prefer the more recent. Keep rules that are still supported; drop ones the corrections no longer support.`,
        messages: [{ role: "user", content: `Corrections (oldest first):\n${correctionLines}${existingRules}` }],
      },
      DistilledRules,
    );
    insertLlmUsage(db, {
      useCase: "rule_distiller",
      model,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      cacheReadTokens: result.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: result.usage.cache_creation_input_tokens ?? 0,
    });

    const rules = result.parsed_output?.rules;
    if (!rules) return;
    const updated = loadTriageFeedback(); // re-read: corrections may have advanced
    updated.rules = rules.slice(0, MAX_RULES);
    updated.rulesUpdatedAt = new Date().toISOString();
    updated.distilledThrough = fb.corrections.length;
    saveTriageFeedback(updated);
    console.log(`[triage-feedback] distilled ${updated.rules.length} rules from ${fb.corrections.length} corrections`);
  } catch (err) {
    console.warn("[triage-feedback] rule distillation failed (will retry later):", err);
  }
}
