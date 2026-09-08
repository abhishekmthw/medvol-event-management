import { getInstance } from "./instances";
import type { Target } from "./types";

/**
 * Consumer API client — replays a stored `public.events` row as the exact HTTP
 * call the V2 SQS consumer would have made.
 *
 * This module is a deliberate, line-by-line mirror of the two production
 * consumers. Any drift there must be reflected here:
 *   - `lambda-corp-consumer/lambda/index.mjs`  (Corp:  /api/v1/{domain}/{action})
 *   - `lambda-oms-consumer/lambda/index.mjs`   (OMS:   /api/v1/oms/{domain}/{action})
 *
 * What the consumers use from the message, and where it lives in `events`:
 *   action, domain, method, destination, data, userDetails  → same-named columns
 *   eventId, event_type                                     → "eventId", event_type
 *   streamId                                                → "eventStreamStreamId"
 * The `signature` field is verified against the *SQS message* and is never
 * forwarded downstream, so a direct HTTP replay does not need it.
 *
 * `company_code` — the OMS API Gateway is SHARED by the common instance and
 * every private one; the Company Mapper Service routes to the correct instance
 * from this header. The OMS consumer reads it from the SQS message attributes
 * (which no producer sets today — `event-store-sdk/SNS/index.ts` publishes only
 * `Target`), so here it comes from the selected target instead: absent for the
 * shared instance, and the instance's configured company code for a private
 * one. Same mechanism as `md-batch-lambda/lambda/event-api-creation`, which
 * sets `headers["company_code"] = company_code` against one shared OMS base URL.
 *
 * `machine-token` — sent by the OMS consumer from its own env, but the
 * per-instance API Gateway authorizer (`md-authorizer-lambda`) injects it into
 * the request context itself. Optional here: sent only when configured.
 */

const DEFAULT_TIMEOUT_MS = Number(
  process.env.CONSUMER_API_FETCH_TIMEOUT_MS ?? 30_000,
);

