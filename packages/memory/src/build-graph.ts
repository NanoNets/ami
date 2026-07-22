import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { amiHome, insertLlmUsage, type Db } from "@ami/db";
import {
  loadState,
  saveState,
  getFilesToProcess,
  markFileAsProcessed,
  resetState,
  recordSourceFailure,
  clearSourceFailure,
  isQuarantined,
  type GraphState,
} from "./graph-state.js";
import { buildKnowledgeIndex, formatIndexForPrompt, invalidateKnowledgeIndex } from "./knowledge-index.js";
import { buildOwnerBlock, ownerFinalReminder, emailReplyGateBanner } from "./owner.js";
import { noteCreationPrompt } from "./prompts/note-creation.js";
import { noteCurationPrompt } from "./prompts/note-curation.js";
import { noiseTagNames } from "./tag-system.js";
import { agentNotesDir, knowledgeDir, sourcesDir, suggestedTopicsPath, ENTITY_FOLDERS } from "./paths.js";
import { runKnowledgeAgent } from "./agent-runner.js";
import { commitKnowledge } from "./version-history.js";
import { anthropicClient, kgModel, parseWithSchema } from "./llm.js";
import { lintNote } from "./lint.js";
import { runDedupePass } from "./dedupe.js";

/** Build the Obsidian-style knowledge graph from source artifacts.
 * One source file per agent run
 * (BATCH_SIZE = 1 — prevents cross-file entity contamination), mtime+hash
 * change detection, incremental state saves. */

const BATCH_SIZE = 1;

