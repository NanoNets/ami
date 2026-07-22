import { useSyncExternalStore } from "react";

/** Latest ingest.progress line from the SSE stream ("Gmail: scanned 214
 * emails…"). Components render it only while a connector reports
 * bootstrapping, so no staleness logic lives here. */

let latest: string | null = null;
const subs = new Set<() => void>();

export function publishIngestProgress(message: string): void {
  latest = message;
  for (const f of subs) f();
}

export function useIngestProgress(): string | null {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => latest,
  );
}
