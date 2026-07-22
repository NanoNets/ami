import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { statePath } from "./paths.js";

/**
 * State tracking for knowledge graph processing.
 * Hybrid mtime + hash change detection:
 * mtime is the fast check; when it moved, the content hash confirms a real change.
 */

export interface FileState {
  mtime: string;
  hash: string;
  lastProcessed: string;
}

export interface GraphState {
  processedFiles: Record<string, FileState>;
  lastBuildTime: string;
  lastCurationTime?: string;
  lastAgentNotesTime?: string;
  /** Last time the agent-notes run included sent-message style mining (~nightly). */
  lastStyleMiningTime?: string;
  /** Sent-message/run sources already mined by the agent-notes agent. */
  processedAgentNoteSources?: Record<string, string>;
  /** Source files whose note-creation batch keeps failing; quarantined after
   * MAX_SOURCE_FAILURES so they stop burning an agent run every tick. */
  failedSources?: Record<string, { count: number; lastAttempt: string }>;
  /** Dedupe-pass verdicts per note pair ("merged" | "distinct"), so the same
   * pair is never re-litigated. */
  mergeDecisions?: Record<string, { verdict: string; at: string }>;
}

export const MAX_SOURCE_FAILURES = 3;

export function recordSourceFailure(state: GraphState, filePath: string): void {
  const failed = (state.failedSources ??= {});
  const prev = failed[filePath];
  failed[filePath] = { count: (prev?.count ?? 0) + 1, lastAttempt: new Date().toISOString() };
}

export function clearSourceFailure(state: GraphState, filePath: string): void {
  if (state.failedSources?.[filePath]) delete state.failedSources[filePath];
}

export function isQuarantined(state: GraphState, filePath: string): boolean {
  return (state.failedSources?.[filePath]?.count ?? 0) >= MAX_SOURCE_FAILURES;
}

export function loadState(): GraphState {
  if (fs.existsSync(statePath())) {
    try {
      return JSON.parse(fs.readFileSync(statePath(), "utf-8"));
    } catch (error) {
      console.error("[memory] error loading knowledge graph state:", error);
    }
  }
  return { processedFiles: {}, lastBuildTime: new Date(0).toISOString() };
}

export function saveState(state: GraphState): void {
  const file = statePath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath, "utf-8");
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function hasFileChanged(filePath: string, state: GraphState): boolean {
  const fileState = state.processedFiles[filePath];
  if (!fileState) return true;
  const stats = fs.statSync(filePath);
  const currentMtime = stats.mtime.toISOString();
  if (currentMtime === fileState.mtime) return false;
  return computeFileHash(filePath) !== fileState.hash;
}

export function markFileAsProcessed(filePath: string, state: GraphState): void {
  const stats = fs.statSync(filePath);
  state.processedFiles[filePath] = {
    mtime: stats.mtime.toISOString(),
    hash: computeFileHash(filePath),
    lastProcessed: new Date().toISOString(),
  };
}

/** New or changed .md files under sourceDir (recursive). */
export function getFilesToProcess(sourceDir: string, state: GraphState): string[] {
  if (!fs.existsSync(sourceDir)) return [];
  const filesToProcess: string[] = [];
  function traverse(dir: string) {
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        traverse(fullPath);
      } else if (stat.isFile() && entry.endsWith(".md")) {
        if (hasFileChanged(fullPath, state)) filesToProcess.push(fullPath);
      }
    }
  }
  traverse(sourceDir);
  return filesToProcess;
}

export function resetState(): void {
  saveState({ processedFiles: {}, lastBuildTime: new Date().toISOString() });
}
