import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { amiHome, getSetting, type Db } from "@ami/db";
import { commitKnowledge, invalidateKnowledgeIndex, knowledgeDir } from "@ami/memory";
import type { AmiEvent } from "@ami/shared";
import { createEvent } from "../events/index.js";
import { processMeetingActionItems } from "./process.js";

type Publish = (e: AmiEvent) => void;

/** Granola meeting sync: reads the auth
 * token from Granola's local supabase.json and pulls meeting notes from the
 * Granola API into knowledge/Meetings/granola/. New meetings additionally get
 * action-item extraction (todos) and a meeting.notes_ready event. */

const GRANOLA_CLIENT_VERSION = "6.462.1";
const GRANOLA_API_BASE = "https://api.granola.ai";
const GRANOLA_CONFIG_PATH = path.join(
  homedir(),
  "Library",
  "Application Support",
  "Granola",
  "supabase.json",
);
const API_DELAY_MS = 1000;
const RATE_LIMIT_RETRY_DELAY_MS = 60 * 1000;
const MAX_RETRIES = 3;
const PAGE_SIZE = 10;
const LOOKBACK_DAYS = 7;

export function granolaAvailable(): boolean {
  return fs.existsSync(GRANOLA_CONFIG_PATH);
}

export function granolaEnabled(db: Db): boolean {
  return getSetting(db, "granola_enabled") === "1";
}

