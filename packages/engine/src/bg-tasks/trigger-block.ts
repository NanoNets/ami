import type { TimedTriggers } from "@ami/shared";

/** The trigger block appended to background-agent messages. The event branch carries the Pass-2 decision
 * directive: the agent may decline to act on a weakly-relevant event. */

export type TriggerType = "manual" | "cron" | "window" | "event";

export function buildTriggerBlock(args: {
  trigger: TriggerType;
  triggers?: TimedTriggers;
  /** One-off bias for this run (manual/cron/window). */
  context?: string;
  /** The event payload (event trigger). */
  eventPayload?: string;
  targetNoun: string; // "task" | "live note"
  decisionDirective: string;
}): string {
  const lines: string[] = ["", "---", ""];
  switch (args.trigger) {
    case "manual":
      lines.push(`**Trigger:** Manual run (user-triggered).`);
      break;
    case "cron":
      lines.push(
        `**Trigger:** Scheduled refresh — cron \`${args.triggers?.cronExpr ?? ""}\` matched. This is a baseline refresh of the ${args.targetNoun}.`,
      );
      break;
    case "window":
      lines.push(
        `**Trigger:** Scheduled refresh — fired inside a configured daily window (${(args.triggers?.windows ?? [])
          .map((w) => `${w.startTime}–${w.endTime}`)
          .join(", ")}). Runs once per day per window.`,
      );
      break;
    case "event":
      lines.push(
        `**Trigger:** Event match. A first-pass classifier flagged this ${args.targetNoun} as possibly relevant to the event below (match criteria: "${args.triggers?.eventMatchCriteria ?? ""}").`,
        ``,
        `**Event:**`,
        args.eventPayload ?? "(no payload)",
        ``,
        args.decisionDirective,
      );
      break;
  }
  if (args.context && args.trigger !== "event") {
    lines.push(``, `**Context for this run:** ${args.context}`);
  }
  return lines.join("\n");
}
