import fs from "node:fs";
import path from "node:path";
import { getSetting, type Db } from "@ami/db";
import { agentNotesDir } from "./paths.js";

/** Owner identity injection.
 * Every note-creation/curation/triage run gets an authoritative "who the user
 * is" block — the identity logic (self-exclusion, first-person perspective,
 * the Email Reply Gate, teammate detection by domain) all depends on it.
 * Never let an agent guess who the user is from email headers. */

// Free-mail providers: a shared domain here does NOT mean two people are colleagues.
const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "hey.com", "fastmail.com",
]);

export interface OwnerIdentity {
  name: string | null;
  email: string | null;
  domain: string | null;
  isFreeMail: boolean;
}

export function ownerIdentity(db: Db): OwnerIdentity {
  const name = getSetting(db, "user_name");
  const email = (getSetting(db, "user_email") ?? "").toLowerCase() || null;
  const domainFromEmail = email?.includes("@") ? email.split("@")[1] : null;
  const domain = ((getSetting(db, "user_domain") ?? domainFromEmail) || null)?.toLowerCase() ?? null;
  return { name, email, domain, isFreeMail: domain ? FREE_MAIL_DOMAINS.has(domain) : false };
}

export function buildOwnerBlock(db: Db): string {
  const user = ownerIdentity(db);

  // Optional profile lines from Agent Notes/user.md — gives the agent context
  // like "the owner runs X" so it reads outbound product email correctly.
  let profileLines = "";
  try {
    const userNotesPath = path.join(agentNotesDir(), "user.md");
    if (fs.existsSync(userNotesPath)) {
      const lines = fs
        .readFileSync(userNotesPath, "utf-8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- "))
        .map((l) => l.replace(/^- \[[^\]]*\]\s*/, "- "))
        .slice(0, 6);
      if (lines.length > 0) profileLines = lines.join("\n");
    }
  } catch {
    // profile lines are best-effort
  }

  let block = `# Owner Of This Memory (authoritative — do not infer identity from email headers)\n\n`;
  block += `- **Name:** ${user.name || "(not set — resolve from the email address below when needed)"}\n`;
  block += `- **Email:** ${user.email || "(not set)"}\n`;
  block += `- **Email domain:** ${user.domain || "(not set)"}${
    user.isFreeMail
      ? " (personal free-mail domain — do NOT treat same-domain senders as the owner's colleagues)"
      : " (company domain — same-domain senders are the owner's teammates)"
  }\n`;
  if (profileLines) {
    block += `- **Profile:**\n${profileLines.split("\n").map((l) => `  ${l}`).join("\n")}\n`;
  }
  block += `\nEvery note is written from this person's first-person perspective: "I"/"me"/"my" = the owner above. `;
  block += `Messages sent FROM the owner's address are the owner's own actions (including outbound sales/marketing/product email from their company). `;
  block += `Never create a People note for the owner, and never describe the owner in third person. Apply the "Owner Identity" rules in your instructions.\n`;
  return block;
}

/** Final-reminder lines repeated right before generation (recency-position). */
export function ownerFinalReminder(db: Db): string {
  const user = ownerIdentity(db);
  if (!user.email) return "";
  const ownerLabel = user.name ? `${user.name} <${user.email}>` : user.email;
  return (
    `**FINAL REMINDER — the owner of this memory is ${ownerLabel}.** ` +
    `(1) Never create or update a People note for them; in prose they are "I", never their name. ` +
    `(2) Emails FROM ${user.email} are the owner's own actions ("I emailed…"), not an external contact. ` +
    `(3) No placeholder text ("Unknown"/"-") and no links between entities that didn't co-occur in one source file.\n`
  );
}

/**
 * Compute the Email Reply Gate mechanically and stamp the verdict on each email
 * source. The gate ("cold inbound
 * never creates notes") is the single most important selectivity rule; code
 * decides "did the user's side ever send a message in this thread" — the model
 * only decides what the reply *means*.
 */
export function emailReplyGateBanner(db: Db, filePath: string, content: string): string | null {
  // Only email sources carry the ### From: thread structure.
  if (!filePath.split(path.sep).includes("gmail")) return null;
  const user = ownerIdentity(db);
  if (!user.email) return null;
  const email = user.email;
  const teamDomain = user.domain && !user.isFreeMail ? "@" + user.domain : null;
  const froms = [...content.matchAll(/^### From: (.+)$/gm)].map((m) => m[1].toLowerCase());
  if (froms.length === 0) return null;
  // Google Groups rewrites external senders: `'Jane Doe' via Founders <founders@user-domain.com>`
  // — an EXTERNAL person routed through a group on the user's domain; never
  // counts as the user's side having replied.
  const isGroupRewrite = (f: string) => /\bvia\b[^<]*</.test(f);
  const replied = froms.some(
    (f) => !isGroupRewrite(f) && (f.includes(email) || (teamDomain !== null && f.includes(teamDomain))),
  );
  return replied
    ? `> **REPLY-GATE (computed by the system, authoritative): the user HAS sent a message in this thread.** New People/Organization notes are allowed IF the user's reply shows real engagement AND the other gates pass. A decline, brush-off, or unsubscribe-style reply ("not interested", "please remove me", a bare "no thanks") is NOT engagement — treat those threads like purely inbound ones.`
    : `> **REPLY-GATE (computed by the system, authoritative): the user has NOT sent any message in this thread — purely inbound.** You MUST NOT create ANY new note from this file — no People, no Organizations, no Projects, no Topics, no event notes. Not for the sender, and not for anyone or anything mentioned in the content (companies, speakers, events, products). No matter how important it sounds. Allowed: updating notes that already exist, and suggestion cards in suggested-topics.md. Sole exception: a calendar invite for a real 1:1/small-group meeting scheduled with the user by name may create the primary contact's note.`;
}
