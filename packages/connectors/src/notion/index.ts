import { z } from "zod";
import type { NormalizedSignal } from "@ami/shared";
import type { AmiConnector, ActionResult } from "../types.js";

const API = "https://api.notion.com/v1";

async function notion(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const j: any = await res.json();
  if (!res.ok) throw new Error(`notion ${path}: ${j.message ?? res.status}`);
  return j;
}

/** Convert simple markdown into Notion blocks (headings, bullets, paragraphs). */
export function markdownToBlocks(md: string): any[] {
  const blocks: any[] = [];
  for (const line of md.split("\n")) {
    const rt = (text: string) => [{ type: "text", text: { content: text.slice(0, 2000) } }];
    if (line.startsWith("### ")) {
      blocks.push({ type: "heading_3", heading_3: { rich_text: rt(line.slice(4)) } });
    } else if (line.startsWith("## ")) {
      blocks.push({ type: "heading_2", heading_2: { rich_text: rt(line.slice(3)) } });
    } else if (line.startsWith("# ")) {
      blocks.push({ type: "heading_1", heading_1: { rich_text: rt(line.slice(2)) } });
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      blocks.push({ type: "bulleted_list_item", bulleted_list_item: { rich_text: rt(line.slice(2)) } });
    } else if (line.trim().length > 0) {
      blocks.push({ type: "paragraph", paragraph: { rich_text: rt(line) } });
    }
  }
  return blocks.slice(0, 100);
}

function rtText(rt: any[] | undefined): string {
  return (rt ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? "").join("");
}

/** One Notion block → one markdown line (null = nothing worth rendering). */
function blockToMd(b: any): string | null {
  const t = b.type;
  const d = b[t] ?? {};
  switch (t) {
    case "heading_1": return `# ${rtText(d.rich_text)}`;
    case "heading_2": return `## ${rtText(d.rich_text)}`;
    case "heading_3": return `### ${rtText(d.rich_text)}`;
    case "bulleted_list_item":
    case "toggle": return `- ${rtText(d.rich_text)}`;
    case "numbered_list_item": return `1. ${rtText(d.rich_text)}`;
    case "to_do": return `- [${d.checked ? "x" : " "}] ${rtText(d.rich_text)}`;
    case "quote":
    case "callout": return `> ${rtText(d.rich_text)}`;
    case "code": return "```" + (d.language ?? "") + "\n" + rtText(d.rich_text) + "\n```";
    case "divider": return "---";
    case "table_row": return `| ${(d.cells ?? []).map((c: any[]) => rtText(c)).join(" | ")} |`;
    case "child_page": return `→ child page: ${d.title} (id: ${b.id})`;
    case "child_database": return `→ child database: ${d.title} (id: ${b.id})`;
    case "bookmark": return d.url ?? null;
    case "image": return `[image: ${d.external?.url ?? d.file?.url ?? ""}]`;
    default: {
      const s = rtText(d.rich_text);
      return s || null;
    }
  }
}

