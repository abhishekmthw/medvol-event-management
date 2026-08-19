import { authSchema, getAuthPool, getPool } from "./db";
import { norm, normalizeMobile } from "./auth-comparison";
import type { Environment } from "./types";

/**
 * Pre-write integrity checks for the Employee Data Correction card.
 *
 * The correction actions write straight to the corp / auth databases, so none
 * of auth-backend's application-level uniqueness guards run. This module
 * replicates them, and evaluates them against the PROJECTED END STATE of the
 * whole plan rather than statement by statement — the corrections deliberately
 * shuffle values between two users (A's mobile → B, B's → A), and such a swap
 * must be allowed because the state after the run is still unique.
 *
 * The rules mirrored (all app-level; there is NO DB unique constraint backing
 * any of them):
 *   - `mobile_no` unique across `Admin_Users → Field_Force_Users →
 *     Counter_Company_Lnk → Delegate_Users → Stockists`
 *     (auth-backend `getUserData`, used by EMPLOYEE_ADD and by EMPLOYEE_EDIT
 *     when the mobile changed). No active-status filter — deactivation blanks
 *     `mobile_no` / `cognito_id` to '' instead, which is how a number is
 *     freed, so blank values are never treated as holders.
 *   - `ucode` unique across `Admin_Users → Field_Force_Users → Counters →
 *     Delegate_Users → Stockists` (auth-backend `getUserDataWithEmail`) —
 *     note `Counters`, NOT `Counter_Company_Lnk`, which has no ucode column.
 *   - `(short_code, company_code)` unique in `Field_Force_Users`
 *     (auth-backend EMPLOYEE_ADD).
 *   - `cognito_id` identifies exactly one record. Auth itself does NOT enforce
 *     this (`saveCognitoID` is a bare `WHERE mobile_no = …`), but a duplicated
 *     cognito_id has broken production before, so the tool is stricter: every
 *     auth table carrying the column plus corp `empmaster_hdr`.
 *
 * Everything here is READ-ONLY. Table names are fixed internal constants and
 * the auth schema is a validated bare identifier (`authSchema`); all values
 * are parameterized.
 */

/** Tables auth's `getUserData()` walks for mobile uniqueness, in its order. */
const MOBILE_TABLES = [
  "Admin_Users",
  "Field_Force_Users",
  "Counter_Company_Lnk",
  "Delegate_Users",
  "Stockists",
] as const;

/** Tables auth's `getUserDataWithEmail()` walks for ucode uniqueness. */
const UCODE_TABLES = [
  "Admin_Users",
  "Field_Force_Users",
  "Counters",
  "Delegate_Users",
  "Stockists",
] as const;

/** Auth tables carrying `cognito_id` (corp `empmaster_hdr` is added on top). */
const COGNITO_TABLES = [
  "Admin_Users",
  "Field_Force_Users",
  "Counter_Company_Lnk",
  "Delegate_Users",
  "Stockists",
] as const;

/**
 * `Counter_Company_Lnk` is the one table with no `name` column (the same
 * gotcha `lib/otp-block.ts` already encodes via `hasName`) — it links a
 * counter to a company, the name lives on `Counters`.
 */
const TABLES_WITHOUT_NAME = new Set<string>(["Counter_Company_Lnk"]);

/** One existing row that currently holds a value we may be about to write. */
export type Holder = {
  db: "auth" | "corp";
  table: string;
  id: string;
  /** The value as stored (raw, un-normalized). */
  value: string;
  name: string | null;
  /**
   * Identity of the holder when it is a field-force employee — the only holder
   * kind that can be matched back to a corp record (and therefore the only one
   * whose value may itself be pending a correction). Null for every other
   * table, none of which carries a short code.
   */
  shortCode: string | null;
  companyCode: string | null;
};

/** A row the plan will write, and what it will hold afterwards. */
export type Assignment = {
  /** `rowKey(...)` of the row being written. */
  rowKey: string;
  /** Value after the plan runs; null / "" means the plan frees the row. */
  newValue: string | null;
  /** Human label for the row, used in violation messages. */
  label: string;
};

/** Stable identity of a row across the two databases. */
export function rowKey(db: "auth" | "corp", table: string, id: string): string {
  return `${db}:${table}:${id}`;
}

export function holderKey(h: Holder): string {
  return rowKey(h.db, h.table, h.id);
}