/** Noise tags anywhere in the frontmatter labels block ⇒ skip the email. */
function hasNoiseLabels(content: string): boolean {
  if (!content.startsWith("---")) return false;
  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) return false;
  const fm = content.slice(3, endIdx);
  const noise = noiseTagNames();

  const values: string[] = [];
  for (const m of fm.matchAll(/^\s+-\s+(.+)$/gm)) values.push(m[1]);
  for (const m of fm.matchAll(/:\s*\[([^\]]*)\]/g)) values.push(...m[1].split(","));
  for (const m of fm.matchAll(/^\s*[\w-]+:\s*([^\n[\]{}|>-][^\n]*)$/gm)) values.push(m[1]);

  for (const raw of values) {
    if (noise.has(raw.trim().replace(/['"]/g, ""))) return true;
  }
  return false;
}

// ── Noise pre-classifier ─────────────────────────────────────────────────────
// Every source file costs a full note-creation agent run. Gmail is already
// filtered by triage labels; Slack chatter and generic connector noise get a
// single cheap batched utility-model call instead. Conservative by
// construction: any doubt, classifier failure, or missing client keeps the
// file, and only clearly-informationless messages are dropped.

const NoiseVerdictsSchema = z.object({
  verdicts: z.array(z.object({ idx: z.number(), noise: z.boolean() })),
});

const CLASSIFIER_BATCH = 20;
const CLASSIFIER_MAX_CHARS_PER_FILE = 1500;

async function filterNoiseSources(
  db: Db,
  provider: string,
  files: string[],
  state: GraphState,
): Promise<string[]> {
  if (provider === "gmail" || provider === "meetings" || files.length === 0) return files;
  const client = anthropicClient(db);
  if (!client) return files;

  const kept: string[] = [];
  for (let i = 0; i < files.length; i += CLASSIFIER_BATCH) {
    const batch = files.slice(i, i + CLASSIFIER_BATCH);
    const docs = batch.map((p, idx) => {
      let content = "";
      try {
        content = fs.readFileSync(p, "utf-8").slice(0, CLASSIFIER_MAX_CHARS_PER_FILE);
      } catch {
        // unreadable — keep, the batch loop tolerates it
      }
      return `<doc idx="${idx}">\n${content}\n</doc>`;
    });
    try {
      const model = kgModel(db);
      const res = await parseWithSchema(
        db,
        client,
        {
          model,
          max_tokens: 1500,
          system: `You pre-filter source documents before they are absorbed into a personal knowledge base of people, organizations, and projects. For each doc, set noise=true ONLY when it clearly contains no durable information about any person, organization, project, decision, or commitment: pure greetings/acks ("thanks!", "sounds good", emoji-only), automated bot/CI notifications, and system messages. When a doc names a person, discusses work, or you are unsure at all, set noise=false — dropping real information is far worse than one wasted processing run.`,
          messages: [{ role: "user", content: `Classify each doc:\n\n${docs.join("\n\n")}` }],
        },
        NoiseVerdictsSchema,
      );
      insertLlmUsage(db, {
        useCase: "source_prefilter",
        subUseCase: provider,
        model,
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      });
      const noiseIdx = new Set(
        (res.parsed_output?.verdicts ?? []).filter((v) => v.noise).map((v) => v.idx),
      );
      batch.forEach((p, idx) => {
        if (noiseIdx.has(idx)) {
          markFileAsProcessed(p, state);
        } else {
          kept.push(p);
        }
      });
      if (noiseIdx.size > 0) {
        console.log(`[graph] ${provider}: pre-filtered ${noiseIdx.size} noise source(s)`);
      }
    } catch (e) {
      console.error(`[graph] noise classifier failed (keeping all ${batch.length} file(s)):`, e);
      kept.push(...batch);
    }
  }
  saveState(state);
  return kept;
}

function readSuggestedTopicsFile(): string {
  try {
    if (!fs.existsSync(suggestedTopicsPath())) return "_No existing suggested topics file._";
    const content = fs.readFileSync(suggestedTopicsPath(), "utf-8").trim();
    return content.length > 0 ? content : "_Existing suggested topics file is empty._";
  } catch {
    return "_Failed to read existing suggested topics file._";
  }
}

async function createNotesFromBatch(
  db: Db,
  files: { path: string; content: string }[],
  knowledgeIndex: string,
): Promise<{ ok: boolean; error?: string }> {
  fs.mkdirSync(knowledgeDir(), { recursive: true });

  let message = `Process the following ${files.length} source file${files.length === 1 ? "" : "s"} and create/update obsidian notes.\n\n`;
  message += buildOwnerBlock(db);
  message += `\n---\n\n`;
  message += `**Instructions:**\n`;
  message += `- Use the KNOWLEDGE BASE INDEX below to resolve entities - DO NOT grep/search for existing notes\n`;
  message += `- Extract entities (people, organizations, projects, topics) from ALL files below\n`;
  message += `- The source files below are INDEPENDENT — they are batched only for efficiency. Two entities are related ONLY if they co-occur within the same single source file (or in an existing note). NEVER link entities just because they appear in this batch (see "Source Scoping" in your instructions)\n`;
  message += `- Create or update notes in the "knowledge" directory (relative paths like "knowledge/People/Name.md")\n`;
  message += `- You may also create or update "suggested-topics.md" to maintain curated suggested-topic cards\n`;
  message += `- If the SAME entity appears in multiple files, merge the information into a single note (this is identity, not a relationship — do not link different entities across files)\n`;
  message += `- Use file tools to read existing notes or "suggested-topics.md" (when you need full content) and write updates\n`;
  message += `- Follow the note templates and guidelines in your instructions\n\n`;

  message += `---\n\n${knowledgeIndex}\n---\n\n`;
  message += `# Current Suggested Topics File\n\nPath: suggested-topics.md\n\n${readSuggestedTopicsFile()}\n\n---\n\n`;

  message += `# Source Files to Process\n\n`;
  files.forEach((file, idx) => {
    const relativePath = path.relative(amiHome(), file.path);
    message += `## Source File ${idx + 1}: ${relativePath}\n\n`;
    const gateBanner = emailReplyGateBanner(db, file.path, file.content);
    if (gateBanner) message += gateBanner + `\n\n`;
    message += file.content;
    message += `\n\n---\n\n`;
  });

  // Recency-position reminder: the identity rules are the ones that corrupt
  // the graph when missed — repeat them right before generation.
  message += ownerFinalReminder(db);

  const result = await runKnowledgeAgent(db, {
    systemPrompt: noteCreationPrompt(),
    message,
    useCase: "note_creation",
  });
  return { ok: result.ok, error: result.error };
}

let building = false;

/** Process all new/changed source artifacts into knowledge notes. */
export async function processAllSources(db: Db): Promise<{ processed: number; errors: number }> {
  if (building) return { processed: 0, errors: 0 };
  building = true;
  try {
    const state = loadState();
    const root = sourcesDir();
    const outcome = { processed: 0, errors: 0 };

    const providers = fs
      .readdirSync(root)
      .filter((e) => fs.statSync(path.join(root, e)).isDirectory())
      .map((e) => ({ provider: e, dir: path.join(root, e) }));
    // Meeting notes live inside the knowledge dir (so [[Meetings/…]] links
    // resolve) but are graph-builder sources like everything else.
    const meetingsDir = path.join(knowledgeDir(), "Meetings");
    if (fs.existsSync(meetingsDir)) {
      providers.push({ provider: "meetings", dir: meetingsDir });
    }

    for (const { provider, dir } of providers) {
      // The prep/ subfolder is Ami's own output — never a source.
      let filesToProcess = getFilesToProcess(dir, state).filter(
        (f) => provider !== "meetings" || !f.includes(`${path.sep}prep${path.sep}`),
      );

      // Sources that repeatedly fail their batch are quarantined instead of
      // burning an agent run on every tick forever.
      const quarantined = filesToProcess.filter((f) => isQuarantined(state, f));
      if (quarantined.length > 0) {
        console.log(`[graph] ${provider}: skipping ${quarantined.length} quarantined source(s)`);
        filesToProcess = filesToProcess.filter((f) => !isQuarantined(state, f));
      }

      // Gmail: skip noise-labeled emails without spending an agent run.
      if (provider === "gmail") {
        filesToProcess = filesToProcess.filter((filePath) => {
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            if (!content.startsWith("---")) return false;
            if (hasNoiseLabels(content)) {
              markFileAsProcessed(filePath, state);
              return false;
            }
            return true;
          } catch {
            return false;
          }
        });
        saveState(state);
      }

      filesToProcess = await filterNoiseSources(db, provider, filesToProcess, state);

      if (filesToProcess.length === 0) continue;
      console.log(`[graph] ${provider}: ${filesToProcess.length} new/changed source file(s)`);

      for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
        const batchPaths = filesToProcess.slice(i, i + BATCH_SIZE);
        const batch = batchPaths
          .map((p) => {
            try {
              return { path: p, content: fs.readFileSync(p, "utf-8") };
            } catch {
              return null;
            }
          })
          .filter((f): f is { path: string; content: string } => f !== null);
        if (batch.length === 0) continue;

        try {
          // Fresh index before each batch so it includes notes from previous batches.
          const index = formatIndexForPrompt(buildKnowledgeIndex());
          const res = await createNotesFromBatch(db, batch, index);
          if (!res.ok) throw new Error(res.error ?? "agent run failed");
          for (const file of batch) {
            markFileAsProcessed(file.path, state);
            clearSourceFailure(state, file.path);
          }
          saveState(state);
          invalidateKnowledgeIndex();
          await commitKnowledge("Knowledge update").catch((e) =>
            console.error("[knowledge-git] commit failed:", e),
          );
          outcome.processed += batch.length;
        } catch (error) {
          outcome.errors++;
          console.error(`[graph] error processing batch:`, error);
          // Failed files stay unprocessed and retry next tick — but each
          // failure is counted, and repeat offenders get quarantined above.
          for (const file of batch) recordSourceFailure(state, file.path);
          saveState(state);
        }
      }
    }

    if (outcome.processed > 0) {
      const state2 = loadState();
      state2.lastBuildTime = new Date().toISOString();
      saveState(state2);
    }
    return outcome;
  } finally {
    building = false;
  }
}

// ── Curation ("gardener") pass ───────────────────────────────────────────────
// note_creation only appends; without periodic consolidation, notes bloat and
// rot. Daily, rewrite the notes that need it — one at a time. This is the
// graph's compounding loop.

const CURATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CURATION_MAX_NOTES_PER_RUN = 8;
const CURATION_MIN_ACTIVITY_LINES = 8;
// A note can bloat without dated activity lines (huge Key facts / Assistant
// notes sections), so raw size is a second, independent trigger.
const CURATION_MIN_NOTE_CHARS = 7000;
const CURATION_MIN_AGENT_NOTE_CHARS = 2500;
const CURATION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

interface CurationCandidate {
  path: string;
  activityCount: number;
  size: number;
  kind: "entity" | "agent-notes";
}

function countActivityEntries(content: string): number {
  const matches = content.match(/^-?\s*\*\*\d{4}-\d{2}(-\d{2})?\*\*/gm);
  return matches ? matches.length : 0;
}

function parseCuratedAt(content: string): Date | null {
  const m = content.match(/^curated_at:\s*"?([^"\n]+)"?\s*$/m);
  if (!m) return null;
  const d = new Date(m[1].trim());
  return isNaN(d.getTime()) ? null : d;
}

