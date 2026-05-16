import type { Service } from "./types";

/**
 * A private DB instance for a service. A "private instance" is a separately
 * deployed copy of a service for a specific company / partner, with its own
 * database and SQS queues. Lupin is the first example; more can be added.
 *
 * Registration is purely env-var driven — see `.env.example`:
 *
 *   PRIVATE_INSTANCES=lupin,alpha
 *   PRIVATE_INSTANCE_LUPIN_LABEL=Lupin
 *   PRIVATE_INSTANCE_LUPIN_SERVICE=oms
 *   PRIVATE_INSTANCE_LUPIN_PLAYGROUND_FLAG=isLupin
 *   PRIVATE_INSTANCE_LUPIN_PROD_DB_HOST=…
 *   PRIVATE_INSTANCE_LUPIN_PROD_DB_USER=…
 *   PRIVATE_INSTANCE_LUPIN_PROD_DB_NAME=…
 *   PRIVATE_INSTANCE_LUPIN_PROD_DB_PASSWORD=…
 *   PRIVATE_INSTANCE_LUPIN_STAGE_DB_HOST=…
 *   …
 */
export type InstanceMeta = {
  id: string;
  label: string;
  service: Service;
  /** The JSON key the Playground SQS API expects to route to this instance. */
  playgroundFlag: string;
};

function envPrefix(id: string): string {
  return `PRIVATE_INSTANCE_${id.toUpperCase()}`;
}

function defaultPlaygroundFlag(id: string): string {
  return `is${id.charAt(0).toUpperCase()}${id.slice(1).toLowerCase()}`;
}

function parseIds(): string[] {
  const raw = process.env.PRIVATE_INSTANCES ?? "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[\s,]+/)) {
    const id = token.trim().toLowerCase();
    if (!id) continue;
    if (!/^[a-z][a-z0-9_]*$/.test(id)) {
      console.warn(
        `[instances] ignoring invalid id "${token}" (must match /^[a-z][a-z0-9_]*$/)`,
      );
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function readOne(id: string): InstanceMeta | null {
  const prefix = envPrefix(id);
  const label = process.env[`${prefix}_LABEL`]?.trim();
  const serviceRaw = process.env[`${prefix}_SERVICE`]?.trim().toLowerCase();
  if (!label) {
    console.warn(
      `[instances] "${id}" is registered but ${prefix}_LABEL is missing; skipping.`,
    );
    return null;
  }
  if (serviceRaw !== "corp" && serviceRaw !== "oms") {
    console.warn(
      `[instances] "${id}" has invalid ${prefix}_SERVICE="${serviceRaw ?? ""}" (must be "corp" or "oms"); skipping.`,
    );
    return null;
  }
  const playgroundFlag =
    process.env[`${prefix}_PLAYGROUND_FLAG`]?.trim() || defaultPlaygroundFlag(id);
  return { id, label, service: serviceRaw, playgroundFlag };
}

let cache: InstanceMeta[] | null = null;

export function listPrivateInstances(): InstanceMeta[] {
  if (cache) return cache;
  const list: InstanceMeta[] = [];
  for (const id of parseIds()) {
    const meta = readOne(id);
    if (meta) list.push(meta);
  }
  cache = list;
  return list;
}

export function getInstance(id: string): InstanceMeta | null {
  return listPrivateInstances().find((i) => i.id === id) ?? null;
}

export function getInstancesForService(service: Service): InstanceMeta[] {
  return listPrivateInstances().filter((i) => i.service === service);
}

/** For tests / hot reload. */
export function _resetInstanceCache(): void {
  cache = null;
}
