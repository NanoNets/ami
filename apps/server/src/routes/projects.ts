import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { codeProjects, type Db } from "@ami/db";
import { newId, nowIso } from "@ami/shared";
import { mergeBack, repoInfo } from "@ami/engine";

export function projectRoutes(db: Db) {
  const app = new Hono();

  app.get("/", (c) => c.json(db.select().from(codeProjects).all()));

  app.post("/", async (c) => {
    const { path: repoPath, name } = await c.req.json<{ path: string; name?: string }>();
    const abs = path.resolve(repoPath.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
    if (!fs.existsSync(abs)) return c.json({ ok: false, error: "path does not exist" }, 400);
    const info = await repoInfo(abs);
    if (!info.isGitRepo) return c.json({ ok: false, error: "not a git repository" }, 400);
    const existing = db.select().from(codeProjects).where(eq(codeProjects.path, abs)).get();
    if (existing) return c.json({ ok: true, project: existing });
    const project = {
      id: newId("proj"),
      name: name?.trim() || path.basename(abs),
      path: abs,
      defaultBranch: info.branch ?? "main",
      createdAt: nowIso(),
    };
    db.insert(codeProjects).values(project).run();
    return c.json({ ok: true, project });
  });

  app.delete("/:id", (c) => {
    db.delete(codeProjects).where(eq(codeProjects.id, c.req.param("id"))).run();
    return c.json({ ok: true });
  });

  /** Merge an ami/<todo> worktree branch back into the project's branch. */
  app.post("/:id/merge-back", async (c) => {
    const { branch } = await c.req.json<{ branch: string }>();
    const project = db.select().from(codeProjects).where(eq(codeProjects.id, c.req.param("id"))).get();
    if (!project) return c.json({ ok: false, error: "project not found" }, 404);
    const result = await mergeBack(project.path, branch);
    return c.json(result);
  });

  return app;
}
