import fs from "node:fs";
import path from "node:path";
import { configDir } from "./paths.js";

/** Note templates for the canonical entity folders.
 * Seeded to ~/.ami/config/notes.json so the user can customize them. */

export interface NoteTypeDefinition {
  type: string;
  folder: string;
  template: string;
  extractionGuide: string;
}

const DEFAULT_NOTE_TYPE_DEFINITIONS: NoteTypeDefinition[] = [
  {
    type: "People",
    folder: "People",
    template: `# {Full Name}

## Info
**Role:** {role, or inferred role with qualifier, or leave blank if truly unknown}
**Organization:** [[Organizations/{organization}]] or leave blank
**Email:** {email or leave blank}
**Aliases:** {comma-separated: first name, nicknames, email}
**First met:** {YYYY-MM-DD}
**Last update:** {YYYY-MM-DD}

## Summary
{2-3 sentences: Who they are, whether I know them through an ongoing relationship or met them in a specific encounter, and what we're discussing or working on together if applicable.}

## Connected to
- [[Organizations/{Organization}]] — works at
- [[People/{Person}]] — {colleague, introduced by, reports to}
- [[Projects/{Project}]] — {role}

## Activity
- **{YYYY-MM-DD}** ({slack|email|meeting|github|other}): {Summary with [[Folder/Name]] links}

## Key facts
{Substantive facts only. Leave empty if none.}

## Open items
{Commitments and next steps only. Leave empty if none.}

## Assistant notes
- [{ISO_TIMESTAMP}] {One concise assistant-facing observation about this person.}`,
    extractionGuide: "Look for: name, role, organization, email, aliases, relationship context",
  },
  {
    type: "Organizations",
    folder: "Organizations",
    template: `# {Organization Name}

## Info
**Type:** {company|team|institution|other}
**Industry:** {industry or leave blank}
**Relationship:** {customer|prospect|partner|competitor|vendor|other}
**Domain:** {primary email domain}
**Aliases:** {comma-separated: short names, abbreviations}
**First met:** {YYYY-MM-DD}
**Last update:** {YYYY-MM-DD}

## Summary
{2-3 sentences: What this org is, how I know or work with them.}

## People
- [[People/{Person}]] — {role}

## Contacts
{For transactional contacts who don't get their own notes}

## Projects
- [[Projects/{Project}]] — {relationship}

## Activity
- **{YYYY-MM-DD}** ({slack|email|meeting|github|other}): {Summary with [[Folder/Name]] links}

## Key facts
{Substantive facts only. Leave empty if none.}

## Open items
{Commitments and next steps only. Leave empty if none.}

## Assistant notes
- [{ISO_TIMESTAMP}] {One concise assistant-facing observation about this organization.}`,
    extractionGuide:
      "Look for: organization name, type, industry, relationship, domain, key people, projects",
  },
  {
    type: "Projects",
    folder: "Projects",
    template: `# {Project Name}

## Info
**Type:** {deal|product|initiative|hiring|other}
**Status:** {active|planning|on hold|completed|cancelled}
**Started:** {YYYY-MM-DD or leave blank}
**Last update:** {YYYY-MM-DD}

## Summary
{2-3 sentences: What this project is, the goal, current state, and my/our involvement where relevant.}

## People
- [[People/{Person}]] — {role}

## Organizations
- [[Organizations/{Org}]] — {customer|partner|etc.}

## Related
- [[Topics/{Topic}]] — {relationship}
- [[Projects/{Project}]] — {relationship}

## Timeline
**{YYYY-MM-DD}** ({slack|email|meeting|github})
{What happened.}

## Decisions
- **{YYYY-MM-DD}**: {Decision}. {Rationale}.

## Open items
{Commitments and next steps only. Leave empty if none.}

## Key facts
{Substantive facts only. Leave empty if none.}

## Assistant notes
- [{ISO_TIMESTAMP}] {One concise assistant-facing observation about this project.}`,
    extractionGuide:
      "Look for: project name, type, status, people involved, organizations, timeline, decisions",
  },
  {
    type: "Topics",
    folder: "Topics",
    template: `# {Topic Name}

## About
{1-2 sentences: What this topic covers.}

**Keywords:** {comma-separated}
**Aliases:** {other ways this topic is referenced}
**First mentioned:** {YYYY-MM-DD}
**Last update:** {YYYY-MM-DD}

## Related
- [[People/{Person}]] — {relationship}
- [[Organizations/{Org}]] — {relationship}
- [[Projects/{Project}]] — {relationship}

## Log
**{YYYY-MM-DD}** ({slack|email|meeting}: {title})
{Summary with [[Folder/Name]] links}

## Decisions
- **{YYYY-MM-DD}**: {Decision}

## Open items
{Commitments and next steps only. Leave empty if none.}

## Key facts
{Substantive facts only. Leave empty if none.}

## Assistant notes
- [{ISO_TIMESTAMP}] {One concise assistant-facing observation about this topic.}`,
    extractionGuide: "Look for: topic name, keywords, related people/orgs/projects, decisions, key facts",
  },
];

let cachedNoteTypeDefinitions: NoteTypeDefinition[] | null = null;
let cachedMtimeMs: number | null = null;

function notesConfigPath(): string {
  return path.join(configDir(), "notes.json");
}

function ensureNotesConfigSync(): void {
  if (!fs.existsSync(notesConfigPath())) {
    fs.writeFileSync(notesConfigPath(), JSON.stringify(DEFAULT_NOTE_TYPE_DEFINITIONS, null, 2) + "\n", "utf8");
  }
}

export function getNoteTypeDefinitions(): NoteTypeDefinition[] {
  ensureNotesConfigSync();
  try {
    const stats = fs.statSync(notesConfigPath());
    if (cachedNoteTypeDefinitions && cachedMtimeMs === stats.mtimeMs) return cachedNoteTypeDefinitions;
    cachedNoteTypeDefinitions = JSON.parse(fs.readFileSync(notesConfigPath(), "utf8"));
    cachedMtimeMs = stats.mtimeMs;
    return cachedNoteTypeDefinitions!;
  } catch {
    cachedNoteTypeDefinitions = null;
    cachedMtimeMs = null;
    return DEFAULT_NOTE_TYPE_DEFINITIONS;
  }
}

export function renderNoteTypesBlock(): string {
  const sections = getNoteTypeDefinitions().map((d) => `## ${d.type}\n\`\`\`markdown\n${d.template}\n\`\`\``);
  return `# Note Templates\n\n${sections.join("\n\n")}`;
}
