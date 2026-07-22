import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronIcon, DotsIcon } from "./icons";

/** Small shared primitives that keep the console quiet: an overflow menu for
 * secondary actions, an arm-then-confirm button instead of window.confirm(),
 * a real switch for on/off state, a disclosure for explanatory prose, and
 * static skeleton rows so lists don't jump when they load. */

export function OverflowMenu({
  items,
  label = "More actions",
}: {
  items: { label: string; onClick: () => void; danger?: boolean; disabled?: boolean }[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (items.length === 0) return null;
  return (
    <div className="relative" ref={ref}>
      <button
        className="btn px-2"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <DotsIcon className="text-mut" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 min-w-36 bg-panel border border-edge2 shadow-lg z-20">
          {items.map((it) => (
            <button
              key={it.label}
              className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-panel2 disabled:opacity-40 ${
                it.danger ? "text-bad" : ""
              }`}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** First click arms ("Really delete?"), second click executes; disarms after
 * a beat. Keeps destructive actions inside the app's visual world instead of
 * the browser's confirm() dialog. */
export function ConfirmButton({
  label,
  confirmLabel = "Really?",
  onConfirm,
  className = "btn text-xs",
}: {
  label: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`${className} ${armed ? "border-bad text-bad" : "text-bad"}`}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

/** A switch whose track shows state — replaces buttons labeled with the
 * current state ("paused") whose click meaning was ambiguous. */
export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-4.5 w-8 shrink-0 items-center border transition-colors cursor-pointer ${
        checked ? "bg-acc border-acc" : "bg-panel2 border-edge2"
      }`}
    >
      <span
        className={`inline-block h-3 w-3 transform bg-white border border-edge2 transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

/** Collapsed-by-default explanatory prose. The UI states the one-line purpose;
 * the paragraph lives behind this. */
export function Disclosure({ summary = "How it works", children }: { summary?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        className="flex items-center gap-1 text-xs text-mut hover:text-hi cursor-pointer"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {summary}
        <ChevronIcon size={12} open={open} />
      </button>
      {open && <div className="text-xs text-mut mt-1.5 space-y-1.5">{children}</div>}
    </div>
  );
}

/** Placeholder rows that keep the list's frame while loading. A slow shimmer
 * (opacity breathing, no movement) says "working" — a frozen skeleton reads
 * as a hang. */
export function SkeletonRows({ count = 3, height = "h-24" }: { count?: number; height?: string }) {
  return (
    <div className="space-y-3" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`card ${height} p-4`} style={{ animation: "shimmer 1.8s ease-in-out infinite" }}>
          <div className="h-3 w-1/3 bg-panel2" />
          <div className="h-2.5 w-2/3 bg-panel2 mt-3" />
        </div>
      ))}
    </div>
  );
}
