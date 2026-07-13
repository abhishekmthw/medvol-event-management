import { authSchema, getAuthPool, getPool } from "./db";
import {
  describeCognitoError,
  lookupByMobile,
  lookupBySub,
  updateUserPhone,
} from "./cognito";
import { norm, normalizeMobile, pairKey } from "./auth-comparison";
import { displayMobile10, normalizeName } from "./format";
import { sendAuthQueueMessage } from "./sqs";
import type {
  CognitoUserInfo,
  CorrectionAnalyzeResult,
  CorrectionClearResult,
  CorrectionConflict,
  CorrectionEmployee,
  CorrectionEventSummary,
  CorrectionField,
  CorrectionFixResult,
  CorrectionOldMobileHolder,
  CorrectionPhoneFixResult,
  CorrectionReassignResult,
  CorrectionReassignWrite,
  CorrectionReleaseResult,
  CorrectionReplayResult,
  CorrectionStoredSubOwner,
  CorrectionSyncChange,
  CorrectionSyncResult,
  Environment,
} from "./types";

/**
 * Employee Data Correction — corp-driven, keyed by a mobile number.
 *
 * Corp `empmaster_hdr` is checked FIRST and is the source of truth for short
 * code / mobile / name / ucode; AWS Cognito is the source of truth for
 * cognito_id. The analyze step is read-only; the two corrective actions are:
 *
 *   1. `replayEmployeeStream` — when the employee is missing in auth, the
 *      whole `employee_<empmaster_id>` event stream is read from corp
 *      `public.events` (ordered by timestamp) and each row is sent verbatim
 *      to the V1 auth consumer SQS FIFO queue, exactly like the proven manual
 *      recovery script. The auth-backend consumer re-creates the user from
 *      its own event history, so short code / mobile / name / ucode land as
 *      corp recorded them.
 *   2. `fixCognitoId` — resolves the LIVE Cognito user by the corp mobile
 *      (`phone_number = +91<mobile>`), requires its `custom:emp_short_code`
 *      to equal the corp short code (so a shared mobile can never pick the
 *      wrong account), then writes that user's sub into
 *      corp `empmaster_hdr.cognito_id` and auth `Field_Force_Users.cognito_id`.
 *
 * Every server entry point re-derives its inputs from the DBs/Cognito — the
 * client only ever sends `empmaster_id` — and both actions support a preview
 * mode that performs no sends and no writes.
 */

/* ------------------------------- fetch ------------------------------- */

/** Corp employee row for the correction card (superset incl. ucode). */
type CorpRow = {
  empmaster_id: string;
  emp_shortcode: string | null;
  company_code: string | null;
  emp_name: string | null;
  mobile_no: string | null;
  cognito_id: string | null;
  /** Corp's ucode lives in the `uid` column (NOT `u_code`). */
  ucode: string | null;
  active_status: string | null;
};

/** Auth employee row for the correction card (superset incl. ucode). */
type AuthRow = {
  id: string;
  short_code: string | null;
  company_code: string | null;
  name: string | null;
  mobile_no: string | null;
  cognito_id: string | null;
  ucode: string | null;
  active_status: string | null;
};

const CORP_SELECT = `
  SELECT
    empmaster_id::text AS empmaster_id,
    emp_shortcode,
    company_code::text AS company_code,
    emp_name,
    mobile_no::text AS mobile_no,
    cognito_id,
    uid::text AS ucode,
    active_status
  FROM public.empmaster_hdr`;

async function fetchCorpByMobile(
  environment: Environment,
  mobile10: string,
): Promise<CorpRow[]> {
  const pool = getPool({ environment, service: "corp", instance: null });
  const { rows } = await pool.query(
    `${CORP_SELECT} WHERE mobile_no = $1::numeric ORDER BY empmaster_id`,
    [mobile10],
  );
  return rows as CorpRow[];
}

async function fetchCorpById(
  environment: Environment,
  empmasterId: string,
): Promise<CorpRow | null> {
  const pool = getPool({ environment, service: "corp", instance: null });
  const { rows } = await pool.query(
    `${CORP_SELECT} WHERE empmaster_id = $1::integer`,
    [empmasterId],
  );
  return (rows[0] as CorpRow | undefined) ?? null;
}

async function fetchCorpByShortCode(
  environment: Environment,
  shortCode: string,
): Promise<CorpRow[]> {
  const pool = getPool({ environment, service: "corp", instance: null });
  const { rows } = await pool.query(
    `${CORP_SELECT} WHERE emp_shortcode = $1 ORDER BY empmaster_id`,
    [shortCode],
  );
  return rows as CorpRow[];
}

/** Auth records for the given short codes (no active filter — lookup target). */
async function fetchAuthByShortCodes(
  environment: Environment,
  shortCodes: string[],
): Promise<AuthRow[]> {
  if (shortCodes.length === 0) return [];
  const pool = getAuthPool(environment);
  const schema = authSchema(environment);
  // Schema is a validated identifier; the table name is a fixed constant.
  const { rows } = await pool.query(
    `SELECT
       id::text AS id,
       short_code,
       company_code::text AS company_code,
       name,
       mobile_no,
       cognito_id,
       ucode,
       active_status
     FROM "${schema}"."Field_Force_Users"
     WHERE short_code = ANY($1::text[])
     ORDER BY id`,
    [shortCodes],
  );
  return rows as AuthRow[];
}

/* ------------------------- Cognito resolution ------------------------- */

type CognitoResolution = {
  byMobile: CognitoUserInfo[];
  /** The single user whose custom:emp_short_code matches the corp short code. */
  target: CognitoUserInfo | null;
  /** Why no target could be resolved (when relevant). */
  blocker: string | null;
  error?: string;
};

function sameCode(a: string | null | undefined, b: string | null | undefined): boolean {
  return norm(a).toUpperCase() === norm(b).toUpperCase();
}

/**
 * Resolve the live Cognito user for a corp employee: look up by the corp
 * mobile, then require exactly one match on the corp short code. Both the
 * mobile (the lookup key) and the short code must agree with corp before a
 * user is treated as the target — a mobile shared across accounts can never
 * pick the wrong one.
 */
function resolveCognitoTarget(
  byMobile: CognitoUserInfo[],
  corpShortCode: string | null,
): { target: CognitoUserInfo | null; blocker: string | null } {
  if (byMobile.length === 0) {
    return { target: null, blocker: "No Cognito user found for the corp mobile number" };
  }
  const matches = byMobile.filter((u) => sameCode(u.emp_short_code, corpShortCode));
  if (matches.length === 1) return { target: matches[0], blocker: null };
  if (matches.length === 0) {
    return {
      target: null,
      blocker:
        byMobile.length === 1
          ? `Cognito user's short code (${norm(byMobile[0].emp_short_code) || "—"}) ≠ corp short code`
          : `${byMobile.length} Cognito users for this mobile, none matching the corp short code`,
    };
  }
  return {
    target: null,
    blocker: `${matches.length} Cognito users match both the mobile and the corp short code`,
  };
}

async function resolveCognito(
  environment: Environment,
  mobile10: string | null,
  corpShortCode: string | null,
): Promise<CognitoResolution> {
  try {
    const byMobile = mobile10 ? await lookupByMobile(environment, mobile10) : [];
    const { target, blocker } = resolveCognitoTarget(byMobile, corpShortCode);
    return { byMobile, target, blocker };
  } catch (e) {
    return {
      byMobile: [],
      target: null,
      blocker: "Cognito lookup failed",
      error: describeCognitoError(e),
    };
  }
}

/* --------------------- cognito_id duplicate guard --------------------- */

/**
 * Rows OTHER than the employee being corrected that already store the given
 * sub as their cognito_id — in corp `empmaster_hdr` and auth
 * `Field_Force_Users`. A cognito_id must identify exactly one record per
 * table; writing a sub that exists elsewhere would create a duplicate (this
 * happened once in production), so any hit blocks the fix.
 */
