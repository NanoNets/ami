import { useRef, useState } from "react";

/** Dependency-free SVG charts for ```chart fenced blocks in Markdown.
 * Agents supply only the data (JSON spec); scales, axes and geometry are
 * computed here so charts are always well-formed. Invalid specs throw and the
 * Markdown layer falls back to showing the raw code block.
 *
 * Hover: an HTML tooltip (not SVG <title>) follows the cursor — instant,
 * styled, and it always carries the FULL label + every series value at that
 * point, so axis/legend truncation never hides information. */

export interface TreeNode {
  name: string;
  role?: string;
  children: TreeNode[];
}

export interface ChartSpec {
  type: "bar" | "line" | "area" | "pie" | "tree";
  title?: string;
  labels: string[];
  series: { name?: string; data: number[]; color?: string }[];
  stacked?: boolean;
  yFormat?: "number" | "usd" | "percent";
  /** Hierarchies (org charts, folder trees) — rendered as a collapsible tree. */
  root?: TreeNode;
}

// First color matches the console accent so charts read as native deliverables.
const PALETTE = ["#546fff", "#22a06b", "#d97b4a", "#e5484d", "#9270d8", "#eab308", "#06b6d4", "#94a3b8"];

/** Depth/size-capped copy of an agent-supplied hierarchy. */
function sanitizeTree(n: any, depth = 0, budget = { nodes: 500 }): TreeNode | null {
  if (!n || typeof n.name !== "string" || !n.name.trim() || depth > 10 || budget.nodes <= 0) return null;
  budget.nodes--;
  const children = Array.isArray(n.children)
    ? (n.children.map((c: any) => sanitizeTree(c, depth + 1, budget)).filter(Boolean) as TreeNode[])
    : [];
  return {
    name: n.name.trim().slice(0, 80),
    role: n.role ? String(n.role).slice(0, 80) : undefined,
    children,
  };
}

export function parseChartSpec(src: string): ChartSpec {
  const j = JSON.parse(src);
  if (j.type === "tree") {
    const root = sanitizeTree(j.root);
    if (!root) throw new Error("tree requires root {name, children}");
    return { type: "tree", title: j.title ? String(j.title) : undefined, labels: [], series: [], root };
  }
  if (!["bar", "line", "area", "pie"].includes(j.type)) throw new Error("bad type");
  if (!Array.isArray(j.labels) || j.labels.length === 0) throw new Error("labels required");
  if (!Array.isArray(j.series) || j.series.length === 0) throw new Error("series required");
  const labels = j.labels.slice(0, 60).map(String);
  const series = j.series.slice(0, 8).map((s: any, i: number) => {
    if (!Array.isArray(s.data)) throw new Error("series.data required");
    const data = labels.map((_: string, k: number) => {
      const v = Number(s.data[k]);
      return Number.isFinite(v) ? v : 0;
    });
    return { name: s.name ? String(s.name) : undefined, data, color: s.color ?? PALETTE[i % PALETTE.length] };
  });
  return { type: j.type, title: j.title ? String(j.title) : undefined, labels, series, stacked: !!j.stacked, yFormat: j.yFormat };
}

function fmt(v: number, kind?: string): string {
  const abbrev = (n: number): string => {
    const a = Math.abs(n);
    if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
    if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
    if (a >= 1e4) return `${+(n / 1e3).toFixed(1)}k`;
    return `${+n.toFixed(2)}`;
  };
  if (kind === "usd") return `$${abbrev(v)}`;
  if (kind === "percent") return `${+v.toFixed(1)}%`;
  return abbrev(v);
}

