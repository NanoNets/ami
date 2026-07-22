import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ami-maint-"));
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

function ageFile(rel: string, days: number) {
  const abs = path.join(home, "knowledge", rel);
  const past = new Date(Date.now() - days * 86_400_000);
  fs.utimesSync(abs, past, past);
}

describe("lint", () => {
  it("flags broken wiki-links and template drift in entity notes", async () => {
    const m = await mem();
    writeNote("People/Sarah Chen.md", "# Sarah Chen\n\n**Email:** sarah@acme.com\n\nWorks at [[Organizations/Acme Corp]] on [[Projects/Ghost Project]].\n");
    writeNote("Organizations/Acme Corp.md", "# Acme Corp\n\n**Domain:** acme.com\n");
    writeNote("Projects/No Title.md", "Some project prose without a heading or fields.\n");

    const issues = m.lintKnowledge();
    const byFile = (f: string) => issues.filter((i) => i.file === f).map((i) => i.issue);

    expect(byFile("People/Sarah Chen.md").join()).toContain("[[Projects/Ghost Project]]");
    expect(byFile("People/Sarah Chen.md").join()).not.toContain("Acme Corp");
    expect(byFile("Projects/No Title.md").join()).toContain("# Title");
    expect(byFile("Organizations/Acme Corp.md")).toHaveLength(0);
  });
});

describe("dedupe candidates", () => {
  it("finds duplicate people by email and orgs by domain, ignores distinct entities", async () => {
    const m = await mem();
    writeNote("People/Sarah Chen.md", "# Sarah Chen\n\n**Email:** sarah@acme.com\n");
    writeNote("People/sarah acme.md", "# sarah\n\n**Email:** sarah@acme.com\n");
    writeNote("People/Bob Roy.md", "# Bob Roy\n\n**Email:** bob@other.io\n");
    writeNote("Organizations/Acme.md", "# Acme\n\n**Domain:** acme.com\n");
    writeNote("Organizations/Acme Corporation.md", "# Acme Corporation\n\n**Domain:** acme.com\n");

    const pairs = m.findDuplicateCandidates(m.buildKnowledgeIndex());
    const keys = pairs.map((p) => m.pairKey(p.a, p.b));
    expect(keys).toContain(m.pairKey("People/Sarah Chen.md", "People/sarah acme.md"));
    expect(keys).toContain(m.pairKey("Organizations/Acme.md", "Organizations/Acme Corporation.md"));
    expect(keys.some((k) => k.includes("Bob Roy"))).toBe(false);
  });
});

describe("archive pass", () => {
  it("flags dormant completed projects and compacts them out of the prompt index", async () => {
    const m = await mem();
    writeNote("Projects/Old Launch.md", "# Old Launch\n\n**Status:** completed\n\nShipped long ago.\n");
    writeNote("Projects/Live Work.md", "# Live Work\n\n**Status:** active\n\nOngoing.\n");
    writeNote("Projects/Fresh Done.md", "# Fresh Done\n\n**Status:** completed\n\nJust finished.\n");
    ageFile("Projects/Old Launch.md", 90);
    ageFile("Projects/Live Work.md", 90);

    expect(m.archiveStaleNotes()).toBe(1);
    const content = fs.readFileSync(path.join(home, "knowledge", "Projects", "Old Launch.md"), "utf-8");
    expect(content.startsWith("---\narchived: true\n---")).toBe(true);

    m.invalidateKnowledgeIndex();
    const index = m.buildKnowledgeIndex();
    expect(index.archivedFiles).toEqual(["Projects/Old Launch.md"]);
    const prompt = m.formatIndexForPrompt(index);
    expect(prompt).toContain("## Archived Notes");
    expect(prompt.split("## Archived Notes")[0]).not.toContain("Old Launch");
    expect(prompt).toContain("Live Work");
  });

  it("running twice is a no-op", async () => {
    const m = await mem();
    writeNote("Projects/Old Launch.md", "# Old Launch\n\n**Status:** cancelled\n");
    ageFile("Projects/Old Launch.md", 90);
    expect(m.archiveStaleNotes()).toBe(1);
    expect(m.archiveStaleNotes()).toBe(0);
  });
});

describe("merged stubs", () => {
  it("notes with merged_into frontmatter vanish from the index and search", async () => {
    const m = await mem();
    writeNote("People/Sarah Chen.md", "# Sarah Chen\n\n**Email:** sarah@acme.com\n\nVP Eng at Acme.\n");
    writeNote("People/sarah.md", '---\nmerged_into: "People/Sarah Chen.md"\n---\n\n# sarah\n\nMerged into [[People/Sarah Chen]].\n');
    const index = m.buildKnowledgeIndex();
    expect(index.people.map((p) => p.file)).toEqual(["People/Sarah Chen.md"]);
    const hits = m.searchKnowledge("sarah acme");
    expect(hits.some((h) => h.file === "People/sarah.md")).toBe(false);
    expect(hits.some((h) => h.file === "People/Sarah Chen.md")).toBe(true);
  });
});

describe("author-keyed retrieval", () => {
  it("resolves the author's People and Organization notes by email/domain", async () => {
    const m = await mem();
    writeNote("People/Sarah Chen.md", "# Sarah Chen\n\n**Email:** sarah@acme.com\n**Aliases:** Sarah\n");
    writeNote("Organizations/Acme Corp.md", "# Acme Corp\n\n**Domain:** acme.com\n");
    expect(m.entityFilesForAuthor("Sarah Chen <sarah@acme.com>")).toEqual([
      "People/Sarah Chen.md",
      "Organizations/Acme Corp.md",
    ]);
    expect(m.entityFilesForAuthor("nobody@unknown.dev")).toEqual([]);
    // Plain display name (Slack-style author) resolves by exact name.
    expect(m.entityFilesForAuthor("Sarah Chen")).toEqual(["People/Sarah Chen.md"]);
  });

  it("combinedMemoryContext pins author dossiers and dedupes across signals", async () => {
    const m = await mem();
    writeNote("People/Sarah Chen.md", "# Sarah Chen\n\n**Email:** sarah@acme.com\n\nVP Eng at Acme.\n");
    writeNote("Topics/Pilot Pricing.md", "# Pilot Pricing\n\n**Keywords:** pricing, pilot\n\nAgreed on usage-based pricing.\n");
    const block = m.combinedMemoryContext(
      [
        { query: "pilot pricing question", author: "Sarah Chen <sarah@acme.com>" },
        { query: "pricing for the pilot again", author: "Sarah Chen <sarah@acme.com>" },
      ],
      4,
      9000,
    );
    expect(block).toContain("People/Sarah Chen.md");
    expect(block).toContain("Pilot Pricing");
    // The dossier appears once, not once per signal.
    expect(block.match(/--- People\/Sarah Chen\.md ---/g)).toHaveLength(1);
  });
});

describe("source quarantine", () => {
  it("quarantines a source after repeated failures and clears on success", async () => {
    const m = await mem();
    const state = m.loadState();
    m.recordSourceFailure(state, "/x/a.md");
    m.recordSourceFailure(state, "/x/a.md");
    expect(m.isQuarantined(state, "/x/a.md")).toBe(false);
    m.recordSourceFailure(state, "/x/a.md");
    expect(m.isQuarantined(state, "/x/a.md")).toBe(true);
    m.clearSourceFailure(state, "/x/a.md");
    expect(m.isQuarantined(state, "/x/a.md")).toBe(false);
  });
});
