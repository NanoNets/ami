import fs from "node:fs";
import path from "node:path";
import { knowledgeDir } from "./paths.js";

/** Brain graph: nodes are notes, edges are [[wiki-links]] between them. */

export interface BrainGraph {
  nodes: { id: string; label: string; group: string; degree: number }[];
  links: { source: string; target: string }[];
}

const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

function scanNotes(dir: string, root: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) files.push(...scanNotes(fullPath, root));
    else if (stat.isFile() && entry.endsWith(".md")) files.push(path.relative(root, fullPath));
  }
  return files;
}

/** Resolve a wiki-link target to a knowledge-relative note path. */
function toNotePath(rawTarget: string, nodeSet: Set<string>, byName: Map<string, string>): string | null {
  const target = rawTarget.trim();
  if (!target) return null;
  const withExt = target.endsWith(".md") ? target : `${target}.md`;
  if (nodeSet.has(withExt)) return withExt;
  // Bare name without folder — resolve by filename.
  const base = path.basename(withExt).toLowerCase();
  return byName.get(base) ?? null;
}

export function exportBrainGraph(): BrainGraph {
  const root = knowledgeDir();
  // Meetings (transcripts + prep briefs) would swamp the graph — entity notes
  // link to them, but they aren't nodes.
  const files = scanNotes(root, root).filter((f) => !f.startsWith(`Meetings${path.sep}`));
  const nodeSet = new Set(files);
  const byName = new Map<string, string>();
  for (const f of files) byName.set(path.basename(f).toLowerCase(), f);

  const links: { source: string; target: string }[] = [];
  const edgeKeys = new Set<string>();
  const labels = new Map<string, string>();

  for (const file of files) {
    let content = "";
    try {
      content = fs.readFileSync(path.join(root, file), "utf-8");
    } catch {
      continue;
    }
    const h1 = content.match(/^#\s+(.+?)$/m);
    labels.set(file, h1 ? h1[1].trim() : path.basename(file, ".md"));

    for (const match of content.matchAll(WIKI_LINK_RE)) {
      const targetPath = toNotePath(match[1], nodeSet, byName);
      if (!targetPath || targetPath === file) continue;
      const edgeKey = file < targetPath ? `${file}|${targetPath}` : `${targetPath}|${file}`;
      if (edgeKeys.has(edgeKey)) continue;
      edgeKeys.add(edgeKey);
      links.push({ source: file, target: targetPath });
    }
  }

  const degree = new Map<string, number>();
  for (const e of links) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const nodes = files.map((file) => {
    const parts = file.split(path.sep);
    return {
      id: file,
      label: labels.get(file) ?? file,
      group: parts.length <= 1 ? "root" : parts[0],
      degree: degree.get(file) ?? 0,
    };
  });

  return { nodes, links };
}
