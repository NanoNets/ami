import { z } from "zod";
import type { NormalizedSignal } from "@ami/shared";
import type { AmiConnector, ActionResult, BootstrapResult } from "../types.js";

const API = "https://api.stripe.com";

async function stripe(key: string, path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`stripe ${path.split("?")[0]}: ${j.error?.message ?? res.status}`);
  return j;
}

/** The billing events worth interrupting a founder for. */
const EVENT_TYPES: Record<string, string> = {
  "invoice.payment_failed": "Payment failed",
  "invoice.payment_action_required": "Payment needs customer action",
  "customer.subscription.created": "New subscription",
  "customer.subscription.deleted": "Subscription canceled",
  "charge.dispute.created": "Dispute opened",
};

function money(amount: number | null | undefined, currency?: string): string {
  if (amount == null) return "";
  return `${(amount / 100).toLocaleString()} ${(currency ?? "").toUpperCase()}`.trim();
}

function eventSignal(e: any): NormalizedSignal {
  const label = EVENT_TYPES[e.type] ?? e.type;
  const o = e.data?.object ?? {};
  const customerEmail = o.customer_email ?? o.receipt_email ?? "";
  const amount = money(o.amount_due ?? o.amount ?? o.plan?.amount ?? null, o.currency);
  const details = [
    customerEmail ? `Customer: ${customerEmail}` : o.customer ? `Customer: ${o.customer}` : "",
    amount ? `Amount: ${amount}` : "",
    o.plan?.nickname ? `Plan: ${o.plan.nickname}` : "",
    e.type === "invoice.payment_failed" && o.attempt_count ? `Attempt ${o.attempt_count}` : "",
    e.type === "customer.subscription.deleted" && o.cancellation_details?.reason
      ? `Reason: ${o.cancellation_details.reason}`
      : "",
  ].filter(Boolean);
  return {
    externalId: e.id,
    kind: "event",
    title: `Stripe: ${label}${customerEmail ? ` — ${customerEmail}` : ""}${amount ? ` (${amount})` : ""}`,
    body: `${label}.\n${details.join("\n")}`,
    author: "",
    url: `https://dashboard.stripe.com/${e.livemode ? "" : "test/"}events/${e.id}`,
    threadRef: typeof o.customer === "string" ? o.customer : null,
    raw: { id: e.id, type: e.type, customer: o.customer },
    occurredAt: new Date(e.created * 1000).toISOString(),
  };
}

async function fetchEvents(key: string, sinceEpoch: number): Promise<{ signals: NormalizedSignal[]; max: number }> {
  const types = Object.keys(EVENT_TYPES)
    .map((t) => `types[]=${encodeURIComponent(t)}`)
    .join("&");
  const j = await stripe(key, `/v1/events?limit=50&created[gt]=${sinceEpoch}&${types}`);
  const signals: NormalizedSignal[] = [];
  let max = sinceEpoch;
  for (const e of (j.data ?? []).reverse()) {
    max = Math.max(max, e.created);
    signals.push(eventSignal(e));
  }
  return { signals, max };
}