/** "Nice" tick step so gridlines land on round numbers. */
function niceStep(range: number): number {
  const raw = range / 4 || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

const W = 560;
const H = 300;
const AXIS = "#8884";
const GRID = "#8882";
const TEXT = "#888";

interface Hover {
  i: number;
  px: number;
  py: number;
}

/** Cursor-anchored tooltip. Flips to the left of the cursor past mid-width. */
function Tooltip({ hover, width, children }: { hover: Hover; width: number; children: React.ReactNode }) {
  const flip = hover.px > width * 0.55;
  return (
    <div
      className="pointer-events-none absolute z-10 border border-edge bg-panel2 px-2.5 py-1.5 text-xs shadow-lg max-w-64"
      style={{
        left: flip ? undefined : hover.px + 14,
        right: flip ? width - hover.px + 14 : undefined,
        top: Math.max(0, hover.py - 14),
      }}
    >
      {children}
    </div>
  );
}

function TooltipRows({ spec, i }: { spec: ChartSpec; i: number }) {
  return (
    <>
      <div className="font-semibold text-hi mb-0.5 break-words">{spec.labels[i]}</div>
      {spec.series.map((s, si) => (
        <div key={si} className="flex items-center gap-1.5 whitespace-nowrap">
          <span className="inline-block w-2 h-2 shrink-0" style={{ background: s.color }} />
          {s.name && <span className="text-mut">{s.name}</span>}
          <span className="font-medium text-hi ml-auto pl-2">{fmt(s.data[i], spec.yFormat)}</span>
        </div>
      ))}
      {spec.stacked && spec.series.length > 1 && (
        <div className="flex items-center gap-1.5 whitespace-nowrap border-t border-edge mt-0.5 pt-0.5">
          <span className="text-mut">total</span>
          <span className="font-medium text-hi ml-auto pl-2">
            {fmt(spec.series.reduce((a, s) => a + s.data[i], 0), spec.yFormat)}
          </span>
        </div>
      )}
    </>
  );
}

export function Chart({ spec }: { spec: ChartSpec }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  if (spec.type === "tree" && spec.root) {
    return (
      <div>
        {spec.title && <div className="text-sm font-medium mb-2">{spec.title}</div>}
        <TreeRow node={spec.root} />
      </div>
    );
  }

  const hoverAt = (i: number) => (e: React.MouseEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setHover({ i, px: e.clientX - r.left, py: e.clientY - r.top });
  };

  if (spec.type === "pie") {
    return (
      <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
        <PieChart spec={spec} hover={hover} hoverAt={hoverAt} />
        {hover && (
          <Tooltip hover={hover} width={ref.current?.clientWidth ?? W}>
            <PieTooltip spec={spec} i={hover.i} />
          </Tooltip>
        )}
      </div>
    );
  }

  const titleH = spec.title ? 22 : 0;
  const m = { l: 52, r: 10, t: 14 + titleH, b: 42 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const n = spec.labels.length;

  // Y domain (stacked sums when stacking).
  const values: number[] = [];
  if (spec.stacked && spec.type === "bar") {
    for (let i = 0; i < n; i++) {
      values.push(spec.series.reduce((a, s) => a + Math.max(0, s.data[i]), 0));
      values.push(spec.series.reduce((a, s) => a + Math.min(0, s.data[i]), 0));
    }
  } else {
    for (const s of spec.series) values.push(...s.data);
  }
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (lo === hi) hi = lo + 1;
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const y = (v: number) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(v);

  const slot = iw / n;
  const cx = (i: number) => m.l + slot * (i + 0.5);
  const every = Math.ceil(n / 8);
  const legend = spec.series.filter((s) => s.name).length > 0;
  const hi_ = hover?.i;

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H + (legend ? 20 : 0)}`} className="w-full h-auto" role="img">
        {spec.title && (
          <text x={W / 2} y={14} textAnchor="middle" fontSize={12} fontWeight={600} fill="currentColor">
            {spec.title}
          </text>
        )}
        {ticks.map((v) => (
          <g key={v}>
            <line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? AXIS : GRID} />
            <text x={m.l - 6} y={y(v) + 3.5} textAnchor="end" fontSize={10} fill={TEXT}>
              {fmt(v, spec.yFormat)}
            </text>
          </g>
        ))}
        {spec.labels.map((lb, i) =>
          i % every === 0 || i === hi_ ? (
            <text
              key={i}
              x={cx(i)}
              y={H - m.b + 16}
              textAnchor="middle"
              fontSize={10}
              fill={i === hi_ ? "currentColor" : TEXT}
              fontWeight={i === hi_ ? 600 : 400}
            >
              {lb.length > 12 ? `${lb.slice(0, 11)}…` : lb}
            </text>
          ) : null,
        )}

        {/* Crosshair on the hovered slot. */}
        {hi_ !== undefined && spec.type !== "bar" && (
          <line x1={cx(hi_)} x2={cx(hi_)} y1={m.t} y2={m.t + ih} stroke={AXIS} strokeDasharray="3 3" />
        )}

        {spec.type === "bar" &&
          spec.labels.map((lb, i) => {
            const groupW = Math.min(slot * 0.7, 64);
            const dim = hi_ !== undefined && hi_ !== i;
            if (spec.stacked) {
              let up = 0;
              let down = 0;
              return (
                <g key={i} opacity={dim ? 0.4 : 1}>
                  {spec.series.map((s, si) => {
                    const v = s.data[i];
                    const base = v >= 0 ? up : down;
                    if (v >= 0) up += v;
                    else down += v;
                    const y0 = y(base);
                    const y1 = y(base + v);
                    return (
                      <rect key={si} x={cx(i) - groupW / 2} y={Math.min(y0, y1)} width={groupW} height={Math.abs(y1 - y0)} fill={s.color} />
                    );
                  })}
                </g>
              );
            }
            const bw = groupW / spec.series.length;
            return (
              <g key={i} opacity={dim ? 0.4 : 1}>
                {spec.series.map((s, si) => {
                  const v = s.data[i];
                  return (
                    <rect
                      key={si}
                      x={cx(i) - groupW / 2 + si * bw}
                      y={Math.min(y(0), y(v))}
                      width={Math.max(bw - 1, 1)}
                      height={Math.abs(y(v) - y(0))}
                      fill={s.color}
                    />
                  );
                })}
              </g>
            );
          })}

        {(spec.type === "line" || spec.type === "area") &&
          spec.series.map((s, si) => {
            const pts = s.data.map((v, i) => `${cx(i)},${y(v)}`).join(" ");
            return (
              <g key={si}>
                {spec.type === "area" && (
                  <polygon points={`${cx(0)},${y(0)} ${pts} ${cx(n - 1)},${y(0)}`} fill={s.color} opacity={0.15} />
                )}
                <polyline points={pts} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
                {s.data.map((v, i) =>
                  i === hi_ ? (
                    <circle key={i} cx={cx(i)} cy={y(v)} r={4.5} fill={s.color} stroke="#fff" strokeWidth={1.5} />
                  ) : n <= 30 ? (
                    <circle key={i} cx={cx(i)} cy={y(v)} r={2.5} fill={s.color} />
                  ) : null,
                )}
              </g>
            );
          })}

        {/* Invisible full-height hit areas, one per x slot. */}
        {spec.labels.map((_, i) => (
          <rect
            key={i}
            x={m.l + slot * i}
            y={m.t}
            width={slot}
            height={ih}
            fill="transparent"
            onMouseMove={hoverAt(i)}
          />
        ))}

        {legend && (
          <g>
            {spec.series.map((s, si) => (
              <g key={si} transform={`translate(${m.l + si * 120}, ${H + 8})`}>
                <rect width={10} height={10} fill={s.color} />
                <text x={14} y={9} fontSize={10} fill="currentColor">
                  {(s.name ?? `series ${si + 1}`).slice(0, 16)}
                  <title>{s.name}</title>
                </text>
              </g>
            ))}
          </g>
        )}
      </svg>
      {hover && (
        <Tooltip hover={hover} width={ref.current?.clientWidth ?? W}>
          <TooltipRows spec={spec} i={hover.i} />
        </Tooltip>
      )}
    </div>
  );
}

function PieTooltip({ spec, i }: { spec: ChartSpec; i: number }) {
  const data = spec.series[0].data.map((v) => Math.max(0, v));
  const total = data.reduce((a, b) => a + b, 0) || 1;
  return (
    <>
      <div className="font-semibold text-hi mb-0.5 break-words">{spec.labels[i]}</div>
      <div className="whitespace-nowrap">
        <span className="font-medium text-hi">{fmt(data[i], spec.yFormat)}</span>
        <span className="text-mut"> · {((data[i] / total) * 100).toFixed(1)}%</span>
      </div>
    </>
  );
}

function PieChart({
  spec,
  hover,
  hoverAt,
}: {
  spec: ChartSpec;
  hover: Hover | null;
  hoverAt: (i: number) => (e: React.MouseEvent) => void;
}) {
  const titleH = spec.title ? 22 : 0;
  const data = spec.series[0].data.map((v) => Math.max(0, v));
  const total = data.reduce((a, b) => a + b, 0) || 1;
  const cx = 150;
  const cy = titleH + 130;
  const R = 105;
  const r = 58;
  let angle = -Math.PI / 2;
  const arcs = data.map((v, i) => {
    const a0 = angle;
    const a1 = (angle += (v / total) * Math.PI * 2);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const mid = (a0 + a1) / 2;
    const p = (a: number, rad: number) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
    return {
      d: `M ${p(a0, R)} A ${R} ${R} 0 ${large} 1 ${p(a1, R)} L ${p(a1, r)} A ${r} ${r} 0 ${large} 0 ${p(a0, r)} Z`,
      color: PALETTE[i % PALETTE.length],
      label: spec.labels[i],
      mid,
      v,
      pct: (v / total) * 100,
    };
  });
  const hi_ = hover?.i;
  return (
    <svg viewBox={`0 0 ${W} ${titleH + 268}`} className="w-full h-auto" role="img">
      {spec.title && (
        <text x={W / 2} y={14} textAnchor="middle" fontSize={12} fontWeight={600} fill="currentColor">
          {spec.title}
        </text>
      )}
      {arcs.map(
        (a, i) =>
          a.v > 0 && (
            <path
              key={i}
              d={a.d}
              fill={a.color}
              stroke="var(--color-panel,#fff)"
              strokeWidth={1}
              opacity={hi_ !== undefined && hi_ !== i ? 0.45 : 1}
              transform={
                hi_ === i ? `translate(${4 * Math.cos(a.mid)}, ${4 * Math.sin(a.mid)})` : undefined
              }
              onMouseMove={hoverAt(i)}
            />
          ),
      )}
      {arcs.slice(0, 12).map((a, i) => (
        <g
          key={i}
          transform={`translate(300, ${titleH + 30 + i * 19})`}
          opacity={hi_ !== undefined && hi_ !== i ? 0.5 : 1}
          onMouseMove={hoverAt(i)}
        >
          <rect width={10} height={10} fill={a.color} y={-9} />
          <text x={15} fontSize={10.5} fill="currentColor">
            {`${a.label.length > 22 ? `${a.label.slice(0, 21)}…` : a.label} — ${fmt(a.v, spec.yFormat)} (${a.pct.toFixed(1)}%)`}
          </text>
        </g>
      ))}
    </svg>
  );
}

/* ---------- tree: hierarchies as a collapsible indented list ----------
 * Org charts drawn top-down grow WIDE and become illegible; rendered as an
 * indented tree they grow tall, which costs nothing. Every branch collapses;
 * a collapsed branch shows how many people/nodes it hides. */

function countDescendants(n: TreeNode): number {
  return n.children.reduce((s, c) => s + 1 + countDescendants(c), 0);
}

function TreeRow({ node }: { node: TreeNode }) {
  const [open, setOpen] = useState(true);
  const kids = node.children;
  return (
    <div>
      <div className="flex items-center gap-1.5 py-0.5">
        {kids.length > 0 ? (
          <button
            className="text-mut hover:text-hi cursor-pointer shrink-0"
            aria-expanded={open}
            aria-label={open ? "Collapse" : "Expand"}
            onClick={() => setOpen((v) => !v)}
          >
            <svg
              width={12}
              height={12}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`transition-transform ${open ? "rotate-90" : ""}`}
            >
              <polyline points="9 6 15 12 9 18" />
            </svg>
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="text-sm font-medium whitespace-nowrap">{node.name}</span>
        {node.role && <span className="text-xs text-mut truncate">· {node.role}</span>}
        {!open && kids.length > 0 && <span className="chip ml-1 shrink-0">+{countDescendants(node)}</span>}
      </div>
      {open && kids.length > 0 && (
        <div className="ml-[5px] pl-4 border-l border-edge">
          {kids.map((c, i) => (
            <TreeRow key={i} node={c} />
          ))}
        </div>
      )}
    </div>
  );
}
