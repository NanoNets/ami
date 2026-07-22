import { z } from "zod";
import type { NormalizedSignal } from "@ami/shared";
import type { AmiConnector, ActionResult, BootstrapResult } from "../types.js";

const API = "https://api.linear.app/graphql";

async function linear(token: string, query: string, variables?: Record<string, unknown>): Promise<any> {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      // Personal API keys are passed raw; OAuth tokens need the Bearer prefix.
      Authorization: token.startsWith("lin_oauth_") ? `Bearer ${token}` : token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const j: any = await res.json();
  if (!res.ok || j.errors?.length) {
    throw new Error(`linear: ${j.errors?.[0]?.message ?? res.status}`);
  }
  return j.data;
}

const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  issueAssignedToYou: "assigned to you",
  issueUnassignedFromYou: "unassigned from you",
  issueMention: "you were mentioned",
  issueCommentMention: "mentioned in a comment",
  issueNewComment: "new comment",
  issueCreated: "issue created",
  issueStatusChanged: "status changed",
  issueDue: "due soon",
  issueBlocking: "blocking issue",
  issueEmojiReaction: "reaction",
  issueCommentReaction: "reaction to comment",
  issueSubscribed: "subscribed",
};

const NOTIFICATIONS_QUERY = `query($first: Int!) {
  notifications(first: $first) {
    nodes {
      id type createdAt
      ... on IssueNotification {
        issue { id identifier title url dueDate }
        comment { body url }
        actor { name displayName }
      }
    }
  }
}`;

