import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

/** Verbatim web-page capture. WebFetch runs an LLM over the page and hands back
 * a summary — useless when the user wants the real article (a full post, an
 * exact spec, a doc to mirror). This fetches the raw HTML, isolates the main
 * content with Readability, and converts it to markdown with nothing dropped or
 * paraphrased. Read-only: it only GETs a public URL. */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface FetchedPage {
  url: string;
  title: string | null;
  markdown: string;
  /** Set when readability found no article body and we fell back to <body>. */
  fallback?: boolean;
}

function turndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  // Drop non-content chrome that survives readability on some pages.
  td.remove(["script", "style", "noscript"]);
  return td;
}

export async function fetchPageMarkdown(url: string): Promise<FetchedPage> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid url: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported protocol: ${parsed.protocol}`);
  }

  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const ctype = res.headers.get("content-type") ?? "";
  const raw = await res.text();

  // Non-HTML (markdown, plain text, JSON) is already verbatim — return as-is.
  if (!/html/i.test(ctype)) {
    return { url, title: null, markdown: raw.trim() };
  }

  const { document } = parseHTML(raw);
  const td = turndown();

  const article = new Readability(document.cloneNode(true) as any, { charThreshold: 200 }).parse();
  if (article?.content) {
    return { url, title: article.title ?? null, markdown: td.turndown(article.content).trim() };
  }

  // Readability bailed (app shell, unusual markup) — convert the whole body so
  // the caller still gets the text rather than an empty result.
  const title = document.querySelector("title")?.textContent?.trim() || null;
  const body = document.querySelector("body")?.innerHTML ?? raw;
  return { url, title, markdown: td.turndown(body).trim(), fallback: true };
}