async function findCorrectionConflicts(
  environment: Environment,
  sub: string,
  excludeCorpId: string,
  excludeAuthId: string | null,
): Promise<CorrectionConflict[]> {
  const corpPool = getPool({ environment, service: "corp", instance: null });
  const authPool = getAuthPool(environment);
  const schema = authSchema(environment);

  const corpParams: unknown[] = [sub, excludeCorpId];
  const authParams: unknown[] = [sub];
  if (excludeAuthId) authParams.push(excludeAuthId);

  const [corpRes, authRes] = await Promise.all([
    corpPool.query(
      `SELECT empmaster_id::text AS id, emp_shortcode AS short_code,
              company_code::text AS company_code, emp_name AS name
       FROM public.empmaster_hdr
       WHERE cognito_id = $1 AND empmaster_id <> $2::integer
       ORDER BY empmaster_id`,
      corpParams,
    ),
    authPool.query(
      `SELECT id::text AS id, short_code, company_code::text AS company_code, name
       FROM "${schema}"."Field_Force_Users"
       WHERE cognito_id = $1${excludeAuthId ? " AND id <> $2::integer" : ""}
       ORDER BY id`,
      authParams,
    ),
  ]);

  return [
    ...corpRes.rows.map(
      (r): CorrectionConflict => ({
        source: "corp",
        id: r.id,
        shortCode: r.short_code,
        companyCode: r.company_code,
        name: r.name,
      }),
    ),
    ...authRes.rows.map(
      (r): CorrectionConflict => ({
        source: "auth",
        id: r.id,
        shortCode: r.short_code,
        companyCode: r.company_code,
        name: r.name,
      }),
    ),
  ];
}

/**
 * Set cognito_id to NULL on the listed corp/auth records. Each UPDATE carries
 * an `AND cognito_id = <sub>` predicate so a concurrently-corrected row is
 * never clobbered. Returns the number of rows actually cleared.
 */
async function releaseSubFromRecords(
  environment: Environment,
  sub: string,
  records: CorrectionConflict[],
): Promise<number> {
  const corpIds = records.filter((c) => c.source === "corp").map((c) => c.id);
  const authIds = records.filter((c) => c.source === "auth").map((c) => c.id);
  let cleared = 0;
  if (corpIds.length > 0) {
    const pool = getPool({ environment, service: "corp", instance: null });
    const res = await pool.query(
      `UPDATE public.empmaster_hdr SET cognito_id = NULL
       WHERE empmaster_id = ANY($1::integer[]) AND cognito_id = $2`,
      [corpIds, sub],
    );
    cleared += res.rowCount ?? 0;
  }
  if (authIds.length > 0) {
    const pool = getAuthPool(environment);
    const schema = authSchema(environment);
    const res = await pool.query(
      `UPDATE "${schema}"."Field_Force_Users" SET cognito_id = NULL
       WHERE id = ANY($1::integer[]) AND cognito_id = $2`,
      [authIds, sub],
    );
    cleared += res.rowCount ?? 0;
  }
  return cleared;
}

/* ---------------------- stored-sub owner resolution ---------------------- */

/**
 * Look each stored cognito_id (corp / auth) up in Cognito BY SUB — needed when
 * the mobile lookup resolves nothing: the stored sub may be stale (no Cognito
 * user) or belong to an entirely different user. A sub is `wrong` when it is
 * confirmed stale or its owner matches NEITHER the corp short code NOR the
 * corp mobile; a lookup error leaves `wrong` false (never clear on
 * uncertainty). An owner holding the corp mobile is never "wrong" — the
 * stored corp/auth linkage plus the matching phone are two independent
 * signals the account is this employee's (only its attributes are stale).
 * Shared by analyze (display + action flags) and the apply functions so they
 * can't disagree.
 */
async function resolveStoredSubOwners(
  environment: Environment,
  corpStored: string,
  authStored: string,
  targetSub: string,
  corpShortCode: string | null,
  corpMobile10: string | null,
): Promise<CorrectionStoredSubOwner[]> {
  const bySub = new Map<string, ("corp" | "auth")[]>();
  if (corpStored && corpStored !== targetSub) bySub.set(corpStored, ["corp"]);
  if (authStored && authStored !== targetSub) {
    const existing = bySub.get(authStored);
    if (existing) existing.push("auth");
    else bySub.set(authStored, ["auth"]);
  }

  const owners: CorrectionStoredSubOwner[] = [];
  for (const [sub, sources] of bySub) {
    try {
      const users = await lookupBySub(environment, sub);
      const user = users[0] ?? null;
      const phoneMatchesCorp =
        user !== null &&
        corpMobile10 !== null &&
        normalizeMobile(user.phone_number) === corpMobile10;
      owners.push({
        sub,
        sources,
        user,
        phoneMatchesCorp,
        wrong:
          user === null ||
          (!sameCode(user.emp_short_code, corpShortCode) && !phoneMatchesCorp),
      });
    } catch (e) {
      owners.push({
        sub,
        sources,
        user: null,
        phoneMatchesCorp: false,
        wrong: false,
        error: describeCognitoError(e),
      });
    }
  }
  return owners;
}

/** Why a stored sub is wrong — used in statuses and the clear preview. */
function describeWrongSub(owner: CorrectionStoredSubOwner): string {
  if (owner.user === null) return "not found in Cognito (stale)";
  const bits = [
    norm(owner.user.emp_short_code) || "no short code",
    displayMobile10(owner.user.phone_number) ?? "no mobile",
  ];
  return `belongs to a different Cognito user (${bits.join(", ")})`;
}

function describeConflicts(conflicts: CorrectionConflict[]): string {
  return conflicts
    .map((c) => {
      const bits = [
        norm(c.shortCode) || "—",
        c.companyCode ? `company ${norm(c.companyCode)}` : null,
        norm(c.name) || null,
      ].filter(Boolean);
      return `${c.source === "corp" ? "corp empmaster" : "auth record"} ${c.id} (${bits.join(", ")})`;
    })
    .join("; ");
}

/* ------------------------- auth-sync drift ------------------------- */

/**
 * Auth columns that drifted from corp (corp = truth) and what the sync would
 * write. Shared by analyze (to decide whether to offer the action) and by
 * `syncAuthFromCorp` (to apply it) so the two can never disagree. Uses the
 * same tolerant comparisons as the display: canonical names (so an
 * encoding-damaged corp name is NOT copied over a clean auth one), last-10
 * mobiles, case-insensitive ucodes.
 */
function computeAuthSyncChanges(corp: CorpRow, auth: AuthRow): CorrectionSyncChange[] {
  const changes: CorrectionSyncChange[] = [];
  if (normalizeName(auth.name) !== normalizeName(corp.emp_name)) {
    changes.push({
      column: "name",
      label: "Name",
      before: auth.name,
      after: norm(corp.emp_name) || null,
    });
  }
  if (normalizeMobile(auth.mobile_no) !== normalizeMobile(corp.mobile_no)) {
    changes.push({
      column: "mobile_no",
      label: "Mobile",
      before: auth.mobile_no,
      after: normalizeMobile(corp.mobile_no),
    });
  }
  if (!sameCode(auth.ucode, corp.ucode)) {
    changes.push({
      column: "ucode",
      label: "Ucode",
      before: auth.ucode,
      after: norm(corp.ucode).toLowerCase() || null,
    });
  }
  return changes;
}

/* ------------------------------ analyze ------------------------------ */

function field(
  key: string,
  label: string,
  corpValue: string | null,
  auth: { value: string | null; present: boolean; mismatch: boolean },
  cognito: { value: string | null; present: boolean; mismatch: boolean },
  corpMismatch = false,
): CorrectionField {
  return {
    key,
    label,
    corp: { value: corpValue, mismatch: corpMismatch },
    auth,
    cognito,
  };
}

