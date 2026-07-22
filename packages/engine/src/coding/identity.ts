import { connectorAccounts, getSetting, type Db } from "@ami/db";
import { eq } from "drizzle-orm";

/** Git author/committer env for agent runs. Commits must be attributed to the
 * user, not an invented identity — deploy platforms (Vercel etc.) gate on the
 * commit author's GitHub account. Prefers the connected GitHub account: its
 * noreply address is always linked, so attribution can't silently break. */

let cached: { name: string; email: string } | null | undefined;

async function resolveGitIdentity(db: Db): Promise<{ name: string; email: string } | null> {
  if (cached !== undefined) return cached;

  const gh = db.select().from(connectorAccounts).where(eq(connectorAccounts.connector, "github")).get();
  if (gh) {
    try {
      const token = JSON.parse(gh.authJson).token as string;
      const res = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (res.ok) {
        const me: any = await res.json();
        cached = {
          name: me.name || me.login,
          // Public profile email when set, else the account's noreply address
          // (guaranteed linked to the GitHub account).
          email: me.email || `${me.id}+${me.login}@users.noreply.github.com`,
        };
        return cached;
      }
    } catch {
      // fall through to identity settings
    }
  }

  const name = getSetting(db, "user_name");
  const email = getSetting(db, "user_email");
  cached = name && email ? { name, email } : null;
  return cached;
}

export async function gitIdentityEnv(db: Db): Promise<Record<string, string>> {
  const id = await resolveGitIdentity(db);
  if (!id) return {};
  return {
    GIT_AUTHOR_NAME: id.name,
    GIT_AUTHOR_EMAIL: id.email,
    GIT_COMMITTER_NAME: id.name,
    GIT_COMMITTER_EMAIL: id.email,
  };
}