async function readBlocks(token: string, blockId: string, depth: number, budget: { left: number }): Promise<string[]> {
  const lines: string[] = [];
  let cursor: string | undefined;
  do {
    const qs = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
    const j = await notion(token, `/blocks/${blockId}/children${qs}`);
    for (const b of j.results ?? []) {
      if (budget.left-- <= 0) return lines;
      const md = blockToMd(b);
      if (md !== null) lines.push("  ".repeat(depth) + md);
      if (b.has_children && b.type !== "child_page" && b.type !== "child_database" && depth < 4) {
        lines.push(...(await readBlocks(token, b.id, depth + 1, budget)));
      }
    }
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return lines;
}

/** Notion user ids are workspace-global UUIDs; resolve once per process so
 * every poll doesn't re-fetch the same handful of editors. */
const userNameCache = new Map<string, string>();
async function userName(token: string, id: string): Promise<string> {
  if (!id) return "";
  const hit = userNameCache.get(id);
  if (hit !== undefined) return hit;
  let name = id;
  try {
    const u = await notion(token, `/users/${id}`);
    name = u.name || id;
  } catch {
    // Guests and removed users aren't resolvable — keep the raw id.
  }
  userNameCache.set(id, name);
  return name;
}

export const notionConnector: AmiConnector = {
  id: "notion",
  meta: {
    label: "Notion",
    authKind: "token",
    authFields: [
      { key: "token", label: "Internal integration secret", placeholder: "ntn_…", secret: true },
    ],
    setupHelp:
      "Create a token at app.notion.com/developers/tokens",
  },
  async validateAuth(auth) {
    try {
      const me = await notion(auth.token, "/users/me");
      return { ok: true, accountLabel: me.name ?? me.bot?.owner?.type ?? "notion" };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
  streams() {
    return [{ name: "updates", intervalSec: 300 }];
  },
  async poll({ auth, cursor }) {
    const since = cursor ?? new Date(Date.now() - 24 * 3600_000).toISOString();
    const j = await notion(auth.token, "/search", {
      method: "POST",
      body: JSON.stringify({
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: 20,
      }),
    });
    const signals: NormalizedSignal[] = [];
    let max = since;
    for (const page of j.results ?? []) {
      const edited = page.last_edited_time;
      if (!edited || edited <= since) continue;
      if (edited > max) max = edited;
      // Skip pages last edited by the integration itself.
      if (page.last_edited_by?.type === "bot") continue;
      const title =
        page.properties?.title?.title?.[0]?.plain_text ??
        page.properties?.Name?.title?.[0]?.plain_text ??
        "(untitled)";
      const author = await userName(auth.token, page.last_edited_by?.id ?? "");
      // Give triage the page itself, not just "something changed": an excerpt
      // of the current content is what lets it tell a spec edit from noise.
      let excerpt = "";
      try {
        const lines = await readBlocks(auth.token, page.id, 0, { left: 60 });
        excerpt = lines.join("\n").slice(0, 2000);
      } catch {
        // Databases and pages the integration can't read have no block children.
      }
      signals.push({
        externalId: `${page.id}:${edited}`,
        kind: "message",
        title: `Notion page updated: ${title}`,
        body:
          `Page "${title}" was edited by ${author || "someone"} at ${edited}.` +
          (excerpt ? `\n\nCurrent page content (excerpt):\n${excerpt}` : ""),
        author,
        url: page.url,
        threadRef: page.id,
        raw: { id: page.id },
        occurredAt: edited,
      });
    }
    return { signals, nextCursor: max };
  },
  async bootstrap(auth, onProgress) {
    // Knowledge: what the workspace has been working on lately — titles and
    // structure of recently edited pages, not full content.
    onProgress?.("reading recently edited pages");
    const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    const j = await notion(auth.token, "/search", {
      method: "POST",
      body: JSON.stringify({
        filter: { property: "object", value: "page" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: 100,
      }),
    });
    const pages = (j.results ?? []).filter((p: any) => (p.last_edited_time ?? "") >= since);
    if (pages.length === 0) return { docs: [], triage: [] };
    const lines = pages.map((p: any) => {
      const title =
        p.properties?.title?.title?.[0]?.plain_text ??
        p.properties?.Name?.title?.[0]?.plain_text ??
        "(untitled)";
      return `- **${title}** — edited ${String(p.last_edited_time).slice(0, 10)} — ${p.url}`;
    });
    return {
      docs: [
        {
          name: "recent-pages",
          title: "Notion: pages edited in the last 30 days",
          body: `Recently active Notion pages (titles reveal current projects and topics):\n\n${lines.join("\n")}`,
        },
      ],
      triage: [],
    };
  },
  actions: [
    {
      name: "notion_search",
      readOnly: true,
      description:
        "Search Notion pages and databases — often the ONLY home of project docs, customer/POC notes, specs and internal wikis, so include it whenever sweeping sources about a customer, project or initiative. Matching is title-only: query the bare entity name ('Schneider', not 'Schneider POC results'), then open results with notion_read_page. Returns ids and URLs.",
      schema: {
        query: z.string(),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const page_size = Math.min(Number(input.limit) || 10, 25);
          const j = await notion(auth.token, "/search", {
            method: "POST",
            body: JSON.stringify({
              query: String(input.query),
              page_size,
              sort: { direction: "descending", timestamp: "last_edited_time" },
            }),
          });
          const results = (j.results ?? []).map((p: any) => ({
            id: p.id,
            object: p.object,
            title:
              p.properties?.title?.title?.[0]?.plain_text ??
              p.properties?.Name?.title?.[0]?.plain_text ??
              p.title?.[0]?.plain_text ??
              "(untitled)",
            lastEdited: p.last_edited_time,
            url: p.url,
          }));
          return { ok: true, output: results };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "notion_read_page",
      readOnly: true,
      description:
        "Read the full content of a Notion page as markdown — THE way to open anything notion_search returns. Pass the page id (or full Notion URL). For a database id it lists the rows (title + id) so each row can be read as a page.",
      schema: {
        pageId: z.string().describe("Page id or full Notion URL, e.g. from notion_search results"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const m = String(input.pageId).replace(/-/g, "").match(/[0-9a-f]{32}/i);
          if (!m) return { ok: false, output: null, error: "no Notion page id found in input" };
          const id = m[0].replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
          let page: any;
          try {
            page = await notion(auth.token, `/pages/${id}`);
          } catch {
            // Not a page — maybe a database: list its rows so the model can read them as pages.
            const db = await notion(auth.token, `/databases/${id}`);
            const rows = await notion(auth.token, `/databases/${id}/query`, {
              method: "POST",
              body: JSON.stringify({ page_size: 50 }),
            });
            const list = (rows.results ?? []).map((r: any) => {
              const titleProp: any = Object.values(r.properties ?? {}).find((p: any) => p.type === "title");
              return { id: r.id, title: rtText(titleProp?.title) || "(untitled)", lastEdited: r.last_edited_time };
            });
            return {
              ok: true,
              url: db.url,
              output: { id, kind: "database", title: rtText(db.title) || "(untitled)", url: db.url, rows: list },
            };
          }
          const titleProp: any = Object.values(page.properties ?? {}).find((p: any) => p.type === "title");
          const title = rtText(titleProp?.title) || "(untitled)";
          const lines = await readBlocks(auth.token, id, 0, { left: 500 });
          let content = lines.join("\n");
          const CAP = 100_000;
          const truncated = content.length > CAP;
          if (truncated) content = content.slice(0, CAP) + "\n\n[content truncated]";
          return {
            ok: true,
            url: page.url,
            output: { id, title, url: page.url, lastEdited: page.last_edited_time, truncated, content: `# ${title}\n\n${content}` },
          };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "notion_create_page",
      description:
        "Create a Notion page from markdown content. parentPageId is optional; without it the page is created in the workspace root the integration can access.",
      schema: {
        title: z.string(),
        markdown: z.string(),
        parentPageId: z.string().optional(),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          let parent: any;
          if (input.parentPageId) {
            parent = { page_id: input.parentPageId };
          } else {
            const s = await notion(auth.token, "/search", {
              method: "POST",
              body: JSON.stringify({ filter: { property: "object", value: "page" }, page_size: 1 }),
            });
            const first = s.results?.[0];
            if (!first) return { ok: false, output: null, error: "no accessible parent page — share one with the integration" };
            parent = { page_id: first.id };
          }
          const j = await notion(auth.token, "/pages", {
            method: "POST",
            body: JSON.stringify({
              parent,
              properties: {
                title: { title: [{ type: "text", text: { content: String(input.title) } }] },
              },
              children: markdownToBlocks(String(input.markdown)),
            }),
          });
          return { ok: true, url: j.url, externalId: j.id, output: { id: j.id, url: j.url } };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
  ],
};
