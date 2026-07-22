import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ForceGraph2D from "react-force-graph-2d";
import { api } from "../lib/api";
import { errMsg } from "../lib/toast";
import { Markdown } from "../components/Markdown";
import { XIcon } from "../components/icons";

/** Brain: the knowledge base as an Obsidian-style graph — every note is a
 * node, every [[wiki-link]] an edge. Click a node to read the dossier. */

// Muted a step from the raw hues so six colors don't shout against a
// one-accent interface.
const GROUP_COLORS: Record<string, string> = {
  People: "#6c82e8",
  Organizations: "#d97b4a",
  Projects: "#c75d92",
  Topics: "#9270d8",
  "Agent Notes": "#4aa39a",
  root: "#6b6b6b",
};

function groupColor(group: string): string {
  return GROUP_COLORS[group] ?? "#5a9a72";
}

/** The graph canvas needs pixel dimensions — track the container's width so
 * the layout breathes with the window instead of hardcoding 900px. */
function useContainerWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      setWidth(Math.floor(entries[0]?.contentRect.width ?? 0));
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export default function MemoryGraph() {
  const { data } = useQuery({ queryKey: ["memoryGraph"], queryFn: api.memoryGraph, refetchInterval: 20000 });
  const [searchParams] = useSearchParams();
  const [selectedPath, setSelectedPath] = useState<string | null>(searchParams.get("note"));
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const [showUpdates, setShowUpdates] = useState(false);
  const fgRef = useRef<any>(null);
  const { ref: graphBox, width: graphWidth } = useContainerWidth<HTMLDivElement>();

  const groups = useMemo(
    () => [...new Set((data?.nodes ?? []).map((n) => n.group))].sort(),
    [data],
  );

  const graphData = useMemo(() => {
    let nodes = (data?.nodes ?? []).map((n) => ({ ...n }));
    if (group) nodes = nodes.filter((n) => n.group === group);
    const q = search.trim().toLowerCase();
    const matches = q ? new Set(nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id)) : null;
    const ids = new Set(nodes.map((n) => n.id));
    const links = (data?.links ?? [])
      .filter((l) => ids.has(l.source as string) && ids.has(l.target as string))
      .map((l) => ({ ...l }));
    return { nodes: nodes.map((n) => ({ ...n, dimmed: matches ? !matches.has(n.id) : false })), links };
  }, [data, search, group]);

  const empty = (data?.nodes.length ?? 0) === 0;

  return (
    <div>
      <div className="flex items-center gap-4 mb-4 flex-wrap">
        <h1 className="text-xl font-semibold">Context Graph</h1>
        <input
          className="input max-w-56 h-8 text-sm"
          placeholder="Search memory"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex gap-2 text-xs flex-wrap">
          {groups.map((g) => (
            <button
              key={g}
              onClick={() => setGroup(group === g ? null : g)}
              className={`flex items-center gap-1 px-2 py-1 border transition-colors ${
                group === g ? "border-acc text-hi" : "border-transparent text-mut hover:text-hi"
              }`}
            >
              <span className="w-2 h-2 rounded-full inline-block" style={{ background: groupColor(g) }} />
              {g === "root" ? "knowledge" : g}
            </button>
          ))}
        </div>
        <button
          className={`ml-auto text-xs ${showUpdates ? "text-acc" : "text-mut hover:text-hi"}`}
          onClick={() => setShowUpdates((v) => !v)}
        >
          recent updates
        </button>
        <span className="text-xs text-mut">
          {data?.nodes.length ?? 0} notes · {data?.links.length ?? 0} links
        </span>
      </div>

      {showUpdates && <RecentUpdates onOpenNote={setSelectedPath} />}

      {empty ? (
        <div className="card p-12 text-center text-mut">
          The context graph grows as ami absorbs tools, data, entities, relationships, decisions, feedback.
        </div>
      ) : (
        <div className="flex gap-4">
          <div ref={graphBox} className="card overflow-hidden flex-1 min-w-0" style={{ height: 580 }}>
            <ForceGraph2D
              ref={fgRef}
              graphData={graphData}
              width={graphWidth || undefined}
              height={580}
              backgroundColor="#ffffff"
              nodeLabel={(n: any) => `${n.group}: ${n.label}`}
              nodeVal={(n: any) => 2 + Math.min(18, n.degree * 2) / 2}
              nodeColor={(n: any) => (n.dimmed ? "#e5e2dd" : groupColor(n.group))}
              nodeCanvasObjectMode={() => "after"}
              nodeCanvasObject={(n: any, ctx, scale) => {
                if (scale > 1.1 && !n.dimmed) {
                  ctx.font = `${3.6}px "DM Sans", sans-serif`;
                  ctx.fillStyle = "#6b6b6b";
                  ctx.textAlign = "center";
                  ctx.fillText(String(n.label).slice(0, 26), n.x, n.y + 7);
                }
              }}
              linkColor={() => "#dedbd6"}
              linkWidth={() => 1}
              onNodeClick={(n: any) => setSelectedPath(n.id)}
              cooldownTicks={140}
            />
          </div>
          {selectedPath && (
            <NotePanel path={selectedPath} onNavigate={setSelectedPath} onClose={() => setSelectedPath(null)} />
          )}
        </div>
      )}
    </div>
  );
}

/** What memory learned recently: every agent write commits to the knowledge
 * repo, so this is the review surface for those writes — each touched note
 * opens in the panel, where its history offers per-version restore. */
