import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import type { AuthBlob, NormalizedSignal } from "@ami/shared";
import type { AmiConnector, ActionResult, BootstrapResult } from "../types.js";

const execFileP = promisify(execFile);

/** AWS via SigV4-signed raw API calls (aws4fetch — no per-service SDKs).
 *
 * Two generic surfaces instead of a hardcoded action list, so agents can reach
 * ALL AWS services:
 * - aws_read: any read-verb action (Get/List/Describe/...) or GET/HEAD REST path.
 * - aws_write: approval-gated (needsApproval) low-risk writes — additive and
 *   reversible operational actions. Destructive, security/IAM/network/DNS, and
 *   human-messaging operations are refused outright in code, on top of the
 *   user-approval gate.
 *
 * Protocol handling: a built-in map covers the popular query/JSON-protocol
 * services; REST services (s3, cloudfront, lambda, ...) work via method+path,
 * which the model constructs itself. XML responses are returned as raw text —
 * the agent reads XML fine. */

interface ServiceDef {
  protocol: "query" | "json";
  version: string;
  /** X-Amz-Target prefix (JSON protocol). */
  target?: string;
  /** application/x-amz-json version; default "1.1". */
  jsonVersion?: "1.0" | "1.1";
  /** Region-less endpoint, signed against us-east-1. */
  global?: boolean;
  /** Host override when it isn't `${id}.${region}.amazonaws.com`. */
  host?: string;
}

const SERVICES: Record<string, ServiceDef> = {
  // Query protocol (form-encoded Action/Version, XML responses)
  ec2: { protocol: "query", version: "2016-11-15" },
  monitoring: { protocol: "query", version: "2010-08-01" }, // CloudWatch
  rds: { protocol: "query", version: "2014-10-31" },
  elasticloadbalancing: { protocol: "query", version: "2015-12-01" },
  autoscaling: { protocol: "query", version: "2011-01-01" },
  cloudformation: { protocol: "query", version: "2010-05-15" },
  elasticache: { protocol: "query", version: "2015-02-02" },
  redshift: { protocol: "query", version: "2012-12-01" },
  sns: { protocol: "query", version: "2010-03-31" },
  iam: { protocol: "query", version: "2010-05-08", global: true, host: "iam.amazonaws.com" },
  sts: { protocol: "query", version: "2011-06-15", global: true, host: "sts.amazonaws.com" },
  // JSON protocol (X-Amz-Target)
  logs: { protocol: "json", version: "2014-03-28", target: "Logs_20140328" },
  dynamodb: { protocol: "json", version: "2012-08-10", target: "DynamoDB_20120810", jsonVersion: "1.0" },
  ecs: { protocol: "json", version: "2014-11-13", target: "AmazonEC2ContainerServiceV20141113" },
  events: { protocol: "json", version: "2015-10-07", target: "AWSEvents" },
  states: { protocol: "json", version: "2016-11-23", target: "AWSStepFunctions", jsonVersion: "1.0" },
  ssm: { protocol: "json", version: "2014-11-06", target: "AmazonSSM" },
  secretsmanager: { protocol: "json", version: "2017-10-17", target: "secretsmanager" },
  kms: { protocol: "json", version: "2014-11-01", target: "TrentService" },
  kinesis: { protocol: "json", version: "2013-12-02", target: "Kinesis_20131202" },
  firehose: { protocol: "json", version: "2015-08-04", target: "Firehose_20150804" },
  athena: { protocol: "json", version: "2017-05-18", target: "AmazonAthena" },
  glue: { protocol: "json", version: "2017-03-31", target: "AWSGlue" },
  sqs: { protocol: "json", version: "2012-11-05", target: "AmazonSQS", jsonVersion: "1.0" },
  cloudtrail: {
    protocol: "json",
    version: "2013-11-01",
    target: "com.amazonaws.cloudtrail.v20131102.CloudTrail_20131102",
  },
  organizations: {
    protocol: "json",
    version: "2016-11-28",
    target: "AWSOrganizationsV20161128",
    global: true,
    host: "organizations.us-east-1.amazonaws.com",
  },
  ce: { protocol: "json", version: "2017-10-25", target: "AWSInsightsIndexService", global: true, host: "ce.us-east-1.amazonaws.com" },
};

/** Hosts for REST-protocol services that don't follow `${id}.${region}...`. */
const REST_GLOBAL_HOSTS: Record<string, string> = {
  cloudfront: "cloudfront.amazonaws.com",
  route53: "route53.amazonaws.com",
};

