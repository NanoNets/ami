import { z } from "zod";
import crypto from "node:crypto";
import type { AuthBlob } from "@ami/shared";
import type { AmiConnector, ActionResult } from "../types.js";

/** Short-lived JWT for the Ghost Admin API, signed from the `id:secret` admin key. */
function ghostJwt(adminKey: string): string {
  const [id, secret] = adminKey.split(":");
  if (!id || !secret) throw new Error("ghost admin key must look like <id>:<secret>");
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "HS256", typ: "JWT", kid: id });
  const payload = b64({ iat: now, exp: now + 300, aud: "/admin/" });
  const sig = crypto
    .createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

async function ghostApi(auth: AuthBlob, path: string, init: RequestInit = {}): Promise<any> {
  const base = auth.url.replace(/\/+$/, "");
  const res = await fetch(`${base}/ghost/api/admin${path}`, {
    ...init,
    headers: {
      Authorization: `Ghost ${ghostJwt(auth.admin_key)}`,
      "Accept-Version": "v5.0",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`ghost ${path}: ${j.errors?.[0]?.message ?? res.status}`);
  }
  return j;
}

const stripHtml = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export const ghostConnector: AmiConnector = {
  id: "ghost",
  meta: {
    label: "Ghost",
    authKind: "token",
    authFields: [
      { key: "url", label: "Blog URL", placeholder: "https://blog.example.com" },
      { key: "admin_key", label: "Admin API key (id:secret)", secret: true },
    ],
    setupHelp:
      "Add a custom integration named Ami and copy its Admin API key (id:secret format) here.",
    setupActions: [{ label: "Open your Ghost integrations", url: "{url}/ghost/#/settings/integrations/new" }],
  },
  async validateAuth(auth) {
    try {
      const j = await ghostApi(auth, "/site/");
      return { ok: true, accountLabel: j.site?.title ?? auth.url };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
  streams() {
    return []; // Ghost is a publish destination; nothing actionable arrives from it.
  },
  async poll() {
    return { signals: [], nextCursor: null };
  },
  actions: [
    {
      name: "ghost_list_posts",
      readOnly: true,
      description:
        "List posts on the user's Ghost blog (drafts and published), newest first. Use to see what exists, avoid duplicate topics, and match the blog's style.",
      schema: {
        status: z.enum(["all", "draft", "published"]).default("all"),
        limit: z.number().int().min(1).max(50).default(15),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const filter = input.status && input.status !== "all" ? `&filter=status:${input.status}` : "";
          const j = await ghostApi(
            auth,
            `/posts/?limit=${input.limit ?? 15}&order=updated_at%20desc&formats=html${filter}`,
          );
          const posts = (j.posts ?? []).map((p: any) => ({
            id: p.id,
            title: p.title,
            status: p.status,
            slug: p.slug,
            url: p.url,
            updatedAt: p.updated_at,
            excerpt: p.custom_excerpt ?? stripHtml(p.html ?? "").slice(0, 200),
          }));
          return { ok: true, output: posts };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "ghost_search_posts",
      readOnly: true,
      description:
        "Search the blog's posts by title keywords (drafts and published). Read a match with ghost_get_post; use ghost_list_posts for a plain newest-first listing.",
      schema: {
        query: z.string().describe("Title keywords"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const limit = Math.min(Number(input.limit) || 10, 25);
          const escaped = String(input.query).replace(/'/g, "\\'");
          const j = await ghostApi(
            auth,
            `/posts/?limit=${limit}&order=updated_at%20desc&filter=${encodeURIComponent(`title:~'${escaped}'`)}`,
          );
          const posts = (j.posts ?? []).map((p: any) => ({
            id: p.id,
            title: p.title,
            status: p.status,
            updatedAt: p.updated_at,
            url: p.url,
          }));
          return { ok: true, output: posts };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "ghost_get_post",
      readOnly: true,
      description: "Read the full content of one Ghost post by id (returns HTML).",
      schema: { postId: z.string() },
      async run(auth, input): Promise<ActionResult> {
        try {
          const j = await ghostApi(auth, `/posts/${input.postId}/?formats=html`);
          const p = j.posts?.[0];
          return {
            ok: true,
            output: { id: p.id, title: p.title, status: p.status, html: p.html, tags: p.tags?.map((t: any) => t.name) },
          };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "ghost_create_draft",
      description:
        "Create a new DRAFT post on the user's Ghost blog from HTML content. The post is never published — the user publishes from Ghost admin. Report the returned URL as an artifact.",
      schema: {
        title: z.string(),
        html: z.string().describe("Post body as HTML"),
        excerpt: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const j = await ghostApi(auth, "/posts/?source=html", {
            method: "POST",
            body: JSON.stringify({
              posts: [
                {
                  title: input.title,
                  html: input.html,
                  status: "draft",
                  custom_excerpt: input.excerpt,
                  tags: ((input.tags as string[]) ?? []).map((name) => ({ name })),
                },
              ],
            }),
          });
          const p = j.posts?.[0];
          const editUrl = `${auth.url.replace(/\/+$/, "")}/ghost/#/editor/post/${p.id}`;
          return { ok: true, url: editUrl, externalId: p.id, output: { id: p.id, editUrl, status: p.status } };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "ghost_update_post",
      description:
        "Update the title, content, excerpt or tags of an existing Ghost post. Cannot change publish status and cannot delete — drafts stay drafts.",
      schema: {
        postId: z.string(),
        title: z.string().optional(),
        html: z.string().optional(),
        excerpt: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const current = (await ghostApi(auth, `/posts/${input.postId}/`)).posts?.[0];
          if (!current) return { ok: false, output: null, error: "post not found" };
          const post: Record<string, unknown> = { updated_at: current.updated_at };
          if (input.title) post.title = input.title;
          if (input.html) post.html = input.html;
          if (input.excerpt) post.custom_excerpt = input.excerpt;
          if (input.tags) post.tags = (input.tags as string[]).map((name) => ({ name }));
          const j = await ghostApi(auth, `/posts/${input.postId}/?source=html`, {
            method: "PUT",
            body: JSON.stringify({ posts: [post] }),
          });
          const p = j.posts?.[0];
          return { ok: true, externalId: p.id, output: { id: p.id, status: p.status, updatedAt: p.updated_at } };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "ghost_list_themes",
      readOnly: true,
      description: "List themes installed on the Ghost blog and which one is active.",
      schema: {},
      async run(auth): Promise<ActionResult> {
        try {
          const j = await ghostApi(auth, "/themes/");
          const themes = (j.themes ?? []).map((t: any) => ({
            name: t.name,
            active: !!t.active,
            version: t.package?.version,
          }));
          return { ok: true, output: themes };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "ghost_activate_theme",
      description:
        "Activate an already-installed theme on the Ghost blog (see ghost_list_themes for names). Cannot upload or delete themes.",
      schema: { name: z.string() },
      async run(auth, input): Promise<ActionResult> {
        try {
          const j = await ghostApi(auth, `/themes/${encodeURIComponent(String(input.name))}/activate/`, {
            method: "PUT",
          });
          const t = j.themes?.[0];
          return { ok: true, output: { activated: t?.name, active: t?.active } };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
  ],
};