function notificationSignal(n: any): NormalizedSignal | null {
  if (!n.issue) return null;
  const label = NOTIFICATION_TYPE_LABELS[n.type] ?? n.type;
  const actor = n.actor?.displayName ?? n.actor?.name ?? "";
  return {
    externalId: `notif:${n.id}`,
    kind: "ticket",
    title: `${n.issue.identifier}: ${n.issue.title} — ${label}${actor ? ` (${actor})` : ""}`,
    body: [
      n.comment?.body ?? `${label} on ${n.issue.identifier} "${n.issue.title}"`,
      n.issue.dueDate ? `Due date: ${n.issue.dueDate}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    author: actor,
    url: n.comment?.url ?? n.issue.url,
    threadRef: n.issue.id,
    // dueDate rides structurally so triage can pin the todo's due date exactly.
    raw: { id: n.id, type: n.type, issueId: n.issue.id, identifier: n.issue.identifier, dueDate: n.issue.dueDate ?? null },
    occurredAt: n.createdAt,
  };
}

async function fetchNotifications(
  token: string,
  first: number,
  oldestIso: string,
): Promise<{ signals: NormalizedSignal[]; maxCreatedAt: string }> {
  const data = await linear(token, NOTIFICATIONS_QUERY, { first });
  const signals: NormalizedSignal[] = [];
  let max = oldestIso;
  for (const n of data.notifications?.nodes ?? []) {
    if (n.createdAt > max) max = n.createdAt;
    if (n.createdAt <= oldestIso) continue;
    const sig = notificationSignal(n);
    if (sig) signals.push(sig);
  }
  return { signals, maxCreatedAt: max };
}

export const linearConnector: AmiConnector = {
  id: "linear",
  meta: {
    label: "Linear",
    authKind: "token",
    authFields: [
      { key: "token", label: "Personal API key", placeholder: "lin_api_…", secret: true },
    ],
    setupHelp:
      "The button opens Linear's API settings. Create a personal API key and paste it here.",
    setupActions: [{ label: "Open Linear API settings", url: "https://linear.app/settings/account/security" }],
  },
  async validateAuth(auth) {
    try {
      const data = await linear(auth.token, `{ viewer { name email } }`);
      return { ok: true, accountLabel: `${data.viewer.name} (${data.viewer.email})` };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
  streams() {
    return [{ name: "notifications", intervalSec: 120 }];
  },
  async poll({ auth, cursor }) {
    const oldest = cursor ?? new Date(Date.now() - 24 * 3600_000).toISOString();
    const { signals, maxCreatedAt } = await fetchNotifications(auth.token, 50, oldest);
    return { signals, nextCursor: maxCreatedAt };
  },
  async bootstrap(auth, onProgress): Promise<BootstrapResult> {
    // First task list: last 7 days of notifications through normal triage.
    onProgress?.("reading last 7 days of notifications");
    const oldest = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const { signals } = await fetchNotifications(auth.token, 100, oldest);

    // Knowledge: the user's open plate — assigned issues with team/project.
    onProgress?.("reading assigned issues");
    const data = await linear(
      auth.token,
      `{ viewer { name email assignedIssues(first: 50, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
        nodes { id identifier title url priorityLabel dueDate updatedAt state { name type } team { name key } project { name } }
      } } }`,
    );
    const issues: any[] = data.viewer?.assignedIssues?.nodes ?? [];
    const lines = issues.map((i) => {
      const parts = [
        `- **${i.identifier}** ${i.title} — ${i.state?.name ?? "open"}`,
        i.team?.name ? `team: ${i.team.name}` : "",
        i.project?.name ? `project: ${i.project.name}` : "",
        i.priorityLabel && i.priorityLabel !== "No priority" ? `priority: ${i.priorityLabel}` : "",
      ].filter(Boolean);
      return parts.join(", ");
    });
    const docs =
      issues.length > 0
        ? [
            {
              name: "assigned-issues",
              title: `Linear: open issues assigned to ${data.viewer?.name ?? "the user"}`,
              body: `The user (${data.viewer?.name} <${data.viewer?.email}>) currently has ${issues.length} open Linear issue(s) assigned. Teams and projects here are the user's active work areas.\n\n${lines.join("\n")}`,
            },
          ]
        : [];

    // The task list must reflect the user's Linear plate even when there are
    // no recent notifications: assigned open issues go through triage too
    // (freshest first). Notification overlap resolves via triage's duplicate
    // detection.
    const issueSignals: NormalizedSignal[] = issues
      .slice()
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, 20)
      .map((i) => ({
        externalId: `issue:${i.identifier}`,
        kind: "ticket",
        title: `${i.identifier}: ${i.title} — assigned to you (${i.state?.name ?? "open"})`,
        body: [
          `Open Linear issue assigned to the user.`,
          `State: ${i.state?.name ?? "open"}`,
          i.team?.name ? `Team: ${i.team.name}` : "",
          i.project?.name ? `Project: ${i.project.name}` : "",
          i.priorityLabel && i.priorityLabel !== "No priority" ? `Priority: ${i.priorityLabel}` : "",
          i.dueDate ? `Due date: ${i.dueDate}` : "",
          `URL: ${i.url}`,
        ]
          .filter(Boolean)
          .join("\n"),
        author: "",
        url: i.url,
        threadRef: i.id,
        raw: { id: i.id, identifier: i.identifier, state: i.state?.name, dueDate: i.dueDate ?? null },
        occurredAt: i.updatedAt,
      }));

    return { docs, triage: [...signals.slice(0, 50), ...issueSignals] };
  },
  actions: [
    {
      name: "linear_issue_context",
      readOnly: true,
      description:
        "Fetch a Linear issue with its description and recent comments for context. Input is the issue id (threadRef of a linear signal).",
      schema: { threadRef: z.string() },
      async run(auth, input): Promise<ActionResult> {
        try {
          const data = await linear(
            auth.token,
            `query($id: String!) { issue(id: $id) {
              identifier title description url priorityLabel
              state { name } assignee { name } team { name }
              comments(first: 30) { nodes { body createdAt user { name } } }
            } }`,
            { id: String(input.threadRef) },
          );
          return { ok: true, output: data.issue };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "linear_search",
      readOnly: true,
      description:
        "Full-text search across Linear issues (title, description, comments). Returns matches — pass a threadRef (issue id) to linear_issue_context for full detail.",
      schema: {
        query: z.string(),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const first = Math.min(Number(input.limit) || 10, 25);
          const data = await linear(
            auth.token,
            `query($term: String!, $first: Int!) { searchIssues(term: $term, first: $first) {
              nodes { id identifier title url updatedAt state { name } assignee { name } team { key } }
            } }`,
            { term: String(input.query), first },
          );
          const issues = (data.searchIssues?.nodes ?? []).map((i: any) => ({
            threadRef: i.id,
            identifier: i.identifier,
            title: i.title,
            state: i.state?.name,
            assignee: i.assignee?.name,
            team: i.team?.key,
            updated: i.updatedAt,
            url: i.url,
          }));
          return { ok: true, output: issues };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "linear_create_issue",
      description:
        "Create a Linear issue in the user's name. Resolves human names to ids: teamKey is the issue prefix ('PLG'), projectName and stateName ('Done', 'In Progress', 'Backlog') match case-insensitively. Give teamKey OR projectName (project implies its team). assignToMe defaults true.",
      schema: {
        title: z.string(),
        description: z.string().optional().describe("Issue body (markdown)"),
        teamKey: z.string().optional().describe("Team key, e.g. 'PLG' — the prefix in issue ids"),
        projectName: z.string().optional().describe("Project to file under, e.g. 'Agents growth'"),
        stateName: z.string().optional().describe("Workflow state name, e.g. 'Done' (default: team default)"),
        assignToMe: z.boolean().optional().describe("Assign to the user (default true)"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          // Resolve project first — it can imply the team.
          let projectId: string | undefined;
          let teamId: string | undefined;
          if (input.projectName) {
            const want = String(input.projectName).toLowerCase();
            // Server-side filter — the workspace has hundreds of projects, a
            // paginated fetch-all misses matches.
            const data = await linear(
              auth.token,
              `query($name: String!) { projects(filter: { name: { containsIgnoreCase: $name } }, first: 20) { nodes { id name teams(first: 5) { nodes { id key } } } } }`,
              { name: String(input.projectName) },
            );
            const projects = data.projects?.nodes ?? [];
            const p = projects.find((x: any) => x.name.toLowerCase() === want) ?? projects[0];
            if (!p) {
              return {
                ok: false,
                output: null,
                error: `no Linear project matching "${input.projectName}" — check the name (or give teamKey and omit projectName)`,
              };
            }
            projectId = p.id;
            teamId = p.teams?.nodes?.[0]?.id;
          }
          if (input.teamKey || !teamId) {
            const data = await linear(auth.token, `query { teams(first: 50) { nodes { id key name } } }`);
            const teams = data.teams?.nodes ?? [];
            const wantKey = String(input.teamKey ?? "").toLowerCase();
            const t = input.teamKey
              ? teams.find((x: any) => x.key.toLowerCase() === wantKey || x.name.toLowerCase() === wantKey)
              : undefined;
            if (input.teamKey && !t) {
              return {
                ok: false,
                output: null,
                error: `no team matching "${input.teamKey}" — teams: ${teams.map((x: any) => x.key).join(", ")}`,
              };
            }
            teamId = t?.id ?? teamId;
          }
          if (!teamId) return { ok: false, output: null, error: "give teamKey or projectName so the issue lands in a team" };

          let stateId: string | undefined;
          if (input.stateName) {
            const data = await linear(
              auth.token,
              `query($teamId: String!) { team(id: $teamId) { states { nodes { id name type } } } }`,
              { teamId },
            );
            const states = data.team?.states?.nodes ?? [];
            const want = String(input.stateName).toLowerCase();
            const s =
              states.find((x: any) => x.name.toLowerCase() === want) ??
              states.find((x: any) => x.name.toLowerCase().includes(want));
            if (!s) {
              return {
                ok: false,
                output: null,
                error: `no state matching "${input.stateName}" — states: ${states.map((x: any) => x.name).join(", ")}`,
              };
            }
            stateId = s.id;
          }

          let assigneeId: string | undefined;
          if (input.assignToMe !== false) {
            const me = await linear(auth.token, `query { viewer { id } }`);
            assigneeId = me.viewer?.id;
          }

          const data = await linear(
            auth.token,
            `mutation($input: IssueCreateInput!) {
              issueCreate(input: $input) { success issue { id identifier title url } }
            }`,
            {
              input: {
                teamId,
                title: String(input.title),
                ...(input.description ? { description: String(input.description) } : {}),
                ...(projectId ? { projectId } : {}),
                ...(stateId ? { stateId } : {}),
                ...(assigneeId ? { assigneeId } : {}),
              },
            },
          );
          const r = data.issueCreate;
          if (!r?.success) return { ok: false, output: null, error: "issueCreate failed" };
          return { ok: true, url: r.issue?.url, externalId: r.issue?.id, output: r.issue };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "linear_update_issue",
      description:
        "Update an existing Linear issue: retitle, edit the description, move it into a project, change workflow state, due date or priority, or assign it to the user. Only the fields given change. issue accepts the identifier ('PLG-951') or the issue id (threadRef of a linear signal).",
      schema: {
        issue: z.string().describe("Issue identifier ('PLG-951') or issue id (threadRef)"),
        title: z.string().optional(),
        description: z.string().optional().describe("Replaces the issue body (markdown)"),
        projectName: z.string().optional().describe("Project to move the issue into, e.g. 'Agents growth'"),
        stateName: z.string().optional().describe("Workflow state name, e.g. 'In Progress'"),
        dueDate: z.string().optional().describe("YYYY-MM-DD; empty string clears the due date"),
        priority: z.number().int().min(0).max(4).optional().describe("0 none, 1 urgent, 2 high, 3 medium, 4 low"),
        assignToMe: z.boolean().optional().describe("Assign the issue to the user"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          // issue(id:) resolves both UUIDs and identifiers like "PLG-951";
          // the team id is needed to resolve state names.
          const found = await linear(
            auth.token,
            `query($id: String!) { issue(id: $id) { id identifier team { id } } }`,
            { id: String(input.issue) },
          );
          const issue = found.issue;
          if (!issue) return { ok: false, output: null, error: `no Linear issue matching "${input.issue}"` };

          const patch: Record<string, unknown> = {};
          if (input.title !== undefined) patch.title = String(input.title);
          if (input.description !== undefined) patch.description = String(input.description);
          if (input.dueDate !== undefined) patch.dueDate = String(input.dueDate) || null;
          if (input.priority !== undefined) patch.priority = Number(input.priority);

          if (input.projectName) {
            const want = String(input.projectName).toLowerCase();
            // Server-side filter — the workspace has hundreds of projects, a
            // paginated fetch-all misses matches.
            const data = await linear(
              auth.token,
              `query($name: String!) { projects(filter: { name: { containsIgnoreCase: $name } }, first: 20) { nodes { id name } } }`,
              { name: String(input.projectName) },
            );
            const projects = data.projects?.nodes ?? [];
            const p = projects.find((x: any) => x.name.toLowerCase() === want) ?? projects[0];
            if (!p) {
              return { ok: false, output: null, error: `no Linear project matching "${input.projectName}" — check the name` };
            }
            patch.projectId = p.id;
          }

          if (input.stateName) {
            const data = await linear(
              auth.token,
              `query($teamId: String!) { team(id: $teamId) { states { nodes { id name } } } }`,
              { teamId: issue.team.id },
            );
            const states = data.team?.states?.nodes ?? [];
            const want = String(input.stateName).toLowerCase();
            const s =
              states.find((x: any) => x.name.toLowerCase() === want) ??
              states.find((x: any) => x.name.toLowerCase().includes(want));
            if (!s) {
              return {
                ok: false,
                output: null,
                error: `no state matching "${input.stateName}" — states: ${states.map((x: any) => x.name).join(", ")}`,
              };
            }
            patch.stateId = s.id;
          }

          if (input.assignToMe) {
            const me = await linear(auth.token, `query { viewer { id } }`);
            patch.assigneeId = me.viewer?.id;
          }

          if (Object.keys(patch).length === 0) {
            return { ok: false, output: null, error: "nothing to update — give at least one field" };
          }

          const data = await linear(
            auth.token,
            `mutation($id: String!, $input: IssueUpdateInput!) {
              issueUpdate(id: $id, input: $input) { success issue { id identifier title url state { name } project { name } assignee { name } dueDate } }
            }`,
            { id: issue.id, input: patch },
          );
          const r = data.issueUpdate;
          if (!r?.success) return { ok: false, output: null, error: "issueUpdate failed" };
          return { ok: true, url: r.issue?.url, externalId: r.issue?.id, output: r.issue };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "linear_comment",
      description: "Post a comment on a Linear issue on behalf of the user.",
      isSend: true,
      schema: {
        targetRef: z.string().describe("Linear issue id (threadRef of the signal)"),
        body: z.string().describe("Comment body (markdown)"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const data = await linear(
            auth.token,
            `mutation($issueId: String!, $body: String!) {
              commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id url } }
            }`,
            { issueId: String(input.targetRef), body: String(input.body) },
          );
          const c = data.commentCreate;
          if (!c?.success) return { ok: false, output: null, error: "commentCreate failed" };
          return { ok: true, url: c.comment?.url, externalId: c.comment?.id, output: c.comment };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
  ],
};