function buildEmployee(
  corp: CorpRow,
  authMatches: AuthRow[],
  cog: CognitoResolution,
): CorrectionEmployee {
  const auth = authMatches[0] ?? null;
  const presentInAuth = auth !== null;
  const target = cog.target;
  const sub = target ? norm(target.sub) : "";

  const authVal = (
    value: string | null | undefined,
    mismatch: boolean,
  ): CorrectionField["auth"] => ({
    value: value ?? null,
    present: presentInAuth,
    mismatch: presentInAuth && mismatch,
  });
  const cogVal = (
    value: string | null | undefined,
    mismatch: boolean,
  ): CorrectionField["cognito"] => ({
    value: value ?? null,
    present: target !== null,
    mismatch: target !== null && mismatch,
  });

  // Ucodes are shown lowercased for uniformity — Cognito stores them in
  // uppercase, corp/auth in lowercase; the comparison is case-insensitive.
  const lcUcode = (v: string | null | undefined): string | null => {
    const s = norm(v);
    return s ? s.toLowerCase() : null;
  };

  // Corp is the truth for short code / mobile / name / ucode. The auth record
  // is matched BY (short code, company code), so its short code can only
  // mismatch by being absent. Names compare on their canonical form
  // (lowercase, special characters stripped) so encoding damage like a
  // trailing "�" doesn't flag a diff. Cognito is the truth for cognito_id:
  // there the corp/auth stored values are the ones flagged.
  const fields: CorrectionField[] = [
    field(
      "shortCode",
      "Short code",
      corp.emp_shortcode,
      authVal(auth?.short_code, false),
      cogVal(target?.emp_short_code, !sameCode(target?.emp_short_code, corp.emp_shortcode)),
    ),
    field(
      "name",
      "Name",
      corp.emp_name,
      authVal(auth?.name, normalizeName(auth?.name) !== normalizeName(corp.emp_name)),
      cogVal(target?.name, normalizeName(target?.name) !== normalizeName(corp.emp_name)),
    ),
    field(
      "mobile",
      "Mobile",
      corp.mobile_no,
      authVal(auth?.mobile_no, normalizeMobile(auth?.mobile_no) !== normalizeMobile(corp.mobile_no)),
      cogVal(
        // Display without the +91 country code Cognito stores.
        target ? displayMobile10(target.phone_number) : null,
        normalizeMobile(target?.phone_number) !== normalizeMobile(corp.mobile_no),
      ),
    ),
    field(
      "ucode",
      "Ucode",
      lcUcode(corp.ucode),
      authVal(lcUcode(auth?.ucode), !sameCode(auth?.ucode, corp.ucode)),
      cogVal(lcUcode(target?.ucode), !sameCode(target?.ucode, corp.ucode)),
    ),
    field(
      "cognitoId",
      "Cognito ID",
      corp.cognito_id,
      authVal(auth?.cognito_id, sub !== "" && norm(auth?.cognito_id) !== sub),
      cogVal(target?.sub, false),
      sub !== "" && norm(corp.cognito_id) !== sub,
    ),
  ];

  const cognitoIdField = fields[fields.length - 1];
  const cognitoIdNeedsFix =
    sub !== "" && (cognitoIdField.corp.mismatch || cognitoIdField.auth.mismatch);

  const blockers: string[] = [];
  if (cog.error) blockers.push(cog.error);
  if (cog.blocker && !cog.error) blockers.push(cog.blocker);
  if (authMatches.length > 1) {
    blockers.push(
      `${authMatches.length} auth records match (short code, company code) — fix blocked, resolve the duplicate first`,
    );
  }

  const statuses: string[] = [];
  if (!presentInAuth) statuses.push("Missing in auth");
  for (const f of fields) {
    if (f.key === "cognitoId") continue;
    if (f.auth.mismatch) statuses.push(`${f.label} ≠ corp (auth)`);
    if (f.cognito.mismatch) statuses.push(`${f.label} ≠ corp (cognito)`);
  }
  if (cognitoIdField.corp.mismatch) statuses.push("corp cognito_id ≠ Cognito");
  if (cognitoIdField.auth.mismatch) statuses.push("auth cognito_id ≠ Cognito");

  let fixBlockedReason: string | undefined;
  if (cognitoIdNeedsFix) {
    if (!presentInAuth) {
      fixBlockedReason = "Create the employee in auth first, then re-check";
    } else if (authMatches.length > 1) {
      fixBlockedReason = "Multiple auth records match — resolve the duplicate first";
    }
  }
  // When sub === "" but a cognito_id is stored somewhere, the analyze
  // post-pass looks the stored sub(s) up in Cognito by sub and pushes
  // precise statuses (stale / different owner) + the clear action.

  // Auth-side drift on an EXISTING record (name / mobile / ucode) is fixed by
  // a direct sync from corp. Cognito-side name/ucode drift is surfaced but
  // never auto-corrected — that would mutate login-critical Cognito
  // attributes, which this tool deliberately doesn't do.
  const syncChanges = auth ? computeAuthSyncChanges(corp, auth) : [];
  const syncNeeded = syncChanges.length > 0;
  const syncBlockedReason =
    syncNeeded && authMatches.length > 1
      ? "Multiple auth records match — resolve the duplicate first"
      : undefined;
  const cognitoAttributeDrift = fields.some(
    (f) => (f.key === "name" || f.key === "ucode") && f.cognito.mismatch,
  );

  const consistent =
    presentInAuth && statuses.length === 0 && blockers.length === 0;

  return {
    empmasterId: corp.empmaster_id,
    streamId: `employee_${corp.empmaster_id}`,
    shortCode: norm(corp.emp_shortcode),
    companyCode: norm(corp.company_code),
    activeStatus: corp.active_status,
    presentInAuth,
    authId: auth?.id ?? null,
    authMatchCount: authMatches.length,
    cognitoTarget: target,
    cognitoByMobileCount: cog.byMobile.length,
    // Filled by the analyze post-pass (needs async Cognito lookups).
    storedSubOwners: [],
    fields,
    actions: {
      createInAuth: !presentInAuth,
      fixCognitoId: cognitoIdNeedsFix && presentInAuth && authMatches.length <= 1,
      fixCognitoIdBlockedReason: fixBlockedReason,
      syncAuthFromCorp: syncNeeded && !syncBlockedReason,
      syncAuthBlockedReason: syncBlockedReason,
      cognitoAttributeDrift,
      // Set by the analyze post-pass when the live sub is found duplicated.
      releaseDuplicateCognitoId: false,
      // Set by the analyze post-pass when the stored sub is stale/foreign.
      clearWrongCognitoId: false,
      // Set by the analyze post-pass when the stored sub's owner matches the
      // corp short code but holds a different mobile in Cognito.
      fixCognitoPhone: false,
      // Set by the analyze post-pass when the stored sub's owner holds the
      // corp mobile but its short code / name attributes are stale.
      reassignCognitoOwner: false,
    },
    blockers,
    statuses,
    consistent,
    cognitoError: cog.error,
  };
}

