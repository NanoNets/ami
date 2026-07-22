import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ami-mem-"));
  process.env.AMI_HOME = home;
});

async function mem() {
  const m = await import("../src/index.js");
  m.invalidateKnowledgeIndex();
  return m;
}

function writeNote(rel: string, content: string) {
  const abs = path.join(home, "knowledge", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("file-based knowledge memory", () => {
  it("indexes notes by folder and finds them by name/content", async () => {
    const m = await mem();
    writeNote(
      "People/Sarah Chen.md",
      "# Sarah Chen\n\n## Info\n**Email:** sarah@acme.com\n**Organization:** [[Organizations/Acme Corp]]\n**Aliases:** Sarah\n\n## Summary\nVP Eng at Acme, we're discussing the pilot.\n",
    );
    writeNote("Projects/Acme Pilot.md", "# Acme Pilot\n\n## Info\n**Status:** active\n\n## Summary\nWebsite logo ticker integration pilot.\n");
    const index = m.buildKnowledgeIndex();
    expect(index.people).toHaveLength(1);
    expect(index.people[0].email).toBe("sarah@acme.com");
    expect(index.projects[0].status).toBe("active");

    const hits = m.searchKnowledge("logo ticker website");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].file).toContain("Acme Pilot");
  });

  it("builds the brain graph from wiki-links (meetings excluded)", async () => {
    const m = await mem();
    writeNote("People/Sarah Chen.md", "# Sarah Chen\n\nWorks at [[Organizations/Acme Corp]].\n");
    writeNote("Organizations/Acme Corp.md", "# Acme Corp\n\n## People\n- [[People/Sarah Chen]] — VP Eng\n");
    writeNote("Meetings/granola/2026-07-13 Sync.md", "# Meeting: Sync\n\nWith [[People/Sarah Chen]].\n");
    const g = m.exportBrainGraph();
    expect(g.nodes).toHaveLength(2); // meeting notes aren't graph nodes
    expect(g.links).toHaveLength(1); // deduped bidirectional link
    const sarah = g.nodes.find((n) => n.label === "Sarah Chen")!;
    expect(sarah.group).toBe("People");
    expect(sarah.degree).toBe(1);
    // …but meetings are still searchable/readable.
    expect(m.searchKnowledge("sync meeting").some((h) => h.file.includes("Meetings"))).toBe(true);
  });

  it("memoryContextBlock returns full dossiers for matches", async () => {
    const m = await mem();
    writeNote(
      "Topics/Logo Ticker.md",
      "# Logo Ticker\n\n**Keywords:** logos, ticker, website\n\n## Key facts\n- (2026-07-01) Lives in LogoTicker.tsx; brand SVGs in public/brand/customers/.\n",
    );
    const block = m.memoryContextBlock("add logo to the ticker");
    expect(block).toContain("LogoTicker.tsx");
  });

  it("graph state detects changed files via mtime+hash", async () => {
    const m = await mem();
    const src = path.join(home, "knowledge_sources", "slack", "growth");
    fs.mkdirSync(src, { recursive: true });
    const f = path.join(src, "123.md");
    fs.writeFileSync(f, "# Slack message\n\nhello");
    const state = m.loadState();
    expect(m.getFilesToProcess(path.join(home, "knowledge_sources"), state)).toContain(f);
    m.markFileAsProcessed(f, state);
    expect(m.getFilesToProcess(path.join(home, "knowledge_sources"), state)).toHaveLength(0);
    fs.writeFileSync(f, "# Slack message\n\nhello again");
    // The mtime fast-path only notices when the timestamp moves; force it
    // forward so the test doesn't depend on sub-ms write timing.
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(f, future, future);
    expect(m.getFilesToProcess(path.join(home, "knowledge_sources"), state)).toContain(f);
  });

  it("gmail artifacts accumulate thread messages and reply-gate needs ### From", async () => {
    const m = await mem();
    const base = {
      id: "sig1",
      connector: "gmail",
      externalId: "m1",
      kind: "email",
      title: "Pilot pricing",
      body: "Can you share pricing?",
      author: "Sarah Chen <sarah@acme.com>",
      url: null,
      threadRef: "t1",
      rawJson: null,
      receivedAt: new Date().toISOString(),
    };
    const p1 = m.writeSignalArtifact(base)!;
    expect(fs.readFileSync(p1, "utf-8")).toContain("### From: Sarah Chen");
    const p2 = m.writeSignalArtifact({ ...base, externalId: "m2", body: "Bumping this." });
    expect(p2).toBe(p1);
    expect(fs.readFileSync(p1, "utf-8").match(/### From:/g)).toHaveLength(2);
    // Same message again → no rewrite
    expect(m.writeSignalArtifact({ ...base, externalId: "m2" })).toBeNull();
  });
});
