import { z } from "zod";
import type { NormalizedSignal } from "@ami/shared";
import type { AmiConnector, ActionResult } from "../types.js";

const API = "https://api.github.com";

async function gh(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`github ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** GitHub's global search ranks strangers' public repos above the user's own
 * private ones. Unless the query already carries an owner qualifier, scope it
 * to the user's login and orgs. */
async function scopeToOwner(token: string, query: string): Promise<string> {
  if (/\b(org|user|owner|repo):/i.test(query)) return query;
  const me = await gh(token, "/user");
  const orgs: any[] = await gh(token, "/user/orgs?per_page=20").catch(() => []);
  const owners = [`user:${me.login}`, ...(orgs ?? []).map((o: any) => `org:${o.login}`)];
  return `${query} ${owners.join(" ")}`;
}

export const githubConnector: AmiConnector = {
  id: "github",
  meta: {
    label: "GitHub",
    authKind: "token",
    authFields: [
      { key: "token", label: "Personal access token", placeholder: "ghp_… or github_pat_…", secret: true },
    ],
    setupHelp:
      "The button opens the new-token page with the scopes pre-selected (repo, notifications, read:org). Generate the token and paste it here. Ami also passes it as GH_TOKEN to Claude Code so coding tasks can clone and open PRs with gh (make sure you have gh installed).",
    setupActions: [
      {
        label: "Create the token",
        url: "https://github.com/settings/tokens/new?description=Ami%20(local)&scopes=repo,notifications,read:org",
      },
    ],
  },
  async validateAuth(auth) {
    try {
      const me = await gh(auth.token, "/user");
      return { ok: true, accountLabel: me.login };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
  streams() {
    return [{ name: "notifications", intervalSec: 90 }];
  },
  async poll({ auth, cursor }) {
    const since = cursor ?? new Date(Date.now() - 24 * 3600_000).toISOString();
    const notifs: any[] = await gh(
      auth.token,
      `/notifications?since=${encodeURIComponent(since)}&participating=true`,
    );
    const signals: NormalizedSignal[] = [];
    let max = since;
    for (const n of notifs ?? []) {
      if (n.updated_at > max) max = n.updated_at;
      const webUrl = (n.subject?.url ?? "")
        .replace("api.github.com/repos", "github.com")
        .replace("/pulls/", "/pull/");
      signals.push({
        externalId: `notif:${n.id}:${n.updated_at}`,
        kind: "issue",
        title: `${n.repository?.full_name}: ${n.subject?.title}`,
        body: `${n.reason} on ${n.subject?.type} — ${n.subject?.title}`,
        author: n.repository?.owner?.login ?? "",
        url: webUrl,
        threadRef: n.subject?.url,
        raw: n,
        occurredAt: n.updated_at,
      });
    }
    return { signals, nextCursor: max };
  },
  async bootstrap(auth, onProgress) {
    // Knowledge: repo landscape + the user's open plate. Structure over
    // history — notifications noise ages badly, repos and open PRs don't.
    onProgress?.("reading repositories and open work");
    const sections: string[] = [];
    try {
      const repos: any[] = await gh(auth.token, "/user/repos?sort=pushed&per_page=30");
      const lines = (repos ?? []).map((r: any) =>
        [
          `- **${r.full_name}**${r.private ? " (private)" : ""}`,
          r.language ?? "",
          r.description ? r.description.slice(0, 120) : "",
          `last push ${String(r.pushed_at ?? "").slice(0, 10)}`,
        ]
          .filter(Boolean)
          .join(" — "),
      );
      if (lines.length) sections.push(`## Repositories (most recently pushed)\n\n${lines.join("\n")}`);
    } catch (e: any) {
      console.error(`[github bootstrap] repos: ${e.message}`);
    }
    for (const [label, q] of [
      ["Open issues/PRs assigned to the user", "is:open assignee:@me"],
      ["Open PRs authored by the user", "is:open type:pr author:@me"],
    ] as const) {
      try {
        const j = await gh(auth.token, `/search/issues?q=${encodeURIComponent(q)}&per_page=30`);
        const lines = (j.items ?? []).map(
          (i: any) => `- ${i.pull_request ? "PR" : "issue"} **${i.title}** — ${i.html_url}`,
        );
        if (lines.length) sections.push(`## ${label}\n\n${lines.join("\n")}`);
      } catch (e: any) {
        console.error(`[github bootstrap] search: ${e.message}`);
      }
    }
    const docs = sections.length
      ? [
          {
            name: "github-overview",
            title: "GitHub: repositories and open work",
            body: sections.join("\n\n"),
          },
        ]
      : [];
    return { docs, triage: [] };
  },
  actions: [
    {
      name: "github_search_repos",
      readOnly: true,
      description:
        "Search repositories by keyword, scoped to the user's own repos and orgs by default (pass an explicit org:/user: qualifier to search elsewhere). Finding a repo by name/description is NOT proof it contains the code you need — verify with github_search_code before pinning a coding task to it.",
      schema: {
        query: z.string(),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const per = Math.min(Number(input.limit) || 10, 25);
          const q = await scopeToOwner(auth.token, String(input.query));
          const j = await gh(auth.token, `/search/repositories?q=${encodeURIComponent(q)}&per_page=${per}`);
          let items: any[] = j.items ?? [];
          if (items.length === 0) {
            // Search ANDs every word against name/description, so "nanonets
            // website" misses a repo called new-website. Fall back to the
            // user's accessible repos, any-word matched.
            const words = String(input.query)
              .toLowerCase()
              .split(/\s+/)
              .filter((w) => w.length >= 3 && !w.includes(":"));
            const mine: any[] = [];
            for (let page = 1; page <= 2; page++) {
              const batch = await gh(auth.token, `/user/repos?per_page=100&sort=pushed&page=${page}`);
              mine.push(...(batch ?? []));
              if (!batch || batch.length < 100) break;
            }
            items = mine
              .map((r: any) => {
                // Match against name + description only — the owner prefix
                // would make every org repo a hit for its own org's name.
                const hay = `${r.name} ${r.description ?? ""}`.toLowerCase();
                return { r, hits: words.filter((w) => hay.includes(w)).length };
              })
              .filter((x) => x.hits > 0)
              .sort((a, b) => b.hits - a.hits) // stable: pushed-recency within equal hits
              .slice(0, per)
              .map((x) => x.r);
          }
          const repos = items.map((r: any) => ({
            fullName: r.full_name,
            private: r.private,
            description: r.description,
            language: r.language,
            pushedAt: r.pushed_at,
            url: r.html_url,
            defaultBranch: r.default_branch,
          }));
          return { ok: true, output: repos };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "github_search_code",
      readOnly: true,
      description:
        "Search file CONTENTS across the user's repos and orgs — the ground truth for \"which repo contains this string/markup/function?\". Use it to verify a repo actually holds the code you plan to change before pinning a coding task to it. Supports code-search qualifiers (repo:, org:, path:, filename:, language:); default-scoped to the user's repos/orgs. Only default branches are indexed.",
      schema: {
        query: z.string().describe("Code search terms, e.g. 'mondelez' or 'logoTicker path:src'"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const per = Math.min(Number(input.limit) || 10, 25);
          const q = await scopeToOwner(auth.token, String(input.query));
          const j = await gh(auth.token, `/search/code?q=${encodeURIComponent(q)}&per_page=${per}`);
          const items = (j.items ?? []).map((i: any) => ({
            repo: i.repository?.full_name,
            path: i.path,
            url: i.html_url,
          }));
          return { ok: true, output: { total: j.total_count, items } };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "github_read_file",
      readOnly: true,
      description:
        "Read a file's contents from any repo the user can access — including private ones. This is THE way to read code found via github_search_code; never WebFetch or browse github.com blob URLs (private repos return 404 there). Optional ref pins a branch, tag or commit SHA (defaults to the default branch).",
      schema: {
        repoFullName: z.string().describe("e.g. acme/website"),
        path: z.string().describe("File path within the repo, e.g. src/components/LogoTicker.tsx"),
        ref: z.string().optional().describe("Branch, tag or commit SHA (default: default branch)"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const repo = String(input.repoFullName);
          const path = String(input.path).replace(/^\/+/, "");
          const ref = input.ref ? `?ref=${encodeURIComponent(String(input.ref))}` : "";
          const url = `${API}/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${ref}`;
          const res = await fetch(url, {
            headers: {
              Authorization: `Bearer ${auth.token}`,
              // raw media type: file bytes directly, no base64/size ceiling dance
              Accept: "application/vnd.github.raw+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          });
          if (!res.ok) throw new Error(`github /repos/${repo}/contents: ${res.status} ${await res.text()}`);
          let text = await res.text();
          const CAP = 100_000;
          const truncated = text.length > CAP;
          if (truncated) text = `${text.slice(0, CAP)}\n… (truncated at ${CAP} chars)`;
          return { ok: true, output: { repo, path, ref: input.ref ?? null, truncated, content: text } };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "github_search_issues",
      readOnly: true,
      description:
        "Search GitHub issues and pull requests with GitHub search syntax (repo:owner/name, author:, is:open, is:pr, in:title, ...). Plain terms match title and body. Use github_pr_status for the live state of one specific PR.",
      schema: {
        query: z.string(),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const per = Math.min(Number(input.limit) || 10, 25);
          const j = await gh(
            auth.token,
            `/search/issues?q=${encodeURIComponent(String(input.query))}&sort=updated&per_page=${per}`,
          );
          const items = (j.items ?? []).map((i: any) => ({
            repo: String(i.repository_url ?? "").replace(`${API}/repos/`, ""),
            number: i.number,
            title: i.title,
            state: i.state,
            isPullRequest: !!i.pull_request,
            author: i.user?.login,
            updatedAt: i.updated_at,
            url: i.html_url,
          }));
          return { ok: true, output: { total: j.total_count, items } };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "github_pr_status",
      readOnly: true,
      description:
        "Live status of a GitHub pull request or issue: open/closed, merged (and by whom/when), branch, last update. Use this to verify current state instead of relying on memory. Input: repo full name ('owner/repo') and the PR/issue number.",
      schema: {
        repoFullName: z.string().describe("e.g. acme/website"),
        number: z.number().int().describe("PR or issue number"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const repo = String(input.repoFullName);
          const n = Number(input.number);
          const issue = await gh(auth.token, `/repos/${repo}/issues/${n}`);
          const out: Record<string, unknown> = {
            number: n,
            title: issue.title,
            state: issue.state,
            isPullRequest: !!issue.pull_request,
            author: issue.user?.login,
            updatedAt: issue.updated_at,
            closedAt: issue.closed_at,
            comments: issue.comments,
            url: issue.html_url,
          };
          if (issue.pull_request) {
            const pr = await gh(auth.token, `/repos/${repo}/pulls/${n}`);
            out.merged = pr.merged;
            out.mergedAt = pr.merged_at;
            out.mergedBy = pr.merged_by?.login;
            out.branch = pr.head?.ref;
            out.baseBranch = pr.base?.ref;
            out.draft = pr.draft;
            out.mergeableState = pr.mergeable_state;
          }
          return { ok: true, url: issue.html_url, output: out };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "github_comment",
      description: "Post a comment on a GitHub issue or pull request on behalf of the user.",
      isSend: true,
      schema: {
        targetRef: z.string().describe("API url of the issue/PR, e.g. https://api.github.com/repos/o/r/issues/1"),
        body: z.string(),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const url = String(input.targetRef).replace(/\/pulls\//, "/issues/");
          const path = url.replace(API, "");
          const j = await gh(auth.token, `${path}/comments`, {
            method: "POST",
            body: JSON.stringify({ body: String(input.body) }),
          });
          return { ok: true, url: j.html_url, externalId: String(j.id), output: j };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
  ],
};