function coolingDown(content: string, mtime: Date): boolean {
  const curatedAt = parseCuratedAt(content);
  if (!curatedAt) return false;
  const modifiedSinceCuration = mtime.getTime() > curatedAt.getTime();
  const cooledDown = Date.now() - curatedAt.getTime() > CURATION_COOLDOWN_MS;
  return !modifiedSinceCuration || !cooledDown;
}

function findCurationCandidates(): CurationCandidate[] {
  const candidates: CurationCandidate[] = [];
  for (const folder of ENTITY_FOLDERS) {
    const dir = path.join(knowledgeDir(), folder);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const filePath = path.join(dir, entry);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        const content = fs.readFileSync(filePath, "utf-8");
        const activityCount = countActivityEntries(content);
        if (activityCount < CURATION_MIN_ACTIVITY_LINES && content.length < CURATION_MIN_NOTE_CHARS)
          continue;
        if (coolingDown(content, stat.mtime)) continue;
        candidates.push({ path: filePath, activityCount, size: content.length, kind: "entity" });
      } catch {
        // unreadable note — skip
      }
    }
  }

  // Agent Notes accumulate too (preferences.md, topical preference files).
  // style/* has its own strict merge contract, inbox.md is a queue, and
  // user.md's timestamp-refresh semantics belong to the agent-notes agent —
  // all three stay out of curation.
  try {
    const dir = agentNotesDir();
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".md") || entry === "inbox.md" || entry === "user.md") continue;
      const filePath = path.join(dir, entry);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        const content = fs.readFileSync(filePath, "utf-8");
        if (content.length < CURATION_MIN_AGENT_NOTE_CHARS) continue;
        if (coolingDown(content, stat.mtime)) continue;
        candidates.push({ path: filePath, activityCount: 0, size: content.length, kind: "agent-notes" });
      } catch {
        // unreadable — skip
      }
    }
  } catch {
    // no Agent Notes dir yet
  }

  candidates.sort((a, b) => b.activityCount * 400 + b.size - (a.activityCount * 400 + a.size));
  return candidates.slice(0, CURATION_MAX_NOTES_PER_RUN);
}