/** Corp-first analysis of every corp employee holding the given mobile. */
export async function analyzeByMobile(
  environment: Environment,
  mobileInput: string,
): Promise<CorrectionAnalyzeResult> {
  const mobile10 = normalizeMobile(mobileInput);
  if (!mobile10 || mobile10.length !== 10) {
    return {
      ok: false,
      message: "Enter a valid 10-digit mobile number.",
      environment,
      mobile10: mobile10 ?? "",
      employees: [],
    };
  }

  const corpRows = await fetchCorpByMobile(environment, mobile10);
  if (corpRows.length === 0) {
    return {
      ok: true,
      message: `No corp employee found for ${mobile10}. Corp is the source of truth — nothing to correct against.`,
      environment,
      mobile10,
      employees: [],
    };
  }

  const shortCodes = Array.from(
    new Set(corpRows.map((r) => norm(r.emp_shortcode)).filter(Boolean)),
  );
  const [authRows, cognitoByMobile] = await Promise.all([
    fetchAuthByShortCodes(environment, shortCodes),
    resolveCognitoByMobileOnce(environment, mobile10),
  ]);

  const authByKey = new Map<string, AuthRow[]>();
  for (const r of authRows) {
    const k = pairKey(r.short_code, r.company_code);
    (authByKey.get(k) ?? authByKey.set(k, []).get(k)!).push(r);
  }

  const employees = corpRows.map((corp) => {
    const matches = authByKey.get(pairKey(corp.emp_shortcode, corp.company_code)) ?? [];
    const resolution: CognitoResolution = cognitoByMobile.error
      ? {
          byMobile: [],
          target: null,
          blocker: "Cognito lookup failed",
          error: cognitoByMobile.error,
        }
      : {
          byMobile: cognitoByMobile.users,
          ...resolveCognitoTarget(cognitoByMobile.users, corp.emp_shortcode),
        };
    return buildEmployee(corp, matches, resolution);
  });

  // Duplicate guard: the resolved live sub must not be stored on any OTHER
  // corp/auth record. Surfaced here so the operator sees the conflict before
  // ever reaching the fix button (which is disabled with the reason).
  for (const emp of employees) {
    const sub = norm(emp.cognitoTarget?.sub);
    if (!sub) continue;
    const conflicts = await findCorrectionConflicts(
      environment,
      sub,
      emp.empmasterId,
      emp.authId,
    );
    if (conflicts.length > 0) {
      emp.blockers.push(
        `Cognito sub is also stored on: ${describeConflicts(conflicts)} — a cognito_id must identify exactly one record`,
      );
      // Offer to NULL the sub on the other records — this employee is its
      // verified owner (matched by corp mobile + short code).
      emp.actions.releaseDuplicateCognitoId = true;
      if (emp.actions.fixCognitoId) {
        emp.actions.fixCognitoId = false;
        emp.actions.fixCognitoIdBlockedReason =
          "The live sub is already stored on another record — release the duplicate first";
      }
      emp.consistent = false;
    }
  }

  // Stored-sub audit: every stored cognito_id that differs from the resolved
  // target is looked up in Cognito BY SUB, so the operator sees whether it is
  // stale or belongs to a different user entirely. When NO rightful Cognito
  // user exists for this employee and every stored sub is confirmed wrong,
  // the clear action is offered.
  for (const emp of employees) {
    const targetSub = norm(emp.cognitoTarget?.sub);
    const idField = emp.fields.find((f) => f.key === "cognitoId");
    const owners = await resolveStoredSubOwners(
      environment,
      norm(idField?.corp.value),
      norm(idField?.auth.value),
      targetSub,
      emp.shortCode,
      mobile10,
    );
    emp.storedSubOwners = owners;
    if (owners.length === 0) continue;

    for (const o of owners) {
      const sides = o.sources.join(" + ");
      if (o.error) {
        emp.statuses.push(
          `Stored cognito_id (${sides}) could not be validated — Cognito lookup error`,
        );
      } else if (o.wrong) {
        emp.statuses.push(`${sides} cognito_id ${describeWrongSub(o)}`);
      } else if (
        o.phoneMatchesCorp &&
        !sameCode(o.user?.emp_short_code, emp.shortCode)
      ) {
        // The account holds THIS employee's corp mobile but its short code
        // (the identity anchor — never rewritten) says it belongs to another
        // employee. Fixable by returning the account to that owner: its
        // Cognito mobile is corrected from the OWNER's corp record, its sub
        // written to the owner's corp/auth, and the stale link here cleared.
        emp.statuses.push(
          `${sides} cognito_id's account holds the corp mobile but its short code is ${norm(o.user?.emp_short_code) || "—"} (${norm(o.user?.name) || "—"}) — it belongs to that employee and can be returned to them`,
        );
        if (!targetSub) emp.actions.reassignCognitoOwner = true;
      } else {
        // Owner matches the corp short code but wasn't found by the corp
        // mobile — the Cognito phone_number is outdated. Fixable by pushing
        // the corp mobile to Cognito.
        emp.statuses.push(
          `${sides} cognito_id belongs to a matching user whose Cognito mobile is ${displayMobile10(o.user?.phone_number) ?? "—"} — corp mobile can be pushed to Cognito`,
        );
        if (!targetSub) emp.actions.fixCognitoPhone = true;
      }
    }
    if (!targetSub && owners.some((o) => o.wrong)) {
      emp.actions.clearWrongCognitoId = true;
    }
    emp.consistent = false;
  }

  const needFix = employees.filter((e) => !e.consistent).length;
  return {
    ok: true,
    message: `Found ${employees.length} corp employee${employees.length === 1 ? "" : "s"} for ${mobile10} — ${needFix === 0 ? "all consistent with auth and Cognito" : `${needFix} needing attention`}.`,
    environment,
    mobile10,
    employees,
  };
}

/** One ListUsers-by-mobile call shared across all corp rows of the mobile. */
async function resolveCognitoByMobileOnce(
  environment: Environment,
  mobile10: string,
): Promise<{ users: CognitoUserInfo[]; error?: string }> {
  try {
    return { users: await lookupByMobile(environment, mobile10) };
  } catch (e) {
    return { users: [], error: describeCognitoError(e) };
  }
}

/* ------------------------- action 1: replay ------------------------- */

/**
 * Replay the corp `employee_<empmasterId>` event stream onto the V1 auth
 * consumer queue so the auth-backend re-creates the user. Rows are sent
 * verbatim (JSON of the `SELECT *` row) in timestamp order with
 * `MessageGroupId = streamId`, mirroring the proven manual script and the
 * SDK's SNS publishing. Preview returns the event list without sending.
 * A run is refused while the employee already exists in auth — the replay
 * is strictly the "missing in auth" recovery path.
 */
export async function replayEmployeeStream(
  environment: Environment,
  empmasterId: string,
  preview: boolean,
): Promise<CorrectionReplayResult> {
  const corp = await fetchCorpById(environment, empmasterId);
  if (!corp) {
    return {
      ok: false,
      message: `No corp employee with empmaster_id ${empmasterId}.`,
      streamId: `employee_${empmasterId}`,
      totalEvents: 0,
      events: [],
      sent: 0,
      errors: [],
      preview,
    };
  }
  const streamId = `employee_${corp.empmaster_id}`;

  const pool = getPool({ environment, service: "corp", instance: null });
  const { rows } = await pool.query(
    `SELECT * FROM public.events
     WHERE "eventStreamStreamId" = $1
     ORDER BY timestamp, "eventId"`,
    [streamId],
  );

  const summaries: CorrectionEventSummary[] = rows.map((r) => ({
    eventId: String(r.eventId),
    event_type: String(r.event_type ?? ""),
    timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : (r.timestamp ?? null),
  }));

  if (rows.length === 0) {
    return {
      ok: false,
      message: `No events found on stream ${streamId} — the user cannot be re-created from event history.`,
      streamId,
      totalEvents: 0,
      events: [],
      sent: 0,
      errors: [],
      preview,
    };
  }

  if (preview) {
    return {
      ok: true,
      message: `${rows.length} event${rows.length === 1 ? "" : "s"} on stream ${streamId} would be replayed to the auth queue (in timestamp order).`,
      streamId,
      totalEvents: rows.length,
      events: summaries,
      sent: 0,
      errors: [],
      preview: true,
    };
  }

  // Refuse a live run when the employee already exists in auth — replaying
  // EMPLOYEE_ADD onto an existing user risks duplicates in auth.
  const existing = await fetchAuthByShortCodes(
    environment,
    [norm(corp.emp_shortcode)].filter(Boolean),
  );
  const alreadyPresent = existing.some(
    (a) =>
      pairKey(a.short_code, a.company_code) ===
      pairKey(corp.emp_shortcode, corp.company_code),
  );
  if (alreadyPresent) {
    return {
      ok: false,
      message: `Employee ${norm(corp.emp_shortcode)} already exists in auth — replay is only for employees missing in auth.`,
      streamId,
      totalEvents: rows.length,
      events: summaries,
      sent: 0,
      errors: [],
      preview: false,
    };
  }

  // Sequential sends: FIFO ordering within the group follows send order.
  let sent = 0;
  const errors: { eventId: string; reason: string }[] = [];
  for (const row of rows) {
    const outcome = await sendAuthQueueMessage(
      environment,
      JSON.stringify(row),
      streamId,
    );
    if (outcome.kind === "success") {
      sent += 1;
    } else {
      errors.push({ eventId: String(row.eventId), reason: outcome.reason });
    }
  }

  return {
    ok: errors.length === 0,
    message:
      errors.length === 0
        ? `Replayed ${sent}/${rows.length} events on ${streamId} to the auth queue. The consumer processes them shortly — re-check to confirm the user appears in auth.`
        : `Sent ${sent}/${rows.length} events on ${streamId}; ${errors.length} failed.`,
    streamId,
    totalEvents: rows.length,
    events: summaries,
    sent,
    errors,
    preview: false,
  };
}

/* ----------------------- action 2: fix cognito_id ----------------------- */

/**
 * Write the live Cognito sub (resolved by corp mobile, guarded by corp short
 * code) into corp `empmaster_hdr.cognito_id` and auth
 * `Field_Force_Users.cognito_id`. Everything is re-derived server-side from
 * `empmasterId`; preview reports what would change without writing.
 */
