import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ami-git-"));
  process.env.AMI_HOME = home;
});

function writeNote(rel: string, content: string) {
  const abs = path.join(home, "knowledge", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("knowledge version history", () => {
  it("commits, tracks per-note history, and restores", async () => {
    const vh = await import("../src/version-history.js");
    writeNote("People/Sarah.md", "# Sarah\n\nv1\n");
    await vh.initKnowledgeRepo();

    writeNote("People/Sarah.md", "# Sarah\n\nv2 (curated)\n");
    writeNote("Topics/Other.md", "# Other\n\nunrelated\n");
    expect(await vh.commitKnowledge("Knowledge curation")).toBe(true);
    expect(await vh.commitKnowledge("no-op")).toBe(false); // clean tree

    const history = await vh.getNoteHistory("People/Sarah.md");
    expect(history.length).toBe(2); // initial snapshot + curation
    expect(history[0].message).toBe("Knowledge curation");

    const old = await vh.getNoteAtCommit("People/Sarah.md", history[1].oid);
    expect(old).toContain("v1");

    // Restore v1; file content reverts and the restore itself is committed.
    expect(await vh.restoreNote("People/Sarah.md", history[1].oid)).toBe(true);
    expect(fs.readFileSync(path.join(home, "knowledge/People/Sarah.md"), "utf-8")).toContain("v1");
    const after = await vh.getNoteHistory("People/Sarah.md");
    expect(after[0].message).toContain("Restored");

    // Unrelated note has its own single-change history (init commit predates it).
    const other = await vh.getNoteHistory("Topics/Other.md");
    expect(other.length).toBe(1);
  });
});