/** Consumer name every V2 row is scoped to (mirrors the lambdas' constants). */
const CONSUMER_NAME = "V2";

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function requireEnv(name: string): string {
  const v = readEnv(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/**
 * Fallback identity used for `x-my-key` when the event carries no
 * `userDetails` (machine-to-machine events). Copied VERBATIM from both
 * consumers — `lambda-corp-consumer/lambda/index.mjs` and
 * `lambda-oms-consumer/lambda/index.mjs` define the identical object. Backend
 * controllers `JSON.parse(req.headers['x-my-key'])` without guarding, so the
 * header must always be present and must carry this exact shape.
 */
export const ADMIN_USER: Record<string, unknown> = {
  sub: "aa67b78e-6afb-46d9-836e-75622566662f",
  "custom:ucode": "F1634CDA-7449-41AF-9752-A685016273BA",
  iss: "https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_I00XBCqsQ",
  "custom:division": " ",
  phone_number_verified: true,
  "cognito:username": "aa67b78e-6afb-46d9-836e-75622566662f",
  "custom:mv_role": "Management",
  "custom:state": " ",
  "custom:company": " ",
  origin_jti: "d6214b0f-a641-4a24-bde2-527dec2af7d3",
  aud: "4gufh47bmgv9me6vh44sah6bga",
  event_id: "d480f204-30c0-48e1-82d3-e9b95560e169",
  token_use: "id",
  auth_time: 1712325682,
  name: "AuthMachine",
  phone_number: "+912111111111",
  exp: 1712412082,
  "custom:role": "admin",
  iat: 1712325682,
  jti: "1930789c-dd5b-47a0-b82e-ae8ff860ee14",
};

/**
 * The only `destination` either consumer can resolve to a base URL. Anything
 * else makes the real consumer return 400 without calling out, so such events
 * are reported ineligible rather than guessed at.
 */
export const SUPPORTED_DESTINATION = "postgres";

export type ConsumerApiConfig = {
  /** Origin of the API Gateway the consumer forwards to (no trailing slash). */
  baseUrl: string;
  /** The consumer's `API_KEY_V2_CONSUMER` for this target. */
  apiKey: string;
  /** Optional `machine-token` (OMS `OMS_SERVICE_API_TOKEN`). */
  machineToken?: string;
  /**
   * `company_code` header value — set only for a private instance, which is
   * how the shared gateway routes to it. Null for the shared instance.
   */
  companyCode: string | null;
};

/**
 * Resolves the consumer API endpoint for a target.
 *
 * The base URL and API key are keyed on `{SERVICE}_{ENV}` ONLY — deliberately
 * NOT per instance. Unlike the DB and SQS layers (where each private instance
 * has its own database and its own AWS account), every OMS instance is reached
 * through the SAME API Gateway; the Company Mapper Service selects the instance
 * from the `company_code` header. So a private instance reuses the shared
 * service credentials and is distinguished only by that header. Adding a future
 * private instance therefore needs no new URL/key vars — just its
 * `PRIVATE_INSTANCE_{ID}_COMPANY_CODE`.
 *
 * These vars are per-environment: each env has its own gateway and API key.
 */
export function resolveConsumerApi(target: Target): ConsumerApiConfig {
  const prefix = `${target.service.toUpperCase()}_${target.environment.toUpperCase()}`;

  let companyCode: string | null = null;
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
    // Hard failure, never a silent fallback: without the header the shared
    // gateway routes to the COMMON instance, so the event would be applied to
    // the wrong company's database.
    if (!meta.companyCode) {
      throw new Error(
        `Instance "${target.instance}" has no company code configured. Set PRIVATE_INSTANCE_${target.instance.toUpperCase()}_COMPANY_CODE — without it the request would be routed to the shared instance and applied to the wrong database.`,
      );
    }
    companyCode = meta.companyCode;
  }

  return {
    baseUrl: requireEnv(`${prefix}_CONSUMER_API_URL`).replace(/\/+$/, ""),
    apiKey: requireEnv(`${prefix}_CONSUMER_API_KEY`),
    machineToken: readEnv(`${prefix}_CONSUMER_MACHINE_TOKEN`),
    companyCode,
  };
}

/** The event-row fields a consumer request is built from. */
/**
 * Human-readable description of where a replay will actually land. The base
 * URL alone is ambiguous for OMS — the shared gateway serves the common
 * instance and every private one — so the `company_code` that does the routing
 * is spelled out for the operator to check before confirming.
 */
export function describeConsumerRoute(
  target: Target,
  cfg: ConsumerApiConfig,
): string {
  if (!cfg.companyCode) return cfg.baseUrl;
  const label = target.instance
    ? (getInstance(target.instance)?.label ?? target.instance)
    : "private instance";
  return `${cfg.baseUrl} (routed to ${label} via company_code=${cfg.companyCode})`;
}

export type ConsumerEventInput = {
  eventId: string;
  streamId: string | null;
  eventType: string | null;
  domain: string;
  action: string;
  method: string;
  /** Raw JSON text of `events.data` — forwarded as the body verbatim. */
  data: string | null;
  /** Parsed `events."userDetails"`, or null when absent/empty. */
  userDetails: Record<string, unknown> | null;
};

export type ConsumerRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

/**
 * Builds the HTTP request for one event. PURE — the preview and the live run
 * both call this, so what the operator confirms is byte-for-byte what is sent.
 *
 * The OMS URL carries an extra `/oms/` segment (oms-consumer:75) that Corp does
 * not (corp-consumer:71); it is keyed on the service so private OMS instances
 * pick it up automatically. `action` is passed through untouched because it can
 * legitimately contain slashes (the SDK builds it as
 * `url.split('/').slice(2).join('/')`, e.g. `cognito_id/add`).
 */
export function buildConsumerRequest(
  target: Target,
  ev: ConsumerEventInput,
  cfg: ConsumerApiConfig,
): ConsumerRequest {
  const segment = target.service === "oms" ? "/api/v1/oms" : "/api/v1";
  const url = `${cfg.baseUrl}${segment}/${ev.domain}/${ev.action}`;

  const hasUserDetails = Boolean(
    ev.userDetails && Object.keys(ev.userDetails).length > 0,
  );

  // Mirrors the consumers exactly: `userDetails` is NESTED under its own key
  // and the key is OMITTED (not null) when empty. `lambda-corp-authorizor`
  // reads `tokenData.userDetails` and silently substitutes its own adminUser
  // when it is absent, so a flat spread here would re-attribute every write.
  const authorization = JSON.stringify({
    apiKey: cfg.apiKey,
    ...(hasUserDetails ? { userDetails: ev.userDetails } : {}),
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    authorization,
    eventid: ev.eventId,
    eventtype: ev.eventType ?? "",
    streamid: ev.streamId ?? "",
    consumername: CONSUMER_NAME,
    // Routes the request to the right OMS instance through the shared gateway.
    // Absent for the shared instance, exactly as the consumer omits it when the
    // SQS message carries no company_code attribute.
    ...(cfg.companyCode ? { company_code: cfg.companyCode } : {}),
    ...(cfg.machineToken ? { "machine-token": cfg.machineToken } : {}),
    "x-my-key":
      ev.userDetails && ev.userDetails.sub
        ? JSON.stringify(ev.userDetails)
        : JSON.stringify(ADMIN_USER),
  };

  return {
    url,
    method: (ev.method || "").trim().toUpperCase(),
    headers,
    // `events.data` is selected as ::text, so it is already the JSON document
    // the producer stored — forwarded verbatim, no re-serialization.
    body: ev.data ?? "",
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * A reproducible curl for the request, with credentials REDACTED. Unlike
 * `buildCurl` in `lib/playground.ts` (whose header values are safe to print),
 * `authorization` carries the consumer API key and `x-my-key` a full decoded
 * token, so neither may reach a browser or a log line.
 */
export function redactedCurl(req: ConsumerRequest): string {
  const lines: string[] = [`curl -X ${req.method} ${shellQuote(req.url)}`];
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    const redacted =
      lower === "authorization" || lower === "x-my-key" || lower === "machine-token";
    lines.push(`  -H ${shellQuote(`${k}: ${redacted ? "<redacted>" : v}`)}`);
  }
  if (req.body) lines.push(`  --data-raw ${shellQuote(req.body)}`);
  return lines.join(" \\\n");
}

export type ConsumerApiOutcome = {
  ok: boolean;
  /** HTTP status, or null when the request never completed (timeout/network). */
  status: number | null;
  /** Response body text, or the error message when the request failed. */
  raw: string;
  /** Reproducible curl with credentials redacted. */
  curl: string;
};

/**
 * Fires one consumer request. Never throws — a timeout or network failure is
 * returned as `{ ok: false, status: null }` so one bad event cannot abort a
 * multi-event run.
 *
 * The default timeout (30s) sits just past API Gateway's own 29s integration
 * limit, so a gateway timeout surfaces as a real 504 rather than as an abort.
 */
export async function callConsumerApi(
  req: ConsumerRequest,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ConsumerApiOutcome> {
  const curl = redactedCurl(req);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      // A GET/HEAD request must not carry a body.
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      signal: ctrl.signal,
    });
    const raw = await res.text();
    return { ok: res.ok, status: res.status, raw, curl };
  } catch (e) {
    if (e instanceof Error && (e.name === "AbortError" || ctrl.signal.aborted)) {
      return {
        ok: false,
        status: null,
        raw: `Request timed out after ${timeoutMs}ms — the backend did not respond. The event may still have been applied; verify before retrying.`,
        curl,
      };
    }
    return {
      ok: false,
      status: null,
      raw: e instanceof Error ? e.message : String(e),
      curl,
    };
  } finally {
    clearTimeout(t);
  }
}