export async function fixCognitoId(
  environment: Environment,
  empmasterId: string,
  preview: boolean,
): Promise<CorrectionFixResult> {
  const fail = (message: string): CorrectionFixResult => ({
    ok: false,
    message,
    sub: "",
    corp: { empmasterId, before: null, needsUpdate: false, updated: false },
    auth: { id: "", before: null, needsUpdate: false, updated: false },
    preview,
  });

  const corp = await fetchCorpById(environment, empmasterId);
  if (!corp) return fail(`No corp employee with empmaster_id ${empmasterId}.`);

  const mobile10 = normalizeMobile(corp.mobile_no);
  if (!mobile10) return fail("Corp employee has no mobile number — cannot resolve the Cognito user.");

  const authMatches = (
    await fetchAuthByShortCodes(environment, [norm(corp.emp_shortcode)].filter(Boolean))
  ).filter(
    (a) =>
      pairKey(a.short_code, a.company_code) ===
      pairKey(corp.emp_shortcode, corp.company_code),
  );
  if (authMatches.length === 0) {
    return fail(
      "Employee is missing in auth — run “Create in auth” first, confirm it landed, then fix the cognito_id.",
    );
  }
  if (authMatches.length > 1) {
    return fail(
      `${authMatches.length} auth records match (short code, company code) — resolve the duplicate before fixing.`,
    );
  }
  const auth = authMatches[0];

  const cog = await resolveCognito(environment, mobile10, corp.emp_shortcode);
  if (cog.error) return fail(cog.error);
  if (!cog.target || !norm(cog.target.sub)) {
    return fail(cog.blocker ?? "No Cognito user could be resolved for this employee.");
  }
  const sub = norm(cog.target.sub);

  // Duplicate guard (hard, on preview AND run): never write a sub that any
  // OTHER corp/auth record already stores — a cognito_id must identify
  // exactly one record per table.
  const conflicts = await findCorrectionConflicts(
    environment,
    sub,
    corp.empmaster_id,
    auth.id,
  );
  if (conflicts.length > 0) {
    return fail(
      `Refusing to write cognito_id ${sub}: it is already stored on ${describeConflicts(conflicts)}. Resolve those records first.`,
    );
  }

  const corpNeeds = norm(corp.cognito_id) !== sub;
  const authNeeds = norm(auth.cognito_id) !== sub;
  const result: CorrectionFixResult = {
    ok: true,
    message: "",
    sub,
    corp: {
      empmasterId: corp.empmaster_id,
      before: corp.cognito_id,
      needsUpdate: corpNeeds,
      updated: false,
    },
    auth: { id: auth.id, before: auth.cognito_id, needsUpdate: authNeeds, updated: false },
    preview,
  };

  if (!corpNeeds && !authNeeds) {
    result.message = `cognito_id already matches the live Cognito sub (${sub}) in both corp and auth — nothing to update.`;
    return result;
  }
  if (preview) {
    const targets = [corpNeeds && "corp", authNeeds && "auth"].filter(Boolean).join(" + ");
    result.message = `Would set cognito_id = ${sub} in ${targets} (Cognito user matched by corp mobile + short code ${norm(corp.emp_shortcode)}).`;
    return result;
  }

  if (corpNeeds) {
    const pool = getPool({ environment, service: "corp", instance: null });
    await pool.query(
      `UPDATE public.empmaster_hdr SET cognito_id = $1 WHERE empmaster_id = $2::integer`,
      [sub, corp.empmaster_id],
    );
    result.corp.updated = true;
  }
  if (authNeeds) {
    const pool = getAuthPool(environment);
    const schema = authSchema(environment);
    await pool.query(
      `UPDATE "${schema}"."Field_Force_Users" SET cognito_id = $1 WHERE id = $2::integer`,
      [sub, auth.id],
    );
    result.auth.updated = true;
  }
  const did = [result.corp.updated && "corp", result.auth.updated && "auth"]
    .filter(Boolean)
    .join(" + ");
  result.message = `Updated cognito_id to ${sub} in ${did}.`;
  return result;
}

/* ---------------------- action 3: sync auth from corp ---------------------- */

/** Auth columns the sync may touch — fixed allow-list, never client input. */
const SYNCABLE_COLUMNS = new Set(["name", "mobile_no", "ucode"]);

/**
 * Copy corp-truth values (name / mobile / ucode) onto an EXISTING auth record
 * that drifted. Only the columns that actually differ (per the same tolerant
 * comparisons the analysis shows) are written, in one parameterized UPDATE.
 * Everything is re-derived server-side from `empmasterId`; preview reports
 * the before → after per column without writing.
 */
export async function syncAuthFromCorp(
  environment: Environment,
  empmasterId: string,
  preview: boolean,
): Promise<CorrectionSyncResult> {
  const fail = (message: string): CorrectionSyncResult => ({
    ok: false,
    message,
    authId: "",
    changes: [],
    updated: false,
    preview,
  });

  const corp = await fetchCorpById(environment, empmasterId);
  if (!corp) return fail(`No corp employee with empmaster_id ${empmasterId}.`);

  const authMatches = (
    await fetchAuthByShortCodes(environment, [norm(corp.emp_shortcode)].filter(Boolean))
  ).filter(
    (a) =>
      pairKey(a.short_code, a.company_code) ===
      pairKey(corp.emp_shortcode, corp.company_code),
  );
  if (authMatches.length === 0) {
    return fail(
      "Employee is missing in auth — run “Create in auth” instead; the replay carries the corp values.",
    );
  }
  if (authMatches.length > 1) {
    return fail(
      `${authMatches.length} auth records match (short code, company code) — resolve the duplicate before syncing.`,
    );
  }
  const auth = authMatches[0];

  const changes = computeAuthSyncChanges(corp, auth).filter((c) =>
    SYNCABLE_COLUMNS.has(c.column),
  );
  if (changes.length === 0) {
    return {
      ok: true,
      message: "Auth already matches corp on name, mobile and ucode — nothing to sync.",
      authId: auth.id,
      changes: [],
      updated: false,
      preview,
    };
  }

  if (preview) {
    return {
      ok: true,
      message: `Would update ${changes.map((c) => c.label.toLowerCase()).join(", ")} on the auth record from corp.`,
      authId: auth.id,
      changes,
      updated: false,
      preview: true,
    };
  }

  const pool = getAuthPool(environment);
  const schema = authSchema(environment);
  // Column names come from the fixed allow-list above; values parameterized.
  const sets = changes.map((c, i) => `"${c.column}" = $${i + 1}`).join(", ");
  const params: unknown[] = changes.map((c) => c.after);
  params.push(auth.id);
  await pool.query(
    `UPDATE "${schema}"."Field_Force_Users" SET ${sets} WHERE id = $${params.length}::integer`,
    params,
  );

  return {
    ok: true,
    message: `Updated ${changes.map((c) => c.label.toLowerCase()).join(", ")} on auth record ${auth.id} from corp.`,
    authId: auth.id,
    changes,
    updated: true,
    preview: false,
  };
}

/* ------------------ action 4: release duplicate cognito_id ------------------ */

/**
 * NULL the cognito_id on every OTHER corp/auth record that stores this
 * employee's live sub. The employee analyzed is the sub's verified owner
 * (the Cognito user is resolved by corp mobile + short-code guard), so any
 * other record holding it is stale — e.g. an old/vacancy record the sub was
 * once written to. The run clears a row only while it STILL holds that exact
 * sub (`AND cognito_id = $sub`), so a concurrently-corrected record is never
 * clobbered. Preview lists the records without writing.
 */
