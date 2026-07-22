import fs from "node:fs";
import path from "node:path";
import { knowledgeDir } from "./paths.js";
import { syncFts } from "./fts.js";

/**
 * Pre-built index of the knowledge base for entity resolution in agent prompts.
 * Parses **Field:** lines from note
 * bodies; folder decides the entry type.
 */

export interface PersonEntry {
  file: string;
  name: string;
  email?: string;
  aliases: string[];
  organization?: string;
  role?: string;
}
export interface OrganizationEntry {
  file: string;
  name: string;
  domain?: string;
  aliases: string[];
}
export interface ProjectEntry {
  file: string;
  name: string;
  status?: string;
  aliases: string[];
}
export interface TopicEntry {
  file: string;
  name: string;
  keywords: string[];
  aliases: string[];
}
export interface OtherEntry {
  file: string;
  name: string;
  folder: string;
  aliases: string[];
}

export interface KnowledgeIndex {
  people: PersonEntry[];
  organizations: OrganizationEntry[];
  projects: ProjectEntry[];
  topics: TopicEntry[];
  other: OtherEntry[];
  /** Notes flagged `archived: true` in frontmatter — still searchable (demoted)
   * but compacted out of the prompt index. */
  archivedFiles: string[];
  buildTime: string;
}

/** Match **Field:** value; only spaces/tabs after the label so empty fields stay undefined. */
function extractField(content: string, fieldName: string): string | undefined {
  const pattern = new RegExp(`\\*\\*${fieldName}:\\*\\*[ \\t]*(.+?)(?:\\r?\\n|$)`, "i");
  const match = content.match(pattern);
  if (match) {
    let value = match[1].trim();
    const linkMatch = value.match(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/);
    if (linkMatch) value = linkMatch[1];
    return value || undefined;
  }
  return undefined;
}

function extractList(content: string, fieldName: string): string[] {
  const value = extractField(content, fieldName);
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+?)$/m);
  return match ? match[1].trim() : "";
}

function frontmatterValue(content: string, key: string): string | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  const m = content.slice(0, end).match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, "m"));
  return m ? m[1].trim() : null;
}

function scanDirectoryRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) files.push(...scanDirectoryRecursive(fullPath));
    else if (stat.isFile() && entry.endsWith(".md")) files.push(fullPath);
  }
  return files;
}

export function buildKnowledgeIndex(): KnowledgeIndex {
  const KNOWLEDGE_DIR = knowledgeDir();
  const index: KnowledgeIndex = {
    people: [],
    organizations: [],
    projects: [],
    topics: [],
    other: [],
    archivedFiles: [],
    buildTime: new Date().toISOString(),
  };

  const allFiles = scanDirectoryRecursive(KNOWLEDGE_DIR);
  syncFts(allFiles.map((abs) => ({ rel: path.relative(KNOWLEDGE_DIR, abs), abs })));

  for (const filePath of allFiles) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const relativePath = path.relative(KNOWLEDGE_DIR, filePath);
      // Dedupe-pass stubs point at the canonical note; they carry no facts of
      // their own, so they stay out of entity resolution and search entirely.
      if (frontmatterValue(content, "merged_into")) continue;
      if (frontmatterValue(content, "archived") === "true") index.archivedFiles.push(relativePath);
      const parts = relativePath.split(path.sep);
      const folder = parts.length <= 1 ? "root" : parts[0];
      const name = extractTitle(content);
      const aliases = extractList(content, "Aliases");

      switch (folder) {
        case "People":
          index.people.push({
            file: relativePath,
            name,
            email: extractField(content, "Email"),
            aliases,
            organization: extractField(content, "Organization"),
            role: extractField(content, "Role"),
          });
          break;
        case "Organizations":
          index.organizations.push({
            file: relativePath,
            name,
            domain: extractField(content, "Domain"),
            aliases,
          });
          break;
        case "Projects":
          index.projects.push({
            file: relativePath,
            name,
            status: extractField(content, "Status"),
            aliases,
          });
          break;
        case "Topics":
          index.topics.push({
            file: relativePath,
            name,
            keywords: extractList(content, "Keywords"),
            aliases,
          });
          break;
        default:
          index.other.push({ file: relativePath, name, folder, aliases });
          break;
      }
    } catch (error) {
      console.error(`[memory] error parsing note ${filePath}:`, error);
    }
  }

  return index;
}

// Cached access. The knowledge dir is written by several actors (graph
// builder, curation, chat/task runs with plain file tools), so in-process
// invalidation alone goes stale — a cheap on-disk signature (file set +
// mtimes + sizes) is checked instead, throttled to once per few seconds.
let cachedIndex: KnowledgeIndex | null = null;
let cachedSignature: string | null = null;
let lastSignatureCheck = 0;
const SIGNATURE_CHECK_MS = 5_000;

