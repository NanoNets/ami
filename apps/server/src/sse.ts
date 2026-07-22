import type { AmiEvent } from "@ami/shared";

type Subscriber = (e: AmiEvent) => void;

const subscribers = new Set<Subscriber>();

export function publish(e: AmiEvent): void {
  for (const sub of subscribers) {
    try {
      sub(e);
    } catch {
      /* subscriber gone */
    }
  }
}

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
