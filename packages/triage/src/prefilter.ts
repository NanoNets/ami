/** Deterministic noise pre-filter:
 * drops obvious noise before it costs triage tokens or todo-list attention.
 * A durable signal always overrides the noise heuristics. */

const EXPIRED_ROUTINE_AGE_MS = 2 * 60 * 60 * 1000;
const ROUTINE_EVENT_RE = /\b(stand[-\s]?up|daily\s+(sync|scrum|standup)|scrum|check[-\s]?in)\b/i;
const ROUTINE_LOGISTICS_RE =
  /\b(skip|skipping|miss|missing|can't|cannot|cant|won't|wont|join|attend|possible|move|reschedule|shift|late|running\s+late|stomach|sick|not\s+feeling|headache|doctor|appointment|today|todays|today's|tomorrow|at\s+\d{1,2}(:\d{2})?\s*(am|pm)?)\b/i;

// Durable signals always win: a message matching any of these is kept even if
// it would otherwise look like noise (a system message, a "done", etc.).
const DURABLE_SIGNAL_RE =
  /\b(blocker|blocked|decision|decided|owner|deadline|shipped|fixed|done|launched|deployed|merged|bug|issue|incident|outage|customer|contract|pricing|proposal|launch|release|handoff|review|approval|approved)\b/i;

// Slack system / automated messages render as plain narration. No human content.
const SYSTEM_MESSAGE_RE =
  /\b(has joined the channel|has left the channel|was added to|has been added|set the channel (topic|purpose|description)|cleared the channel (topic|purpose)|renamed the channel|archived the channel|un-?archived the channel|pinned a message|joined the (call|huddle)|started a (call|huddle)|set up a call)\b/i;

// Greetings / acknowledgements with no informational content. Anchored to the
// whole (trimmed) message so "ok" drops but "ok, the deploy is blocked" stays.
const TRIVIAL_RE =
  /^(hi|hello+|hey+|yo|gm|gn|good\s*(morning|night|evening|afternoon)|morning|thanks?|thank\s*you|ty|thx|tysm|np|no\s*problem|ok(ay)?|k|got\s*it|gotcha|lgtm|\+1|nice|cool|great|awesome|perfect|done|yes+|yep|yup|no+|nope|sure|sounds?\s*good|sg|welcome|congrats?|congratulations)[\s.!?]*$/i;

const EMOJI_SHORTCODE_RE = /:[a-z0-9_+-]+:/gi;

/** What remains after removing :shortcodes:, unicode emoji/symbols, punctuation
 * and whitespace. Empty ⇒ the message was emoji/reaction-only. */
function strippedToCore(text: string): string {
  return text
    .replace(EMOJI_SHORTCODE_RE, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .trim();
}

export interface PrefilterVerdict {
  drop: boolean;
  reason?: string;
}

/** Pure function so it's unit-testable; only message-like signals are filtered
 * (issues, events, tickets carry structure worth triaging). */
export function prefilterSignal(
  signal: { connector: string; kind: string; body: string; receivedAt: string },
  nowMs = Date.now(),
): PrefilterVerdict {
  if (signal.kind !== "message") return { drop: false };
  // Judge the message itself, not any conversation context attached at poll time.
  const own = signal.body.split(/\n--- Conversation context/)[0];
  const text = own.replace(/\s+/g, " ").trim();

  if (!text) return { drop: true, reason: "empty body" };
  if (DURABLE_SIGNAL_RE.test(text)) return { drop: false };
  if (SYSTEM_MESSAGE_RE.test(text)) return { drop: true, reason: "system message" };
  if (TRIVIAL_RE.test(text)) return { drop: true, reason: "trivial acknowledgement" };
  if (strippedToCore(text).length === 0) return { drop: true, reason: "emoji/reaction only" };

  // Expired routine standup logistics ("running late today", 2+ hours old).
  const sentAtMs = new Date(signal.receivedAt).getTime();
  if (
    Number.isFinite(sentAtMs) &&
    nowMs - sentAtMs >= EXPIRED_ROUTINE_AGE_MS &&
    ROUTINE_EVENT_RE.test(text) &&
    ROUTINE_LOGISTICS_RE.test(text)
  ) {
    return { drop: true, reason: "expired routine logistics" };
  }

  return { drop: false };
}
