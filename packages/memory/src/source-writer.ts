import fs from "node:fs";
import path from "node:path";
import { sourcesDir, safeSegment } from "./paths.js";

/** Write a polled signal as a markdown source artifact under
 * ~/.ami/knowledge_sources/<connector>/… for the graph builder to consume. Returns the file
 * path, or null when nothing new was written. */

export interface SignalLike {
  id: string;
  connector: string;
  externalId: string;
  kind: string;
  title: string;
  body: string;
  author: string;
  url: string | null;
  threadRef: string | null;
  rawJson: string | null;
  receivedAt: string;
}

function frontmatter(fields: Record<string, string | string[] | Record<string, string[]> | undefined>): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else if (typeof v === "object") {
      lines.push(`${k}:`);
      for (const [k2, arr] of Object.entries(v)) {
        if (arr.length === 0) {
          lines.push(`  ${k2}: []`);
        } else {
          lines.push(`  ${k2}:`);
          for (const item of arr) lines.push(`    - ${item}`);
        }
      }
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

function writeIfChanged(filePath: string, content: string): string | null {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf-8") === content) return null;
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function slackArtifact(signal: SignalLike): string | null {
  const raw = signal.rawJson ? JSON.parse(signal.rawJson) : {};
  const channelName = raw?.channel?.name ?? signal.title.match(/^#([\w-]+)/)?.[1] ?? "unknown";
  const ts = safeSegment(raw?.ts ?? signal.externalId);
  const filePath = path.join(sourcesDir("slack"), safeSegment(channelName), `${ts}.md`);
  const content =
    frontmatter({
      source: "slack",
      external_id: signal.externalId,
      occurred_at: signal.receivedAt,
      url: signal.url ?? undefined,
    }) +
    [
      `# Slack message in ${channelName}`,
      ``,
      `**Channel:** ${channelName}`,
      `**Author:** ${signal.author}`,
      `**Timestamp:** ${signal.receivedAt}`,
      signal.threadRef ? `**Thread TS:** ${signal.threadRef}` : "",
      signal.url ? `**Link:** ${signal.url}` : "",
      ``,
      `## Message`,
      ``,
      signal.body,
      ``,
    ]
      .filter((l) => l !== "")
      .join("\n") +
    "\n";
  return writeIfChanged(filePath, content);
}

/** Gmail: one file per thread; new messages append a `### From:` section so
 * the Reply Gate can be computed over the whole thread. */
function gmailArtifact(signal: SignalLike, labels?: Record<string, string[]>): string | null {
  const threadId = signal.threadRef ?? signal.externalId;
  const filePath = path.join(sourcesDir("gmail"), `${safeSegment(threadId)}.md`);
  const marker = `<!-- msg:${signal.externalId} -->`;
  const section = [
    marker,
    `### From: ${signal.author}`,
    `### Date: ${signal.receivedAt}`,
    ``,
    signal.body,
    ``,
    `---`,
    ``,
  ].join("\n");

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf-8");
    if (existing.includes(marker)) return null;
    fs.writeFileSync(filePath, existing + "\n" + section, "utf-8");
    return filePath;
  }

  const content =
    frontmatter({
      source: "gmail",
      thread_id: threadId,
      occurred_at: signal.receivedAt,
      url: signal.url ?? undefined,
      labels,
    }) +
    [`# ${signal.title || "(no subject)"}`, ``, `**Thread ID:** ${threadId}`, ``, section].join("\n");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function gcalArtifact(signal: SignalLike): string | null {
  const raw = signal.rawJson ? JSON.parse(signal.rawJson) : {};
  const attendees = (raw?.attendees ?? [])
    .map((a: any) => a.displayName ? `${a.displayName} <${a.email}>` : a.email)
    .filter(Boolean);
  const filePath = path.join(sourcesDir("gcal"), `${safeSegment(signal.externalId)}.md`);
  const content =
    frontmatter({ source: "gcal", external_id: signal.externalId, occurred_at: signal.receivedAt, url: signal.url ?? undefined }) +
    [
      `# ${signal.title || "Calendar event"}`,
      ``,
      `**Organizer:** ${raw?.organizer?.email ?? signal.author}`,
      attendees.length ? `**Attendees:** ${attendees.join(", ")}` : "",
      raw?.start?.dateTime || raw?.start?.date ? `**Starts:** ${raw.start.dateTime ?? raw.start.date}` : "",
      raw?.end?.dateTime || raw?.end?.date ? `**Ends:** ${raw.end.dateTime ?? raw.end.date}` : "",
      signal.url ? `**Link:** ${signal.url}` : "",
      ``,
      signal.body,
      ``,
    ]
      .filter((l) => l !== "")
      .join("\n");
  return writeIfChanged(filePath, content);
}

function genericArtifact(signal: SignalLike): string | null {
  const filePath = path.join(sourcesDir(signal.connector), `${safeSegment(signal.externalId)}.md`);
  const content =
    frontmatter({ source: signal.connector, external_id: signal.externalId, occurred_at: signal.receivedAt, url: signal.url ?? undefined }) +
    [
      `# ${signal.title || `${signal.connector} ${signal.kind}`}`,
      ``,
      signal.author ? `**Author:** ${signal.author}` : "",
      `**Kind:** ${signal.kind}`,
      signal.url ? `**Link:** ${signal.url}` : "",
      ``,
      signal.body,
      ``,
    ]
      .filter((l) => l !== "")
      .join("\n");
  return writeIfChanged(filePath, content);
}

/** Write a standalone bootstrap digest document (sent-mail digest, workspace
 * directory, repo overview) as a graph-builder source. One digest = one agent
 * run, so backfills condense history instead of writing per-message files. */
export function writeSourceDoc(
  connector: string,
  name: string,
  title: string,
  body: string,
): string | null {
  const filePath = path.join(sourcesDir(connector), `${safeSegment(name)}.md`);
  const content =
    frontmatter({
      source: connector,
      external_id: `bootstrap:${name}`,
      occurred_at: new Date().toISOString(),
    }) + `# ${title}\n\n${body.trim()}\n`;
  return writeIfChanged(filePath, content);
}

export function writeSignalArtifact(
  signal: SignalLike,
  opts: { gmailLabels?: Record<string, string[]> } = {},
): string | null {
  try {
    switch (signal.connector) {
      case "slack":
        return slackArtifact(signal);
      case "gmail":
        return gmailArtifact(signal, opts.gmailLabels);
      case "gcal":
        return gcalArtifact(signal);
      default:
        return genericArtifact(signal);
    }
  } catch (e) {
    console.error(`[memory] failed to write source artifact for ${signal.id}:`, e);
    return null;
  }
}
