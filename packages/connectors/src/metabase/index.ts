import { z } from "zod";
import type { AuthBlob } from "@ami/shared";
import type { AmiConnector, ActionResult, BootstrapResult } from "../types.js";

/** Metabase: the BI layer as an agent tool. No polling streams — dashboards
 * aren't inbox items. Bootstrap ingests the last month of questions and
 * dashboards into the knowledge graph; actions let agents run SQL, save
 * questions, and pin them to dashboards. */

function host(auth: AuthBlob): string {
  return (auth.host ?? "").trim().replace(/\/+$/, "");
}

async function metabase(auth: AuthBlob, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${host(auth)}${path}`, {
    ...init,
    headers: {
      "x-api-key": auth.api_key,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = typeof j.message === "string" ? j.message : typeof j.errors === "object" ? JSON.stringify(j.errors) : res.status;
    throw new Error(`metabase ${path.split("?")[0]}: ${msg}`);
  }
  return j;
}

const MONTH_MS = 30 * 24 * 3600_000;

function recent(item: any): boolean {
  const t = Date.parse(item.updated_at ?? item.created_at ?? "");
  return Number.isFinite(t) && Date.now() - t < MONTH_MS;
}

export const metabaseConnector: AmiConnector = {
  id: "metabase",
  meta: {
    label: "Metabase",
    authKind: "token",
    authFields: [
      { key: "host", label: "Metabase URL", placeholder: "https://metabase.yourco.com" },
      { key: "api_key", label: "API key (mb_…)", secret: true },
    ],
    setupHelp:
      "In Metabase: Admin settings → Authentication → API keys → Create API key (choose a group with query and collection access). Paste your Metabase URL and the key.",
  },
  async validateAuth(auth) {
    try {
      const me = await metabase(auth, "/api/user/current");
      return { ok: true, accountLabel: me.common_name ?? me.email ?? "metabase" };
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
    const sections: string[] = [];

    // Questions (cards) touched in the last month — the SQL is knowledge: it
    // encodes what the team's metrics actually mean.
    onProgress?.("reading recent questions");
    try {
      const cards: any[] = await metabase(auth, "/api/card");
      const lines = cards
        .filter(recent)
        .sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))
        .slice(0, 40)
        .map((c) => {
          const sql = c.dataset_query?.type === "native" ? String(c.dataset_query.native?.query ?? "") : "";
          return [
            `- **${c.name}** (question #${c.id})`,
            c.description ? `${c.description}` : "",
            c.creator?.common_name ? `by ${c.creator.common_name}` : "",
            `updated ${String(c.updated_at ?? c.created_at ?? "").slice(0, 10)}`,
            sql ? `\n  \`\`\`sql\n  ${sql.replace(/\s+/g, " ").trim().slice(0, 300)}\n  \`\`\`` : "",
          ]
            .filter(Boolean)
            .join(" — ");
        });
      if (lines.length) sections.push(`## Questions updated in the last month\n\n${lines.join("\n")}`);
    } catch (e: any) {
      console.error(`[metabase bootstrap] cards: ${e.message}`);
    }

    onProgress?.("reading recent dashboards");
    try {
      const j = await metabase(auth, "/api/dashboard");
      const dashboards: any[] = Array.isArray(j) ? j : (j.data ?? []);
      const lines = dashboards
        .filter(recent)
        .slice(0, 25)
        .map((d) =>
          [
            `- **${d.name}** (dashboard #${d.id})`,
            d.description ? `${d.description}` : "",
            d.creator?.common_name ? `by ${d.creator.common_name}` : "",
            `updated ${String(d.updated_at ?? d.created_at ?? "").slice(0, 10)}`,
          ]
            .filter(Boolean)
            .join(" — "),
        );
      if (lines.length) sections.push(`## Dashboards updated in the last month\n\n${lines.join("\n")}`);
    } catch (e: any) {
      console.error(`[metabase bootstrap] dashboards: ${e.message}`);
    }

    return {
      docs: sections.length
        ? [
            {
              name: "bi-overview",
              title: "Metabase: questions and dashboards from the last month",
              body: `The team's BI layer — these questions/dashboards are the metrics the user's team actively works with. Agents can run SQL via metabase_run_query, save questions, and add them to dashboards.\n\n${sections.join("\n\n")}`,
            },
          ]
        : [],
      triage: [],
    };
  },
  actions: [
    {
      name: "metabase_list_databases",
      readOnly: true,
      description: "List the databases configured in Metabase (id, name, engine) — needed to run or save queries.",
      schema: {},
      async run(auth): Promise<ActionResult> {
        try {
          const j = await metabase(auth, "/api/database");
          const dbs: any[] = Array.isArray(j) ? j : (j.data ?? []);
          return { ok: true, output: dbs.map((d) => ({ id: d.id, name: d.name, engine: d.engine })) };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "metabase_list_dashboards",
      readOnly: true,
      description: "List Metabase dashboards (id, name, description) — for picking a dashboard to add questions to.",
      schema: {},
      async run(auth): Promise<ActionResult> {
        try {
          const j = await metabase(auth, "/api/dashboard");
          const dashboards: any[] = Array.isArray(j) ? j : (j.data ?? []);
          return {
            ok: true,
            output: dashboards.map((d) => ({ id: d.id, name: d.name, description: d.description ?? "" })),
          };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "metabase_run_query",
      readOnly: true,
      description:
        "Run an ad-hoc SQL query against a Metabase database and return the rows (nothing is saved). Get the databaseId from metabase_list_databases.",
      schema: {
        databaseId: z.number().int(),
        sql: z.string().describe("SQL in the database's dialect"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const j = await metabase(auth, "/api/dataset", {
            method: "POST",
            body: JSON.stringify({
              database: input.databaseId,
              type: "native",
              native: { query: String(input.sql) },
            }),
          });
          if (j.error) return { ok: false, output: null, error: String(j.error) };
          return {
            ok: true,
            output: {
              columns: (j.data?.cols ?? []).map((c: any) => c.display_name ?? c.name),
              rows: (j.data?.rows ?? []).slice(0, 200),
              rowCount: j.row_count ?? j.data?.rows?.length ?? 0,
            },
          };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "metabase_save_question",
      description:
        "Save a SQL query as a Metabase question (card) so the team can see and reuse it. Returns the question id and URL.",
      schema: {
        name: z.string().describe("Question title"),
        description: z.string().nullable().describe("What this question shows"),
        databaseId: z.number().int(),
        sql: z.string(),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const j = await metabase(auth, "/api/card", {
            method: "POST",
            body: JSON.stringify({
              name: String(input.name),
              description: input.description ? String(input.description) : null,
              display: "table",
              visualization_settings: {},
              dataset_query: {
                database: input.databaseId,
                type: "native",
                native: { query: String(input.sql) },
              },
            }),
          });
          return { ok: true, externalId: String(j.id), url: `${host(auth)}/question/${j.id}`, output: { id: j.id } };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "metabase_add_to_dashboard",
      description:
        "Add a saved question (card) to a Metabase dashboard, placed below the existing cards. Use metabase_list_dashboards / metabase_save_question for the ids. Tabbed dashboards: pass tabName to pick the tab (e.g. the tab where related cards already live) — otherwise the first tab is used. Success is verified by re-reading the dashboard.",
      schema: {
        dashboardId: z.number().int(),
        cardId: z.number().int().describe("Question id from metabase_save_question"),
        tabName: z.string().optional().describe("For tabbed dashboards: tab to add the card to (substring match, case-insensitive; defaults to the first tab)"),
      },
      async run(auth, input): Promise<ActionResult> {
        const dashId = input.dashboardId;
        const cardId = input.cardId;
        const url = `${host(auth)}/dashboard/${dashId}`;
        const cardsOf = (d: any): any[] => d.dashcards ?? d.ordered_cards ?? [];
        const isAttached = async () => cardsOf(await metabase(auth, `/api/dashboard/${dashId}`)).some((c: any) => c.card_id === cardId);
        try {
          const dash = await metabase(auth, `/api/dashboard/${dashId}`);
          const existing = cardsOf(dash);
          if (existing.some((c: any) => c.card_id === cardId)) {
            return { ok: true, url, output: { dashboardId: dashId, cardId, note: "card is already on this dashboard" } };
          }
          // Tabbed dashboards: every dashcard must belong to a tab, and row
          // layout is per tab — place the card below its tab's cards only.
          const tabs: any[] = dash.tabs ?? [];
          const want = String(input.tabName ?? "").toLowerCase();
          const tab = tabs.length
            ? ((want && tabs.find((t) => String(t.name ?? "").toLowerCase().includes(want))) ?? tabs[0])
            : null;
          const peers = tab ? existing.filter((c: any) => c.dashboard_tab_id === tab.id) : existing;
          const nextRow = peers.reduce((m: number, c: any) => Math.max(m, (c.row ?? 0) + (c.size_y ?? 4)), 0);
          const newCard: any = { id: -1, card_id: cardId, row: nextRow, col: 0, size_x: 12, size_y: 8 };
          if (tab) newCard.dashboard_tab_id = tab.id;

          // Modern API (v48+): PUT the full dashcards array back (tabs must be
          // echoed too, or tabbed dashboards reject/lose them).
          let modernError = "";
          try {
            await metabase(auth, `/api/dashboard/${dashId}`, {
              method: "PUT",
              body: JSON.stringify({ dashcards: [...existing, newCard], ...(tabs.length ? { tabs } : {}) }),
            });
          } catch (e: any) {
            modernError = e.message;
          }
          // Verify: pre-v48 servers 200 the PUT but silently ignore `dashcards`.
          if (!modernError && (await isAttached())) {
            return { ok: true, url, output: { dashboardId: dashId, cardId, tab: tab?.name ?? null } };
          }
          // Older Metabase: legacy add-card endpoint (404 on v48+ just means
          // "not this vintage" — never report it as THE error).
          let legacyError = "";
          try {
            await metabase(auth, `/api/dashboard/${dashId}/cards`, {
              method: "POST",
              body: JSON.stringify({ cardId, row: nextRow, col: 0, size_x: 12, size_y: 8 }),
            });
          } catch (e: any) {
            legacyError = e.message;
          }
          if (await isAttached()) {
            return { ok: true, url, output: { dashboardId: dashId, cardId, tab: null } };
          }
          return {
            ok: false,
            output: null,
            error: `card not attached — modern PUT: ${modernError || "accepted but had no effect"}; legacy POST: ${legacyError || "accepted but had no effect"}`,
          };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
  ],
};
