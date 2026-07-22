import { z } from "zod";
import type { AuthBlob } from "@ami/shared";
import type { AmiConnector, ActionResult, BootstrapResult } from "../types.js";

/** PostHog: product analytics as an agent-queryable data source. No polling
 * streams — metrics aren't inbox items; background agents and live notes pull
 * numbers on their own schedule via the posthog_query action. */

function host(auth: AuthBlob): string {
  return (auth.host || "https://us.posthog.com").trim().replace(/\/+$/, "");
}

async function posthog(auth: AuthBlob, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${host(auth)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.api_key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`posthog ${path}: ${j.detail ?? j.type ?? res.status}`);
  return j;
}

export const posthogConnector: AmiConnector = {
  id: "posthog",
  meta: {
    label: "PostHog",
    authKind: "token",
    authFields: [
      { key: "host", label: "Host", placeholder: "https://us.posthog.com" },
      { key: "project_id", label: "Project ID", placeholder: "Project ID (something like 12345)" },
      { key: "api_key", label: "Personal API key (phx_…)", secret: true },
    ],
    setupHelp:
      "Go to Posthog. Create the API key in Settings → Personal API keys (scope: query read + project read). Project ID is in Settings → Project. Host is https://us.posthog.com, https://eu.posthog.com, or your self-hosted URL.",
  },
  async validateAuth(auth) {
    try {
      const j = await posthog(auth, `/api/projects/${auth.project_id}/`);
      return { ok: true, accountLabel: j.name ?? `project ${auth.project_id}` };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
  streams() {
    return [];
  },
  async poll() {
    return { signals: [], nextCursor: null };
  },
  async bootstrap(auth, onProgress): Promise<BootstrapResult> {
    // Knowledge: what this team measures — saved insights and dashboards tell
    // Ami which metrics the user cares about (and what to query later).
    onProgress?.("reading insights and dashboards");
    const sections: string[] = [];
    try {
      const j = await posthog(auth, `/api/projects/${auth.project_id}/insights/?limit=25&saved=true&order=-last_modified_at`);
      const lines = (j.results ?? [])
        .filter((i: any) => i.name || i.derived_name)
        .map((i: any) => `- **${i.name || i.derived_name}**${i.description ? ` — ${i.description}` : ""}`);
      if (lines.length) sections.push(`## Saved insights\n\n${lines.join("\n")}`);
    } catch (e: any) {
      console.error(`[posthog bootstrap] insights: ${e.message}`);
    }
    try {
      const j = await posthog(auth, `/api/projects/${auth.project_id}/dashboards/?limit=15`);
      const lines = (j.results ?? []).map(
        (d: any) => `- **${d.name}**${d.description ? ` — ${d.description}` : ""}`,
      );
      if (lines.length) sections.push(`## Dashboards\n\n${lines.join("\n")}`);
    } catch (e: any) {
      console.error(`[posthog bootstrap] dashboards: ${e.message}`);
    }
    try {
      // 14-day event volume — a baseline snapshot for later comparisons.
      const j = await posthog(auth, `/api/projects/${auth.project_id}/query/`, {
        method: "POST",
        body: JSON.stringify({
          query: {
            kind: "HogQLQuery",
            query:
              "SELECT event, count() AS c FROM events WHERE timestamp > now() - INTERVAL 14 DAY GROUP BY event ORDER BY c DESC LIMIT 15",
          },
        }),
      });
      const lines = (j.results ?? []).map((r: any[]) => `- ${r[0]}: ${Number(r[1]).toLocaleString()}`);
      if (lines.length) sections.push(`## Event volume (last 14 days)\n\n${lines.join("\n")}`);
    } catch (e: any) {
      console.error(`[posthog bootstrap] volume: ${e.message}`);
    }
    return {
      docs: sections.length
        ? [
            {
              name: "analytics-overview",
              title: "PostHog: what the team measures",
              body: `Product analytics for the user's project. The insights/dashboards below are the metrics the team tracks — the user's "work scope" for product/growth questions. Use the posthog_query action for live numbers.\n\n${sections.join("\n\n")}`,
            },
          ]
        : [],
      triage: [],
    };
  },
  actions: [
    {
      name: "posthog_query",
      readOnly: true,
      description:
        "Run a HogQL (SQL) query against PostHog product analytics. Main table: events(event, timestamp, distinct_id, properties). Example: SELECT toDate(timestamp) AS d, count() FROM events WHERE event = '$pageview' AND timestamp > now() - INTERVAL 7 DAY GROUP BY d ORDER BY d. Use for live metrics: signups, pageviews, feature usage, trends.",
      schema: { query: z.string().describe("HogQL query (ClickHouse SQL dialect)") },
      async run(auth, input): Promise<ActionResult> {
        try {
          const j = await posthog(auth, `/api/projects/${auth.project_id}/query/`, {
            method: "POST",
            body: JSON.stringify({ query: { kind: "HogQLQuery", query: String(input.query) } }),
          });
          return {
            ok: true,
            output: { columns: j.columns ?? [], results: (j.results ?? []).slice(0, 200) },
          };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
  ],
};
