import fs from "node:fs";
import path from "node:path";
import { amiHome } from "@ami/db";

/** ~/.ami/knowledge — the Obsidian-style knowledge base (the memory itself). */
export function knowledgeDir(): string {
  const dir = path.join(amiHome(), "knowledge");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** ~/.ami/knowledge_sources/<connector>/… — markdown source artifacts the graph builder consumes. */
export function sourcesDir(connector?: string): string {
  const dir = connector
    ? path.join(amiHome(), "knowledge_sources", connector)
    : path.join(amiHome(), "knowledge_sources");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** ~/.ami/config — JSON config files (notes.json, tags.json, triage_feedback.json …). */
export function configDir(): string {
  const dir = path.join(amiHome(), "config");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function statePath(): string {
  return path.join(amiHome(), "knowledge_graph_state.json");
}

export function suggestedTopicsPath(): string {
  return path.join(amiHome(), "suggested-topics.md");
}

export function agentNotesDir(): string {
  const dir = path.join(knowledgeDir(), "Agent Notes");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Save-to-memory inbox: agents append lines here; the agent-notes agent routes them. */
export function inboxPath(): string {
  return path.join(agentNotesDir(), "inbox.md");
}

export const ENTITY_FOLDERS = ["People", "Organizations", "Projects", "Topics"] as const;

/** Path safety: keep segments filesystem-friendly. */
export function safeSegment(s: string): string {
  return s.replace(/[/\\:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "unknown";
}