// ---------- read/write policy ----------

const READ_ACTION = /^(Get|List|Describe|Lookup|Search|BatchGet|Head|Query|Scan|Select|Simulate|Estimate|Preview)/;

/** Services whose writes Ami never performs: identity/security, DNS, org
 * structure, and anything that delivers messages to humans (the never-send
 * invariant extends to SNS/SES/SQS/etc.). */
const DENY_WRITE_SERVICES = new Set([
  "iam", "sts", "organizations", "kms", "route53", "route53domains",
  "sns", "ses", "sesv2", "sqs", "pinpoint", "connect", "workmail", "chime",
  "sso", "sso-admin", "identitystore", "cognito-idp", "cognito-identity", "signer", "acm", "acm-pca",
]);

/** Write actions Ami refuses even with approval: destructive verbs, and
 * security/permission/network-topology changes in any service. */
const DENY_WRITE_ACTION =
  /^(Delete|Terminate|Deregister|Destroy|Disassociate|Detach|Cancel|Purge|Release|Revoke|Disable|Remove|Reject|Publish|Send|Post)|Policy|Permission|Acl|Grant|Authorize|SecurityGroup|NetworkAcl|RouteTable|Vpc[A-Z]|Subnet|Gateway|PeeringConnection/;

function writePolicy(service: string, actionOrPath: string, method?: string): string | null {
  if (DENY_WRITE_SERVICES.has(service)) {
    return `writes to '${service}' are permanently disabled in Ami (identity/security/DNS/messaging) — propose the change to the user as an artifact instead`;
  }
  if (method === "DELETE") {
    return "DELETE requests are permanently disabled in Ami — propose the change to the user as an artifact instead";
  }
  if (/policy|permission|acl|grant/i.test(actionOrPath) || DENY_WRITE_ACTION.test(actionOrPath)) {
    return `'${actionOrPath}' is outside Ami's low-risk write envelope (destructive or security-sensitive) — propose the exact change to the user as an artifact instead`;
  }
  return null;
}

// ---------- credentials (pasted keys, or the local AWS CLI chain) ----------

interface ResolvedCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Refresh-by time for temporary credentials (already includes a 5-min margin). */
  expiresAt?: number;
  source: "form" | "cli" | "file";
}

let cliCache: { profile: string; creds: ResolvedCreds; fetchedAt: number } | null = null;

function parseIniSection(text: string, section: string): Record<string, string> {
  const out: Record<string, string> = {};
  let cur = "";
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^\s*\[([^\]]+)\]/);
    if (h) {
      cur = h[1].trim();
      continue;
    }
    if (cur !== section) continue;
    const kv = line.match(/^\s*(\w+)\s*=\s*(.+?)\s*$/);
    if (kv) out[kv[1].toLowerCase()] = kv[2];
  }
  return out;
}

/** Empty key fields mean "use the machine's own AWS CLI credentials" — Ami is
 * local-first, so the local credential chain is fair game. The CLI resolves
 * static keys, SSO and assumed roles uniformly and refreshes expiring ones;
 * a direct ~/.aws/credentials parse covers machines without the CLI. */
async function resolveCreds(auth: AuthBlob): Promise<ResolvedCreds> {
  if (auth.access_key_id && auth.secret_access_key) {
    return {
      accessKeyId: auth.access_key_id,
      secretAccessKey: auth.secret_access_key,
      sessionToken: auth.session_token || undefined,
      source: "form",
    };
  }
  const profile = String(auth.profile || process.env.AWS_PROFILE || "default");
  const now = Date.now();
  if (cliCache && cliCache.profile === profile && now < (cliCache.creds.expiresAt ?? cliCache.fetchedAt + 5 * 60_000)) {
    return cliCache.creds;
  }
  try {
    const { stdout } = await execFileP("aws", ["configure", "export-credentials", "--profile", profile], {
      timeout: 15_000,
    });
    const j = JSON.parse(stdout);
    if (j.AccessKeyId && j.SecretAccessKey) {
      const creds: ResolvedCreds = {
        accessKeyId: j.AccessKeyId,
        secretAccessKey: j.SecretAccessKey,
        sessionToken: j.SessionToken || undefined,
        expiresAt: j.Expiration ? Date.parse(j.Expiration) - 5 * 60_000 : undefined,
        source: "cli",
      };
      cliCache = { profile, creds, fetchedAt: now };
      return creds;
    }
  } catch {
    // CLI missing or profile broken — try the credentials file directly.
  }
  try {
    const text = fs.readFileSync(path.join(os.homedir(), ".aws", "credentials"), "utf8");
    const s = parseIniSection(text, profile);
    if (s.aws_access_key_id && s.aws_secret_access_key) {
      const creds: ResolvedCreds = {
        accessKeyId: s.aws_access_key_id,
        secretAccessKey: s.aws_secret_access_key,
        sessionToken: s.aws_session_token || undefined,
        source: "file",
      };
      cliCache = { profile, creds, fetchedAt: now };
      return creds;
    }
  } catch {
    /* no credentials file */
  }
  throw new Error(
    `no AWS credentials: paste access keys in the connect form, or configure the AWS CLI (profile '${profile}')`,
  );
}