export async function releaseDuplicateCognitoId(
  environment: Environment,
  empmasterId: string,
  preview: boolean,
): Promise<CorrectionReleaseResult> {
  const fail = (message: string): CorrectionReleaseResult => ({
    ok: false,
    message,
    sub: "",
    conflicts: [],
    cleared: 0,
    preview,
  });

  const corp = await fetchCorpById(environment, empmasterId);
  if (!corp) return fail(`No corp employee with empmaster_id ${empmasterId}.`);

  const mobile10 = normalizeMobile(corp.mobile_no);
  if (!mobile10) return fail("Corp employee has no mobile number — cannot resolve the Cognito user.");

  const authMatches = (
    await fetchAuthByShortCodes(environment, [norm(corp.emp_shortcode)].filter(Boolean))
  ).filter(
    (a) =>
      pairKey(a.short_code, a.company_code) ===
      pairKey(corp.emp_shortcode, corp.company_code),
  );
  if (authMatches.length > 1) {
    return fail(
      `${authMatches.length} auth records match (short code, company code) — resolve the duplicate manually.`,
    );
  }
  const auth = authMatches[0] ?? null;

  const cog = await resolveCognito(environment, mobile10, corp.emp_shortcode);
  if (cog.error) return fail(cog.error);
  if (!cog.target || !norm(cog.target.sub)) {
    return fail(cog.blocker ?? "No Cognito user could be resolved for this employee.");
  }
  const sub = norm(cog.target.sub);

  const conflicts = await findCorrectionConflicts(
    environment,
    sub,
    corp.empmaster_id,
    auth?.id ?? null,
  );
  if (conflicts.length === 0) {
    return {
      ok: true,
      message: `No other record stores ${sub} — nothing to release.`,
      sub,
      conflicts: [],
      cleared: 0,
      preview,
    };
  }

  if (preview) {
    return {
      ok: true,
      message: `Would set cognito_id to NULL on ${conflicts.length} record${conflicts.length === 1 ? "" : "s"} so that ${norm(corp.emp_shortcode)} remains the sub's only holder.`,
      sub,
      conflicts,
      cleared: 0,
      preview: true,
    };
  }

  const cleared = await releaseSubFromRecords(environment, sub, conflicts);

  return {
    ok: true,
    message: `Cleared cognito_id on ${cleared} record${cleared === 1 ? "" : "s"} — ${norm(corp.emp_shortcode)} is now the only holder of ${sub}.`,
    sub,
    conflicts,
    cleared,
    preview: false,
  };
}

/* ------------------- action 5: clear wrong cognito_id ------------------- */

/**
 * NULL the cognito_id stored on THIS employee's corp/auth records when it is
 * confirmed wrong — either the sub no longer exists in Cognito (stale) or it
 * belongs to a different user (its owner's `custom:emp_short_code` ≠ corp
 * short code). Only offered/applied when NO rightful Cognito user resolves
 * for this employee (if one does, `fixCognitoId` overwrites instead of
 * clearing). Only the wrong side(s) are touched, and each UPDATE carries an
 * `AND cognito_id = <sub>` predicate so a concurrently-corrected row is never
 * clobbered. A Cognito lookup error never clears anything.
 */
export async function clearWrongCognitoId(
  environment: Environment,
  empmasterId: string,
  preview: boolean,
): Promise<CorrectionClearResult> {
  const fail = (message: string): CorrectionClearResult => ({
    ok: false,
    message,
    targets: [],
    cleared: 0,
    preview,
  });

  const corp = await fetchCorpById(environment, empmasterId);
  if (!corp) return fail(`No corp employee with empmaster_id ${empmasterId}.`);

  const authMatches = (
    await fetchAuthByShortCodes(environment, [norm(corp.emp_shortcode)].filter(Boolean))
  ).filter(
    (a) =>
      pairKey(a.short_code, a.company_code) ===
      pairKey(corp.emp_shortcode, corp.company_code),
  );
  if (authMatches.length > 1) {
    return fail(
      `${authMatches.length} auth records match (short code, company code) — resolve the duplicate manually.`,
    );
  }
  const auth = authMatches[0] ?? null;

  const mobile10 = normalizeMobile(corp.mobile_no);
  const cog = await resolveCognito(environment, mobile10, corp.emp_shortcode);
  if (cog.error) return fail(cog.error);
  if (cog.target && norm(cog.target.sub)) {
    return fail(
      "A live Cognito user was resolved for this employee — use “Fix cognito_id in corp + auth” instead of clearing.",
    );
  }

  const corpStored = norm(corp.cognito_id);
  const authStored = norm(auth?.cognito_id);
  if (!corpStored && !authStored) {
    return {
      ok: true,
      message: "No cognito_id is stored on this employee — nothing to clear.",
      targets: [],
      cleared: 0,
      preview,
    };
  }

  const owners = await resolveStoredSubOwners(
    environment,
    corpStored,
    authStored,
    "",
    corp.emp_shortcode,
    mobile10,
  );
  const lookupError = owners.find((o) => o.error);
  if (lookupError) return fail(lookupError.error!);

  const targets: CorrectionClearResult["targets"] = [];
  for (const o of owners) {
    if (!o.wrong) continue;
    const reason = describeWrongSub(o);
    for (const source of o.sources) {
      if (source === "corp") {
        targets.push({ source, id: corp.empmaster_id, sub: o.sub, reason });
      } else if (auth) {
        targets.push({ source, id: auth.id, sub: o.sub, reason });
      }
    }
  }
  if (targets.length === 0) {
    return fail(
      "The stored cognito_id belongs to a Cognito user matching this employee's short code or mobile — use “Update Cognito mobile from corp” / “Sync Cognito details from corp” instead of clearing.",
    );
  }

  if (preview) {
    return {
      ok: true,
      message: `Would set cognito_id to NULL on ${targets.length} record${targets.length === 1 ? "" : "s"} of ${norm(corp.emp_shortcode)} (the stored sub is not this employee's).`,
      targets,
      cleared: 0,
      preview: true,
    };
  }

  let cleared = 0;
  for (const t of targets) {
    if (t.source === "corp") {
      const pool = getPool({ environment, service: "corp", instance: null });
      const res = await pool.query(
        `UPDATE public.empmaster_hdr SET cognito_id = NULL
         WHERE empmaster_id = $1::integer AND cognito_id = $2`,
        [t.id, t.sub],
      );
      cleared += res.rowCount ?? 0;
    } else {
      const pool = getAuthPool(environment);
      const schema = authSchema(environment);
      const res = await pool.query(
        `UPDATE "${schema}"."Field_Force_Users" SET cognito_id = NULL
         WHERE id = $1::integer AND cognito_id = $2`,
        [t.id, t.sub],
      );
      cleared += res.rowCount ?? 0;
    }
  }

  return {
    ok: true,
    message: `Cleared the wrong cognito_id on ${cleared} record${cleared === 1 ? "" : "s"} of ${norm(corp.emp_shortcode)}. If this employee should have a Cognito account, it must be signed up / corrected separately; to fix the sub's real owner, analyze their mobile number.`,
    targets,
    cleared,
    preview: false,
  };
}

/* ------------------ action 6: update Cognito mobile from corp ------------------ */

/**
 * Push the corp mobile onto the employee's Cognito user when the stored
 * cognito_id's owner MATCHES the corp short code but holds a different
 * phone_number (so the mobile lookup couldn't resolve it). Mirrors
 * auth-backend's own `updateCognitoUserPhoneNumber` (phone_number +91… +
 * phone_number_verified) — the tool's only Cognito write. Guards:
 *   - refused when a Cognito user already holds the corp mobile (the phone is
 *     a sign-in alias; if it's the rightful user, `fixCognitoId` applies —
 *     if a different user, that account must be corrected first);
 *   - the owner's `custom:emp_short_code` must equal the corp short code;
 *   - the OLD Cognito mobile is searched in corp + auth and any employees
 *     holding it are reported (analyze that number afterwards to bring the
 *     other user in sync — updating this phone frees the number for them).
 */