/** Where a holder lives, for messages. */
export function describeHolder(h: Holder): string {
  const who = norm(h.name);
  const where = h.db === "corp" ? `corp ${h.table}` : `auth ${h.table}`;
  return `${where} row ${h.id}${who ? ` (${who})` : ""}`;
}

/* ------------------------------ holder lookups ------------------------------ */

/**
 * Runs the same `SELECT` against several fixed auth tables and flattens the
 * result. `valueColumn` is one of a fixed set of column names — never client
 * input — and the searched values are parameterized.
 */
async function authHolders(
  environment: Environment,
  tables: readonly string[],
  valueColumn: "mobile_no" | "ucode" | "cognito_id",
  values: string[],
): Promise<Holder[]> {
  const wanted = Array.from(new Set(values.map((v) => norm(v)).filter(Boolean)));
  if (wanted.length === 0) return [];

  const pool = getAuthPool(environment);
  const schema = authSchema(environment);

  const results = await Promise.all(
    tables.map(async (table) => {
      const nameExpr = TABLES_WITHOUT_NAME.has(table) ? "NULL::text" : `"name"`;
      // Only Field_Force_Users carries the (short code, company code) identity.
      const identityExpr =
        table === "Field_Force_Users"
          ? `short_code::text AS short_code, company_code::text AS company_code`
          : `NULL::text AS short_code, NULL::text AS company_code`;
      // Blank / NULL values are "free" — auth frees a mobile or cognito_id by
      // blanking it on deactivation, so such rows are not holders.
      const { rows } = await pool.query(
        `SELECT id::text AS id, "${valueColumn}"::text AS value, ${nameExpr} AS name,
                ${identityExpr}
           FROM "${schema}"."${table}"
          WHERE "${valueColumn}" IS NOT NULL
            AND btrim("${valueColumn}"::text) <> ''
            AND btrim("${valueColumn}"::text) = ANY($1::text[])
          ORDER BY id`,
        [wanted],
      );
      return rows.map(
        (r): Holder => ({
          db: "auth",
          table,
          id: String(r.id),
          value: String(r.value ?? ""),
          name: r.name ?? null,
          shortCode: r.short_code ?? null,
          companyCode: r.company_code ?? null,
        }),
      );
    }),
  );
  return results.flat();
}

/** Every auth row (across all five user types) holding one of these mobiles. */
export function findMobileHolders(
  environment: Environment,
  mobiles: string[],
): Promise<Holder[]> {
  return authHolders(environment, MOBILE_TABLES, "mobile_no", mobiles);
}

/** Every auth row holding one of these ucodes (case-insensitive). */
export async function findUcodeHolders(
  environment: Environment,
  ucodes: string[],
): Promise<Holder[]> {
  // Auth compares ucodes with plain equality, but the tool displays/writes
  // them lowercased while Cognito stores them uppercase — search both forms so
  // a case-only collision is still caught.
  const variants = ucodes.flatMap((u) => {
    const s = norm(u);
    return s ? [s, s.toLowerCase(), s.toUpperCase()] : [];
  });
  return authHolders(environment, UCODE_TABLES, "ucode", variants);
}

/**
 * Every row holding one of these Cognito subs — the five auth user tables plus
 * corp `empmaster_hdr`.
 */
export async function findCognitoHolders(
  environment: Environment,
  subs: string[],
): Promise<Holder[]> {
  const wanted = Array.from(new Set(subs.map((s) => norm(s)).filter(Boolean)));
  if (wanted.length === 0) return [];

  const [auth, corp] = await Promise.all([
    authHolders(environment, COGNITO_TABLES, "cognito_id", wanted),
    (async (): Promise<Holder[]> => {
      const pool = getPool({ environment, service: "corp", instance: null });
      const { rows } = await pool.query(
        `SELECT empmaster_id::text AS id, cognito_id::text AS value, emp_name AS name,
                emp_shortcode::text AS short_code, company_code::text AS company_code
           FROM public.empmaster_hdr
          WHERE cognito_id IS NOT NULL
            AND btrim(cognito_id) <> ''
            AND btrim(cognito_id) = ANY($1::text[])
          ORDER BY empmaster_id`,
        [wanted],
      );
      return rows.map(
        (r): Holder => ({
          db: "corp",
          table: "empmaster_hdr",
          id: String(r.id),
          value: String(r.value ?? ""),
          name: r.name ?? null,
          shortCode: r.short_code ?? null,
          companyCode: r.company_code ?? null,
        }),
      );
    })(),
  ]);
  return [...auth, ...corp];
}