const regionCache = new Map<string, string>();

/** Region precedence: connect-form field → ~/.aws/config for the profile → us-east-1. */
function localRegion(auth: AuthBlob): string {
  if (auth.region) return String(auth.region);
  const profile = String(auth.profile || process.env.AWS_PROFILE || "default");
  const cached = regionCache.get(profile);
  if (cached) return cached;
  let region = "us-east-1";
  try {
    const text = fs.readFileSync(path.join(os.homedir(), ".aws", "config"), "utf8");
    const s = parseIniSection(text, profile === "default" ? "default" : `profile ${profile}`);
    if (s.region) region = s.region;
  } catch {
    /* no config file */
  }
  regionCache.set(profile, region);
  return region;
}

// ---------- request plumbing ----------

async function client(auth: AuthBlob): Promise<AwsClient> {
  const c = await resolveCreds(auth);
  return new AwsClient({
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    sessionToken: c.sessionToken,
  });
}

/** Query-protocol params flatten to Foo.Bar=..., lists to Name.member.1=... */
function flattenQueryParams(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === "object") {
          Object.assign(out, flattenQueryParams(item as Record<string, unknown>, `${key}.${i + 1}`));
        } else {
          out[`${key}.${i + 1}`] = String(item);
        }
      });
    } else if (v !== null && typeof v === "object") {
      Object.assign(out, flattenQueryParams(v as Record<string, unknown>, key));
    } else if (v !== undefined) {
      out[key] = String(v);
    }
  }
  return out;
}

export interface AwsCallArgs {
  service: string;
  region?: string;
  action?: string;
  params?: Record<string, unknown>;
  path?: string;
  method?: string;
  body?: string;
  target?: string;
  version?: string;
}

const MAX_RESPONSE_CHARS = 20000;

async function awsCall(auth: AuthBlob, args: AwsCallArgs): Promise<{ status: number; body: unknown }> {
  const service = args.service.toLowerCase().trim();
  const def = SERVICES[service];
  const region = args.region?.trim() || (def?.global ? "us-east-1" : localRegion(auth));
  const aws = await client(auth);

  let url: string;
  let init: RequestInit & { aws: { service: string; region: string } };

  if (args.path) {
    // REST mode: the model constructs the path (it knows the AWS REST APIs).
    const host =
      REST_GLOBAL_HOSTS[service] ?? (service === "s3" ? `s3.${region}.amazonaws.com` : `${service}.${region}.amazonaws.com`);
    const restRegion = REST_GLOBAL_HOSTS[service] ? "us-east-1" : region;
    url = `https://${host}${args.path.startsWith("/") ? args.path : `/${args.path}`}`;
    init = {
      method: args.method ?? (args.body ? "POST" : "GET"),
      body: args.body,
      headers: args.body?.trim().startsWith("<") ? { "Content-Type": "application/xml" } : args.body ? { "Content-Type": "application/json" } : undefined,
      aws: { service, region: restRegion },
    };
  } else if (def?.protocol === "json" || args.target) {
    const target = args.target ?? def!.target!;
    const host = def?.host ?? `${service}.${region}.amazonaws.com`;
    url = `https://${host}/`;
    init = {
      method: "POST",
      headers: {
        "Content-Type": `application/x-amz-json-${def?.jsonVersion ?? "1.1"}`,
        "X-Amz-Target": `${target}.${args.action}`,
      },
      body: JSON.stringify(args.params ?? {}),
      aws: { service, region },
    };
  } else {
    // Query protocol (also the fallback for unmapped services when a version is supplied).
    const version = args.version ?? def?.version;
    if (!version) {
      throw new Error(
        `service '${service}' is not in the built-in map — pass 'target' (JSON protocol), 'version' (query protocol), or use REST mode with 'path'`,
      );
    }
    const host = def?.host ?? `${service}.${region}.amazonaws.com`;
    url = `https://${host}/`;
    const form = new URLSearchParams({ Action: String(args.action), Version: version, ...flattenQueryParams(args.params ?? {}) });
    init = {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      aws: { service, region },
    };
  }

  const res = await aws.fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`aws ${service} ${args.action ?? args.path}: ${res.status} ${text.slice(0, 800)}`);
  }
  const trimmed = text.length > MAX_RESPONSE_CHARS ? `${text.slice(0, MAX_RESPONSE_CHARS)}\n...[truncated]` : text;
  try {
    return { status: res.status, body: JSON.parse(trimmed) };
  } catch {
    return { status: res.status, body: trimmed };
  }
}