const AGENT_NOTES_CURATION_ADDENDUM = `**This is an assistant-notes file (learned preferences/rules about the user), not an entity dossier — the entity template rules do not apply.** Curate it as a preference list: deduplicate (same rule worded differently → keep the clearest phrasing), group related preferences under short headers, drop only rules that are clearly superseded by a newer contradicting one (keep the newer, note "(previously: …)"), and keep every still-relevant preference verbatim in meaning. No entity sections, no Activity log.`;

export async function curateNotes(db: Db): Promise<void> {
  const state = loadState();
  const last = state.lastCurationTime ? new Date(state.lastCurationTime).getTime() : 0;
  if (Date.now() - last < CURATION_INTERVAL_MS) return;

  const candidates = findCurationCandidates();
  // Stamp the attempt time even when there is nothing to do, so we only scan daily.
  state.lastCurationTime = new Date().toISOString();
  saveState(state);
  if (candidates.length === 0) {
    console.log("[graph] curation: no notes need consolidation");
    return;
  }

  console.log(`[graph] curation: consolidating ${candidates.length} note(s)`);
  for (const candidate of candidates) {
    const relPath = path.relative(amiHome(), candidate.path);
    const knowledgeRel = path.relative(knowledgeDir(), candidate.path).split(path.sep).join("/");
    try {
      const content = fs.readFileSync(candidate.path, "utf-8");
      let message = buildOwnerBlock(db);
      message += `\n---\n\n`;
      message += `Curate the following knowledge note per your instructions. Rewrite it in place with a single Write to the SAME path.\n\n`;
      if (candidate.kind === "agent-notes") message += AGENT_NOTES_CURATION_ADDENDUM + `\n\n`;
      const lintIssues = lintNote(knowledgeRel);
      if (lintIssues.length > 0) {
        message += `**Integrity issues detected in this note (fix them during the rewrite):**\n${lintIssues
          .map((i) => `- ${i.issue}`)
          .join("\n")}\n\n`;
      }
      message += `**Note path:** ${relPath}\n\n`;
      message += `**Current content:**\n\n${content}\n`;
      const res = await runKnowledgeAgent(db, {
        systemPrompt: noteCurationPrompt(),
        message,
        useCase: "note_curation",
        maxTurns: 20,
      });
      if (!res.ok) throw new Error(res.error ?? "curation agent failed");
      invalidateKnowledgeIndex();
    } catch (error) {
      console.error(`[graph] curation failed for ${relPath}:`, error);
    }
  }
  await commitKnowledge("Knowledge curation").catch((e) =>
    console.error("[knowledge-git] commit failed:", e),
  );

  // Same daily cadence: flag dormant notes as archived, then resolve up to a
  // couple of suspected duplicate entity pairs.
  try {
    const archived = archiveStaleNotes();
    if (archived > 0) {
      console.log(`[graph] archived ${archived} dormant note(s)`);
      invalidateKnowledgeIndex();
      await commitKnowledge("Archived dormant notes").catch(() => {});
    }
  } catch (e) {
    console.error("[graph] archive pass failed:", e);
  }
  try {
    const dedupe = await runDedupePass(db);
    if (dedupe.merged + dedupe.distinct > 0) {
      console.log(`[graph] dedupe: ${dedupe.merged} merged, ${dedupe.distinct} confirmed distinct`);
    }
  } catch (e) {
    console.error("[graph] dedupe pass failed:", e);
  }
}

