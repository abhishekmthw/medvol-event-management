import { initiateCustomAuth } from "./cognito";
import { authSchema, getAuthPool } from "./db";
import { parseList } from "./events";
import {
  ALL_COMPANY_ROLE_IDS,
  SPECIFIC_COMPANY_ROLE_IDS,
  type AdminEventCompany,
  type AdminEventPreview,
  type AdminEventRow,
  type AdminEventRunResult,
  type AdminEventUser,
  type AdminRoleGroup,
  type AdminTokenResult,
  type Environment,
} from "./types";

/**
 * Admin Events — bulk `ADMIN_EDIT` push for admin users.
 *
 * Replaces the two-pass ops script that re-ran `adminUserEditBulk` with the
 * role list and the `companies` field commented in and out by hand. It reads
 * eligible `Admin_Users` from the auth DB (`getAuthPool` / `authSchema`, same
 * access path as the 24h OTP Block tab), then PUTs one
 * `{ data, primary_key }` body per user at the auth-backend API Gateway, which
 * produces one `ADMIN_EDIT` V2 event per user on stream `admin_<id>`.
 *
 * Three deliberate differences from the script:
 *   1. ONE query covers both role groups — the body shape is decided per row
 *      from that row's own `user_role_id`, so a mixed selection is fine;
 *   2. the companies list is resolved ONCE per request, not inside the loop;
 *   3. the Bearer token is minted server-side and cached against its real
 *      expiry (see `getBulkToken`).
 *
 * The outbound call mirrors `lib/consumer-api.ts`'s `callConsumerApi`:
 * `AbortController` timeout, never throws, returns status + raw body.
 */

const ROLE_GROUP_BY_ID: ReadonlyMap<string, AdminRoleGroup> = new Map([
  ...ALL_COMPANY_ROLE_IDS.map(
    (id) => [id, "all-companies"] as [string, AdminRoleGroup],
  ),
  ...SPECIFIC_COMPANY_ROLE_IDS.map(
    (id) => [id, "specific-companies"] as [string, AdminRoleGroup],
  ),
]);

const ALL_ROLE_IDS: readonly string[] = [
  ...ALL_COMPANY_ROLE_IDS,
  ...SPECIFIC_COMPANY_ROLE_IDS,
];

/** Matches `EXECUTE_CONCURRENCY` in `lib/events.ts` — the other bulk HTTP action. */
const PUSH_CONCURRENCY = 4;

/**
 * Hard cap on ids accepted in one apply request, to bound its wall time. The
 * UI sends `ADMIN_EVENT_CHUNK` (25) at a time; this only guards the route
 * against a hand-crafted request.
 */
export const MAX_IDS_PER_CHUNK = 100;

const DEFAULT_TIMEOUT_MS = Number(
  process.env.ADMIN_EVENT_FETCH_TIMEOUT_MS ?? 30_000,
);

/** Re-mint the cached token when it has less than this long to live. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * The account the bulk push authenticates as. Hardcoded for BOTH stage and
 * prod, per the ops procedure this replaces — every `ADMIN_EDIT` event is
 * therefore attributed to this user's identity in `created_by` / `modified_by`,
 * exactly as the script's hand-pasted token was.
 */
export const BULK_AUTH_MOBILE = "9008695776";

/** Longest response body kept on a result row. */
const RESPONSE_PREVIEW_LIMIT = 500;