export async function fixCognitoPhone(
  environment: Environment,
  empmasterId: string,
  preview: boolean,
): Promise<CorrectionPhoneFixResult> {
  const fail = (message: string): CorrectionPhoneFixResult => ({
    ok: false,
    message,
    sub: "",
    username: "",
    oldMobile: null,
    newMobile: "",
    oldMobileHolders: [],
    updated: false,
    preview,
  });

  const corp = await fetchCorpById(environment, empmasterId);
  if (!corp) return fail(`No corp employee with empmaster_id ${empmasterId}.`);

  const mobile10 = normalizeMobile(corp.mobile_no);
  if (!mobile10) return fail("Corp employee has no mobile number — nothing to push to Cognito.");

  const authMatches = (
    await fetchAuthByShortCodes(environment, [norm(corp.emp_shortcode)].filter(Boolean))
  ).filter(
    (a) =>
      pairKey(a.short_code, a.company_code) ===
      pairKey(corp.emp_shortcode, corp.company_code),
  );
  if (authMatches.length > 1) {
    return fail(
      `${authMatches.length} auth records match (short code, company code) — resolve the duplicate manually.`,
    );
  }
  const auth = authMatches[0] ?? null;

  // The corp mobile must be free in Cognito — phone_number is a sign-in alias.
  const cog = await resolveCognito(environment, mobile10, corp.emp_shortcode);
  if (cog.error) return fail(cog.error);
  if (cog.target && norm(cog.target.sub)) {
    return fail(
      "A Cognito user already holds the corp mobile with a matching short code — use “Fix cognito_id in corp + auth” instead.",
    );
  }
  if (cog.byMobile.length > 0) {
    const other = cog.byMobile[0];
    return fail(
      `Another Cognito user already holds the corp mobile ${mobile10} (short code ${norm(other.emp_short_code) || "—"}) — correct that account first; a phone number can only belong to one Cognito user.`,
    );
  }

  // Resolve the employee's own Cognito user via the stored cognito_id.
  const owners = await resolveStoredSubOwners(
    environment,
    norm(corp.cognito_id),
    norm(auth?.cognito_id),
    "",
    corp.emp_shortcode,
    mobile10,
  );
  if (owners.length === 0) {
    return fail("No cognito_id is stored on this employee — there is no Cognito user to update.");
  }
  const lookupError = owners.find((o) => o.error);
  if (lookupError) return fail(lookupError.error!);

  const matching = owners.filter(
    (o) => o.user !== null && sameCode(o.user.emp_short_code, corp.emp_shortcode),
  );
  if (matching.length === 0) {
    return fail(
      "The stored cognito_id is stale or belongs to a different user — use “Clear wrong cognito_id” or “Sync Cognito details from corp” instead.",
    );
  }
  if (matching.length > 1) {
    return fail(
      "Multiple stored cognito_ids resolve to matching Cognito users — resolve manually.",
    );
  }
  const owner = matching[0].user!;
  const sub = norm(owner.sub);
  const username = norm(owner.username);
  if (!username) return fail("The Cognito user has no username — cannot update.");

  const oldMobile = displayMobile10(owner.phone_number);
  if (oldMobile === mobile10) {
    return fail(
      "The Cognito mobile already equals the corp mobile — re-run Analyze; nothing to update.",
    );
  }

  // Who currently holds the OLD Cognito mobile in corp/auth — reported so the
  // operator brings that user in sync afterwards (this update frees the
  // number in Cognito for them).
  const oldMobileHolders: CorrectionOldMobileHolder[] = [];
  if (oldMobile) {
    const corpPool = getPool({ environment, service: "corp", instance: null });
    const authPool = getAuthPool(environment);
    const schema = authSchema(environment);
    const [corpRes, authRes] = await Promise.all([
      corpPool.query(
        `SELECT empmaster_id::text AS id, emp_shortcode AS short_code,
                company_code::text AS company_code, emp_name AS name
         FROM public.empmaster_hdr
         WHERE mobile_no = $1::numeric AND empmaster_id <> $2::integer
         ORDER BY empmaster_id`,
        [oldMobile, corp.empmaster_id],
      ),
      authPool.query(
        `SELECT id::text AS id, short_code, company_code::text AS company_code, name
         FROM "${schema}"."Field_Force_Users"
         WHERE mobile_no = $1${auth ? " AND id <> $2::integer" : ""}
         ORDER BY id`,
        auth ? [oldMobile, auth.id] : [oldMobile],
      ),
    ]);
    for (const r of corpRes.rows) {
      oldMobileHolders.push({
        source: "corp",
        id: r.id,
        shortCode: r.short_code,
        companyCode: r.company_code,
        name: r.name,
      });
    }
    for (const r of authRes.rows) {
      oldMobileHolders.push({
        source: "auth",
        id: r.id,
        shortCode: r.short_code,
        companyCode: r.company_code,
        name: r.name,
      });
    }
  }

  if (preview) {
    return {
      ok: true,
      message: `Would update Cognito user ${username} (sub ${sub}) phone from ${oldMobile ?? "—"} to the corp mobile ${mobile10} (marked verified).`,
      sub,
      username,
      oldMobile,
      newMobile: mobile10,
      oldMobileHolders,
      updated: false,
      preview: true,
    };
  }

  await updateUserPhone(environment, username, mobile10);

  return {
    ok: true,
    message: `Updated the Cognito mobile of ${norm(corp.emp_shortcode)} from ${oldMobile ?? "—"} to ${mobile10}. Re-check to confirm — the fix action can then align corp/auth cognito_id if still needed.${oldMobileHolders.length > 0 ? ` Now analyze ${oldMobile} to bring its corp/auth holder in sync.` : ""}`,
    sub,
    username,
    oldMobile,
    newMobile: mobile10,
    oldMobileHolders,
    updated: true,
    preview: false,
  };
}

/* --------- action 7: return the Cognito account to its owner --------- */

/**
 * The stored cognito_id's account holds THIS employee's corp mobile but its
 * `custom:emp_short_code` identifies a DIFFERENT employee. The short code is
 * the identity anchor and is never rewritten — per corp (source of truth for
 * that short code) the account belongs to the OTHER employee, and what is
 * wrong is (a) the account's Cognito mobile and (b) the stale link on this
 * employee's records. One run repairs both users:
 *   1. the account's Cognito `phone_number` is set to the OWNER's corp mobile
 *      (the tool's only kind of Cognito write; skipped when already equal);
 *   2. the account's sub is written to the owner's corp/auth cognito_id
 *      ("based on the short code in Cognito");
 *   3. the stale link on THIS employee's corp/auth rows is NULLed
 *      (conditional `AND cognito_id = <sub>`).
 * Guards: exactly one corp employee may carry the account's short code (else
 * analyze the owner's mobile instead); the owner's corp/auth rows must not
 * store a DIFFERENT cognito_id; no other Cognito account may already hold the
 * owner's corp mobile; the sub must not be stored on any third-party record;
 * refused on lookup errors or when a live mobile+short-code target exists for
 * this employee. Run order: Cognito phone → owner DB writes → clear stale
 * link, so a mid-run failure always leaves a re-runnable state.
 */
