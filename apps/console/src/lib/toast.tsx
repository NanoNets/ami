import { useEffect, useState } from "react";
import { CheckIcon, XIcon } from "../components/icons";

/** One feedback convention for the whole console: success/error messages
 * always appear bottom-right, same style, auto-dismissing. Call toast("Saved")
 * or toast.error("Failed: …") from anywhere — no context/provider plumbing. */

type Toast = { id: number; kind: "ok" | "error"; message: string; leaving?: boolean };

let nextId = 1;
const listeners = new Set<(t: Toast) => void>();

export function toast(message: string): void {
  emit({ id: nextId++, kind: "ok", message });
}
toast.error = (message: string): void => {
  emit({ id: nextId++, kind: "error", message });
};

function emit(t: Toast) {
  for (const l of listeners) l(t);
}

/** Extracts a readable message from a thrown fetch error (often a JSON body). */
export function errMsg(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    return JSON.parse(raw).error ?? raw;
  } catch {
    return raw;
  }
}

export function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);

  useEffect(() => {
    const onToast = (t: Toast) => {
      setItems((prev) => [...prev.slice(-3), t]);
      const ttl = t.kind === "error" ? 6000 : 3500;
      // Fade out before removal so dismissal reads as motion, not a blink.
      setTimeout(() => setItems((prev) => prev.map((x) => (x.id === t.id ? { ...x, leaving: true } : x))), ttl);
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), ttl + 160);
    };
    listeners.add(onToast);
    return () => void listeners.delete(onToast);
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 space-y-2 max-w-sm">
      {items.map((t) => (
        <div
          key={t.id}
          style={{
            animation: t.leaving ? "row-exit 150ms ease-in both" : "toast-in 200ms ease-out both",
          }}
          className={`card px-3 py-2 text-sm flex items-start gap-2 ${t.kind === "error" ? "border-bad/50" : ""}`}
        >
          <span className={`mt-0.5 shrink-0 ${t.kind === "error" ? "text-bad" : "text-ok"}`}>
            {t.kind === "error" ? <XIcon /> : <CheckIcon />}
          </span>
          <span className="min-w-0 break-words">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
