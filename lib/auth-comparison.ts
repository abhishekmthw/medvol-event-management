import { authSchema, getAuthPool, getPool } from "./db";
import { describeCognitoError, lookupByMobile, lookupBySub } from "./cognito";
import { normalizeName } from "./format";
import type {
  AuthComparisonResult,
  AuthComparisonRow,
  AuthEmployeeRow,
  CognitoLookup,
  CognitoUserInfo,
  CorpEmployeeRow,
  EmployeeCognitoChunk,
  EmployeeCognitoRow,
  EmployeeScope,
  Environment,
} from "./types";

/**
 * Read-only reconciliation of field-force employees, driven by CORP:
 *
 *   1. Fetch the list of employees from corp `empmaster_hdr` (the base set, and
 *      the source of truth for short code, company code, name and mobile).
 *   2. For each, look up the matching record in auth `Field_Force_Users` by the
 *      (short code, company code) pair — a short code is only unique within a
 *      company. Auth records with no corp match are NOT reported.
 *   3. Validate cognito_id against AWS Cognito — the source of truth for
 *      cognito_id — by looking the user up by the corp mobile (and by the stored
 *      subs), then flagging corp/auth cognito_id values that disagree with it.
 *
 * The corp and auth DBs are reached through separately-configured pools that may
 * point at different databases, so they are fetched independently and joined in
 * Node — never via a cross-DB SQL join. Both `company_code` columns hold the same
 * human company code (auth `Companies.id` PrimaryColumn = the code, stored on the
 * FK; corp `empmaster_hdr.company_code` = `company_hdr.code`). Corp uses 'Y' for
 * active. No source is ever written to.
 */

/** NUL separator for the composite (short code, company code) map key — a NUL
 * can't appear in a short/company code, so distinct pairs never collide. */
const KEY_SEP = String.fromCharCode(0);

const BULK_LIMIT = 100;
/** Cap on concurrent Cognito calls so a 100-record scan doesn't get throttled. */
const COGNITO_CONCURRENCY = 6;

export function isEmployeeScope(v: unknown): v is EmployeeScope {
  return v === "active" || v === "all";
}