function extractAccessToken(): string | null {
  try {
    if (!fs.existsSync(GRANOLA_CONFIG_PATH)) return null;
    const supabaseJson = JSON.parse(fs.readFileSync(GRANOLA_CONFIG_PATH, "utf-8"));
    if (!supabaseJson.workos_tokens) return null;
    const tokens = JSON.parse(supabaseJson.workos_tokens);
    return tokens.access_token ?? null;
  } catch (error) {
    console.error("[granola] error extracting access token:", error);
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function apiCall<T>(endpoint: string, accessToken: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${GRANOLA_API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": `Granola/${GRANOLA_CLIENT_VERSION}`,
      "X-Client-Version": GRANOLA_CLIENT_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status}: ${response.statusText}`);
  return (await response.json()) as T;
}

async function callWithRateLimit<T>(op: () => Promise<T>, name: string): Promise<T | null> {
  let delay = RATE_LIMIT_RETRY_DELAY_MS;
  for (let retries = 0; retries < MAX_RETRIES; retries++) {
    try {
      return await op();
    } catch (error: any) {
      const msg = String(error?.message ?? error);
      if (/429|Too Many Requests|rate limit/i.test(msg)) {
        console.log(`[granola] rate limit on ${name}, retry in ${delay / 1000}s`);
        await sleep(delay);
        delay *= 2;
      } else {
        throw error;
      }
    }
  }
  return null;
}

// ── ProseMirror → markdown ───────────────────────────────────────────────────

interface PMNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
}

function pmToMarkdown(content: PMNode | undefined): string {
  if (!content || typeof content !== "object" || !content.content) return "";
  function processNode(node: PMNode): string {
    if (!node || typeof node !== "object") return "";
    const children = node.content ?? [];
    switch (node.type) {
      case "heading": {
        const level = (node.attrs?.level as number) || 1;
        return `${"#".repeat(level)} ${children.map(processNode).join("")}\n\n`;
      }
      case "paragraph":
        return `${children.map(processNode).join("")}\n\n`;
      case "bulletList":
        return (
          children
            .filter((i) => i.type === "listItem")
            .map((i) => `- ${(i.content ?? []).map(processNode).join("").trim()}`)
            .join("\n") + "\n\n"
        );
      case "orderedList":
        return (
          children
            .filter((i) => i.type === "listItem")
            .map((i, idx) => `${idx + 1}. ${(i.content ?? []).map(processNode).join("").trim()}`)
            .join("\n") + "\n\n"
        );
      case "text":
        return node.text ?? "";
      case "hardBreak":
        return "\n";
      default:
        return children.map(processNode).join("");
    }
  }
  return processNode(content);
}

function documentToMarkdown(doc: any): string {
  const title = doc.title || "Untitled meeting";
  let md = `---\n`;
  md += `source: granola\n`;
  md += `granola_id: ${doc.id}\n`;
  md += `title: ${JSON.stringify(title)}\n`;
  md += `created_at: ${doc.created_at}\n`;
  md += `updated_at: ${doc.updated_at || doc.created_at}\n`;
  md += `---\n\n`;
  md += `# Meeting: ${title}\n\n**When:** ${doc.created_at}\n\n`;

  const panel = doc.last_viewed_panel?.content;
  if (panel && typeof panel === "object" && panel.type === "doc") {
    md += pmToMarkdown(panel as PMNode);
  } else if (doc.notes && typeof doc.notes === "object" && doc.notes.type === "doc") {
    md += pmToMarkdown(doc.notes as PMNode);
  } else if (doc.notes_markdown) {
    md += doc.notes_markdown;
  } else if (doc.notes_plain) {
    md += doc.notes_plain;
  }
  return md;
}

// ── Sync ─────────────────────────────────────────────────────────────────────

interface GranolaState {
  lastSyncDate: string;
  syncedDocs: Record<string, string>; // documentId -> updated_at
}

function statePath(): string {
  return path.join(amiHome(), "granola_sync_state.json");
}

function loadGranolaState(): GranolaState {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf-8"));
  } catch {
    return { lastSyncDate: "", syncedDocs: {} };
  }
}

function cleanFilename(name: string): string {
  return name.replace(/[\\/*?:"<>|]/g, "_").substring(0, 100).trim() || "untitled";
}

let syncing = false;

export async function granolaSync(db: Db, publish: Publish): Promise<{ new: number; updated: number }> {
  if (syncing) return { new: 0, updated: 0 };
  syncing = true;
  try {
    if (!granolaEnabled(db)) return { new: 0, updated: 0 };
    const accessToken = extractAccessToken();
    if (!accessToken) {
      console.log("[granola] no access token (is Granola installed and signed in?)");
      return { new: 0, updated: 0 };
    }

    const meetingsDir = path.join(knowledgeDir(), "Meetings", "granola");
    fs.mkdirSync(meetingsDir, { recursive: true });
    const state = loadGranolaState();
    const lookbackCutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);

    let newCount = 0;
    let updatedCount = 0;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      if (offset > 0) await sleep(API_DELAY_MS);
      const res: any = await callWithRateLimit(
        () =>
          apiCall("/v2/get-documents", accessToken, {
            limit: PAGE_SIZE,
            offset,
            include_last_viewed_panel: true,
          }),
        "get-documents",
      );
      if (!res?.docs?.length) break;

      for (const doc of res.docs) {
        const docDate = new Date(doc.created_at);
        if (docDate < lookbackCutoff) {
          hasMore = false;
          break;
        }
        if (doc.deleted_at) continue;
        const docUpdatedAt = doc.updated_at || doc.created_at;
        const lastSyncedAt = state.syncedDocs[doc.id];
        if (lastSyncedAt === docUpdatedAt) continue;

        const title = doc.title || "Untitled meeting";
        const dateStr = doc.created_at.slice(0, 10);
        const filePath = path.join(meetingsDir, `${dateStr} ${cleanFilename(title)}.md`);
        fs.writeFileSync(filePath, documentToMarkdown(doc), "utf-8");

        if (lastSyncedAt) {
          updatedCount++;
        } else {
          newCount++;
          // First-time write only — Granola notes update live; don't re-fire
          // todos/events on later edits to the same meeting.
          const relPath = path.relative(knowledgeDir(), filePath);
          void processMeetingActionItems(db, publish, {
            title,
            when: doc.created_at,
            notePath: relPath,
          }).catch((e) => console.error("[granola] action-item extraction failed:", e));
          createEvent({
            source: "granola",
            type: "meeting.notes_ready",
            createdAt: new Date().toISOString(),
            payload: `# Meeting notes ready: ${title}\n\nWhen: ${doc.created_at}\nNote: knowledge/${relPath}\n\n${documentToMarkdown(doc).slice(0, 2000)}`,
          });
        }
        state.syncedDocs[doc.id] = docUpdatedAt;
      }

      offset += res.docs.length;
      if (res.docs.length < PAGE_SIZE) hasMore = false;
    }

    state.lastSyncDate = new Date().toISOString();
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));

    if (newCount + updatedCount > 0) {
      invalidateKnowledgeIndex();
      await commitKnowledge("Meeting notes sync").catch(() => {});
      publish({ type: "ingest.progress", message: `granola: ${newCount} new, ${updatedCount} updated meeting(s)` });
      console.log(`[granola] sync: ${newCount} new, ${updatedCount} updated`);
    }
    return { new: newCount, updated: updatedCount };
  } finally {
    syncing = false;
  }
}