/**
 * Auth `Field_Force_Users` rows on a (short code, company code) pair — the
 * identity key auth's EMPLOYEE_ADD requires to be free.
 */
export async function findShortCodePairHolders(
  environment: Environment,
  shortCode: string,
  companyCode: string | null,
): Promise<Holder[]> {
  const sc = norm(shortCode);
  if (!sc) return [];
  const pool = getAuthPool(environment);
  const schema = authSchema(environment);
  const { rows } = await pool.query(
    `SELECT id::text AS id, short_code::text AS value, "name" AS name,
            short_code::text AS short_code, company_code::text AS company_code
       FROM "${schema}"."Field_Force_Users"
      WHERE btrim(short_code) = $1
        AND COALESCE(btrim(company_code::text), '') = COALESCE(btrim($2::text), '')
      ORDER BY id`,
    [sc, norm(companyCode) || null],
  );
  return rows.map(
    (r): Holder => ({
      db: "auth",
      table: "Field_Force_Users",
      id: String(r.id),
      value: String(r.value ?? ""),
      name: r.name ?? null,
      shortCode: r.short_code ?? null,
      companyCode: r.company_code ?? null,
    }),
  );
}

/* --------------------------- net end-state validator --------------------------- */

/** How two values are considered "the same" for a given invariant. */
export type Canonicalize = (v: string | null | undefined) => string;

const canonExact: Canonicalize = (v) => norm(v);
const canonLower: Canonicalize = (v) => norm(v).toLowerCase();
const canonMobile: Canonicalize = (v) => normalizeMobile(v) ?? "";

export const CANON = {
  /** Auth compares mobiles with raw string equality — that is the hard rule. */
  exact: canonExact,
  /** Case-insensitive (ucode). */
  lower: canonLower,
  /** Last-10 digits — a looser net than auth applies (reported as a warning). */
  mobile10: canonMobile,
};

/**
 * The core check: would the plan leave two different rows holding the same
 * value?
 *
 * A holder is only a violation when it will STILL hold the contested value
 * after the plan runs — i.e. the plan does not reassign that very row to
 * something else. That is what lets a swap through: with A→B's number and
 * B→A's number, each side appears in `assignments` with a different new value,
 * so neither is counted against the other. A target genuinely occupied by a
 * row the plan never touches survives and is reported.
 *
 * Also catches the plan contradicting itself — two different rows assigned the
 * same value.
 */
export function validateNetUniqueness(opts: {
  /** What the invariant is called in messages, e.g. "Mobile number". */
  label: string;
  assignments: Assignment[];
  holders: Holder[];
  canon?: Canonicalize;
  /** Appended to each violation — e.g. which auth guard would reject it. */
  hint?: string;
}): string[] {
  const canon = opts.canon ?? canonExact;
  const hint = opts.hint ? ` ${opts.hint}` : "";

  /** Projected value per row the plan writes. */
  const planned = new Map<string, Assignment>();
  for (const a of opts.assignments) planned.set(a.rowKey, a);

  const violations: string[] = [];

  // 1. The plan must not assign one value to two different rows.
  const byValue = new Map<string, Assignment[]>();
  for (const a of opts.assignments) {
    const v = canon(a.newValue);
    if (!v) continue; // freeing a row is always safe
    const list = byValue.get(v);
    if (list) list.push(a);
    else byValue.set(v, [a]);
  }
  for (const [value, list] of byValue) {
    if (list.length > 1) {
      violations.push(
        `${opts.label} ${value} would be written to ${list.length} different records (${list
          .map((a) => a.label)
          .join(", ")}) — a plan can never assign it twice.${hint}`,
      );
    }
  }

  // 2. Existing rows that keep the contested value after the plan runs.
  for (const [value, list] of byValue) {
    const targetKeys = new Set(list.map((a) => a.rowKey));
    for (const h of opts.holders) {
      if (canon(h.value) !== value) continue;
      const key = holderKey(h);
      if (targetKeys.has(key)) continue; // this row IS the intended owner
      const move = planned.get(key);
      // The plan moves this row off the value → no end-state collision.
      if (move && canon(move.newValue) !== value) continue;
      violations.push(
        `${opts.label} ${value} is already held by ${describeHolder(h)} and the plan does not free it — writing it to ${list
          .map((a) => a.label)
          .join(", ")} would create a duplicate.${hint}`,
      );
    }
  }

  return violations;
}