/** Reduce any stored/displayed phone to its last 10 digits (or null). */
export function normalizeMobile(v: string | null | undefined): string | null {
  if (v == null) return null;
  const digits = String(v).replace(/\D/g, "");
  if (!digits) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function norm(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/** Composite identity key — a short code is only unique within a company. */
export function pairKey(
  shortCode: string | null,
  companyCode: string | null,
): string {
  return `${norm(shortCode)}${KEY_SEP}${norm(companyCode)}`;
}

/* ----------------------------- DB fetch ----------------------------- */

/** Corp employees (the base). Scope filters this set; `mobile10` narrows it. */
async function fetchCorpEmployees(
  environment: Environment,
  scope: EmployeeScope,
  mobile10?: string,
): Promise<CorpEmployeeRow[]> {
  const pool = getPool({ environment, service: "corp", instance: null });
  const where: string[] = ["1=1"];
  const params: unknown[] = [];
  if (scope === "active") where.push("active_status = 'Y'");
  if (mobile10) {
    params.push(mobile10);
    // mobile_no is numeric(10); compare against the numeric form of the input.
    where.push(`mobile_no = $${params.length}::numeric`);
  }
  const sql = `
    SELECT
      empmaster_id::text AS empmaster_id,
      emp_shortcode,
      company_code::text AS company_code,
      emp_name,
      mobile_no::text AS mobile_no,
      cognito_id,
      active_status
    FROM public.empmaster_hdr
    WHERE ${where.join(" AND ")}
    ORDER BY emp_shortcode NULLS LAST, company_code NULLS LAST, empmaster_id`;
  const { rows } = await pool.query(sql, params);
  return rows as CorpEmployeeRow[];
}

/**
 * Auth records, used only to look up the corp employees. Never filtered by active
 * status (we want to detect a corp employee that exists in auth even if inactive
 * there). `shortCodes`, when given, restricts the fetch to those short codes
 * (used by single-mobile lookup to avoid scanning the whole table).
 */
async function fetchAuthEmployees(
  environment: Environment,
  shortCodes?: string[],
): Promise<AuthEmployeeRow[]> {
  const pool = getAuthPool(environment);
  const schema = authSchema(environment);
  const where: string[] = ["1=1"];
  const params: unknown[] = [];
  if (shortCodes && shortCodes.length) {
    params.push(shortCodes);
    where.push(`short_code = ANY($${params.length}::text[])`);
  }
  // Schema is a validated identifier; the table name is a fixed constant; values
  // are parameterized.
  const sql = `
    SELECT
      id::text AS id,
      short_code,
      company_code::text AS company_code,
      name,
      mobile_no,
      cognito_id,
      active_status
    FROM "${schema}"."Field_Force_Users"
    WHERE ${where.join(" AND ")}
    ORDER BY short_code NULLS LAST, company_code NULLS LAST, id`;
  const { rows } = await pool.query(sql, params);
  return rows as AuthEmployeeRow[];
}

/* --------------------------- pairing/diff --------------------------- */

type Pair = {
  corp: CorpEmployeeRow;
  auth: AuthEmployeeRow | null;
  authMatchCount: number;
};

/**
 * Corp-driven join: one entry per corp employee, matched to its auth record by
 * the (short code, company code) pair. Corp order (from the SQL) is preserved for
 * deterministic "first 100" selection. Auth rows with no corp match are dropped.
 */
function pairFromCorp(
  corpRows: CorpEmployeeRow[],
  authRows: AuthEmployeeRow[],
): Pair[] {
  const authByKey = new Map<string, AuthEmployeeRow[]>();
  for (const r of authRows) {
    const k = pairKey(r.short_code, r.company_code);
    (authByKey.get(k) ?? authByKey.set(k, []).get(k)!).push(r);
  }
  return corpRows.map((corp) => {
    const matches = authByKey.get(pairKey(corp.emp_shortcode, corp.company_code)) ?? [];
    return { corp, auth: matches[0] ?? null, authMatchCount: matches.length };
  });
}

function buildComparison(pair: Pair): AuthComparisonRow {
  const { corp, auth, authMatchCount } = pair;
  const presentInAuth = auth !== null;

  // Names match on their canonical form (lowercase, special characters
  // stripped) so encoding damage like a trailing "�" doesn't flag a diff.
  const nameMismatch =
    presentInAuth && normalizeName(auth!.name) !== normalizeName(corp.emp_name);
  const mobileMismatch =
    presentInAuth &&
    normalizeMobile(auth!.mobile_no) !== normalizeMobile(corp.mobile_no);
  const authCorpCognitoMismatch =
    presentInAuth && norm(auth!.cognito_id) !== norm(corp.cognito_id);

  const statuses: string[] = [];
  if (!presentInAuth) statuses.push("Missing in auth");
  if (nameMismatch) statuses.push("Name differs from corp");
  if (mobileMismatch) statuses.push("Mobile differs from corp");
  if (authCorpCognitoMismatch) statuses.push("auth cognito_id ≠ corp cognito_id");
  if (authMatchCount > 1) statuses.push("Multiple auth matches");

  // Cheap (pre-Cognito) inconsistency — drives the bulk top-100 selection.
  const inconsistent =
    !presentInAuth || nameMismatch || mobileMismatch || authCorpCognitoMismatch;

  return {
    key: corp.empmaster_id,
    shortCode: norm(corp.emp_shortcode),
    companyCode: norm(corp.company_code),
    corp,
    auth,
    cognito: { checked: false, byMobile: [], bySub: [] },
    flags: {
      presentInAuth,
      nameMismatch,
      mobileMismatch,
      authCorpCognitoMismatch,
      corpCognitoMismatch: false,
      authCognitoMismatch: false,
    },
    inconsistent,
    statuses,
  };
}

/* --------------------------- Cognito step --------------------------- */

/**
 * Validate cognito_id against the live Cognito user (the source of truth),
 * looked up by the corp mobile. Sets the corp/auth cognito-mismatch flags and
 * status notes, and may flip the record to inconsistent.
 */
function applyCognitoTruth(row: AuthComparisonRow): void {
  const c = row.cognito;
  if (!c.checked) return;
  if (c.error) {
    row.statuses.push("Cognito lookup error");
    row.inconsistent = true;
    return;
  }

  const realSubs = c.byMobile.map((u) => norm(u.sub)).filter(Boolean);
  const hasCognitoUser = realSubs.length > 0;
  const corpCog = norm(row.corp?.cognito_id);
  const authCog = norm(row.auth?.cognito_id);

  const mismatchVsTruth = (stored: string): boolean =>
    hasCognitoUser ? !realSubs.includes(stored) : Boolean(stored);

  const corpCognitoMismatch = mismatchVsTruth(corpCog);
  const authCognitoMismatch = row.flags.presentInAuth
    ? mismatchVsTruth(authCog)
    : false;

  row.flags.corpCognitoMismatch = corpCognitoMismatch;
  row.flags.authCognitoMismatch = authCognitoMismatch;

  if (!hasCognitoUser) {
    if (corpCog || authCog) row.statuses.push("No Cognito user for corp mobile");
  } else {
    if (corpCognitoMismatch) {
      row.statuses.push(corpCog ? "corp cognito_id ≠ Cognito" : "corp cognito_id missing (Cognito has it)");
    }
    if (row.flags.presentInAuth && authCognitoMismatch) {
      row.statuses.push(authCog ? "auth cognito_id ≠ Cognito" : "auth cognito_id missing (Cognito has it)");
    }
  }
  for (const s of c.bySub) {
    if (s.users.length === 0) row.statuses.push("Stored cognito_id not found in Cognito");
  }

  if (corpCognitoMismatch || authCognitoMismatch) row.inconsistent = true;
}

/**
 * Always validate every shown record against Cognito (Cognito is the source of
 * truth for cognito_id): look the user up by the corp mobile and by each stored
 * sub, in bounded-concurrency batches. A per-record failure is captured on the
 * record, never thrown.
 */
async function enrichWithCognito(
  environment: Environment,
  rows: AuthComparisonRow[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += COGNITO_CONCURRENCY) {
    const batch = rows.slice(i, i + COGNITO_CONCURRENCY);
    await Promise.all(
      batch.map(async (row) => {
        const corpMobile = normalizeMobile(row.corp?.mobile_no);
        const distinctSubs = Array.from(
          new Set(
            [norm(row.corp?.cognito_id), norm(row.auth?.cognito_id)].filter(
              Boolean,
            ),
          ),
        );
        const lookup: CognitoLookup = { checked: true, byMobile: [], bySub: [] };
        try {
          if (corpMobile) lookup.byMobile = await lookupByMobile(environment, corpMobile);
          for (const sub of distinctSubs) {
            const users = await lookupBySub(environment, sub);
            lookup.bySub.push({ cognitoId: sub, users });
          }
        } catch (e) {
          lookup.error = describeCognitoError(e);
        }
        row.cognito = lookup;
        applyCognitoTruth(row);
      }),
    );
  }
}

function dedupeStatuses(rows: AuthComparisonRow[]): void {
  for (const r of rows) r.statuses = Array.from(new Set(r.statuses));
}

/* ------------------------------ modes ------------------------------ */

/** Mode 1: single mobile lookup — corp by mobile, then resolve auth + Cognito. */
export async function compareByMobile(
  environment: Environment,
  mobileInput: string,
  scope: EmployeeScope,
): Promise<AuthComparisonResult> {
  const mobile10 = normalizeMobile(mobileInput);
  if (!mobile10 || mobile10.length !== 10) {
    return {
      ok: false,
      message: "Enter a valid 10-digit mobile number.",
      mode: "single",
      environment,
      scope,
      rows: [],
    };
  }

  const scopeWord = scope === "active" ? "active " : "";
  const corpRows = await fetchCorpEmployees(environment, scope, mobile10);
  if (corpRows.length === 0) {
    return {
      ok: true,
      mode: "single",
      environment,
      scope,
      message: `No ${scopeWord}corp employee found for ${mobile10}. (Corp is the source of truth; a mobile only present in auth is not reported.)`,
      rows: [],
    };
  }

  const shortCodes = Array.from(
    new Set(corpRows.map((r) => norm(r.emp_shortcode)).filter(Boolean)),
  );
  const authRows = await fetchAuthEmployees(environment, shortCodes);

  const rows = pairFromCorp(corpRows, authRows).map(buildComparison);
  await enrichWithCognito(environment, rows);
  dedupeStatuses(rows);

  const inconsistentCount = rows.filter((r) => r.inconsistent).length;
  return {
    ok: true,
    mode: "single",
    environment,
    scope,
    message: `Found ${rows.length} ${scopeWord}corp record${rows.length === 1 ? "" : "s"} for ${mobile10} — ${inconsistentCount} inconsistent.`,
    rows,
  };
}

/** Mode 2: bulk scan — first `limit` corp employees that differ from auth. */
export async function scanInconsistent(
  environment: Environment,
  scope: EmployeeScope,
  limit: number = BULK_LIMIT,
): Promise<AuthComparisonResult> {
  const [corpRows, authRows] = await Promise.all([
    fetchCorpEmployees(environment, scope),
    fetchAuthEmployees(environment),
  ]);

  const all = pairFromCorp(corpRows, authRows).map(buildComparison);
  const inconsistentAll = all.filter((r) => r.inconsistent);
  const total = inconsistentAll.length;
  const slice = inconsistentAll.slice(0, limit);

  await enrichWithCognito(environment, slice);
  dedupeStatuses(slice);

  const scopeWord = scope === "active" ? "active " : "";
  return {
    ok: true,
    mode: "bulk",
    environment,
    scope,
    totalInconsistent: total,
    truncated: total > slice.length,
    message: `Scanned ${corpRows.length} corp ${scopeWord}employees against auth. ${total} inconsistent (missing in auth, or name / mobile / cognito_id differs); showing first ${slice.length}, each validated against Cognito.`,
    rows: slice,
  };
}

/* -------------------- Employee ↔ Cognito full scan -------------------- */

/**
 * Mode 3: chunked full scan of the auth employee table against Cognito.
 * Every `Field_Force_Users` row (in scope) that has a cognito_id is looked up
 * in Cognito by that sub, and its mobile number and short code are compared
 * against the live Cognito user (`phone_number` / `custom:emp_short_code`).
 *
 * Checking "all users" can mean thousands of ListUsers calls, so one API call
 * processes only `EMP_COGNITO_CHUNK` employees (ordered by id, LIMIT/OFFSET)
 * and returns `nextOffset` for the client to continue — the whole table is
 * covered across requests without any single one hitting a serverless timeout.
 * Only mismatched rows are returned. Read-only throughout.
 */
export const EMP_COGNITO_CHUNK = 200;

async function fetchAuthEmployeeChunk(
  environment: Environment,
  scope: EmployeeScope,
  offset: number,
): Promise<{ totalEmployees: number; totalWithCognitoId: number; rows: AuthEmployeeRow[] }> {
  const pool = getAuthPool(environment);
  const schema = authSchema(environment);
  const scopeWhere = scope === "active" ? `AND active_status = 'Y'` : "";
  const hasCognitoWhere = `cognito_id IS NOT NULL AND btrim(cognito_id) <> ''`;
  // Schema is a validated identifier; the table name is a fixed constant; values
  // are parameterized. Totals are recomputed per chunk (cheap counts) so the
  // client never needs a second endpoint.
  const countSql = `
    SELECT
      count(*) FILTER (WHERE true ${scopeWhere})::int AS total_employees,
      count(*) FILTER (WHERE ${hasCognitoWhere} ${scopeWhere})::int AS total_with_cognito
    FROM "${schema}"."Field_Force_Users"`;
  const chunkSql = `
    SELECT
      id::text AS id,
      short_code,
      company_code::text AS company_code,
      name,
      mobile_no,
      cognito_id,
      active_status
    FROM "${schema}"."Field_Force_Users"
    WHERE ${hasCognitoWhere} ${scopeWhere}
    ORDER BY id
    LIMIT $1 OFFSET $2`;
  const [countRes, chunkRes] = await Promise.all([
    pool.query(countSql),
    pool.query(chunkSql, [EMP_COGNITO_CHUNK, offset]),
  ]);
  return {
    totalEmployees: countRes.rows[0]?.total_employees ?? 0,
    totalWithCognitoId: countRes.rows[0]?.total_with_cognito ?? 0,
    rows: chunkRes.rows as AuthEmployeeRow[],
  };
}

/**
 * Corp records for the chunk's short codes, keyed by (short code, company code)
 * — the same pair identity the corp-driven comparison uses. No active filter:
 * the auth scope drives the scan; the corp record is looked up regardless.
 */
async function fetchCorpForShortCodes(
  environment: Environment,
  shortCodes: string[],
): Promise<Map<string, CorpEmployeeRow[]>> {
  const byKey = new Map<string, CorpEmployeeRow[]>();
  if (shortCodes.length === 0) return byKey;
  const pool = getPool({ environment, service: "corp", instance: null });
  const sql = `
    SELECT
      empmaster_id::text AS empmaster_id,
      emp_shortcode,
      company_code::text AS company_code,
      emp_name,
      mobile_no::text AS mobile_no,
      cognito_id,
      active_status
    FROM public.empmaster_hdr
    WHERE emp_shortcode = ANY($1::text[])
    ORDER BY empmaster_id`;
  const { rows } = await pool.query(sql, [shortCodes]);
  for (const r of rows as CorpEmployeeRow[]) {
    const k = pairKey(r.emp_shortcode, r.company_code);
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
  }
  return byKey;
}

function buildEmployeeCognitoRow(
  auth: AuthEmployeeRow,
  lookup: { users: CognitoUserInfo[]; error?: string },
  corpMatches: CorpEmployeeRow[],
): EmployeeCognitoRow {
  const cognito = lookup.users[0] ?? null;
  const corp = corpMatches[0] ?? null;
  const flags = {
    notFoundInCognito: !lookup.error && cognito === null,
    mobileMismatch:
      cognito !== null &&
      normalizeMobile(auth.mobile_no) !== normalizeMobile(cognito.phone_number),
    shortCodeMismatch:
      cognito !== null &&
      norm(auth.short_code).toUpperCase() !==
        norm(cognito.emp_short_code).toUpperCase(),
    missingInCorp: corp === null,
    corpNameMismatch:
      corp !== null && normalizeName(auth.name) !== normalizeName(corp.emp_name),
    corpMobileMismatch:
      corp !== null &&
      normalizeMobile(auth.mobile_no) !== normalizeMobile(corp.mobile_no),
    corpCognitoIdMismatch:
      corp !== null && norm(auth.cognito_id) !== norm(corp.cognito_id),
  };

  const statuses: string[] = [];
  if (lookup.error) statuses.push("Cognito lookup error");
  if (flags.notFoundInCognito) statuses.push("cognito_id not found in Cognito");
  if (flags.mobileMismatch) statuses.push("Mobile ≠ Cognito");
  if (flags.shortCodeMismatch) statuses.push("Short code ≠ Cognito");
  if (flags.missingInCorp) statuses.push("Missing in corp");
  if (flags.corpNameMismatch) statuses.push("Name ≠ corp");
  if (flags.corpMobileMismatch) statuses.push("Mobile ≠ corp");
  if (flags.corpCognitoIdMismatch) statuses.push("cognito_id ≠ corp");
  if (corpMatches.length > 1) statuses.push("Multiple corp matches");

  return {
    key: auth.id,
    auth,
    cognito,
    corp,
    corpMatchCount: corpMatches.length,
    error: lookup.error,
    flags,
    statuses,
  };
}

/** Process one chunk: fetch employees, look each sub up in Cognito, compare. */
export async function checkEmployeesAgainstCognito(
  environment: Environment,
  scope: EmployeeScope,
  offset: number,
): Promise<EmployeeCognitoChunk> {
  const { totalEmployees, totalWithCognitoId, rows } =
    await fetchAuthEmployeeChunk(environment, scope, offset);

  // One Cognito lookup per DISTINCT sub (two auth rows can share a cognito_id),
  // in bounded-concurrency batches. A per-sub failure is captured on the rows
  // that reference it, never thrown. The corp lookup for the chunk's short
  // codes runs concurrently — it's a single DB query on a separate pool.
  const subs = Array.from(new Set(rows.map((r) => norm(r.cognito_id))));
  const lookups = new Map<string, { users: CognitoUserInfo[]; error?: string }>();
  const shortCodes = Array.from(
    new Set(rows.map((r) => norm(r.short_code)).filter(Boolean)),
  );
  const [corpByKey] = await Promise.all([
    fetchCorpForShortCodes(environment, shortCodes),
    (async () => {
      for (let i = 0; i < subs.length; i += COGNITO_CONCURRENCY) {
        const batch = subs.slice(i, i + COGNITO_CONCURRENCY);
        await Promise.all(
          batch.map(async (sub) => {
            try {
              lookups.set(sub, { users: await lookupBySub(environment, sub) });
            } catch (e) {
              lookups.set(sub, { users: [], error: describeCognitoError(e) });
            }
          }),
        );
      }
    })(),
  ]);

  const mismatched = rows
    .map((auth) =>
      buildEmployeeCognitoRow(
        auth,
        lookups.get(norm(auth.cognito_id)) ?? { users: [] },
        corpByKey.get(pairKey(auth.short_code, auth.company_code)) ?? [],
      ),
    )
    .filter((r) => r.statuses.length > 0);

  const end = offset + rows.length;
  return {
    ok: true,
    environment,
    scope,
    totalEmployees,
    totalWithCognitoId,
    offset,
    checked: rows.length,
    nextOffset: end < totalWithCognitoId && rows.length > 0 ? end : null,
    rows: mismatched,
  };
}
