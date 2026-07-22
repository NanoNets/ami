import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { AmiConnector } from "./types.js";
import { allConnectors, getConnector, registerConnector, unregisterConnector } from "./registry.js";

/** User-built connectors live as plain ESM modules under
 * ~/.ami/connectors/<id>/connector.mjs. Each module default-exports a factory
 * `({ z }) => AmiConnector` — dependencies are injected so the module resolves
 * without a node_modules of its own. They register into the same registry as
 * the built-ins, so polling, triage, the MCP tool surface, drafts and the
 * console all pick them up with no special cases. */

export function customConnectorsDir(): string {
  // Mirrors amiHome() in @ami/db (connectors can't depend on db — it would
  // invert the package graph).
  const dir = path.join(process.env.AMI_HOME ?? path.join(os.homedir(), ".ami"), "connectors");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function customConnectorFile(id: string): string {
  return path.join(customConnectorsDir(), id, "connector.mjs");
}

const customIds = new Set<string>();

export function isCustomConnector(id: string): boolean {
  return customIds.has(id);
}

/** Structural validation of a loaded connector module. Returns every problem
 * found (not just the first) so the builder agent can fix them in one pass. */
export function validateConnectorShape(c: any, expectedId?: string): string[] {
  const errors: string[] = [];
  if (!c || typeof c !== "object") return ["factory did not return an object"];
  if (typeof c.id !== "string" || !/^[a-z][a-z0-9_]{1,30}$/.test(c.id))
    errors.push("id must be a short lowercase string (a-z, 0-9, _)");
  if (expectedId && c.id !== expectedId) errors.push(`id must be exactly "${expectedId}", got "${c.id}"`);
  if (!c.meta || typeof c.meta !== "object") {
    errors.push("meta object is missing");
  } else {
    if (typeof c.meta.label !== "string" || !c.meta.label) errors.push("meta.label must be a non-empty string");
    if (c.meta.authKind !== "token" && c.meta.authKind !== "none")
      errors.push('meta.authKind must be "token" or "none" (custom connectors cannot do oauth)');
    if (!Array.isArray(c.meta.authFields)) errors.push("meta.authFields must be an array");
    else
      for (const f of c.meta.authFields) {
        if (typeof f?.key !== "string" || typeof f?.label !== "string")
          errors.push("every authFields entry needs string key and label");
      }
    if (typeof c.meta.setupHelp !== "string" || c.meta.setupHelp.length < 20)
      errors.push("meta.setupHelp must explain, in a couple of sentences, where the user gets their token");
  }
  if (typeof c.validateAuth !== "function") errors.push("validateAuth(auth) function is missing");
  if (typeof c.streams !== "function") errors.push("streams() function is missing");
  else {
    try {
      const streams = c.streams();
      if (!Array.isArray(streams)) errors.push("streams() must return an array");
      else
        for (const s of streams) {
          if (typeof s?.name !== "string" || typeof s?.intervalSec !== "number")
            errors.push("every stream needs a string name and numeric intervalSec");
          else if (s.intervalSec < 60) errors.push(`stream "${s.name}": intervalSec must be >= 60`);
        }
    } catch (e: any) {
      errors.push(`streams() threw: ${e?.message ?? e}`);
    }
  }
  if (typeof c.poll !== "function") errors.push("poll(ctx) function is missing");
  if (!Array.isArray(c.actions)) errors.push("actions must be an array");
  else {
    if (c.actions.length === 0) errors.push("at least one action is required");
    const seen = new Set<string>();
    for (const a of c.actions) {
      const label = typeof a?.name === "string" ? a.name : "<unnamed>";
      if (typeof a?.name !== "string" || !/^[a-z][a-z0-9_]{2,60}$/.test(a.name))
        errors.push(`action "${label}": name must be lowercase snake_case`);
      else if (c.id && !a.name.startsWith(`${c.id}_`))
        errors.push(`action "${a.name}": name must be prefixed with the connector id ("${c.id}_")`);
      if (seen.has(a?.name)) errors.push(`action "${label}": duplicate name`);
      seen.add(a?.name);
      if (typeof a?.description !== "string" || a.description.length < 20)
        errors.push(`action "${label}": description must tell the agent when to use it`);
      if (typeof a?.run !== "function") errors.push(`action "${label}": run(auth, input) function is missing`);
      if (!a?.schema || typeof a.schema !== "object") {
        errors.push(`action "${label}": schema must be an object of zod fields (may be empty)`);
      } else {
        try {
          z.object(a.schema);
        } catch (e: any) {
          errors.push(`action "${label}": schema is not a valid zod raw shape: ${e?.message ?? e}`);
        }
      }
      if (!a?.readOnly && !a?.isSend && !a?.needsApproval)
        errors.push(
          `action "${label}": must be marked readOnly (pure read), isSend (delivers a message to a human), or needsApproval (any other side effect)`,
        );
    }
  }
  return errors;
}

/** Import a connector module fresh (cache-busted) and instantiate it. */
export async function instantiateCustomConnector(
  file: string,
  expectedId?: string,
): Promise<{ connector?: AmiConnector; errors: string[] }> {
  if (!fs.existsSync(file)) return { errors: [`file not found: ${file}`] };
  let mod: any;
  try {
    mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  } catch (e: any) {
    return { errors: [`module failed to import: ${e?.message ?? e}`] };
  }
  if (typeof mod?.default !== "function")
    return { errors: ["module must `export default function createConnector({ z }) { … }`"] };
  let connector: any;
  try {
    connector = mod.default({ z });
  } catch (e: any) {
    return { errors: [`factory threw: ${e?.message ?? e}`] };
  }
  const errors = validateConnectorShape(connector, expectedId);
  return errors.length ? { errors } : { connector: connector as AmiConnector, errors: [] };
}

/** Load every custom connector from disk into the registry. Called at server
 * startup; a broken module is skipped and reported, never fatal. */
export async function loadCustomConnectors(): Promise<{ loaded: string[]; errors: Record<string, string> }> {
  const dir = customConnectorsDir();
  const loaded: string[] = [];
  const errors: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir)) {
    const file = customConnectorFile(entry);
    if (!fs.existsSync(file)) continue;
    const res = await instantiateCustomConnector(file, entry);
    if (res.connector) {
      registerConnector(res.connector);
      customIds.add(entry);
      loaded.push(entry);
    } else {
      errors[entry] = res.errors.join("; ");
    }
  }
  return { loaded, errors };
}

/** Register a freshly built connector (post-validation). */
export function activateCustomConnector(c: AmiConnector): void {
  registerConnector(c);
  customIds.add(c.id);
}

export function removeCustomConnector(id: string): void {
  if (!isCustomConnector(id)) return;
  unregisterConnector(id);
  customIds.delete(id);
  fs.rmSync(path.join(customConnectorsDir(), id), { recursive: true, force: true });
}

/** An id is free when no built-in or custom connector claims it. */
export function connectorIdAvailable(id: string): boolean {
  return !getConnector(id) && !allConnectors().some((c) => c.id === id);
}
