import type { AuthBlob } from "@ami/shared";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  // Profile (name) — lets onboarding pre-fill the owner identity from the account.
  "https://www.googleapis.com/auth/userinfo.profile",
  // Drive read — doc comments become signals, recent docs feed the knowledge base.
  "https://www.googleapis.com/auth/drive.readonly",
  // Write limited to files Ami itself creates (gdoc/gsheet/gslides creation) —
  // Ami can never modify or share the user's existing files with this scope.
  "https://www.googleapis.com/auth/drive.file",
].join(" ");

export function googleAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

export async function exchangeGoogleCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }).toString(),
  });
  const j: any = await res.json();
  if (!res.ok || j.error) throw new Error(`google token exchange: ${j.error ?? res.status}`);
  return j;
}

/** Returns a fresh access token, refreshing when past expiry. Mutates the blob in place;
 * caller persists it. */
export async function googleAccessToken(auth: AuthBlob): Promise<string> {
  const expiry = auth.expiry ? parseInt(auth.expiry, 10) : 0;
  if (auth.access_token && Date.now() < expiry - 60_000) return auth.access_token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: auth.client_id,
      client_secret: auth.client_secret,
      refresh_token: auth.refresh_token,
      grant_type: "refresh_token",
    }).toString(),
  });
  const j: any = await res.json();
  if (!res.ok || j.error) throw new Error(`google token refresh: ${j.error ?? res.status}`);
  auth.access_token = j.access_token;
  auth.expiry = String(Date.now() + j.expires_in * 1000);
  return j.access_token;
}

export async function googleApi(auth: AuthBlob, url: string, init: RequestInit = {}): Promise<any> {
  const token = await googleAccessToken(auth);
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`google api ${url}: ${res.status} ${body}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}