// ── Archive pass ─────────────────────────────────────────────────────────────
// Completed/cancelled projects and stale people/orgs accumulate forever and
// crowd the prompt index. Archiving is a frontmatter flag, not a file move —
// [[wiki-links]] keep resolving, search still finds the note (demoted), but
// the prompt index compacts it to one line. Deterministic and reversible.

const ARCHIVE_AFTER_MS = 60 * 24 * 60 * 60 * 1000;
const ARCHIVABLE_PROJECT_STATUS = /^\s*\*\*Status:\*\*\s*(completed|cancelled|complete|done|shipped)\b/im;
const STALE_FRONTMATTER = /^status:\s*"?stale"?\s*$/m;

function setFrontmatterFlag(content: string, key: string, value: string): string {
  if (content.startsWith("---")) {
    const end = content.indexOf("\n---", 3);
    if (end !== -1) {
      const fm = content.slice(0, end);
      if (new RegExp(`^${key}:`, "m").test(fm)) {
        return content.replace(new RegExp(`^${key}:.*$`, "m"), `${key}: ${value}`);
      }
      return `${fm}\n${key}: ${value}${content.slice(end)}`;
    }
  }
  return `---\n${key}: ${value}\n---\n\n${content}`;
}

export function archiveStaleNotes(): number {
  let archived = 0;
  for (const folder of ENTITY_FOLDERS) {
    const dir = path.join(knowledgeDir(), folder);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const filePath = path.join(dir, entry);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || Date.now() - stat.mtime.getTime() < ARCHIVE_AFTER_MS) continue;
        const content = fs.readFileSync(filePath, "utf-8");
        if (/^archived:\s*true\s*$/m.test(content.slice(0, 500))) continue;
        const dormant =
          folder === "Projects"
            ? ARCHIVABLE_PROJECT_STATUS.test(content)
            : STALE_FRONTMATTER.test(content.slice(0, 500));
        if (!dormant) continue;
        fs.writeFileSync(filePath, setFrontmatterFlag(content, "archived", "true"), "utf-8");
        archived++;
      } catch {
        // unreadable — skip
      }
    }
  }
  return archived;
}

export function resetGraphState(): void {
  resetState();
}
