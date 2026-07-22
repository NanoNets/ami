import type { ConnectorId } from "@ami/shared";
import type { AmiConnector } from "./types.js";
import { slackConnector } from "./slack/index.js";
import { githubConnector } from "./github/index.js";
import { gmailConnector } from "./gmail/index.js";
import { gcalConnector } from "./gcal/index.js";
import { zoomConnector } from "./zoom/index.js";
import { notionConnector } from "./notion/index.js";
import { ghostConnector } from "./ghost/index.js";
import { linearConnector } from "./linear/index.js";
import { hubspotConnector } from "./hubspot/index.js";
import { jiraConnector } from "./jira/index.js";
import { gdriveConnector } from "./gdrive/index.js";
import { posthogConnector } from "./posthog/index.js";
import { metabaseConnector } from "./metabase/index.js";
import { stripeConnector } from "./stripe/index.js";
import { m365Connector } from "./m365/index.js";
import { msteamsConnector } from "./msteams/index.js";
import { awsConnector } from "./aws/index.js";

const registry = new Map<ConnectorId, AmiConnector>(
  [
    slackConnector,
    githubConnector,
    gmailConnector,
    gcalConnector,
    gdriveConnector,
    linearConnector,
    jiraConnector,
    hubspotConnector,
    stripeConnector,
    posthogConnector,
    metabaseConnector,
    m365Connector,
    msteamsConnector,
    zoomConnector,
    notionConnector,
    ghostConnector,
    awsConnector,
  ].map((c) => [c.id, c]),
);

export function getConnector(id: string): AmiConnector | undefined {
  return registry.get(id as ConnectorId);
}

export function allConnectors(): AmiConnector[] {
  return [...registry.values()];
}

/** Register a connector at runtime (user-built custom connectors). Replaces
 * any previous registration with the same id, so a rebuild takes effect
 * without a restart. */
export function registerConnector(c: AmiConnector): void {
  registry.set(c.id, c);
}

export function unregisterConnector(id: string): void {
  registry.delete(id as ConnectorId);
}