// ---------- tiny XML digging (query-protocol responses) ----------

function xmlBlocks(text: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

function xmlTag(block: string, tag: string): string {
  return block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? "";
}

// ---------- alarm signals (stream + bootstrap triage) ----------

async function fetchAlarmSignals(auth: AuthBlob, sinceIso: string): Promise<{ signals: NormalizedSignal[]; maxIso: string }> {
  const { body } = await awsCall(auth, {
    service: "monitoring",
    action: "DescribeAlarms",
    params: { StateValue: "ALARM", MaxRecords: 50 },
  });
  const signals: NormalizedSignal[] = [];
  let max = sinceIso;
  const region = String(auth.region ?? "us-east-1");
  for (const block of xmlBlocks(String(body), "member")) {
    const name = xmlTag(block, "AlarmName");
    if (!name) continue; // members of nested lists (dimensions, actions)
    const updated = xmlTag(block, "StateUpdatedTimestamp");
    if (!updated || updated <= sinceIso) continue;
    if (updated > max) max = updated;
    signals.push({
      externalId: `alarm:${name}:${updated}`,
      kind: "issue",
      title: `CloudWatch alarm: ${name}`,
      body: [
        `State: ALARM since ${updated}`,
        xmlTag(block, "MetricName") ? `Metric: ${xmlTag(block, "Namespace")}/${xmlTag(block, "MetricName")}` : "",
        xmlTag(block, "StateReason"),
      ]
        .filter(Boolean)
        .join("\n"),
      author: "",
      url: `https://console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(name)}`,
      threadRef: name,
      raw: { alarmName: name, stateUpdated: updated },
      occurredAt: updated,
    });
  }
  return { signals, maxIso: max };
}

export const awsConnector: AmiConnector = {
  id: "aws",
  meta: {
    label: "AWS",
    authKind: "token",
    authFields: [
      { key: "access_key_id", label: "Access key ID (blank = use local AWS CLI credentials)", placeholder: "AKIA…", optional: true },
      { key: "secret_access_key", label: "Secret access key", secret: true, optional: true },
      { key: "region", label: "Default region (blank = from ~/.aws/config)", placeholder: "us-east-1", optional: true },
      { key: "session_token", label: "Session token (temporary credentials only)", secret: true, optional: true },
      { key: "profile", label: "AWS CLI profile (when using local credentials)", placeholder: "default", optional: true },
    ],
    setupHelp:
      "Two ways to connect. Easiest: leave everything blank and Ami uses your local AWS CLI credentials (~/.aws, 'default' or the profile you name; SSO and temporary credentials refresh automatically) — with your full permissions. More contained: paste access keys for a dedicated IAM user with ReadOnlyAccess plus the specific low-risk writes you want to allow. Either way, every write requires your live approval in the console, and destructive or security/IAM/DNS operations are refused outright.",
  },
  async validateAuth(auth) {
    try {
      const creds = await resolveCreds(auth);
      const { body } = await awsCall(auth, { service: "sts", action: "GetCallerIdentity" });
      const text = String(body);
      const account = xmlTag(text, "Account");
      const arn = xmlTag(text, "Arn");
      const via = creds.source === "form" ? "" : " · local CLI";
      return { ok: true, accountLabel: `${arn.split("/").pop() ?? "aws"} @ ${account}${via}` };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
  streams() {
    return [{ name: "alarms", intervalSec: 300 }];
  },
  async poll({ auth, cursor }) {
    const since = cursor ?? new Date(Date.now() - 24 * 3600_000).toISOString();
    const { signals, maxIso } = await fetchAlarmSignals(auth, since);
    return { signals, nextCursor: maxIso };
  },
  async bootstrap(auth, onProgress): Promise<BootstrapResult> {
    const sections: string[] = [];
    const region = String(auth.region ?? "us-east-1");

    onProgress?.("reading account identity");
    try {
      const { body } = await awsCall(auth, { service: "sts", action: "GetCallerIdentity" });
      sections.push(`Account ${xmlTag(String(body), "Account")}, default region ${region}, connected as ${xmlTag(String(body), "Arn")}.`);
    } catch (e: any) {
      console.error(`[aws bootstrap] sts: ${e.message}`);
    }

    onProgress?.("reading compute footprint");
    try {
      const { body } = await awsCall(auth, { service: "ec2", action: "DescribeInstances", params: { MaxResults: 100 } });
      const text = String(body);
      const ids = xmlBlocks(text, "instanceId");
      const types = xmlBlocks(text, "instanceType");
      const states = xmlBlocks(text, "instanceState").map((b) => xmlTag(b, "name"));
      if (ids.length) {
        const lines = ids.map((id, i) => `- ${id} — ${types[i] ?? "?"}, ${states[i] ?? "?"}`);
        sections.push(`## EC2 instances (${region})\n\n${lines.join("\n")}`);
      }
    } catch (e: any) {
      console.error(`[aws bootstrap] ec2: ${e.message}`);
    }
    try {
      const { body } = await awsCall(auth, { service: "lambda", path: "/2015-03-31/functions/?MaxItems=100" });
      const fns: any[] = (body as any)?.Functions ?? [];
      if (fns.length) {
        const lines = fns.map((f) => `- ${f.FunctionName} — ${f.Runtime ?? "container"}, modified ${String(f.LastModified ?? "").slice(0, 10)}`);
        sections.push(`## Lambda functions (${region})\n\n${lines.join("\n")}`);
      }
    } catch (e: any) {
      console.error(`[aws bootstrap] lambda: ${e.message}`);
    }
    try {
      const { body } = await awsCall(auth, { service: "rds", action: "DescribeDBInstances" });
      const dbs = xmlBlocks(String(body), "DBInstance").map(
        (b) => `- ${xmlTag(b, "DBInstanceIdentifier")} — ${xmlTag(b, "Engine")} ${xmlTag(b, "DBInstanceClass")}, ${xmlTag(b, "DBInstanceStatus")}`,
      );
      if (dbs.length) sections.push(`## RDS instances (${region})\n\n${dbs.join("\n")}`);
    } catch (e: any) {
      console.error(`[aws bootstrap] rds: ${e.message}`);
    }

    onProgress?.("reading storage and CDN");
    try {
      const { body } = await awsCall(auth, { service: "s3", path: "/" });
      const buckets = xmlBlocks(String(body), "Bucket").map((b) => `- ${xmlTag(b, "Name")}`);
      if (buckets.length) sections.push(`## S3 buckets\n\n${buckets.join("\n")}`);
    } catch (e: any) {
      console.error(`[aws bootstrap] s3: ${e.message}`);
    }
    try {
      const { body } = await awsCall(auth, { service: "cloudfront", path: "/2020-05-31/distribution" });
      const dists = xmlBlocks(String(body), "DistributionSummary").map((b) => {
        const aliases = xmlBlocks(b, "CNAME").join(", ");
        return `- ${xmlTag(b, "Id")} — ${xmlTag(b, "DomainName")}${aliases ? ` (${aliases})` : ""}, ${xmlTag(b, "Status")}`;
      });
      if (dists.length) sections.push(`## CloudFront distributions\n\n${dists.join("\n")}`);
    } catch (e: any) {
      console.error(`[aws bootstrap] cloudfront: ${e.message}`);
    }

    onProgress?.("reading month-to-date spend");
    try {
      const now = new Date();
      const start = `${now.toISOString().slice(0, 8)}01`;
      const end = now.toISOString().slice(0, 10);
      const { body } = await awsCall(auth, {
        service: "ce",
        action: "GetCostAndUsage",
        params: {
          TimePeriod: { Start: start, End: end },
          Granularity: "MONTHLY",
          Metrics: ["UnblendedCost"],
          GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        },
      });
      const groups: any[] = (body as any)?.ResultsByTime?.[0]?.Groups ?? [];
      const lines = groups
        .map((g) => ({ name: g.Keys?.[0], amount: parseFloat(g.Metrics?.UnblendedCost?.Amount ?? "0") }))
        .filter((g) => g.amount >= 0.01)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 20)
        .map((g) => `- ${g.name}: $${g.amount.toFixed(2)}`);
      if (lines.length) sections.push(`## Month-to-date spend by service\n\n${lines.join("\n")}`);
    } catch (e: any) {
      console.error(`[aws bootstrap] cost: ${e.message}`);
    }

    // First task list: alarms currently firing.
    onProgress?.("reading active alarms");
    let triage: NormalizedSignal[] = [];
    try {
      const { signals } = await fetchAlarmSignals(auth, new Date(Date.now() - 7 * 24 * 3600_000).toISOString());
      triage = signals.slice(0, 10);
    } catch (e: any) {
      console.error(`[aws bootstrap] alarms: ${e.message}`);
    }

    return {
      docs: sections.length
        ? [
            {
              name: "aws-account-overview",
              title: "AWS: account footprint",
              body: `Snapshot of the user's AWS account at connect time — what runs where and what it costs. Alarm state changes arrive as signals from here on.\n\n${sections.join("\n\n")}`,
            },
          ]
        : [],
      triage,
    };
  },
  actions: [
    {
      name: "aws_read",
      readOnly: true,
      description:
        'Call any read-only AWS API (SigV4-signed with the user\'s credentials). Two modes: (1) action mode for query/JSON-protocol services — service + action + params, e.g. service "ec2" action "DescribeInstances", service "monitoring" action "DescribeAlarms", service "dynamodb" action "ListTables"; (2) REST mode for s3/cloudfront/lambda/apigateway/etc. — service + path (GET), e.g. service "cloudfront" path "/2020-05-31/distribution", service "s3" path "/my-bucket?list-type=2&prefix=logs/". Only Get/List/Describe/Lookup/Search/Query/Scan-style actions and GET/HEAD requests are permitted. XML responses come back as raw text — read them directly.',
      schema: {
        service: z.string().describe('Endpoint id: "ec2", "s3", "cloudfront", "rds", "ecs", "logs", "dynamodb", "lambda", "cloudtrail", ...'),
        action: z.string().optional().describe("API action name (action mode)"),
        params: z.record(z.string(), z.unknown()).optional().describe("Action parameters"),
        path: z.string().optional().describe("Request path incl. query string (REST mode; GET)"),
        region: z.string().optional().describe("Defaults to the connected region"),
        target: z.string().optional().describe("X-Amz-Target prefix for JSON-protocol services not in the built-in map"),
        version: z.string().optional().describe("API version for query-protocol services not in the built-in map"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          if (input.action && !READ_ACTION.test(String(input.action))) {
            return { ok: false, output: null, error: `'${input.action}' is not a read action — use aws_write for writes` };
          }
          const method = input.path ? "GET" : undefined;
          const { body } = await awsCall(auth, { ...(input as unknown as AwsCallArgs), method });
          return { ok: true, output: body };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "aws_logs_query",
      readOnly: true,
      description:
        "Run a CloudWatch Logs Insights query over one or more log groups and return the rows — the search surface for application logs. Query syntax: fields/filter/stats/sort/limit.",
      schema: {
        query: z.string().describe('e.g. fields @timestamp, @message | filter @message like /error/ | sort @timestamp desc | limit 20'),
        logGroups: z.array(z.string()).min(1).max(10),
        sinceHours: z.number().optional().describe("Look-back window (default 24)"),
        region: z.string().optional(),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const end = Math.floor(Date.now() / 1000);
          const start = end - Math.round((Number(input.sinceHours) || 24) * 3600);
          const region = input.region ? String(input.region) : undefined;
          const started = await awsCall(auth, {
            service: "logs",
            region,
            action: "StartQuery",
            params: { logGroupNames: input.logGroups, queryString: String(input.query), startTime: start, endTime: end },
          });
          const queryId = (started.body as any)?.queryId;
          if (!queryId) return { ok: false, output: null, error: "StartQuery returned no queryId" };
          for (let i = 0; i < 15; i++) {
            await new Promise((r) => setTimeout(r, 1500));
            const res = await awsCall(auth, { service: "logs", region, action: "GetQueryResults", params: { queryId } });
            const b: any = res.body;
            if (b?.status === "Complete") {
              const rows = (b.results ?? []).map((row: any[]) =>
                Object.fromEntries(row.filter((f) => f.field !== "@ptr").map((f) => [f.field, f.value])),
              );
              return { ok: true, output: { rows, stats: b.statistics } };
            }
            if (b?.status === "Failed" || b?.status === "Cancelled") {
              return { ok: false, output: null, error: `query ${b.status}` };
            }
          }
          return { ok: false, output: null, error: "query timed out after ~22s — narrow the time window or log groups" };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "aws_cost_report",
      readOnly: true,
      description:
        "AWS spend over recent days grouped by service (Cost Explorer). Note: AWS bills $0.01 per call — don't poll it in loops.",
      schema: {
        days: z.number().int().min(1).max(365).optional().describe("Look-back window (default 30)"),
        granularity: z.enum(["DAILY", "MONTHLY"]).optional(),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const days = Number(input.days) || 30;
          const end = new Date().toISOString().slice(0, 10);
          const start = new Date(Date.now() - days * 24 * 3600_000).toISOString().slice(0, 10);
          const { body } = await awsCall(auth, {
            service: "ce",
            action: "GetCostAndUsage",
            params: {
              TimePeriod: { Start: start, End: end },
              Granularity: String(input.granularity ?? "MONTHLY"),
              Metrics: ["UnblendedCost"],
              GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
            },
          });
          const periods = ((body as any)?.ResultsByTime ?? []).map((p: any) => ({
            period: `${p.TimePeriod?.Start} → ${p.TimePeriod?.End}`,
            services: (p.Groups ?? [])
              .map((g: any) => ({ service: g.Keys?.[0], usd: parseFloat(g.Metrics?.UnblendedCost?.Amount ?? "0") }))
              .filter((g: any) => g.usd >= 0.01)
              .sort((a: any, b: any) => b.usd - a.usd)
              .slice(0, 25),
          }));
          return { ok: true, output: periods };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
    {
      name: "aws_write",
      needsApproval: true,
      description:
        'Perform a LOW-RISK AWS write — additive or reversible operational actions across all services: cloudfront CreateInvalidation, ecs UpdateService, ec2 Start/Stop/RebootInstances, rds RebootDBInstance, autoscaling SetDesiredCapacity, states StartExecution, ssm PutParameter, ec2 CreateSnapshot/CreateTags, s3 PutObject (REST mode), and similar. Every call pauses for the user\'s explicit approval before executing. Refused outright regardless of approval: deletes/terminates, IAM/security/policy/ACL, network topology, DNS, and anything that sends messages to humans (SNS/SES/SQS) — for those, produce the exact change (CLI command or config) as an artifact instead. Same two modes as aws_read: action mode (service+action+params) or REST mode (service+method+path+body).',
      schema: {
        service: z.string(),
        action: z.string().optional().describe("API action name (action mode)"),
        params: z.record(z.string(), z.unknown()).optional(),
        path: z.string().optional().describe("Request path (REST mode)"),
        method: z.enum(["POST", "PUT", "PATCH"]).optional().describe("REST mode method (default POST)"),
        body: z.string().optional().describe("REST mode request body (JSON or XML as the API requires)"),
        region: z.string().optional(),
        target: z.string().optional().describe("X-Amz-Target prefix override (JSON protocol)"),
        version: z.string().optional().describe("API version override (query protocol)"),
        reason: z.string().describe("One line shown to the user with the approval request: what this does and why"),
      },
      async run(auth, input): Promise<ActionResult> {
        try {
          const service = String(input.service).toLowerCase().trim();
          const actionOrPath = String(input.action ?? input.path ?? "");
          if (!actionOrPath) return { ok: false, output: null, error: "need action or path" };
          if (input.action && READ_ACTION.test(String(input.action))) {
            return { ok: false, output: null, error: `'${input.action}' is a read — use aws_read` };
          }
          const denied = writePolicy(service, actionOrPath, input.path ? String(input.method ?? "POST") : undefined);
          if (denied) return { ok: false, output: null, error: denied };
          const { body } = await awsCall(auth, {
            ...(input as unknown as AwsCallArgs),
            method: input.path ? String(input.method ?? "POST") : undefined,
          });
          return { ok: true, output: body };
        } catch (e: any) {
          return { ok: false, output: null, error: e.message };
        }
      },
    },
  ],
};
