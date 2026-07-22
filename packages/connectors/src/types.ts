import type { AuthBlob, ConnectorId, NormalizedSignal, StreamDef } from "@ami/shared";
import type { ZodRawShape } from "zod";

export interface PollContext {
  auth: AuthBlob;
  stream: string;
  cursor: string | null;
  /** Connector-specific user configuration (e.g. Slack read-all channel list),
   * supplied by the scheduler from settings. */
  config?: Record<string, unknown>;
}

export interface PollResult {
  signals: NormalizedSignal[];
  nextCursor: string | null;
}

export interface ActionResult {
  ok: boolean;
  url?: string;
  externalId?: string;
  output: unknown;
  error?: string;
}

export interface ConnectorAction {
  name: string;
  description: string;
  schema: ZodRawShape;
  /** Actions that deliver a message to a human. These are excluded from the agent's
   * tool surface — sending always goes through the draft-approval flow. */
  isSend?: boolean;
  /** Approval-gated actions (e.g. low-risk infra writes): exposed to the agent,
   * but every call pauses on a permission question the user must approve in the
   * console. Excluded entirely from unattended (background) runs. */
  needsApproval?: boolean;
  /** Pure reads (no side effects). Marked with MCP readOnlyHint so they stay
   * available in plan mode. */
  readOnly?: boolean;
  run(auth: AuthBlob, input: Record<string, unknown>): Promise<ActionResult>;
}

/** One-time first-connect backfill. Two very different outputs:
 * - docs: condensed digest documents (sent-mail digests, calendar history,
 *   workspace directories) that feed the knowledge graph builder — historical
 *   context, never the to-do list.
 * - triage: recent actionable items (last ~7 days of inbox/mentions) that go
 *   through normal triage to seed the first task list. */
export interface BootstrapResult {
  docs: { name: string; title: string; body: string }[];
  triage: NormalizedSignal[];
}

export interface AmiConnector {
  id: ConnectorId;
  meta: {
    label: string;
    authKind: "token" | "oauth" | "none";
    /** Which auth fields the onboarding form should collect (token connectors). */
    authFields: { key: string; label: string; placeholder?: string; secret?: boolean; optional?: boolean }[];
    setupHelp: string;
    /** One-click setup openers rendered as buttons in the connect panel
     * (e.g. Slack's pre-filled create-app-from-manifest URL, GitHub's
     * scope-pre-selected token page). `{field}` placeholders are substituted
     * client-side from the auth fields the user has typed (Ghost's admin URL
     * depends on the blog domain); the button stays disabled until filled. */
    setupActions?: { label: string; url: string }[];
  };
  validateAuth(auth: AuthBlob): Promise<{ ok: boolean; accountLabel?: string; error?: string }>;
  streams(): StreamDef[];
  poll(ctx: PollContext): Promise<PollResult>;
  bootstrap?(auth: AuthBlob, onProgress?: (message: string) => void): Promise<BootstrapResult>;
  /** Optional: the account owner's identity, used to pre-fill "who are you"
   * during onboarding (never overwrites user-set values). */
  identity?(auth: AuthBlob): Promise<{ name?: string; email?: string }>;
  actions: ConnectorAction[];
}