export const stripeConnector: AmiConnector = {
  id: "stripe",
  meta: {
    label: "Stripe",
    authKind: "token",
    authFields: [
      { key: "api_key", label: "API key (restricted key recommended)", placeholder: "rk_live_… / sk_live_…", secret: true },
    ],
    setupHelp:
      "Create a restricted key at dashboard.stripe.com/apikeys (read access to Events, Customers, Subscriptions, Invoices) and paste it. Ami only reads — it never creates charges.",
  },
  async validateAuth(auth) {
    try {
      const j = await stripe(auth.api_key, "/v1/account");
      return { ok: true, accountLabel: j.settings?.dashboard?.display_name ?? j.email ?? j.id };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
  streams() {
    return [{ name: "events", intervalSec: 120 }];
  },
  async poll({ auth, cursor }) {
    const since = cursor ? parseInt(cursor, 10) : Math.floor(Date.now() / 1000) - 24 * 3600;
    const { signals, max } = await fetchEvents(auth.api_key, since);
    return { signals, nextCursor: String(max) };
  },
  async bootstrap(auth, onProgress): Promise<BootstrapResult> {
    const key = auth.api_key;

    // Knowledge: the revenue picture — active subscriptions and rough MRR.
    onProgress?.("reading subscriptions");
    const sections: string[] = [];
    try {
      const j = await stripe(key, "/v1/subscriptions?status=active&limit=100");
      const subs: any[] = j.data ?? [];
      let monthly = 0;
      let currency = "";
      for (const s of subs) {
        for (const item of s.items?.data ?? []) {
          const p = item.price ?? {};
          if (!p.unit_amount || !p.recurring) continue;
          currency = p.currency ?? currency;
          const qty = item.quantity ?? 1;
          const perMonth =
            p.recurring.interval === "year"
              ? (p.unit_amount * qty) / 12
              : p.recurring.interval === "month"
                ? p.unit_amount * qty
                : 0;
          monthly += perMonth;
        }
      }
      sections.push(
        `## Subscriptions\n\n- Active subscriptions: ${subs.length}${j.has_more ? "+" : ""}\n- Approximate MRR: ${money(Math.round(monthly), currency)}`,
      );
    } catch (e: any) {
      console.error(`[stripe bootstrap] subscriptions: ${e.message}`);
    }

    // First task list: payment failures and disputes from the last 7 days —
    // things a founder acts on.
    onProgress?.("reading recent billing events");
    let triage: NormalizedSignal[] = [];
    try {
      const since = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
      const { signals } = await fetchEvents(key, since);
      triage = signals
        .filter((s) => /payment_failed|dispute|payment_action_required/.test(String((s.raw as any)?.type)))
        .slice(0, 10);
    } catch (e: any) {
      console.error(`[stripe bootstrap] events: ${e.message}`);
    }

    return {
      docs: sections.length
        ? [
            {
              name: "billing-overview",
              title: "Stripe: revenue snapshot",
              body: `The user's Stripe billing state at connect time. Payment failures, new subscriptions, cancellations and disputes arrive as signals from here on.\n\n${sections.join("\n\n")}`,
            },
          ]
        : [],
      triage,
    };
  },
  actions: [
    {
      name: "stripe_customer_context",
      readOnly: true,
      description:
        "Look up a Stripe customer by email or customer id: subscriptions, recent invoices and payment status.",
      schema: { customer: z.string().describe("Email address or customer id (cus_…)") },
      async run(auth, input): Promise<ActionResult> {
        const key = auth.api_key;
        const q = String(input.customer);
        try {
          let customer: any;
          if (q.startsWith("cus_")) {
            customer = await stripe(key, `/v1/customers/${q}`);
          } else {
            const s = await stripe(key, `/v1/customers/search?query=${encodeURIComponent(`email:'${q}'`)}`);
            customer = s.data?.[0];
          }
          if (!customer) return { ok: false, output: null, error: "customer not found" };
          const [subs, invoices] = await Promise.all([
            stripe(key, `/v1/subscriptions?customer=${customer.id}&status=all&limit=5`),
            stripe(key, `/v1/invoices?customer=${customer.id}&limit=5`),
          ]);
          return {
            ok: true,
            output: {
              id: customer.id,
              email: customer.email,
              name: customer.name,
              created: customer.created ? new Date(customer.created * 1000).toISOString() : null,
              subscriptions: (subs.data ?? []).map((s: any) => ({
                status: s.status,
                plan: s.items?.data?.[0]?.price?.nickname ?? s.items?.data?.[0]?.price?.id,
                amount: money(s.items?.data?.[0]?.price?.unit_amount, s.items?.data?.[0]?.price?.currency),
                interval: s.items?.data?.[0]?.price?.recurring?.interval,
              })),
              invoices: (invoices.data ?? []).map((i: any) => ({
                status: i.status,
                amount: money(i.amount_due, i.currency),
                created: new Date(i.created * 1000).toISOString().slice(0, 10),
              })),
            },
          };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "stripe_search_customers",
      readOnly: true,
      description:
        "Search Stripe customers by name or email substring. Returns matches — pass an id or email to stripe_customer_context for subscriptions and invoices.",
      schema: {
        query: z.string().describe("Name or email fragment"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
      },
      async run(auth, input): Promise<ActionResult> {
        const key = auth.api_key;
        try {
          const limit = Math.min(Number(input.limit) || 10, 25);
          const escaped = String(input.query).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
          const q = `name~'${escaped}' OR email~'${escaped}'`;
          const j = await stripe(key, `/v1/customers/search?query=${encodeURIComponent(q)}&limit=${limit}`);
          const customers = (j.data ?? []).map((c: any) => ({
            id: c.id,
            name: c.name,
            email: c.email,
            created: c.created ? new Date(c.created * 1000).toISOString().slice(0, 10) : null,
          }));
          return { ok: true, output: customers };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
  ],
};
