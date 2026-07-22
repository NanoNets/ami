import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { amiHome, insertLlmUsage, type Db } from "@ami/db";
import { anthropicClient, kgModel, parseWithSchema } from "@ami/memory";

/** Durable event pipeline: producers write JSON
 * files to ~/.ami/events/pending/; a 5s processor routes each event through a
 * liberal Pass-1 LLM classifier against every consumer's targets, fires the
 * candidates (the agent itself is Pass-2 and may decline), then moves the
 * enriched event to done/. */

export interface AmiEventFile {
  id: string;
  source: string;
  type: string;
  createdAt: string;
  payload: string;
  /** Direct target — skips Pass-1 for that consumer. */
  target?: { consumer: string; id: string };
  processedAt?: string;
  consumers?: Record<string, { candidateIds: string[]; runIds: (string | null)[]; errors: string[] }>;
}

export interface EventConsumerTarget {
  id: string;
  instructions: string;
  eventMatchCriteria: string;
}

export interface EventConsumer {
  name: string;
  listEligibleTargets(): Promise<EventConsumerTarget[]>;
  fireCandidate(event: AmiEventFile, id: string): Promise<{ runId: string | null; error?: string }>;
}

function pendingDir(): string {
  const d = path.join(amiHome(), "events", "pending");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function doneDir(): string {
  const d = path.join(amiHome(), "events", "done");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

let seq = 0;

/** Write an event to pending/ — filenames sort by creation order. */
export function createEvent(event: Omit<AmiEventFile, "id">): void {
  const id = `${Date.now().toString(36)}-${(seq++).toString(36).padStart(3, "0")}`;
  fs.writeFileSync(path.join(pendingDir(), `${id}.json`), JSON.stringify({ id, ...event }, null, 2), "utf-8");
}

// ── Pass-1 routing ───────────────────────────────────────────────────────────

const Pass1Schema = z.object({ ids: z.array(z.string()) });
const BATCH_SIZE = 20;

async function routeBatch(
  db: Db,
  event: AmiEventFile,
  targets: EventConsumerTarget[],
  nouns: { singular: string; plural: string },
): Promise<string[]> {
  if (targets.length === 0) return [];
  const client = anthropicClient(db);
  if (!client || process.env.AMI_FAKE_LLM === "1") return [];
  const model = kgModel(db);
  const matched = new Set<string>();

  const system = `You are a routing classifier for a personal AI assistant.

You will receive an event (something that happened — a message, email, meeting, etc.) and a list of ${nouns.plural}. Each has: id, intent (what it should keep being/doing), and matchCriteria (which incoming signals should wake it).

Identify which ${nouns.plural} MIGHT be relevant to this event.

Rules:
- Be LIBERAL. Include any ${nouns.singular} that is even moderately relevant — prefer false positives over false negatives (a later stage decides whether to actually act).
- Only exclude entries that are CLEARLY and OBVIOUSLY irrelevant.
- Return each candidate's id exactly as given; empty list when nothing is relevant.`;

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    try {
      const res = await parseWithSchema(
        db,
        client,
        {
          model,
          max_tokens: 1000,
          system,
          messages: [
            {
              role: "user",
              content: `## Event\n\nSource: ${event.source}\nType: ${event.type}\nTime: ${event.createdAt}\n\n${event.payload}\n\n## ${nouns.plural}\n\n${batch
                .map((t, j) => `${j + 1}. id: ${t.id}\n   intent: ${t.instructions.slice(0, 400)}\n   matchCriteria: ${t.eventMatchCriteria}`)
                .join("\n\n")}`,
            },
          ],
        },
        Pass1Schema,
      );
      insertLlmUsage(db, {
        useCase: "event_routing",
        model,
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      });
      for (const id of res.parsed_output?.ids ?? []) matched.add(id);
    } catch (e: any) {
      console.error(`[events] Pass-1 batch failed:`, e.message);
    }
  }
  return targets.filter((t) => matched.has(t.id)).map((t) => t.id);
}

// ── Processor ────────────────────────────────────────────────────────────────

const consumers: { consumer: EventConsumer; nouns: { singular: string; plural: string } }[] = [];

export function registerEventConsumer(
  consumer: EventConsumer,
  nouns: { singular: string; plural: string },
): void {
  consumers.push({ consumer, nouns });
}

let processing = false;

export async function processPendingEvents(db: Db): Promise<number> {
  if (processing) return 0;
  processing = true;
  try {
    const files = fs.readdirSync(pendingDir()).filter((f) => f.endsWith(".json")).sort();
    let handled = 0;
    for (const file of files) {
      const abs = path.join(pendingDir(), file);
      let event: AmiEventFile;
      try {
        event = JSON.parse(fs.readFileSync(abs, "utf-8"));
      } catch {
        fs.renameSync(abs, path.join(doneDir(), file)); // malformed — park it
        continue;
      }

      const results: AmiEventFile["consumers"] = {};
      for (const { consumer, nouns } of consumers) {
        const entry = { candidateIds: [] as string[], runIds: [] as (string | null)[], errors: [] as string[] };
        try {
          const targets = await consumer.listEligibleTargets();
          const candidates =
            event.target?.consumer === consumer.name
              ? targets.some((t) => t.id === event.target!.id)
                ? [event.target.id]
                : []
              : await routeBatch(db, event, targets, nouns);
          entry.candidateIds = candidates;
          for (const id of candidates) {
            const res = await consumer.fireCandidate(event, id);
            entry.runIds.push(res.runId);
            if (res.error) entry.errors.push(res.error);
          }
        } catch (e: any) {
          entry.errors.push(String(e.message ?? e));
        }
        results[consumer.name] = entry;
      }

      const enriched: AmiEventFile = { ...event, processedAt: new Date().toISOString(), consumers: results };
      fs.writeFileSync(path.join(doneDir(), file), JSON.stringify(enriched, null, 2), "utf-8");
      fs.unlinkSync(abs);
      handled++;
    }
    return handled;
  } finally {
    processing = false;
  }
}
