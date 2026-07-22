import { useState, type ReactElement } from "react";
import type { TaskRunDto, TaskStepDto } from "@ami/shared";
import { Markdown } from "./Markdown";
import {
  ChevronIcon,
  FileIcon,
  GlobeIcon,
  SparkIcon,
  Spinner,
  TerminalIcon,
  ToolIcon,
} from "./icons";

/* ---------- grouping: pair each tool_result with its preceding tool_use ---------- */

type Item =
  | { kind: "status" | "thinking" | "text"; step: TaskStepDto }
  | { kind: "tool"; use: TaskStepDto; result?: TaskStepDto };

function groupSteps(steps: TaskStepDto[]): Item[] {
  const items: Item[] = [];
  const openTools: Extract<Item, { kind: "tool" }>[] = [];
  for (const s of steps) {
    if (s.kind === "tool_use") {
      const item: Extract<Item, { kind: "tool" }> = { kind: "tool", use: s };
      items.push(item);
      openTools.push(item);
    } else if (s.kind === "tool_result") {
      const open = openTools.shift();
      if (open) open.result = s;
      else items.push({ kind: "status", step: s });
    } else {
      items.push({ kind: s.kind as "status" | "thinking" | "text", step: s });
    }
  }
  return items;
}

/* ---------- friendly tool naming ---------- */

function parseDetail(s: TaskStepDto): any {
  try {
    return s.detail ? JSON.parse(s.detail) : null;
  } catch {
    return null;
  }
}

function toolMeta(use: TaskStepDto): { icon: ReactElement; title: string; subtitle: string } {
  const d = parseDetail(use) ?? {};
  const name: string = d.name ?? use.label;
  const input = d.input ?? {};
  const sub = (v: unknown, n = 90) => {
    const t = String(v ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  if (name === "Bash") return { icon: <TerminalIcon />, title: "Terminal", subtitle: sub(input.command) };
  if (["Read", "Write", "Edit", "Glob", "Grep"].includes(name))
    return { icon: <FileIcon />, title: name, subtitle: sub(input.file_path ?? input.pattern ?? input.query) };
  if (name === "WebSearch") return { icon: <GlobeIcon />, title: "Web search", subtitle: sub(input.query) };
  if (name === "WebFetch") return { icon: <GlobeIcon />, title: "Fetch page", subtitle: sub(input.url) };
  if (name.startsWith("mcp__ami__")) {
    const short = name.replace("mcp__ami__", "").replace(/_/g, " ");
    const arg = input.query ?? input.title ?? input.summary ?? input.body ?? input.name ?? "";
    return { icon: <SparkIcon />, title: `ami · ${short}`, subtitle: sub(arg) };
  }
  return { icon: <ToolIcon />, title: name, subtitle: sub(use.label) };
}

/* ---------- component ---------- */

export function StepTimeline({ run, steps }: { run: TaskRunDto; steps: TaskStepDto[] }) {
  const items = groupSteps(steps);
  const running = run.status === "running" || run.status === "queued";

  return (
    <div className="relative pl-5">
      {/* rail */}
      <div className="absolute left-[5px] top-1 bottom-1 w-px bg-edge" />
      <div className="space-y-2.5">
        {items.map((item, i) => (
          // Steps rise in as they land so a live run reads as ami visibly working.
          <div key={i} className="rise">
            <TimelineRow item={item} />
          </div>
        ))}
        {running && (
          <div className="relative rise">
            <Marker color="#546fff" />
            <div className="text-sm text-acc pl-1 inline-flex items-center gap-1.5">
              <Spinner /> ami is working…
            </div>
          </div>
        )}
        {run.status === "failed" && run.error && (
          <div className="relative">
            <Marker color="#dc2626" />
            <div className="text-sm text-bad pl-1">{run.error}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Marker({ color }: { color: string }) {
  return (
    <span
      className="absolute -left-5 top-[5px] w-[9px] h-[9px] border-2 border-panel"
      style={{ background: color }}
    />
  );
}

function TimelineRow({ item }: { item: Item }) {
  if (item.kind === "status") {
    return (
      <div className="relative">
        <Marker color="#c9c6c2" />
        <div className="text-xs text-mut uppercase tracking-wide pl-1">{item.step.label}</div>
      </div>
    );
  }
  if (item.kind === "thinking") {
    return (
      <div className="relative">
        <Marker color="#dedbd6" />
        <div className="text-sm text-mut italic pl-1">
          <span className="not-italic text-xs uppercase tracking-wide mr-2 text-mut/70">thought</span>
          {item.step.label}
        </div>
      </div>
    );
  }
  if (item.kind === "text") {
    const full = parseDetail(item.step)?.text ?? item.step.label;
    return (
      <div className="relative">
        <Marker color="#131315" />
        <div className="pl-1 max-w-none">
          <Markdown>{full}</Markdown>
        </div>
      </div>
    );
  }
  return <ToolRow item={item as Extract<Item, { kind: "tool" }>} />;
}

function ToolRow({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const meta = toolMeta(item.use);
  const resultDetail = item.result ? (parseDetail(item.result)?.text ?? item.result.label) : null;
  const inputDetail = parseDetail(item.use)?.input;
  const failed = typeof resultDetail === "string" && /^(\s*)(error|failed)/i.test(resultDetail);

  return (
    <div className="relative">
      <Marker color={item.result ? (failed ? "#dc2626" : "#15803d") : "#6b6b6b"} />
      <div className="border border-edge bg-panel2/60">
        <button
          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left cursor-pointer hover:bg-panel2 transition-colors"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="text-mut shrink-0">{meta.icon}</span>
          <span className="text-xs font-medium shrink-0">{meta.title}</span>
          {meta.subtitle && (
            <span className="text-xs text-mut font-mono truncate flex-1">{meta.subtitle}</span>
          )}
          {!item.result && <Spinner className="text-mut shrink-0" />}
          <ChevronIcon className="text-mut" open={open} />
        </button>
        {open && (
          <div className="border-t border-edge px-2.5 py-2 space-y-2">
            {inputDetail && Object.keys(inputDetail).length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-mut mb-1">input</div>
                <pre className="text-xs font-mono whitespace-pre-wrap max-h-40 overflow-y-auto text-hi/80">
                  {typeof inputDetail.command === "string"
                    ? inputDetail.command
                    : JSON.stringify(inputDetail, null, 2)}
                </pre>
              </div>
            )}
            {resultDetail && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-mut mb-1">result</div>
                <pre className={`text-xs font-mono whitespace-pre-wrap max-h-48 overflow-y-auto ${failed ? "text-bad" : "text-hi/80"}`}>
                  {resultDetail}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* icons live in components/icons.tsx — one set for the whole console */
