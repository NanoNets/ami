import { z } from "zod";
import type { AuthBlob, NormalizedSignal } from "@ami/shared";
import type { AmiConnector, ActionResult, BootstrapResult } from "../types.js";

/** Jira Cloud: Basic auth with account email + API token against the site's
 * REST API (https://<site>.atlassian.net/rest/api/3). */

function baseUrl(auth: AuthBlob): string {
  const site = (auth.site ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${site}`;
}

async function jira(auth: AuthBlob, path: string, init: RequestInit = {}): Promise<any> {
  const basic = Buffer.from(`${auth.email}:${auth.token}`).toString("base64");
  const res = await fetch(`${baseUrl(auth)}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`jira ${path}: ${j.errorMessages?.[0] ?? j.message ?? res.status}`);
  }
  return j;
}

/** Flatten Atlassian Document Format to plain text. */
function adfText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  const parts = (node.content ?? []).map(adfText);
  const joined = parts.join("");
  return node.type === "paragraph" || node.type === "heading" ? `${joined}\n` : joined;
}

/** JQL timestamp: minute precision, "yyyy/MM/dd HH:mm" in the site's timezone.
 * We format in UTC and search one extra minute back — dedup absorbs overlap. */
function jqlTime(ms: number): string {
  const d = new Date(ms - 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const SEARCH_FIELDS = "summary,status,assignee,reporter,updated,priority,comment";

async function searchIssues(auth: AuthBlob, jql: string, maxResults: number): Promise<any[]> {
  const j = await jira(
    auth,
    `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=${SEARCH_FIELDS}&maxResults=${maxResults}`,
  );
  return j.issues ?? [];
}

function issueSignal(auth: AuthBlob, issue: any, titleSuffix: string): NormalizedSignal {
  const f = issue.fields ?? {};
  const comments: any[] = f.comment?.comments ?? [];
  const last = comments[comments.length - 1];
  const lastComment = last
    ? `Latest comment (${last.author?.displayName ?? "unknown"}): ${adfText(last.body).trim().slice(0, 1500)}`
    : "";
  return {
    externalId: `${issue.key}:${f.updated ?? ""}`,
    kind: "ticket",
    title: `${issue.key}: ${f.summary ?? ""} — ${titleSuffix}`,
    body: [
      `Status: ${f.status?.name ?? "unknown"}`,
      f.assignee?.displayName ? `Assignee: ${f.assignee.displayName}` : "",
      f.priority?.name ? `Priority: ${f.priority.name}` : "",
      lastComment,
    ]
      .filter(Boolean)
      .join("\n"),
    author: last?.author?.displayName ?? f.reporter?.displayName ?? "",
    url: `${baseUrl(auth)}/browse/${issue.key}`,
    threadRef: issue.key,
    raw: { key: issue.key, status: f.status?.name, updated: f.updated },
    occurredAt: f.updated ?? new Date().toISOString(),
  };
}

export const jiraConnector: AmiConnector = {
  id: "jira",
  meta: {
    label: "Jira",
    authKind: "token",
    authFields: [
      { key: "site", label: "Site", placeholder: "yourco.atlassian.net" },
      { key: "email", label: "Atlassian account email" },
      { key: "token", label: "API token", secret: true },
    ],
    setupHelp:
      "Create an API token at id.atlassian.com/manage-profile/security/api-tokens, then enter your Jira Cloud site (yourco.atlassian.net), account email, and the token.",
  },
  async validateAuth(auth) {
    try {
      const me = await jira(auth, "/rest/api/3/myself");
      return { ok: true, accountLabel: `${me.displayName} @ ${auth.site}` };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
  async identity(auth) {
    const me = await jira(auth, "/rest/api/3/myself");
    return { name: me.displayName, email: me.emailAddress };
  },
  streams() {
    return [{ name: "activity", intervalSec: 120 }];
  },
  async poll({ auth, cursor }) {
    // Issues involving the user, updated since the cursor. The externalId
    // embeds the updated stamp: each update (comment, status change) is one
    // signal; triage decides whether it matters.
    const sinceMs = cursor ? parseInt(cursor, 10) : Date.now() - 24 * 3600_000;
    const jql = `updated > "${jqlTime(sinceMs)}" AND (assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) ORDER BY updated ASC`;
    const issues = await searchIssues(auth, jql, 25);
    const signals: NormalizedSignal[] = [];
    let maxMs = sinceMs;
    for (const issue of issues) {
      const updated = Date.parse(issue.fields?.updated ?? "") || sinceMs;
      if (updated <= sinceMs) continue;
      maxMs = Math.max(maxMs, updated);
      signals.push(issueSignal(auth, issue, "updated"));
    }
    return { signals, nextCursor: String(maxMs) };
  },
  async bootstrap(auth, onProgress): Promise<BootstrapResult> {
    // The user's plate: open assigned issues → digest doc + first task list
    // (same shape as the Linear bootstrap).
    onProgress?.("reading assigned issues");
    const issues = await searchIssues(
      auth,
      `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`,
      50,
    );
    const lines = issues.map((i: any) => {
      const f = i.fields ?? {};
      return [
        `- **${i.key}** ${f.summary ?? ""} — ${f.status?.name ?? "open"}`,
        f.priority?.name ? `priority: ${f.priority.name}` : "",
      ]
        .filter(Boolean)
        .join(", ");
    });
    const docs =
      lines.length > 0
        ? [
            {
              name: "assigned-issues",
              title: `Jira: open issues assigned to the user (${auth.site})`,
              body: `The user has ${lines.length} open Jira issue(s) assigned on ${auth.site}. These are their active work items.\n\n${lines.join("\n")}`,
            },
          ]
        : [];
    const triage = issues.slice(0, 20).map((i: any) => issueSignal(auth, i, "assigned to you"));
    return { docs, triage };
  },
  actions: [
    {
      name: "jira_issue_context",
      readOnly: true,
      description:
        "Fetch a Jira issue with description and recent comments for context. Input is the issue key (threadRef of a jira signal).",
      schema: { threadRef: z.string().describe("Issue key, e.g. ENG-123") },
      async run(auth, input): Promise<ActionResult> {
        try {
          const j = await jira(
            auth,
            `/rest/api/3/issue/${encodeURIComponent(String(input.threadRef))}?fields=summary,description,status,assignee,reporter,priority,comment`,
          );
          const f = j.fields ?? {};
          return {
            ok: true,
            output: {
              key: j.key,
              summary: f.summary,
              status: f.status?.name,
              assignee: f.assignee?.displayName,
              reporter: f.reporter?.displayName,
              priority: f.priority?.name,
              description: adfText(f.description).trim().slice(0, 6000),
              comments: (f.comment?.comments ?? []).slice(-15).map((c: any) => ({
                author: c.author?.displayName,
                created: c.created,
                body: adfText(c.body).trim().slice(0, 1500),
              })),
              url: `${baseUrl(auth)}/browse/${j.key}`,
            },
          };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "jira_search",
      readOnly: true,
      description:
        'Search Jira issues by free text, or pass raw JQL for precise filters (e.g. `project = ENG AND status = "In Progress"`). Returns issue keys — pass a key to jira_issue_context for full detail.',
      schema: {
        query: z.string().describe("Free-text search terms"),
        jql: z.string().optional().describe("Raw JQL override; when set, query is ignored"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const max = Math.min(Number(input.limit) || 10, 25);
          const text = String(input.query).replace(/"/g, '\\"');
          const jql = input.jql ? String(input.jql) : `text ~ "${text}" ORDER BY updated DESC`;
          const issues = await searchIssues(auth, jql, max);
          const out = issues.map((i: any) => {
            const f = i.fields ?? {};
            return {
              key: i.key,
              summary: f.summary,
              status: f.status?.name,
              assignee: f.assignee?.displayName,
              updated: f.updated,
              url: `${baseUrl(auth)}/browse/${i.key}`,
            };
          });
          return { ok: true, output: out };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "jira_comment",
      description: "Post a comment on a Jira issue on behalf of the user.",
      isSend: true,
      schema: {
        targetRef: z.string().describe("Issue key (threadRef of the signal)"),
        body: z.string().describe("Comment text (plain text)"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const j = await jira(auth, `/rest/api/3/issue/${encodeURIComponent(String(input.targetRef))}/comment`, {
            method: "POST",
            body: JSON.stringify({
              body: {
                type: "doc",
                version: 1,
                content: [{ type: "paragraph", content: [{ type: "text", text: String(input.body) }] }],
              },
            }),
          });
          return { ok: true, externalId: j.id, output: j };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
  ],
};
