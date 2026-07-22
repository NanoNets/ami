import fs from "node:fs";
import path from "node:path";
import { knowledgeDir, ENTITY_FOLDERS } from "./paths.js";

/** Deterministic integrity checks over the knowledge base (no LLM). Two
 * failure modes silently degrade the graph: [[wiki-links]] whose target file
 * doesn't exist (broken edges), and entity notes whose title/Info formatting
 * drifted from the template (the knowledge index parses `# Title` and
 * `**Field:**` lines — a malformed note just vanishes from entity
 * resolution). Findings feed the curation agent so rot gets repaired instead
 * of accumulating. */

export interface LintIssue {
  file: string;
  issue: string;
}

const WIKI_LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

function listNoteFiles(root: string): Set<string> {
  const files = new Set<string>();
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      if (entry === ".git") continue;
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (entry.endsWith(".md")) files.add(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return files;
}

/** Lint one note's content against the set of existing note files. */
export function lintNoteContent(relPath: string, content: string, existingFiles: Set<string>): LintIssue[] {
  const issues: LintIssue[] = [];
  const folder = relPath.split("/")[0];

  const broken: string[] = [];
  for (const m of content.matchAll(WIKI_LINK)) {
    const target = m[1].trim();
    if (!target.includes("/")) continue; // relative link — template noise, not resolvable
    if (!existingFiles.has(`${target}.md`)) broken.push(`[[${target}]]`);
  }
  if (broken.length > 0) {
    issues.push({ file: relPath, issue: `broken wiki-links (no such note): ${[...new Set(broken)].join(", ")}` });
  }

  if ((ENTITY_FOLDERS as readonly string[]).includes(folder)) {
    if (!/^#\s+.+$/m.test(content)) {
      issues.push({ file: relPath, issue: "missing `# Title` H1 — the note is invisible to the knowledge index" });
    }
    if (!/\*\*[A-Za-z ]+:\*\*/.test(content)) {
      issues.push({
        file: relPath,
        issue: "no `**Field:**` Info lines — aliases/email/domain can't be indexed for entity resolution",
      });
    }
  }
  return issues;
}

/** Lint the whole knowledge base. */
export function lintKnowledge(): LintIssue[] {
  const root = knowledgeDir();
  const existing = listNoteFiles(root);
  const issues: LintIssue[] = [];
  for (const rel of existing) {
    try {
      const content = fs.readFileSync(path.join(root, rel), "utf-8");
      issues.push(...lintNoteContent(rel, content, existing));
    } catch {
      // unreadable — skip
    }
  }
  return issues;
}

/** Lint a single note by path (used to attach findings to a curation run). */
export function lintNote(relPath: string): LintIssue[] {
  const root = knowledgeDir();
  try {
    const content = fs.readFileSync(path.join(root, relPath), "utf-8");
    return lintNoteContent(relPath.split(path.sep).join("/"), content, listNoteFiles(root));
  } catch {
    return [];
  }
}
