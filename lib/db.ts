import { Pool } from "pg";
import { getInstance } from "./instances";
import type { Environment, Service, Target } from "./types";

type PoolKey = string;

const pools = new Map<PoolKey, Pool>();

type EnvCreds = {
  user: string | undefined;
  host: string | undefined;
  database: string | undefined;
  password: string | undefined;
};

function creds(prefix: string): EnvCreds {
  return {
    user: process.env[`${prefix}_DB_USER`],
    host: process.env[`${prefix}_DB_HOST`],
    database: process.env[`${prefix}_DB_NAME`],
    password: process.env[`${prefix}_DB_PASSWORD`],
  };
}

/**
 * Resolves the env-var prefix for the requested target.
 *  - Shared:  `{SERVICE}_{ENV}`              e.g. CORP_PROD, OMS_STAGE
 *  - Private: `PRIVATE_INSTANCE_{ID}_{ENV}`  e.g. PRIVATE_INSTANCE_LUPIN_PROD
 *
 * The Corp service has no private instances today; the API layer rejects
 * non-null `instance` for Corp before reaching this function. If a future
 * instance is registered for Corp, this code already supports it.
 */
function prefixFor(target: Target): string {
  const env = target.environment.toUpperCase();
  if (target.instance) {
    return `PRIVATE_INSTANCE_${target.instance.toUpperCase()}_${env}`;
  }
  return `${target.service.toUpperCase()}_${env}`;
}

function poolKey(target: Target): PoolKey {
  return `${target.environment}:${target.service}:${target.instance ?? "_shared"}`;
}

export function getPool(target: Target): Pool {
  // If an instance is set, sanity-check it exists and matches the service.
  if (target.instance) {
    const meta = getInstance(target.instance);
    if (!meta) {
      throw new Error(`Unknown private instance "${target.instance}".`);
    }
    if (meta.service !== target.service) {
      throw new Error(
        `Instance "${target.instance}" is registered for service "${meta.service}", not "${target.service}".`,
      );
    }
  }

  const key = poolKey(target);
  const existing = pools.get(key);
  if (existing) return existing;

  const prefix = prefixFor(target);
  const c = creds(prefix);
  const missing = Object.entries(c)
    .filter(([, v]) => !v)
    .map(([k]) => `${prefix}_DB_${k.toUpperCase()}`);
  if (missing.length) {
    throw new Error(
      `Missing database env vars for ${prefix}: ${missing.join(", ")}`,
    );
  }

  const pool = new Pool({
    user: c.user,
    host: c.host,
    database: c.database,
    password: c.password,
    port: 5432,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on("error", (err) => {
    console.error(`[db pool ${key}] idle client error`, err.message);
  });

  pools.set(key, pool);
  return pool;
}

export function describeTarget(target: Target): string {
  const env = target.environment.toUpperCase();
  const svc = target.service.toUpperCase();
  if (target.instance) {
    const meta = getInstance(target.instance);
    const label = meta?.label ?? target.instance;
    return `${env} • ${svc} • ${label}`;
  }
  return `${env} • ${svc}`;
}

/**
 * Pool for the V1 auth-backend database (the Corp DB shared with
 * backend_corp_svc, where the user-login tables live). Used by the "24h OTP
 * Block" tab to clear `otp_retry_count` + `lockup_date` on the per-user-type
 * tables. Keyed per-environment; creds come from `AUTH_{ENV}_DB_*`. This is a
 * deliberately separate target from the `corp` service pool so auth-DB access
 * stays decoupled from the V2 event-store queries.
 */
export function getAuthPool(environment: Environment): Pool {
  const key = `auth:${environment}`;
  const existing = pools.get(key);
  if (existing) return existing;

  const prefix = `AUTH_${environment.toUpperCase()}`;
  const c = creds(prefix);
  const missing = Object.entries(c)
    .filter(([, v]) => !v)
    .map(([k]) => `${prefix}_DB_${k.toUpperCase()}`);
  if (missing.length) {
    throw new Error(
      `Missing database env vars for ${prefix}: ${missing.join(", ")}`,
    );
  }

  const pool = new Pool({
    user: c.user,
    host: c.host,
    database: c.database,
    password: c.password,
    port: 5432,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on("error", (err) => {
    console.error(`[db pool ${key}] idle client error`, err.message);
  });

  pools.set(key, pool);
  return pool;
}

/**
 * The Postgres schema (search_path) the auth-backend tables live in for this
 * env. auth-backend sets it via `POSTGRES_SCHEMA`, which may not be `public`,
 * so the OTP-block queries schema-qualify their table. Defaults to `public`.
 * Validated to a bare SQL identifier because it is interpolated into the query
 * text (the table names themselves are fixed internal constants).
 */
export function authSchema(environment: Environment): string {
  const raw = process.env[`AUTH_${environment.toUpperCase()}_DB_SCHEMA`];
  const schema = (raw ?? "").trim() || "public";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(
      `Invalid AUTH_${environment.toUpperCase()}_DB_SCHEMA "${schema}" — must be a bare SQL identifier.`,
    );
  }
  return schema;
}

// Re-export for legacy imports
export type { Environment, Service, Target };
