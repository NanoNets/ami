import { z } from "zod";
import type { NormalizedSignal } from "@ami/shared";
import type { AmiConnector, ActionResult, BootstrapResult } from "../types.js";

const API = "https://api.hubapi.com";

async function hubspot(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`hubspot ${path}: ${j.message ?? res.status}`);
  return j;
}

const DEAL_PROPERTIES = [
  "dealname",
  "dealstage",
  "pipeline",
  "amount",
  "closedate",
  "hs_lastmodifieddate",
  "hs_is_closed",
];

/** dealstage/pipeline come back as internal ids — resolve to human labels. */
async function stageLabels(token: string): Promise<Map<string, { stage: string; pipeline: string }>> {
  const map = new Map<string, { stage: string; pipeline: string }>();
  try {
    const j = await hubspot(token, "/crm/v3/pipelines/deals");
    for (const p of j.results ?? []) {
      for (const s of p.stages ?? []) {
        map.set(s.id, { stage: s.label, pipeline: p.label });
      }
    }
  } catch {
    /* labels degrade to raw ids */
  }
  return map;
}

function fmtAmount(amount?: string): string {
  const n = parseFloat(amount ?? "");
  return Number.isFinite(n) && n > 0 ? n.toLocaleString() : "";
}

export const hubspotConnector: AmiConnector = {
  id: "hubspot",
  meta: {
    label: "HubSpot",
    authKind: "token",
    authFields: [
      { key: "token", label: "Private app access token (pat-…)", placeholder: "pat-…", secret: true },
    ],
    setupHelp:
      "In HubSpot: Settings → Integrations → Private Apps → Create app. Grant read scopes: crm.objects.deals.read, crm.objects.contacts.read, crm.objects.companies.read, crm.objects.owners.read. Paste the access token (pat-…).",
  },
  async validateAuth(auth) {
    try {
      const j = await hubspot(auth.token, "/account-info/v3/details");
      return { ok: true, accountLabel: `portal ${j.portalId}${j.uiDomain ? ` (${j.uiDomain})` : ""}` };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
  streams() {
    return [{ name: "deals", intervalSec: 300 }];
  },
  async poll({ auth, cursor }) {
    // Deal changes since the cursor. The externalId embeds the current stage,
    // so the dedup index turns "any modification" into effectively one signal
    // per deal per stage — i.e. stage-change semantics without state diffing.
    const token = auth.token;
    const sinceMs = cursor ? parseInt(cursor, 10) : Date.now() - 24 * 3600_000;
    const j = await hubspot(token, "/crm/v3/objects/deals/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [
          { filters: [{ propertyName: "hs_lastmodifieddate", operator: "GT", value: String(sinceMs) }] },
        ],
        sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
        properties: DEAL_PROPERTIES,
        limit: 50,
      }),
    });
    const deals: any[] = j.results ?? [];
    if (deals.length === 0) return { signals: [], nextCursor: cursor ?? String(sinceMs) };

    const labels = await stageLabels(token);
    const signals: NormalizedSignal[] = [];
    let maxMs = sinceMs;
    for (const d of deals) {
      const p = d.properties ?? {};
      const modified = Date.parse(p.hs_lastmodifieddate ?? "") || sinceMs;
      maxMs = Math.max(maxMs, modified);
      const lbl = labels.get(p.dealstage) ?? { stage: p.dealstage ?? "unknown", pipeline: p.pipeline ?? "" };
      const amount = fmtAmount(p.amount);
      signals.push({
        externalId: `deal:${d.id}:${p.dealstage}`,
        kind: "ticket",
        title: `Deal "${p.dealname ?? d.id}" → ${lbl.stage}${amount ? ` (${amount})` : ""}`,
        body: [
          `HubSpot deal moved to stage "${lbl.stage}"${lbl.pipeline ? ` in pipeline "${lbl.pipeline}"` : ""}.`,
          amount ? `Amount: ${amount}` : "",
          p.closedate ? `Close date: ${p.closedate.slice(0, 10)}` : "",
          p.hs_is_closed === "true" ? "This deal is now closed." : "",
        ]
          .filter(Boolean)
          .join("\n"),
        author: "",
        url: `https://app.hubspot.com/contacts/deal/${d.id}`,
        threadRef: d.id,
        raw: { id: d.id, ...p },
        occurredAt: new Date(modified).toISOString(),
      });
    }
    return { signals, nextCursor: String(maxMs) };
  },
  async bootstrap(auth, onProgress): Promise<BootstrapResult> {
    const token = auth.token;

    // Knowledge: the live pipeline — what deals exist, at which stages, with
    // whom. This is the ground truth triage uses to judge "does this inbound
    // email matter" (FYI scoping).
    onProgress?.("reading deal pipeline");
    const labels = await stageLabels(token);
    const open = await hubspot(token, "/crm/v3/objects/deals/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "hs_is_closed", operator: "EQ", value: "false" }] }],
        sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
        properties: DEAL_PROPERTIES,
        limit: 100,
      }),
    });
    const dealLines = (open.results ?? []).map((d: any) => {
      const p = d.properties ?? {};
      const lbl = labels.get(p.dealstage) ?? { stage: p.dealstage ?? "?", pipeline: "" };
      const amount = fmtAmount(p.amount);
      return [
        `- **${p.dealname ?? d.id}** — ${lbl.stage}`,
        lbl.pipeline ? `pipeline: ${lbl.pipeline}` : "",
        amount ? `amount: ${amount}` : "",
        p.closedate ? `close: ${p.closedate.slice(0, 10)}` : "",
      ]
        .filter(Boolean)
        .join(", ");
    });

    onProgress?.("reading recent contacts");
    let contactLines: string[] = [];
    try {
      const contacts = await hubspot(
        token,
        "/crm/v3/objects/contacts?limit=100&properties=firstname,lastname,email,company,jobtitle&sorts=-lastmodifieddate",
      );
      contactLines = (contacts.results ?? []).map((c: any) => {
        const p = c.properties ?? {};
        const name = [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email || c.id;
        return [`- **${name}**`, p.jobtitle ?? "", p.company ?? "", p.email ? `<${p.email}>` : ""]
          .filter(Boolean)
          .join(" — ");
      });
    } catch (e: any) {
      console.error(`[hubspot bootstrap] contacts: ${e.message}`);
    }

    const sections = [
      dealLines.length ? `## Open deals (${dealLines.length})\n\n${dealLines.join("\n")}` : "",
      contactLines.length ? `## Recent CRM contacts\n\n${contactLines.join("\n")}` : "",
    ].filter(Boolean);

    return {
      docs: sections.length
        ? [
            {
              name: "crm-pipeline",
              title: "HubSpot: pipeline and contacts",
              body: `The user's CRM state. Deals here are active work — inbound email or Slack from these companies/contacts is business-relevant.\n\n${sections.join("\n\n")}`,
            },
          ]
        : [],
      triage: [],
    };
  },
  actions: [
    {
      name: "hubspot_lookup",
      readOnly: true,
      description:
        "Look up CRM context by email, name or company: matching contacts, companies and deals from HubSpot.",
      schema: { query: z.string().describe("Email address, person name, or company name") },
      async run(auth, input): Promise<ActionResult> {
        const q = String(input.query);
        const search = (objectType: string, properties: string[]) =>
          hubspot(auth.token, `/crm/v3/objects/${objectType}/search`, {
            method: "POST",
            body: JSON.stringify({ query: q, properties, limit: 5 }),
          }).catch(() => ({ results: [] }));
        try {
          const [contacts, companies, deals] = await Promise.all([
            search("contacts", ["firstname", "lastname", "email", "company", "jobtitle"]),
            search("companies", ["name", "domain", "industry"]),
            search("deals", DEAL_PROPERTIES),
          ]);
          return {
            ok: true,
            output: {
              contacts: (contacts.results ?? []).map((r: any) => r.properties),
              companies: (companies.results ?? []).map((r: any) => r.properties),
              deals: (deals.results ?? []).map((r: any) => r.properties),
            },
          };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
  ],
};
