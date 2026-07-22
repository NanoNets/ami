import { unzipSync, strFromU8 } from "fflate";

/** Text extraction for the document formats that actually get shared at work:
 * docx/pptx/xlsx (OOXML zips — unzipped in memory, XML stripped), PDF
 * (pdf-parse), and anything text-shaped as-is. Throws on unsupported types so
 * callers report honestly instead of returning garbage. */

function xmlToText(xml: string): string {
  return xml
    .replace(/<\/(w|a):p>/g, "\n")
    .replace(/<(w|a):tab[^>]*\/>/g, "\t")
    .replace(/<(w|a):br[^>]*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function docxText(buf: Buffer): string {
  const z = unzipSync(new Uint8Array(buf));
  const doc = z["word/document.xml"];
  if (!doc) throw new Error("not a valid .docx (missing word/document.xml)");
  return xmlToText(strFromU8(doc));
}

function pptxText(buf: Buffer): string {
  const z = unzipSync(new Uint8Array(buf));
  const keys = Object.keys(z)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  if (keys.length === 0) throw new Error("not a valid .pptx (no slides)");
  return keys.map((k, i) => `--- Slide ${i + 1} ---\n${xmlToText(strFromU8(z[k]))}`).join("\n\n");
}

function xlsxText(buf: Buffer): string {
  // Crude but useful: shared strings hold nearly all textual cell content.
  const z = unzipSync(new Uint8Array(buf));
  const shared = z["xl/sharedStrings.xml"];
  if (!shared) return "(spreadsheet contains no extractable text — numbers only)";
  return xmlToText(strFromU8(shared)).replace(/\n/g, " | ");
}

async function pdfText(buf: Buffer): Promise<string> {
  // Subpath import dodges pdf-parse's debug-mode side effect on ESM import.
  // @ts-expect-error — pdf-parse ships no types
  const mod = await import("pdf-parse/lib/pdf-parse.js");
  const parse = (mod.default ?? mod) as (b: Buffer) => Promise<{ text: string }>;
  const r = await parse(buf);
  return r.text.trim();
}

const TEXTUAL_EXT = /\.(md|txt|csv|tsv|json|html?|xml|ya?ml|ts|tsx|js|jsx|py|go|java|rb|sh|sql|log)$/;

export async function extractFileText(buf: Buffer, mimetype: string, name: string): Promise<string> {
  const lower = (name ?? "").toLowerCase();
  if (lower.endsWith(".docx")) return docxText(buf);
  if (lower.endsWith(".pptx")) return pptxText(buf);
  if (lower.endsWith(".xlsx")) return xlsxText(buf);
  if (lower.endsWith(".pdf") || mimetype === "application/pdf") return pdfText(buf);
  if ((mimetype ?? "").startsWith("text/") || TEXTUAL_EXT.test(lower) || mimetype === "application/json") {
    return buf.toString("utf8");
  }
  throw new Error(
    `unsupported file type (${mimetype || lower || "unknown"}) — readable: docx, pptx, xlsx, pdf, and text formats. Legacy .doc/.ppt/.xls are not.`,
  );
}
