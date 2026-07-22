import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { TodoDto } from "@ami/shared";
import { api } from "../lib/api";
import { ConnectorIcon } from "../components/ConnectorIcon";

export default function History() {
  const { data: todos = [], isLoading } = useQuery({ queryKey: ["todos"], queryFn: api.todos });
  const [showDismissed, setShowDismissed] = useState(false);

  const done = todos
    .filter((t) => t.status === "resolved" || (showDismissed && t.status === "dismissed"))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  if (isLoading) return <div className="text-mut">Loading…</div>;

  // Group by calendar day.
  const groups = new Map<string, TodoDto[]>();
  for (const t of done) {
    const day = new Date(t.updatedAt).toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(t);
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <h1 className="text-xl font-semibold">History</h1>
        <label className="flex items-center gap-2 text-sm text-mut cursor-pointer">
          <input
            type="checkbox"
            checked={showDismissed}
            onChange={(e) => setShowDismissed(e.target.checked)}
          />
          include dismissed
        </label>
        <span className="text-sm text-mut ml-auto">{done.length} items</span>
      </div>

      {done.length === 0 ? (
        <div className="card p-12 text-center text-mut">
          Tasks you resolve{showDismissed ? " or dismiss" : ""} will show up
          here.
        </div>
      ) : (
        <div className="space-y-8">
          {[...groups.entries()].map(([day, items]) => (
            <section key={day}>
              <h2 className="text-sm uppercase tracking-wider text-mut mb-3">{day}</h2>
              <div className="card divide-y divide-edge rise-stagger">
                {items.map((t) => (
                  <Link
                    key={t.id}
                    to={`/tasks/${t.id}`}
                    className="row-link flex items-center gap-3 px-4 py-3 hover:bg-panel2"
                  >
                    <span className="shrink-0"><ConnectorIcon id={t.connector} size={16} /></span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{t.title}</span>
                        <span
                          className={`text-xs shrink-0 ${t.status === "resolved" ? "text-ok" : "text-mut"}`}
                        >
                          {t.status}
                        </span>
                      </div>
                      <p className="text-xs text-mut truncate mt-0.5">{t.summary}</p>
                    </div>
                    <span className="text-xs text-mut shrink-0">
                      {new Date(t.updatedAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
