import { authSchema, getAuthPool, getPool } from "./db";
import { describeCognitoError, lookupByMobile, lookupBySub } from "./cognito";
import type {
  AuthComparisonResult,
  AuthComparisonRow,
  AuthEmployeeRow,
  CognitoLookup,
  CorpEmployeeRow,
  EmployeeScope,
  Environment,
} from "./types";

/**
 * Read-only reconciliation of field-force employees across three sources:
 *   - auth DB  `Field_Force_Users`  (getAuthPool + authSchema)
 *   - corp DB  `empmaster_hdr`      (getPool, corp service)
 *   - AWS Cognito                   (lib/cognito.ts, ListUsers only)
 *
 * The two DBs are reached through separately-configured pools that may point at
 * different databases, so they are fetched independently and joined in Node by
 * employee short code — never via a cross-DB SQL join. Both DBs use 'Y' for
 * active in their `active_status` column. No source is ever written to.
 */

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

function norm(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/* ----------------------------- DB fetch ----------------------------- */

async function fetchAuthEmployees(
  environment: Environment,
  scope: EmployeeScope,
  mobile10?: string,
): Promise<AuthEmployeeRow[]> {
  const pool = getAuthPool(environment);
  const schema = authSchema(environment);
  const where: string[] = ["1=1"];
  const params: string[] = [];
  if (scope === "active") where.push("active_status = 'Y'");
  if (mobile10) {
    params.push(mobile10);
    where.push(`mobile_no = $${params.length}`);
  }
  // Schema is a validated identifier; the table name is a fixed constant; the
  // mobile is parameterized.
  const sql = `
    SELECT
      id::text AS id,
      short_code,
      name,
      mobile_no,
      cognito_id,
      active_status
    FROM "${schema}"."Field_Force_Users"
    WHERE ${where.join(" AND ")}
    ORDER BY short_code NULLS LAST, id`;
  const { rows } = await pool.query(sql, params);
  return rows as AuthEmployeeRow[];
}

async function fetchCorpEmployees(
  environment: Environment,
  scope: EmployeeScope,
  mobile10?: string,
): Promise<CorpEmployeeRow[]> {
  const pool = getPool({ environment, service: "corp", instance: null });
  const where: string[] = ["1=1"];
  const params: string[] = [];
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
      emp_name,
      mobile_no::text AS mobile_no,
      cognito_id,
      active_status
    FROM public.empmaster_hdr
    WHERE ${where.join(" AND ")}
    ORDER BY emp_shortcode NULLS LAST, empmaster_id`;
  const { rows } = await pool.query(sql, params);
  return rows as CorpEmployeeRow[];
}

/* --------------------------- pairing/diff --------------------------- */

type Pair = { auth: AuthEmployeeRow | null; corp: CorpEmployeeRow | null; key: string };

/**
 * Join auth and corp rows by short code. Rows that share a code are zipped
 * together (index-aligned) so duplicates don't get lost; a code present on only
 * one side yields an unpaired row (the "missing in auth/corp" case). Keys are
 * sorted for deterministic "first 100" selection.
 */
function pairByShortCode(
  authRows: AuthEmployeeRow[],
  corpRows: CorpEmployeeRow[],
): Pair[] {
  const authByCode = new Map<string, AuthEmployeeRow[]>();
  const corpByCode = new Map<string, CorpEmployeeRow[]>();
  for (const r of authRows) {
    const k = norm(r.short_code);
    (authByCode.get(k) ?? authByCode.set(k, []).get(k)!).push(r);
  }
  for (const r of corpRows) {
    const k = norm(r.emp_shortcode);
    (corpByCode.get(k) ?? corpByCode.set(k, []).get(k)!).push(r);
  }
  const keys = Array.from(
    new Set<string>([...authByCode.keys(), ...corpByCode.keys()]),
  ).sort();

  const pairs: Pair[] = [];
  for (const k of keys) {
    const a = authByCode.get(k) ?? [];
    const c = corpByCode.get(k) ?? [];
    const n = Math.max(a.length, c.length);
    for (let i = 0; i < n; i++) {
      pairs.push({ auth: a[i] ?? null, corp: c[i] ?? null, key: k });
    }
  }
  return pairs;
}

function buildComparison(pair: Pair): AuthComparisonRow {
  const { auth, corp, key } = pair;
  const presentInAuth = auth !== null;
  const presentInCorp = corp !== null;
  const bothPresent = presentInAuth && presentInCorp;

  const nameMismatch =
    bothPresent &&
    norm(auth!.name).toLowerCase() !== norm(corp!.emp_name).toLowerCase();
  const mobileMismatch =
    bothPresent &&
    normalizeMobile(auth!.mobile_no) !== normalizeMobile(corp!.mobile_no);

  const authCog = norm(auth?.cognito_id);
  const corpCog = norm(corp?.cognito_id);
  const cognitoIdMismatch = bothPresent && authCog !== corpCog;
  const bothCognitoNull = !authCog && !corpCog;

  const statuses: string[] = [];
  if (!presentInAuth) statuses.push("Missing in auth");
  if (!presentInCorp) statuses.push("Missing in corp");
  if (nameMismatch) statuses.push("Name mismatch");
  if (mobileMismatch) statuses.push("Mobile mismatch");
  if (cognitoIdMismatch) statuses.push("cognito_id mismatch (auth vs corp)");

  const inconsistent =
    !bothPresent || nameMismatch || mobileMismatch || cognitoIdMismatch;

  return {
    key,
    auth,
    corp,
    cognito: { checked: false, byMobile: [], bySub: [] },
    flags: {
      presentInAuth,
      presentInCorp,
      nameMismatch,
      mobileMismatch,
      cognitoIdMismatch,
      bothCognitoNull,
    },
    inconsistent,
    statuses,
  };
}

/* --------------------------- Cognito step --------------------------- */

/** Add cognito-vs-DB cross-check notes once the lookup has run. */
function finalizeCognitoStatuses(row: AuthComparisonRow): void {
  const c = row.cognito;
  if (!c.checked) return;
  if (c.error) {
    row.statuses.push("Cognito lookup error");
    return;
  }
  const authCog = norm(row.auth?.cognito_id);
  const corpCog = norm(row.corp?.cognito_id);
  const mobileSubs = c.byMobile.map((u) => norm(u.sub)).filter(Boolean);

  if ((authCog || corpCog) && c.byMobile.length === 0) {
    row.statuses.push("No Cognito user for mobile");
  }
  if (mobileSubs.length) {
    if (authCog && !mobileSubs.includes(authCog)) {
      row.statuses.push("auth cognito_id ≠ Cognito (by mobile)");
    }
    if (corpCog && !mobileSubs.includes(corpCog)) {
      row.statuses.push("corp cognito_id ≠ Cognito (by mobile)");
    }
  }
  const rowMobile =
    normalizeMobile(row.auth?.mobile_no) ?? normalizeMobile(row.corp?.mobile_no);
  for (const s of c.bySub) {
    if (s.users.length === 0) {
      row.statuses.push("cognito_id not found in Cognito");
    } else {
      const subMobile = normalizeMobile(s.users[0].phone_number);
      if (rowMobile && subMobile && rowMobile !== subMobile) {
        row.statuses.push("Cognito phone ≠ DB mobile (by sub)");
      }
    }
  }
}

/**
 * Enrich each record that has at least one stored cognito_id (per the rule:
 * both-null → consistent → skip Cognito). Runs in bounded-concurrency batches;
 * a per-record failure is captured on the record, never thrown.
 */
async function enrichWithCognito(
  environment: Environment,
  rows: AuthComparisonRow[],
): Promise<void> {
  const targets = rows.filter((r) => {
    if (r.flags.bothCognitoNull) {
      r.cognito = {
        checked: false,
        skippedReason: "cognito_id null in both auth and corp",
        byMobile: [],
        bySub: [],
      };
      return false;
    }
    return true;
  });

  for (let i = 0; i < targets.length; i += COGNITO_CONCURRENCY) {
    const batch = targets.slice(i, i + COGNITO_CONCURRENCY);
    await Promise.all(
      batch.map(async (row) => {
        const mobile10 =
          normalizeMobile(row.auth?.mobile_no) ??
          normalizeMobile(row.corp?.mobile_no);
        const distinctSubs = Array.from(
          new Set(
            [norm(row.auth?.cognito_id), norm(row.corp?.cognito_id)].filter(
              Boolean,
            ),
          ),
        );
        const lookup: CognitoLookup = { checked: true, byMobile: [], bySub: [] };
        try {
          if (mobile10) lookup.byMobile = await lookupByMobile(environment, mobile10);
          for (const sub of distinctSubs) {
            const users = await lookupBySub(environment, sub);
            lookup.bySub.push({ cognitoId: sub, users });
          }
        } catch (e) {
          lookup.error = describeCognitoError(e);
        }
        row.cognito = lookup;
        finalizeCognitoStatuses(row);
      }),
    );
  }
}

function dedupeStatuses(rows: AuthComparisonRow[]): void {
  for (const r of rows) r.statuses = Array.from(new Set(r.statuses));
}

/* ------------------------------ modes ------------------------------ */

/** Mode 1: single mobile lookup across all three sources. */
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

  const [authRows, corpRows] = await Promise.all([
    fetchAuthEmployees(environment, scope, mobile10),
    fetchCorpEmployees(environment, scope, mobile10),
  ]);

  const rows = pairByShortCode(authRows, corpRows).map(buildComparison);
  await enrichWithCognito(environment, rows);
  dedupeStatuses(rows);

  const inconsistentCount = rows.filter((r) => r.inconsistent).length;
  const scopeWord = scope === "active" ? "active " : "";
  return {
    ok: true,
    mode: "single",
    environment,
    scope,
    message: rows.length
      ? `Found ${rows.length} ${scopeWord}record${rows.length === 1 ? "" : "s"} for ${mobile10} — ${inconsistentCount} inconsistent.`
      : `No ${scopeWord}field-force employee found for ${mobile10} in auth or corp.`,
    rows,
  };
}

/** Mode 2: bulk scan — first `limit` records that differ between auth and corp. */
export async function scanInconsistent(
  environment: Environment,
  scope: EmployeeScope,
  limit: number = BULK_LIMIT,
): Promise<AuthComparisonResult> {
  const [authRows, corpRows] = await Promise.all([
    fetchAuthEmployees(environment, scope),
    fetchCorpEmployees(environment, scope),
  ]);

  const all = pairByShortCode(authRows, corpRows).map(buildComparison);
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
    message: `Scanned ${authRows.length} auth + ${corpRows.length} corp ${scopeWord}records. ${total} inconsistent; showing first ${slice.length}. Cognito checked only where a cognito_id exists.`,
    rows: slice,
  };
}
