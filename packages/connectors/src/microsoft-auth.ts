import crypto from "node:crypto";
import type { AuthBlob } from "@ami/shared";

/** Microsoft identity platform (Entra) — authorization code + PKCE for a
 * public client (no client secret; the user registers their own app with a
 * "Mobile and desktop applications" redirect URI). One consent covers Graph
 * mail, calendar and Teams chats — the callback registers m365 + msteams. */

export const MS_SCOPES = [
  "offline_access",
  "User.Read",
  "Mail.Read",
  "Mail.Send",
  "Calendars.Read",
  "Chat.Read",
  "Chat.ReadWrite",
].join(" ");

const GRAPH = "https://graph.microsoft.com/v1.0";

function loginBase(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant || "common"}/oauth2/v2.0`;
}

export function msPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function msAuthUrl(clientId: string, tenant: string, redirectUri: string, challenge: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: MS_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "consent",
  });
  return `${loginBase(tenant)}/authorize?${p.toString()}`;
}

export async function exchangeMsCode(
  clientId: string,
  tenant: string,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch(`${loginBase(tenant)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      scope: MS_SCOPES,
    }).toString(),
  });
  const j: any = await res.json();
  if (!res.ok || j.error) throw new Error(`microsoft token exchange: ${j.error_description ?? j.error ?? res.status}`);
  return j;
}

/** Fresh access token, refreshing past expiry. Mutates the blob; caller persists. */
export async function msAccessToken(auth: AuthBlob): Promise<string> {
  const expiry = auth.expiry ? parseInt(auth.expiry, 10) : 0;
  if (auth.access_token && Date.now() < expiry - 60_000) return auth.access_token;
  const res = await fetch(`${loginBase(auth.tenant)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: auth.client_id,
      grant_type: "refresh_token",
      refresh_token: auth.refresh_token,
      scope: MS_SCOPES,
    }).toString(),
  });
  const j: any = await res.json();
  if (!res.ok || j.error) throw new Error(`microsoft token refresh: ${j.error_description ?? j.error ?? res.status}`);
  auth.access_token = j.access_token;
  if (j.refresh_token) auth.refresh_token = j.refresh_token; // MS rotates refresh tokens
  auth.expiry = String(Date.now() + j.expires_in * 1000);
  return j.access_token;
}

export async function msGraph(auth: AuthBlob, path: string, init: RequestInit = {}): Promise<any> {
  const token = await msAccessToken(auth);
  const res = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 204) return {};
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`graph ${path.split("?")[0]}: ${j.error?.message ?? res.status}`);
  }
  return j;
}

/** Graph message bodies are HTML — crude but effective plain-text reduction. */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>(\n)?/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
