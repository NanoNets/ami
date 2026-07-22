import { useEffect, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router-dom";
import { Chart, parseChartSpec } from "./Chart";

/** Inline SVG from agents is rendered for real, but only when it carries no
 * executable surface. Reject-don't-scrub: anything suspicious falls back to
 * being shown as a plain code block. */
function sanitizeSvg(src: string): string | null {
  const s = src.trim();
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return null;
  if (/<\s*(script|foreignObject|iframe|embed|object|use)\b/i.test(s)) return null;
  if (/\son\w+\s*=/i.test(s)) return null; // onload=, onclick=, ...
  if (/(href|src)\s*=\s*["']?\s*(javascript:|data:(?!image\/))/i.test(s)) return null;
  if (/<\s*(animate|set)\b[^>]*attributeName\s*=\s*["']?href/i.test(s)) return null;
  return s;
}

/** Agent-drawn SVG at natural size: wide diagrams scroll horizontally inline
 * (never scaled down to illegibility), and click opens a zoomable full-screen
 * viewer. */
function SvgBlock({ html }: { html: string }) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <div
        className="my-2 max-w-full overflow-x-auto cursor-zoom-in"
        title="Click to open full size"
        onClick={() => {
          setZoom(1);
          setOpen(true);
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {open && (
        <div className="fixed inset-0 z-50 bg-hi/80 flex flex-col" onClick={() => setOpen(false)}>
          <div className="flex items-center gap-2 p-3 justify-end shrink-0" onClick={(e) => e.stopPropagation()}>
            <button className="btn text-xs" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.25, +(z / 1.25).toFixed(2)))}>
              −
            </button>
            <span className="text-xs text-panel w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
            <button className="btn text-xs" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(5, +(z * 1.25).toFixed(2)))}>
              +
            </button>
            <button className="btn text-xs" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          <div className="flex-1 overflow-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div
              className="inline-block bg-panel p-4"
              style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        </div>
      )}
    </>
  );
}

const codeText = (node: unknown): string => {
  const child: any = Array.isArray(node) ? node[0] : node;
  if (typeof child === "string") return child;
  return typeof child?.props?.children === "string" ? child.props.children : "";
};

/** Markdown rendering styled for the nanonets-flavored theme. GFM enabled:
 * tables, strikethrough, task lists, autolinks. Images and safe inline SVG
 * (```svg fences) render as graphics. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed text-hi/90 min-w-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Default transform drops data: URIs; agents legitimately emit
        // data:image/* (charts, screenshots). Scripts can't run inside <img>.
        urlTransform={(url) => (url.startsWith("data:image/") ? url : defaultUrlTransform(url))}
        components={{
          h1: (p) => <h1 className="text-base font-semibold mt-4 mb-2 first:mt-0" {...p} />,
          h2: (p) => <h2 className="text-sm font-semibold mt-4 mb-1.5 first:mt-0" {...p} />,
          h3: (p) => <h3 className="text-sm font-semibold mt-3 mb-1 first:mt-0 text-hi/80" {...p} />,
          p: (p) => <p className="my-2 first:mt-0 last:mb-0" {...p} />,
          ul: ({ className, ...p }) =>
            className?.includes("contains-task-list") ? (
              <ul className="my-2 pl-1 list-none space-y-1" {...p} />
            ) : (
              <ul className="my-2 pl-5 list-disc space-y-1" {...p} />
            ),
          ol: (p) => <ol className="my-2 pl-5 list-decimal space-y-1" {...p} />,
          li: (p) => <li className="marker:text-mut" {...p} />,
          input: ({ checked, ...p }) => (
            <input
              type="checkbox"
              checked={!!checked}
              readOnly
              className="mr-1.5 align-middle accent-[var(--color-acc,#f60)] cursor-default"
              {...p}
            />
          ),
          a: ({ href, children, ...p }) =>
            href?.startsWith("/api/") ? (
              // Server-served file (downloads/exports) — a real request, not a client route.
              <a href={href} className="text-acc hover:underline" {...p}>
                {children}
              </a>
            ) : href?.startsWith("/") ? (
              // Console-internal link (/tasks/…, /memory?note=…) — client-side route.
              <Link to={href} className="text-acc hover:underline" {...p}>
                {children}
              </Link>
            ) : (
              <a href={href} className="text-acc hover:underline" target="_blank" rel="noreferrer" {...p}>
                {children}
              </a>
            ),
          strong: (p) => <strong className="font-semibold text-hi" {...p} />,
          del: (p) => <del className="text-mut" {...p} />,
          blockquote: (p) => (
            <blockquote className="border-l-2 border-edge2 pl-3 my-2 text-mut" {...p} />
          ),
          img: ({ src, alt, ...p }) => (
            <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noreferrer" className="inline-block my-2 max-w-full">
              <img
                src={typeof src === "string" ? src : undefined}
                alt={alt ?? ""}
                loading="lazy"
                className="max-w-full max-h-96 border border-edge rounded-sm bg-panel2"
                {...p}
              />
            </a>
          ),
          code: ({ className, children, ...rest }) => {
            const isBlock = /language-/.test(className ?? "");
            return isBlock ? (
              <code className={`${className} block`} {...rest}>
                {children}
              </code>
            ) : (
              <code className="bg-panel2 border border-edge px-1 py-px text-[0.85em] font-mono" {...rest}>
                {children}
              </code>
            );
          },
          pre: ({ children, ...p }) => {
            const child: any = Array.isArray(children) ? children[0] : children;
            const lang = String(child?.props?.className ?? "");
            if (/language-svg\b/.test(lang)) {
              const clean = sanitizeSvg(codeText(children));
              if (clean) return <SvgBlock html={clean} />;
            }
            if (/language-chart\b/.test(lang)) {
              try {
                const spec = parseChartSpec(codeText(children));
                return (
                  <div className="my-2 max-w-full border border-edge bg-panel2/30 p-2">
                    <Chart spec={spec} />
                  </div>
                );
              } catch {
                // Malformed spec — fall through to the plain code block.
              }
            }
            return (
              <pre className="bg-panel2 border border-edge p-3 my-2 overflow-x-auto text-xs font-mono" {...p}>
                {children}
              </pre>
            );
          },
          hr: () => <hr className="border-edge my-3" />,
          table: (p) => (
            <div className="my-2 max-w-full overflow-x-auto border border-edge">
              <table className="border-collapse text-xs w-full" {...p} />
            </div>
          ),
          thead: (p) => <thead className="bg-panel2" {...p} />,
          th: (p) => (
            <th className="border-b border-r last:border-r-0 border-edge px-2.5 py-1.5 text-left font-semibold whitespace-nowrap" {...p} />
          ),
          td: (p) => (
            <td className="border-b border-r last:border-r-0 border-edge px-2.5 py-1.5 align-top" {...p} />
          ),
          tr: (p) => <tr className="last:[&>td]:border-b-0 even:bg-panel2/40" {...p} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