function truncateResponse(raw: string): string {
  return raw.length > RESPONSE_PREVIEW_LIMIT
    ? `${raw.slice(0, RESPONSE_PREVIEW_LIMIT)}… (truncated)`
    : raw;
}

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function requireEnv(name: string): string {
  const v = readEnv(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/** Last 10 digits, matching `normalizeMobile` in `lib/auth-comparison.ts`. */
export function normalizeMobile10(v: string): string | null {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * The `PUT` endpoint for the admin edit event.
 *
 * `AUTH_{ENV}_EVENT_API_URL` holds the API-Gateway ORIGIN including its stage
 * segment (e.g. `https://xxxx.execute-api.ap-south-1.amazonaws.com/api`) and
 * the path is derived here — the same origin-only convention as
 * `*_CONSUMER_API_URL` in `lib/consumer-api.ts`, so the route can never be
 * pointed somewhere unintended by an env edit.
 */
export function resolveAdminEventUrl(environment: Environment): string {
  const base = requireEnv(
    `AUTH_${environment.toUpperCase()}_EVENT_API_URL`,
  ).replace(/\/+$/, "");
  return `${base}/event/admin/edit`;
}

/* ------------------------------------------------------------------ *
 * Token
 * ------------------------------------------------------------------ */

type CachedToken = { token: string; expiresAtMs: number };

const tokenCache = new Map<Environment, CachedToken>();

/**
 * In-flight mints, so concurrent callers share one `InitiateAuth` instead of
 * each starting their own. Without this, the four parallel pushes in a batch
 * all 401 at the same instant when a token ages out and all four force-mint —
 * four needless calls, and four OTP records cleared.
 */
const tokenInFlight = new Map<Environment, Promise<string>>();

async function mintToken(environment: Environment): Promise<string> {
  const existing = tokenInFlight.get(environment);
  if (existing) return existing;

  const p = (async () => {
    const tokens = await initiateCustomAuth(environment, BULK_AUTH_MOBILE);
    tokenCache.set(environment, {
      token: tokens.accessToken,
      expiresAtMs: tokens.expiresAtMs ?? 0,
    });
    return tokens.accessToken;
  })().finally(() => {
    tokenInFlight.delete(environment);
  });

  tokenInFlight.set(environment, p);
  return p;
}

/**
 * The Bearer access token the bulk push authenticates with, cached per env.
 *
 * Caching is not an optimisation, it is the design: the prod app client issues
 * access tokens valid for FIVE MINUTES, so one mint cannot cover a ~500-user
 * run, while minting per chunk would call `define-auth-challenge` repeatedly —
 * and that trigger clears the account's pending OTP for every number outside
 * its `PERMANENT_ADMIN_BYPASS_NUMBERS` list, which `BULK_AUTH_MOBILE` is not
 * in. Re-minting only inside the expiry margin keeps that to roughly one call
 * per four minutes of run time.
 *
 * When the token cannot be decoded we treat it as expiring immediately rather
 * than guessing a TTL — a redundant mint is cheap, a 401 mid-run is not.
 */
export async function getBulkToken(
  environment: Environment,
  options: { force?: boolean } = {},
): Promise<string> {
  const cached = tokenCache.get(environment);
  if (
    !options.force &&
    cached &&
    cached.expiresAtMs - Date.now() > TOKEN_REFRESH_MARGIN_MS
  ) {
    return cached.token;
  }
  return mintToken(environment);
}

/** The standalone "Generate token" card — one mobile in, all three tokens out. */
export async function generateToken(
  environment: Environment,
  mobile: string,
): Promise<AdminTokenResult> {
  const mobile10 = normalizeMobile10(mobile);
  if (!mobile10 || mobile10.length !== 10) {
    throw new Error(
      `"${mobile}" is not a 10-digit mobile number (a +91 prefix is accepted and stripped).`,
    );
  }

  const tokens = await initiateCustomAuth(environment, mobile10);
  return {
    ok: true,
    bearer: `Bearer ${tokens.accessToken}`,
    accessToken: tokens.accessToken,
    idToken: tokens.idToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAtMs
      ? new Date(tokens.expiresAtMs).toISOString()
      : null,
    mobile: mobile10,
  };
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

type AdminUserRow = Omit<AdminEventUser, "group">;

/**
 * Eligible admin users, in id order.
 *
 * The eligibility predicate is the script's, verbatim:
 * `active_status = 'Y' AND user_role_id IN (…) AND mobile_no != '' AND email != ''`.
 * (`<> ''` already excludes NULLs in SQL, so no IS NOT NULL is needed — and
 * adding one would change nothing.) Both role groups are fetched together and
 * tagged per row, so one query serves both scenarios.
 *
 * `ids` narrows to a previously previewed set during the apply phase; the full
 * predicate is re-applied so a row that stopped qualifying since the preview is
 * dropped rather than pushed with stale values.
 */
async function fetchAdminUsers(
  environment: Environment,
  mobiles: string[] | null,
  ids: string[] | null,
): Promise<AdminEventUser[]> {
  const pool = getAuthPool(environment);
  const schema = authSchema(environment);

  // Schema is a validated bare identifier and the table is a fixed constant;
  // every value is parameterized.
  const sql = `
    SELECT
      id::text            AS id,
      name,
      email,
      mobile_no,
      code,
      ucode,
      user_role_id::text  AS user_role_id,
      active_status
    FROM "${schema}"."Admin_Users"
    WHERE active_status = 'Y'
      AND user_role_id = ANY($1::bigint[])
      AND mobile_no <> ''
      AND email <> ''
      AND ($2::text[] IS NULL OR mobile_no = ANY($2::text[]))
      AND ($3::bigint[] IS NULL OR id = ANY($3::bigint[]))
    ORDER BY id`;

  const { rows } = await pool.query(sql, [ALL_ROLE_IDS, mobiles, ids]);

  return (rows as AdminUserRow[]).map((r) => ({
    ...r,
    // Every row matched the role filter, so the lookup always resolves; the
    // fallback only satisfies the type.
    group: ROLE_GROUP_BY_ID.get(r.user_role_id) ?? "all-companies",
  }));
}

/**
 * Active companies that have at least one active division — the script's
 * companies query, run once per request instead of once per user.
 *
 * `Companies.id` is a `bigint`, so `pg` hands it back as a string, which is
 * the same value the script's `.toString()` produced. Do not coerce to a
 * number: `getAdminAccess` is fed these verbatim.
 */
async function fetchActiveCompanies(
  environment: Environment,
): Promise<AdminEventCompany[]> {
  const pool = getAuthPool(environment);
  const schema = authSchema(environment);

  const sql = `
    SELECT c.id::text AS id, c.name
    FROM "${schema}"."Companies" c
    WHERE c.id IN (
            SELECT d.company_code
            FROM "${schema}"."Divisions" d
            WHERE d.active_status = 'Y'
          )
      AND c.active_status = 'Y'
    ORDER BY c.id`;

  const { rows } = await pool.query(sql);
  return rows as AdminEventCompany[];
}

/* ------------------------------------------------------------------ *
 * Push
 * ------------------------------------------------------------------ */

/**
 * The request body, byte-for-byte the script's shape.
 *
 * `uid` maps from the row's `ucode` and is load-bearing — `EventProducer.ts`
 * uses it to let a user's own mobile/email pass the uniqueness checks, so
 * omitting it makes every edit collide with the record it is editing.
 *
 * `companies` is included ONLY for the specific-companies group: for every
 * other role `getAdminAccess` resolves all companies itself and ignores the
 * field entirely.
 */
export function buildAdminEditBody(
  user: AdminEventUser,
  companyIds: string[],
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    id: user.id,
    name: user.name,
    email: user.email,
    mobile_no: user.mobile_no,
    code: user.code,
    uid: user.ucode,
    user_role_id: user.user_role_id,
    active_status: user.active_status,
  };
  if (user.group === "specific-companies") {
    data.companies = companyIds;
  }
  return { data, primary_key: user.id };
}

type PushOutcome = { ok: boolean; status: number | null; raw: string };

/**
 * One `PUT /event/admin/edit`. Mirrors `callConsumerApi` — `AbortController`
 * timeout, never throws, hands the caller status + raw body so a per-user
 * failure is reported rather than aborting the chunk.
 */
async function putAdminEdit(
  url: string,
  token: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<PushOutcome> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        accept: "application/json, text/plain, */*",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        // WAF's managed NoUserAgent rule 403s a request with no UA before the
        // authorizer ever runs — the same trap documented in lib/consumer-api.ts.
        "User-Agent": "medvol-event-management/1.0",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    return { ok: res.ok, status: res.status, raw };
  } catch (e) {
    if (e instanceof Error && (e.name === "AbortError" || ctrl.signal.aborted)) {
      return {
        ok: false,
        status: null,
        raw: `Request timed out after ${timeoutMs}ms — the event may still have been created; check the admin_<id> stream before retrying.`,
      };
    }
    return {
      ok: false,
      status: null,
      raw: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

/**
 * Read-only pass. Resolves exactly what the run would send — users, their role
 * groups, and the company list — without minting a token or making a single
 * outbound call. This is the operator's only chance to notice a bad filter
 * before ~500 real `ADMIN_EDIT` events are produced.
 */
export async function previewAdminEdits(
  environment: Environment,
  input: string,
): Promise<AdminEventPreview> {
  const mobiles = parseList(input);
  const filter = mobiles.length ? mobiles : null;

  const [users, companies] = await Promise.all([
    fetchAdminUsers(environment, filter, null),
    fetchActiveCompanies(environment),
  ]);

  const allCompaniesCount = users.filter(
    (u) => u.group === "all-companies",
  ).length;
  const specificCompaniesCount = users.length - allCompaniesCount;

  const matched = new Set(users.map((u) => u.mobile_no ?? ""));
  const notes = (filter ?? [])
    .filter((m) => !matched.has(m))
    .map((m) => ({
      mobile: m,
      reason:
        "No admin user matched — check the number is exact, active, has an email, and holds one of the listed roles.",
    }));

  const blockers: string[] = [];
  if (specificCompaniesCount > 0 && companies.length === 0) {
    blockers.push(
      `${specificCompaniesCount} user(s) hold a company-scoped role (${SPECIFIC_COMPANY_ROLE_IDS.join(", ")}) but no active company with an active division was found. auth-backend requires a non-empty companies array for those roles and would reject every one of them.`,
    );
  }

  let endpoint = "";
  try {
    endpoint = resolveAdminEventUrl(environment);
  } catch (e) {
    blockers.push(e instanceof Error ? e.message : String(e));
  }

  const message = users.length
    ? `${users.length} admin user${users.length === 1 ? "" : "s"} will receive an ADMIN_EDIT event — ${allCompaniesCount} with all-company roles and ${specificCompaniesCount} with company-scoped roles (${companies.length} companies).`
    : filter
      ? "No eligible admin user matched the supplied mobile number(s). Nothing would be sent."
      : "No eligible admin user found. Nothing would be sent.";

  return {
    ok: blockers.length === 0,
    preview: true,
    message,
    users,
    allCompaniesCount,
    specificCompaniesCount,
    companies,
    endpoint,
    blockers,
    notes,
  };
}

/**
 * Apply one chunk of previously previewed ids.
 *
 * The UI drives this in slices rather than the server paging with
 * LIMIT/OFFSET: what the operator confirmed is exactly what gets sent, and the
 * page cannot drift underneath the run while the V2 consumer writes back to
 * `Admin_Users`.
 */
export async function runAdminEdits(
  environment: Environment,
  ids: string[],
): Promise<AdminEventRunResult> {
  if (!ids.length) {
    return {
      ok: false,
      message: "No user ids supplied.",
      attempted: 0,
      succeeded: 0,
      failed: 0,
      rows: [],
      skipped: [],
    };
  }

  const url = resolveAdminEventUrl(environment);
  const [users, companies] = await Promise.all([
    fetchAdminUsers(environment, null, ids),
    fetchActiveCompanies(environment),
  ]);
  const companyIds = companies.map((c) => c.id);

  const found = new Set(users.map((u) => u.id));
  const skipped = ids
    .filter((id) => !found.has(id))
    .map((id) => ({
      id,
      reason:
        "No longer matches the eligibility filter (role / active status / mobile / email changed since the preview) — skipped rather than sent with stale data.",
    }));

  const sendable: AdminEventUser[] = [];
  for (const u of users) {
    if (u.group === "specific-companies" && companyIds.length === 0) {
      // auth-backend requires a non-empty array for these roles; sending an
      // empty one would strip the user's company access.
      skipped.push({
        id: u.id,
        reason:
          "Company-scoped role but no active company resolved — auth-backend requires a non-empty companies array.",
      });
      continue;
    }
    sendable.push(u);
  }

  let token = await getBulkToken(environment);
  const rows: AdminEventRow[] = [];

  for (let i = 0; i < sendable.length; i += PUSH_CONCURRENCY) {
    const batch = sendable.slice(i, i + PUSH_CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (user) => {
        const body = buildAdminEditBody(user, companyIds);
        let out = await putAdminEdit(url, token, body, DEFAULT_TIMEOUT_MS);

        // A 401 mid-run means the cached token aged out between chunks; mint a
        // fresh one and give this user one more attempt. Retried only on 401 —
        // any other failure is reported as-is, never silently repeated.
        if (out.status === 401) {
          token = await getBulkToken(environment, { force: true });
          out = await putAdminEdit(url, token, body, DEFAULT_TIMEOUT_MS);
        }
        return { user, out };
      }),
    );

    for (const { user, out } of settled) {
      if (!out.ok) {
        console.error(
          `[admin-events] ${user.id} (${user.mobile_no ?? "—"}) failed: HTTP ${out.status ?? "network"} ${out.raw}`,
        );
      }
      rows.push({
        id: user.id,
        name: user.name,
        mobile_no: user.mobile_no,
        user_role_id: user.user_role_id,
        group: user.group,
        ok: out.ok,
        status: out.status,
        detail: truncateResponse(out.raw) || "<empty response>",
      });
    }
  }

  const succeeded = rows.filter((r) => r.ok).length;
  const failed = rows.length - succeeded;

  return {
    ok: failed === 0 && skipped.length === 0,
    message: `Pushed ${rows.length} admin edit${rows.length === 1 ? "" : "s"} — ${succeeded} succeeded, ${failed} failed${skipped.length ? `, ${skipped.length} skipped` : ""}.`,
    attempted: rows.length,
    succeeded,
    failed,
    rows,
    skipped,
  };
}
