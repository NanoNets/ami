/** Ami's memory: an Obsidian-style markdown knowledge base built and curated
 * by agents.
 *
 * - Source artifacts land in ~/.ami/knowledge_sources/<connector>/ (source-writer)
 * - The note-creation agent processes them one at a time into ~/.ami/knowledge/
 *   dossiers (People/Organizations/Projects/Topics) linked with [[wiki-links]]
 * - A daily curation ("gardener") agent consolidates bloated notes
 * - The agent-notes agent maintains knowledge about the user themself
 * - Retrieval is deterministic: knowledge index + content matching (search.ts)
 */

export * from "./llm.js";
export * from "./paths.js";
export * from "./fts.js";
export * from "./lint.js";
export * from "./dedupe.js";
export * from "./graph-state.js";
export * from "./knowledge-index.js";
export * from "./note-system.js";
export * from "./tag-system.js";
export * from "./owner.js";
export * from "./source-writer.js";
export * from "./build-graph.js";
export * from "./agent-runner.js";
export * from "./agent-session.js";
export * from "./search.js";
export * from "./style.js";
export * from "./agent-notes.js";
export * from "./migrate.js";
export * from "./graph-export.js";
export * from "./version-history.js";
export { noteCreationPrompt } from "./prompts/note-creation.js";
export { noteCurationPrompt } from "./prompts/note-curation.js";
export { agentNotesPrompt } from "./prompts/agent-notes.js";