export async function reassignCognitoOwner(
  environment: Environment,
  empmasterId: string,
  preview: boolean,
): Promise<CorrectionReassignResult> {
  const fail = (message: string): CorrectionReassignResult => ({
    ok: false,
    message,
    sub: "",
    username: "",
    owner: null,
    phoneChange: null,
    writes: [],
    clearedFrom: [],
    cleared: 0,
    updated: false,
    preview,
  });

  const corp = await fetchCorpById(environment, empmasterId);
  if (!corp) return fail(`No corp employee with empmaster_id ${empmasterId}.`);

  const mobile10 = normalizeMobile(corp.mobile_no);
  if (!mobile10) return fail("Corp employee has no mobile number — cannot verify the Cognito account.");

  const authMatches = (
    await fetchAuthByShortCodes(environment, [norm(corp.emp_shortcode)].filter(Boolean))
  ).filter(
    (a) =>
      pairKey(a.short_code, a.company_code) ===
      pairKey(corp.emp_shortcode, corp.company_code),
  );
  if (authMatches.length > 1) {
    return fail(
      `${authMatches.length} auth records match (short code, company code) — resolve the duplicate manually.`,
    );
  }
  const auth = authMatches[0] ?? null;

  const cog = await resolveCognito(environment, mobile10, corp.emp_shortcode);
  if (cog.error) return fail(cog.error);
  if (cog.target && norm(cog.target.sub)) {
    return fail(
      "A Cognito user already matches this employee by mobile + short code — use “Fix cognito_id in corp + auth” instead.",
    );
  }

  const storedOwners = await resolveStoredSubOwners(
    environment,
    norm(corp.cognito_id),
    norm(auth?.cognito_id),
    "",
    corp.emp_shortcode,
    mobile10,
  );
  if (storedOwners.length === 0) {
    return fail("No cognito_id is stored on this employee — there is no account to reassign.");
  }
  const lookupError = storedOwners.find((o) => o.error);
  if (lookupError) return fail(lookupError.error!);

  const candidates = storedOwners.filter(
    (o) =>
      o.user !== null &&
      o.phoneMatchesCorp &&
      !sameCode(o.user.emp_short_code, corp.emp_shortcode),
  );
  if (candidates.length === 0) {
    return fail(
      "The stored cognito_id's account does not hold this employee's corp mobile with a different short code — use the other actions instead.",
    );
  }
  if (candidates.length > 1) {
    return fail("Multiple stored cognito_ids qualify — resolve manually.");
  }
  const account = candidates[0].user!;
  const sub = norm(account.sub);
  const username = norm(account.username);
  if (!username) return fail("The Cognito account has no username — cannot update.");

  // Resolve the OWNER: the corp employee carrying the account's short code.
  const ownerShort = norm(account.emp_short_code);
  if (!ownerShort) {
    return fail("The Cognito account has no custom:emp_short_code — its owner cannot be determined.");
  }
  const ownerCorpRows = await fetchCorpByShortCode(environment, ownerShort);
  if (ownerCorpRows.length === 0) {
    return fail(
      `No corp employee carries the account's short code ${ownerShort} — the owner cannot be resolved from corp; correct this account manually.`,
    );
  }
  if (ownerCorpRows.length > 1) {
    return fail(
      `${ownerCorpRows.length} corp employees carry the account's short code ${ownerShort} — ambiguous owner; analyze the owner's mobile instead.`,
    );
  }
  const ownerCorp = ownerCorpRows[0];
  const ownerMobile10 = normalizeMobile(ownerCorp.mobile_no);
  if (!ownerMobile10) {
    return fail(
      `The owner's corp record (${ownerShort}, empmaster ${ownerCorp.empmaster_id}) has no mobile number — cannot fix the account's Cognito mobile.`,
    );
  }

  const ownerAuthMatches = (
    await fetchAuthByShortCodes(environment, [ownerShort])
  ).filter(
    (a) =>
      pairKey(a.short_code, a.company_code) ===
      pairKey(ownerCorp.emp_shortcode, ownerCorp.company_code),
  );
  if (ownerAuthMatches.length > 1) {
    return fail(
      `${ownerAuthMatches.length} auth records match the owner (${ownerShort}) — resolve the duplicate manually.`,
    );
  }
  const ownerAuth = ownerAuthMatches[0] ?? null;

  // The owner's rows must not already store a DIFFERENT cognito_id — that
  // could be their real (newer) account; analyze the owner's mobile instead.
  if (norm(ownerCorp.cognito_id) && norm(ownerCorp.cognito_id) !== sub) {
    return fail(
      `The owner's corp record (${ownerShort}) already stores a different cognito_id — analyze the owner's mobile ${ownerMobile10} to resolve their account first.`,
    );
  }
  if (ownerAuth && norm(ownerAuth.cognito_id) && norm(ownerAuth.cognito_id) !== sub) {
    return fail(
      `The owner's auth record (${ownerShort}) already stores a different cognito_id — analyze the owner's mobile ${ownerMobile10} to resolve their account first.`,
    );
  }

  // Phone fix: the account must end up holding the OWNER's corp mobile.
  const accountMobile10 = normalizeMobile(account.phone_number);
  let phoneChange: { before: string | null; after: string } | null = null;
  if (accountMobile10 !== ownerMobile10) {
    try {
      const holders = await lookupByMobile(environment, ownerMobile10);
      const others = holders.filter((u) => norm(u.sub) !== sub);
      if (others.length > 0) {
        return fail(
          `Another Cognito account already holds the owner's corp mobile ${ownerMobile10} (${others
            .map((u) => norm(u.emp_short_code) || norm(u.sub))
            .join(", ")}) — resolve that account first (analyze ${ownerMobile10}).`,
        );
      }
    } catch (e) {
      return fail(describeCognitoError(e));
    }
    phoneChange = {
      before: displayMobile10(account.phone_number),
      after: ownerMobile10,
    };
  }

  // Where the sub currently sits: the owner's rows get it written, THIS
  // employee's rows get it cleared, anything else is a third-party holder
  // and blocks (manual resolution — neither the owner nor the analyzed
  // employee).
  const allHolders = await findCorrectionConflicts(
    environment,
    sub,
    ownerCorp.empmaster_id,
    ownerAuth?.id ?? null,
  );
  const clearedFrom = allHolders.filter(
    (c) =>
      (c.source === "corp" && c.id === corp.empmaster_id) ||
      (c.source === "auth" && auth !== null && c.id === auth.id),
  );
  const thirdParty = allHolders.filter((c) => !clearedFrom.includes(c));
  if (thirdParty.length > 0) {
    return fail(
      `The sub is also stored on ${describeConflicts(thirdParty)} — neither this employee nor the account's owner; resolve those records manually first.`,
    );
  }

  const writes: CorrectionReassignWrite[] = [
    {
      source: "corp" as const,
      id: ownerCorp.empmaster_id,
      before: norm(ownerCorp.cognito_id) || null,
      needsUpdate: norm(ownerCorp.cognito_id) !== sub,
    },
    ...(ownerAuth
      ? [
          {
            source: "auth" as const,
            id: ownerAuth.id,
            before: norm(ownerAuth.cognito_id) || null,
            needsUpdate: norm(ownerAuth.cognito_id) !== sub,
          },
        ]
      : []),
  ];

  const owner = {
    shortCode: ownerShort,
    cognitoName: account.name,
    corpId: ownerCorp.empmaster_id,
    companyCode: ownerCorp.company_code,
    corpName: ownerCorp.emp_name,
    corpMobile: ownerMobile10,
    authId: ownerAuth?.id ?? null,
  };

  const pendingWrites = writes.filter((w) => w.needsUpdate);
  if (!phoneChange && pendingWrites.length === 0 && clearedFrom.length === 0) {
    return fail("Nothing to do — the account, its owner and this employee are already consistent; re-run Analyze.");
  }

  if (preview) {
    const steps = [
      phoneChange
        ? `set its Cognito mobile from ${phoneChange.before ?? "—"} to ${phoneChange.after} (owner's corp mobile)`
        : null,
      pendingWrites.length > 0
        ? `write the sub to the owner's ${pendingWrites.map((w) => w.source).join(" + ")} record${pendingWrites.length === 1 ? "" : "s"}`
        : null,
      clearedFrom.length > 0
        ? `clear the stale link on ${describeConflicts(clearedFrom)}`
        : null,
    ].filter(Boolean);
    return {
      ok: true,
      message: `The account (sub ${sub}) belongs to ${ownerShort} (${norm(ownerCorp.emp_name) || "—"}) per its short code. Would ${steps.join("; ")}.`,
      sub,
      username,
      owner,
      phoneChange,
      writes,
      clearedFrom,
      cleared: 0,
      updated: false,
      preview: true,
    };
  }

  // 1. Cognito phone (the only Cognito write) — first, so a failure here
  // changes nothing else and the action can simply be re-run.
  if (phoneChange) {
    await updateUserPhone(environment, username, ownerMobile10);
  }

  // 2. Owner corp/auth cognito_id writes (guarded above: before is NULL or
  // already the sub).
  for (const w of pendingWrites) {
    if (w.source === "corp") {
      const pool = getPool({ environment, service: "corp", instance: null });
      await pool.query(
        `UPDATE public.empmaster_hdr SET cognito_id = $1 WHERE empmaster_id = $2::integer`,
        [sub, w.id],
      );
    } else {
      const pool = getAuthPool(environment);
      const schema = authSchema(environment);
      await pool.query(
        `UPDATE "${schema}"."Field_Force_Users" SET cognito_id = $1 WHERE id = $2::integer`,
        [sub, w.id],
      );
    }
  }

  // 3. Clear the stale link on THIS employee's rows.
  const cleared =
    clearedFrom.length > 0
      ? await releaseSubFromRecords(environment, sub, clearedFrom)
      : 0;

  return {
    ok: true,
    message: `Returned the account to ${ownerShort}${phoneChange ? ` — Cognito mobile set to ${ownerMobile10}` : ""}${pendingWrites.length > 0 ? `; cognito_id written to the owner's ${pendingWrites.map((w) => w.source).join(" + ")}` : ""}${cleared > 0 ? `; stale link cleared from ${cleared} record${cleared === 1 ? "" : "s"} of this employee` : ""}. Re-check this employee, and analyze ${ownerMobile10} to verify the owner.`,
    sub,
    username,
    owner,
    phoneChange,
    writes,
    clearedFrom,
    cleared,
    updated: true,
    preview: false,
  };
}
