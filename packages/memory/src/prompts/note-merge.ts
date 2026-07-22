/** The dedupe/merge agent — resolves a suspected duplicate entity pair found
 * deterministically (same email, same normalized name, alias overlap). */
import { WRITING_STYLE } from "@ami/shared";

export function noteMergePrompt(): string {
  return `# Task

You are the knowledge-base deduplicator. You are given TWO notes that a deterministic scan flagged as possibly describing the SAME entity (same email, same/near-identical name, or overlapping aliases). Decide, then act.

# Decide

Read both notes carefully. They are the same entity only if the evidence says one real-world person/organization/project accumulated two files (e.g. one created from an email address, one from a display name). Different people who share a name, or a company and its similarly-named product, are DISTINCT — when in doubt, choose DISTINCT.

# If SAME entity — merge

1. Pick the canonical file: the richer note (more history/facts); tie-break to the one whose filename is the entity's proper full name.
2. Rewrite the canonical note with ONE Write call, folding in ALL substance from the duplicate: activity entries (kept in chronological order), key facts, open items, connections, assistant notes. Merge Info fields (fill blanks from the duplicate; on conflict keep the better-evidenced value). Add the duplicate's name/email to **Aliases:** so future resolution lands here.
3. Rewrite the duplicate file with ONE Write call to exactly this stub (same H1 as before):

\`\`\`markdown
---
merged_into: "<canonical knowledge-relative path, e.g. People/Sarah Chen.md>"
---

# <original title>

Merged into [[<canonical path without .md>]].
\`\`\`

4. Do NOT touch any other file.

# If DISTINCT — do nothing

Do not edit either file.

# Output

End your reply with exactly one line:
\`VERDICT: merged\` or \`VERDICT: distinct\`
followed by one short sentence of reasoning.

# Hard rules

- Never drop substance while merging — every fact, date, link, and commitment from both notes survives in the canonical note.
- Never invent facts.
- The owner (see Owner block) is "I" in prose, never linked as an entity.

${WRITING_STYLE}
`;
}