function RecentUpdates({ onOpenNote }: { onOpenNote: (path: string) => void }) {
  const { data: commits = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ["memoryHistory"],
    queryFn: () => api.memoryHistory(20),
    refetchInterval: 30000,
  });
  if (isLoading) return <div className="card p-3 mb-4 text-xs text-mut">Loading updates…</div>;
  if (isError)
    return (
      <div className="card p-3 mb-4 text-xs text-bad">
        Couldn't load updates: {errMsg(error)}{" "}
        <button className="text-mut hover:text-acc underline" onClick={() => void refetch()}>
          retry
        </button>
      </div>
    );
  if (commits.length === 0)
    return <div className="card p-3 mb-4 text-xs text-mut">No memory updates recorded yet.</div>;
  return (
    <div className="card p-3 mb-4 max-h-56 overflow-y-auto space-y-1.5">
      {commits.map((c) => (
        <div key={c.oid} className="flex items-baseline gap-2 text-xs flex-wrap">
          <span className="text-mut shrink-0 tabular-nums">
            {new Date(c.timestamp * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
          <span className="text-hi shrink-0">{c.message}</span>
          <span className="flex gap-1.5 flex-wrap min-w-0">
            {c.files.slice(0, 6).map((f) => (
              <button key={f} className="text-mut hover:text-acc truncate max-w-48" onClick={() => onOpenNote(f)}>
                {f.replace(/\.md$/, "")}
              </button>
            ))}
            {c.files.length > 6 && <span className="text-mut">+{c.files.length - 6} more</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function NotePanel({
  path,
  onNavigate,
  onClose,
}: {
  path: string;
  onNavigate: (p: string) => void;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["memoryNote", path],
    queryFn: () => api.memoryNote(path),
  });
  const [showHistory, setShowHistory] = useState(false);
  const [viewOid, setViewOid] = useState<string | null>(null);
  const group = path.includes("/") ? path.split("/")[0] : "root";

  // Render [[Folder/Name]] links as clickable note navigation.
  const rendered = useMemo(() => {
    if (!data?.content) return "";
    return data.content.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, target, alias) => {
      const label = alias || String(target).split("/").pop();
      return `[${label}](#note:${encodeURIComponent(String(target))})`;
    });
  }, [data]);

  return (
    <aside
      className="card p-4 w-96 shrink-0 self-start overflow-y-auto"
      style={{ maxHeight: 580 }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        const href = a?.getAttribute("href") ?? "";
        if (href.startsWith("#note:")) {
          e.preventDefault();
          let target = decodeURIComponent(href.slice(6));
          if (!target.endsWith(".md")) target += ".md";
          onNavigate(target);
        }
      }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: groupColor(group) }} />
        <span className="text-xs uppercase tracking-wide text-mut truncate">{path}</span>
        <button
          className={`ml-auto shrink-0 text-xs ${showHistory ? "text-acc" : "text-mut hover:text-hi"}`}
          onClick={() => {
            setShowHistory((v) => !v);
            setViewOid(null);
          }}
          title="Version history"
        >
          history
        </button>
        <button className="text-mut hover:text-hi shrink-0 cursor-pointer" aria-label="Close note" onClick={onClose}>
          <XIcon />
        </button>
      </div>
      {showHistory && <NoteHistory path={path} viewOid={viewOid} setViewOid={setViewOid} />}
      {viewOid ? (
        <NoteAtCommit path={path} oid={viewOid} />
      ) : isLoading ? (
        <p className="text-sm text-mut">Loading…</p>
      ) : data?.content ? (
        <Markdown>{rendered}</Markdown>
      ) : (
        <p className="text-sm text-mut">Note not found.</p>
      )}
    </aside>
  );
}

function NoteHistory({
  path,
  viewOid,
  setViewOid,
}: {
  path: string;
  viewOid: string | null;
  setViewOid: (oid: string | null) => void;
}) {
  const qc = useQueryClient();
  const { data: commits = [] } = useQuery({
    queryKey: ["noteHistory", path],
    queryFn: () => api.noteHistory(path),
  });
  if (commits.length === 0) return <p className="text-xs text-mut mb-3">No history yet.</p>;
  return (
    <div className="border border-edge bg-panel2 p-2 mb-3 max-h-48 overflow-y-auto space-y-1">
      {commits.map((c) => (
        <div key={c.oid} className="flex items-center gap-2 text-xs">
          <button
            className={`truncate text-left flex-1 hover:text-acc ${viewOid === c.oid ? "text-acc" : ""}`}
            onClick={() => setViewOid(viewOid === c.oid ? null : c.oid)}
          >
            {c.message}
          </button>
          <span className="text-mut shrink-0">{new Date(c.timestamp * 1000).toLocaleDateString()}</span>
          <button
            className="text-mut hover:text-acc shrink-0"
            title="Restore this version"
            onClick={async () => {
              await api.noteRestore(path, c.oid);
              setViewOid(null);
              void qc.invalidateQueries({ queryKey: ["memoryNote", path] });
              void qc.invalidateQueries({ queryKey: ["noteHistory", path] });
            }}
          >
            restore
          </button>
        </div>
      ))}
    </div>
  );
}

function NoteAtCommit({ path, oid }: { path: string; oid: string }) {
  const { data } = useQuery({
    queryKey: ["noteAt", path, oid],
    queryFn: () => api.noteAt(path, oid),
  });
  if (!data) return <p className="text-sm text-mut">Loading version…</p>;
  return (
    <div>
      <p className="text-xs text-acc mb-2">Viewing historical version — click the commit again to return.</p>
      <Markdown>{data.content}</Markdown>
    </div>
  );
}
