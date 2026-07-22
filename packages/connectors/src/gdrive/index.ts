import { z } from "zod";
import type { NormalizedSignal } from "@ami/shared";
import type { AmiConnector, ActionResult, BootstrapResult } from "../types.js";
import { googleAccessToken, googleApi } from "../google-auth.js";

/** Google Drive/Docs. Shares the Google OAuth blob with gmail/gcal (registered
 * by the same callback) — needs the drive.readonly scope. */

const DRIVE = "https://www.googleapis.com/drive/v3";
const GOOGLE_DOC_MIME = "application/vnd.google-apps.";

interface DriveCursor {
  pageToken: string;
  /** Comments older than this are ignored (ISO). */
  since: string;
}

function extractFileId(input: string): string {
  // Accepts a raw file id or any Drive/Docs URL.
  const m = input.match(/[-\w]{25,}/);
  return m ? m[0] : input;
}

/** Multipart upload with conversion to a native Google format (Doc/Sheet).
 * Files land in My Drive, private — Ami never shares them. */
async function driveCreate(
  auth: any,
  args: { title: string; targetMime: string; content: string; contentType: string },
): Promise<{ id: string; link: string }> {
  const boundary = `ami${Math.random().toString(36).slice(2)}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({ name: args.title, mimeType: args.targetMime }),
    `--${boundary}`,
    `Content-Type: ${args.contentType}`,
    "",
    args.content,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await googleAccessToken(auth)}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`drive upload: ${j.error?.message ?? res.status}`);
  return { id: j.id, link: j.webViewLink };
}

export const gdriveConnector: AmiConnector = {
  id: "gdrive",
  meta: {
    label: "Google Drive",
    authKind: "oauth",
    authFields: [],
    setupHelp: "Connected automatically with Google (Gmail) — no separate setup.",
  },
  async validateAuth(auth) {
    try {
      const j = await googleApi(auth, `${DRIVE}/about?fields=user`);
      return { ok: true, accountLabel: j.user?.emailAddress ?? "google" };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
  streams() {
    return [{ name: "comments", intervalSec: 180 }];
  },
  async poll({ auth, cursor }) {
    // Changes feed → for changed Google docs, new unresolved comments by
    // others become signals ("+mention in a doc" is a classic buried task).
    const signals: NormalizedSignal[] = [];
    let cur: DriveCursor | null = null;
    try {
      cur = JSON.parse(cursor ?? "");
    } catch {
      /* first run */
    }
    if (!cur?.pageToken) {
      const j = await googleApi(auth, `${DRIVE}/changes/startPageToken`);
      return { signals: [], nextCursor: JSON.stringify({ pageToken: j.startPageToken, since: new Date().toISOString() }) };
    }

    const changes = await googleApi(
      auth,
      `${DRIVE}/changes?pageToken=${cur.pageToken}&pageSize=50&fields=newStartPageToken,nextPageToken,changes(fileId,file(id,name,mimeType,modifiedTime))`,
    );
    const nextToken = changes.newStartPageToken ?? changes.nextPageToken ?? cur.pageToken;
    const docs = (changes.changes ?? [])
      .map((c: any) => c.file)
      .filter((f: any) => f?.mimeType?.startsWith(GOOGLE_DOC_MIME));

    for (const f of docs.slice(0, 15)) {
      try {
        const j = await googleApi(
          auth,
          `${DRIVE}/files/${f.id}/comments?pageSize=20&fields=comments(id,author(displayName,me),content,modifiedTime,resolved,quotedFileContent(value),replies(author(displayName,me),content,modifiedTime))`,
        );
        for (const cm of j.comments ?? []) {
          if (cm.resolved || cm.author?.me) continue;
          const latest = [cm, ...(cm.replies ?? [])]
            .map((x: any) => x.modifiedTime)
            .sort()
            .pop();
          if (!latest || latest <= cur.since) continue;
          const replies = (cm.replies ?? [])
            .slice(-5)
            .map((r: any) => `${r.author?.me ? "Me" : (r.author?.displayName ?? "someone")}: ${String(r.content ?? "").slice(0, 300)}`)
            .join("\n");
          signals.push({
            externalId: `comment:${f.id}:${cm.id}:${latest}`,
            kind: "message",
            title: `Comment on "${f.name}" from ${cm.author?.displayName ?? "someone"}`,
            body: [
              cm.quotedFileContent?.value ? `On: "${String(cm.quotedFileContent.value).slice(0, 200)}"` : "",
              String(cm.content ?? "").slice(0, 1500),
              replies ? `--- Replies ---\n${replies}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
            author: cm.author?.displayName ?? "",
            url: `https://docs.google.com/document/d/${f.id}`,
            threadRef: `${f.id}:${cm.id}`,
            raw: { fileId: f.id, fileName: f.name, commentId: cm.id },
            occurredAt: latest,
          });
        }
      } catch (e: any) {
        console.error(`[gdrive comments] ${f.name}: ${e.message}`);
      }
    }
    return {
      signals,
      nextCursor: JSON.stringify({ pageToken: nextToken, since: new Date().toISOString() } satisfies DriveCursor),
    };
  },
  async bootstrap(auth, onProgress): Promise<BootstrapResult> {
    // Knowledge: what the user has been working on in Drive lately.
    onProgress?.("reading recent documents");
    const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    const j = await googleApi(
      auth,
      `${DRIVE}/files?q=${encodeURIComponent(`mimeType contains 'application/vnd.google-apps' and modifiedTime > '${since}' and trashed = false`)}&orderBy=modifiedTime desc&pageSize=50&fields=files(name,mimeType,modifiedTime,webViewLink,owners(displayName,me))`,
    );
    const files: any[] = j.files ?? [];
    const lines = files.map((f) => {
      const kind = f.mimeType.replace(GOOGLE_DOC_MIME, "");
      const owner = f.owners?.[0]?.me ? "" : f.owners?.[0]?.displayName;
      return `- [${f.name}](${f.webViewLink}) — ${kind}, edited ${f.modifiedTime.slice(0, 10)}${owner ? `, owner: ${owner}` : ""}`;
    });
    return {
      docs: lines.length
        ? [
            {
              name: "recent-documents",
              title: "Google Drive: documents active in the last 30 days",
              body: `Documents the user created, edited or had shared with them recently — their active work surfaces.\n\n${lines.join("\n")}`,
            },
          ]
        : [],
      triage: [],
    };
  },
  actions: [
    {
      name: "gdoc_read",
      readOnly: true,
      description:
        "Read the text content of a Google Doc/Sheet/Slides file. Input is the file id or any Drive/Docs URL.",
      schema: { fileRef: z.string().describe("File id or URL") },
      async run(auth, input): Promise<ActionResult> {
        const id = extractFileId(String(input.fileRef));
        try {
          const meta = await googleApi(auth, `${DRIVE}/files/${id}?fields=name,mimeType`);
          const mime = meta.mimeType?.endsWith("spreadsheet") ? "text/csv" : "text/plain";
          const res = await fetch(`${DRIVE}/files/${id}/export?mimeType=${encodeURIComponent(mime)}`, {
            headers: { Authorization: `Bearer ${await googleAccessToken(auth)}` },
          });
          if (!res.ok) return { ok: false, output: null, error: `export failed: ${res.status}` };
          const text = (await res.text()).slice(0, 20000);
          return { ok: true, output: { name: meta.name, text } };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "gdoc_create",
      description:
        "Create a new Google Doc in the user's My Drive from HTML content (converted to native Doc format — headings, lists, tables, bold/italic all carry over; fonts/styling become Docs defaults). When the result must match an existing template's exact styling, do NOT rebuild it here — gdrive_copy_file the template and fill it with gdoc_replace_text instead. The doc is private; Ami never shares it. Report the returned URL as an artifact. Requires the Google connection to have been made after Drive write support was added — reconnect Google if this returns a scope error.",
      schema: {
        title: z.string(),
        html: z.string().describe("Document body as HTML"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const r = await driveCreate(auth, {
            title: String(input.title),
            targetMime: "application/vnd.google-apps.document",
            content: String(input.html),
            contentType: "text/html; charset=UTF-8",
          });
          return { ok: true, url: r.link, externalId: r.id, output: r };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "gdrive_copy_file",
      description:
        "Duplicate a Drive file into the user's My Drive — THE way to produce a document that keeps a template's exact styling, fonts and layout (never rebuild a styled template from HTML). Office files (.docx/.xlsx/.pptx) are converted to the native Google format so the copy is editable. Follow with gdoc_replace_text to fill in the specifics. The copy is private; Ami never shares it, and the original is never touched.",
      schema: {
        fileRef: z.string().describe("Source file id or any Drive/Docs URL"),
        title: z.string().describe("Name for the copy"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const id = extractFileId(String(input.fileRef));
          const meta = await googleApi(auth, `${DRIVE}/files/${id}?fields=name,mimeType`);
          const OFFICE_TO_NATIVE: Record<string, string> = {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "application/vnd.google-apps.document",
            "application/msword": "application/vnd.google-apps.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "application/vnd.google-apps.spreadsheet",
            "application/vnd.ms-excel": "application/vnd.google-apps.spreadsheet",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation": "application/vnd.google-apps.presentation",
            "application/vnd.ms-powerpoint": "application/vnd.google-apps.presentation",
          };
          const native = OFFICE_TO_NATIVE[meta.mimeType ?? ""];
          const body: any = { name: String(input.title) };
          if (native) body.mimeType = native;
          const j = await googleApi(auth, `${DRIVE}/files/${id}/copy?fields=id,name,mimeType,webViewLink`, {
            method: "POST",
            body: JSON.stringify(body),
          });
          return {
            ok: true,
            url: j.webViewLink,
            externalId: j.id,
            output: { id: j.id, name: j.name, mimeType: j.mimeType, url: j.webViewLink, convertedToNative: Boolean(native) },
          };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "gdoc_replace_text",
      description:
        "Find-and-replace text inside a Google Doc while preserving ALL styling — pairs with gdrive_copy_file to turn a copied template into the finished document ('[Customer Name]' → 'Schneider Electric'). Replacements run in order, each against the whole doc. Only works on docs Ami itself created or copied — a 403 means the doc isn't Ami's; copy it first. Needs the Google Docs API enabled in the user's Google Cloud project (same place the other Google APIs were enabled).",
      schema: {
        fileRef: z.string().describe("Google Doc id or URL (one Ami created or copied)"),
        replacements: z
          .array(
            z.object({
              find: z.string(),
              replace: z.string(),
              matchCase: z.boolean().optional().describe("Default true"),
            }),
          )
          .min(1)
          .max(50),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const id = extractFileId(String(input.fileRef));
          const reps = input.replacements as { find: string; replace: string; matchCase?: boolean }[];
          const requests = reps.map((r) => ({
            replaceAllText: {
              containsText: { text: r.find, matchCase: r.matchCase ?? true },
              replaceText: r.replace,
            },
          }));
          const j = await googleApi(auth, `https://docs.googleapis.com/v1/documents/${id}:batchUpdate`, {
            method: "POST",
            body: JSON.stringify({ requests }),
          });
          const results = (j.replies ?? []).map((rep: any, i: number) => ({
            find: reps[i]?.find,
            occurrencesChanged: rep?.replaceAllText?.occurrencesChanged ?? 0,
          }));
          const url = `https://docs.google.com/document/d/${id}/edit`;
          return { ok: true, url, externalId: id, output: { id, url, replacements: results } };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "gsheet_create",
      description:
        "Create a new Google Sheet in the user's My Drive from CSV content (first row becomes the header row). Private; never shared by Ami. Report the returned URL as an artifact.",
      schema: {
        title: z.string(),
        csv: z.string().describe("Sheet content as CSV"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const r = await driveCreate(auth, {
            title: String(input.title),
            targetMime: "application/vnd.google-apps.spreadsheet",
            content: String(input.csv),
            contentType: "text/csv; charset=UTF-8",
          });
          return { ok: true, url: r.link, externalId: r.id, output: r };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "gslides_create",
      description:
        "Create a new Google Slides presentation in the user's My Drive: one slide per entry, each with a title and bullet points. Private; never shared by Ami. Report the returned URL as an artifact. Needs the Google Slides API enabled in the user's Google Cloud project (same place the Gmail/Drive APIs were enabled).",
      schema: {
        title: z.string().describe("Presentation title"),
        slides: z
          .array(z.object({ title: z.string(), bullets: z.array(z.string()).default([]) }))
          .min(1)
          .max(30),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const file = await googleApi(auth, `${DRIVE}/files?fields=id,webViewLink`, {
            method: "POST",
            body: JSON.stringify({
              name: String(input.title),
              mimeType: "application/vnd.google-apps.presentation",
            }),
          });
          const SLIDES = "https://slides.googleapis.com/v1/presentations";
          // Replace the default blank slide with the requested ones.
          const pres = await googleApi(auth, `${SLIDES}/${file.id}?fields=slides.objectId`);
          const requests: any[] = [];
          (input.slides as { title: string; bullets?: string[] }[]).forEach((s, i) => {
            const tid = `ami_t${i}`;
            const bid = `ami_b${i}`;
            requests.push({
              createSlide: {
                objectId: `ami_s${i}`,
                slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
                placeholderIdMappings: [
                  { layoutPlaceholder: { type: "TITLE" }, objectId: tid },
                  { layoutPlaceholder: { type: "BODY" }, objectId: bid },
                ],
              },
            });
            if (s.title) requests.push({ insertText: { objectId: tid, text: s.title } });
            if (s.bullets?.length) requests.push({ insertText: { objectId: bid, text: s.bullets.join("\n") } });
          });
          for (const sl of pres.slides ?? []) {
            requests.push({ deleteObject: { objectId: sl.objectId } });
          }
          await googleApi(auth, `${SLIDES}/${file.id}:batchUpdate`, {
            method: "POST",
            body: JSON.stringify({ requests }),
          });
          return { ok: true, url: file.webViewLink, externalId: file.id, output: { id: file.id, link: file.webViewLink } };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "gdrive_search",
      readOnly: true,
      description:
        "Full-text search across the user's Google Drive (file names and content). Returns matching files — pass a fileRef to gdoc_read for the content.",
      schema: {
        query: z.string().describe("Search terms"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const max = Math.min(Number(input.limit) || 10, 25);
          const escaped = String(input.query).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
          const q = encodeURIComponent(`fullText contains '${escaped}' and trashed = false`);
          const j = await googleApi(
            auth,
            `${DRIVE}/files?q=${q}&pageSize=${max}&orderBy=modifiedTime desc&fields=files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,me))`,
          );
          const files = (j.files ?? []).map((f: any) => ({
            fileRef: f.id,
            name: f.name,
            kind: String(f.mimeType ?? "").replace(GOOGLE_DOC_MIME, ""),
            modified: f.modifiedTime,
            owner: f.owners?.[0]?.me ? "me" : f.owners?.[0]?.displayName,
            url: f.webViewLink,
          }));
          return { ok: true, output: files };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
  ],
};