function dirSignature(): string {
  const root = knowledgeDir();
  let count = 0;
  let mtimeSum = 0;
  let sizeSum = 0;
  for (const file of scanDirectoryRecursive(root)) {
    try {
      const stat = fs.statSync(file);
      count++;
      mtimeSum += stat.mtimeMs;
      sizeSum += stat.size;
    } catch {
      // racing a delete — the next check settles it
    }
  }
  return `${count}:${mtimeSum}:${sizeSum}`;
}

export function getKnowledgeIndex(): KnowledgeIndex {
  const now = Date.now();
  if (cachedIndex && now - lastSignatureCheck < SIGNATURE_CHECK_MS) return cachedIndex;
  lastSignatureCheck = now;
  const signature = dirSignature();
  if (!cachedIndex || signature !== cachedSignature) {
    cachedIndex = buildKnowledgeIndex();
    cachedSignature = signature;
  }
  return cachedIndex;
}

export function invalidateKnowledgeIndex(): void {
  cachedIndex = null;
  cachedSignature = null;
  lastSignatureCheck = 0;
}

export function formatIndexForPrompt(fullIndex: KnowledgeIndex): string {
  // Archived notes are compacted to one line each at the end — they must not
  // occupy prompt space or attract new links, but the agent should still know
  // they exist so it doesn't create a duplicate.
  const archived = new Set(fullIndex.archivedFiles);
  const index: KnowledgeIndex = {
    ...fullIndex,
    people: fullIndex.people.filter((e) => !archived.has(e.file)),
    organizations: fullIndex.organizations.filter((e) => !archived.has(e.file)),
    projects: fullIndex.projects.filter((e) => !archived.has(e.file)),
    topics: fullIndex.topics.filter((e) => !archived.has(e.file)),
    other: fullIndex.other.filter((e) => !archived.has(e.file)),
  };

  let output = "# Existing Knowledge Base Index\n\n";
  output += `Built at: ${index.buildTime}\n\n`;

  output += "## People\n\n";
  if (index.people.length === 0) {
    output += "_No people notes yet_\n\n";
  } else {
    output += "| File | Name | Email | Organization | Aliases |\n";
    output += "|------|------|-------|--------------|--------|\n";
    for (const p of index.people) {
      output += `| ${p.file} | ${p.name} | ${p.email || "-"} | ${p.organization || "-"} | ${p.aliases.join(", ") || "-"} |\n`;
    }
    output += "\n";
  }

  output += "## Organizations\n\n";
  if (index.organizations.length === 0) {
    output += "_No organization notes yet_\n\n";
  } else {
    output += "| File | Name | Domain | Aliases |\n|------|------|--------|--------|\n";
    for (const o of index.organizations) {
      output += `| ${o.file} | ${o.name} | ${o.domain || "-"} | ${o.aliases.join(", ") || "-"} |\n`;
    }
    output += "\n";
  }

  output += "## Projects\n\n";
  if (index.projects.length === 0) {
    output += "_No project notes yet_\n\n";
  } else {
    output += "| File | Name | Status | Aliases |\n|------|------|--------|--------|\n";
    for (const p of index.projects) {
      output += `| ${p.file} | ${p.name} | ${p.status || "-"} | ${p.aliases.join(", ") || "-"} |\n`;
    }
    output += "\n";
  }

  output += "## Topics\n\n";
  if (index.topics.length === 0) {
    output += "_No topic notes yet_\n\n";
  } else {
    output += "| File | Name | Keywords | Aliases |\n|------|------|----------|--------|\n";
    for (const t of index.topics) {
      output += `| ${t.file} | ${t.name} | ${t.keywords.join(", ") || "-"} | ${t.aliases.join(", ") || "-"} |\n`;
    }
    output += "\n";
  }

  if (index.other.length > 0) {
    output += "## Other Notes\n\n| File | Name | Folder | Aliases |\n|------|------|--------|--------|\n";
    for (const n of index.other) {
      output += `| ${n.file} | ${n.name} | ${n.folder} | ${n.aliases.join(", ") || "-"} |\n`;
    }
    output += "\n";
  }

  if (fullIndex.archivedFiles.length > 0) {
    output += "## Archived Notes (dormant — update only if the entity clearly becomes active again; never create a duplicate)\n\n";
    for (const file of fullIndex.archivedFiles) output += `- ${file}\n`;
    output += "\n";
  }

  return output;
}
