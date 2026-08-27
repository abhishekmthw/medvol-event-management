import { authSchema, getAuthPool, getPool } from "./db";
import {
  describeCognitoError,
  lookupByMobile,
  generateRandomPhoneNumber,
  lookupByReservedMobile,
  lookupBySub,
  releaseUserPhone,
  updateUserAttributes,
  updateUserPhone,
} from "./cognito";
import { CognitoIdentityProviderServiceException } from "@aws-sdk/client-cognito-identity-provider";
import { norm, normalizeMobile, pairKey } from "./auth-comparison";
import {
  CANON,
  describeHolder,
  findCognitoHolders,
  findMobileHolders,
  findShortCodePairHolders,
  findUcodeHolders,
  holderKey,
  rowKey,
  validateNetUniqueness,
  type Assignment,
  type Holder,
} from "./integrity";
import { displayMobile10, normalizeName } from "./format";
import { sendAuthQueueMessage } from "./sqs";
import type {
  CognitoUserInfo,
  CorrectionAnalyzeResult,
  CorrectionConflict,
  CorrectionEmployee,
  CorrectionEventSummary,
  CorrectionField,
  CorrectionMobileAccount,
  CorrectionMobileChangeResult,
  CorrectionMobileStep,
  CorrectionMobileVerification,
  CorrectionReleaseAttempt,
  CorrectionReleaseNumberResult,
  CorrectionReleaseOwner,
  CorrectionRepairParticipant,
  CorrectionRepairResult,
  CorrectionRepairStep,
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
 * cognito_id. The analyze step is read-only; the corrective actions are:
 *
 *   1. `replayEmployeeStream` — when the employee is missing in auth, the
 *      whole `employee_<empmaster_id>` event stream is read from corp
 *      `public.events` (ordered by timestamp) and each row is sent verbatim
 *      to the V1 auth consumer SQS FIFO queue, exactly like the proven manual
 *      recovery script. The auth-backend consumer re-creates the user from
 *      its own event history, so short code / mobile / name / ucode land as
 *      corp recorded them.
 *   2. `syncAuthFromCorp` — overwrites drifted auth name / mobile / ucode
 *      with the corp values (fixed column allow-list).
 *   3. `repairCognitoLinks` — the SINGLE action for every cognito_id
 *      entanglement: discovers the two users whose details criss-crossed
 *      (via cognito_id or mobile across corp / auth / Cognito) and repairs
 *      both in one confirmed run. See its doc comment for the rules.
 *
 * Every server entry point re-derives its inputs from the DBs/Cognito — the
 * client only ever sends `empmaster_id` — and every action supports a preview
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

  // When sub === "" but a cognito_id is stored somewhere, the analyze
  // post-pass looks the stored sub(s) up in Cognito by sub and pushes
  // precise statuses (stale / different owner) + turns on the repair.

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
      syncAuthFromCorp: syncNeeded && !syncBlockedReason,
      syncAuthBlockedReason: syncBlockedReason,
      cognitoAttributeDrift,
      // ANY cognito_id entanglement → the single unified repair. The analyze
      // post-passes also turn this on for duplicated / stale / criss-crossed
      // stored subs.
      repairCognito: cognitoIdNeedsFix,
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

  // Duplicate audit: the resolved live sub stored on any OTHER corp/auth
  // record means two users' data is criss-crossed — the unified repair
  // updates both users in one confirmed run.
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
      emp.statuses.push(
        `Cognito sub is also stored on: ${describeConflicts(conflicts)} — a cognito_id must identify exactly one record; the repair updates both users`,
      );
      emp.actions.repairCognito = true;
      emp.consistent = false;
    }
  }

  // Stored-sub audit: every stored cognito_id that differs from the resolved
  // target is looked up in Cognito BY SUB, so the operator sees whether it is
  // stale or belongs to a different user entirely. Every such case is fixed
  // by the unified repair (which discovers and updates the OTHER intertwined
  // user too).
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
        emp.actions.repairCognito = true;
      } else if (
        o.phoneMatchesCorp &&
        !sameCode(o.user?.emp_short_code, emp.shortCode)
      ) {
        // The account holds THIS employee's corp mobile but its short code
        // (the identity anchor — never rewritten) says it belongs to another
        // employee — a criss-cross the repair untangles for both users.
        emp.statuses.push(
          `${sides} cognito_id's account holds the corp mobile but its short code is ${norm(o.user?.emp_short_code) || "—"} (${norm(o.user?.name) || "—"}) — it belongs to that employee; the repair returns it to them`,
        );
        emp.actions.repairCognito = true;
      } else {
        // Owner matches the corp short code but wasn't found by the corp
        // mobile — the Cognito phone_number is outdated; the repair pushes
        // the corp mobile to Cognito.
        emp.statuses.push(
          `${sides} cognito_id belongs to a matching user whose Cognito mobile is ${displayMobile10(o.user?.phone_number) ?? "—"} — the repair pushes the corp mobile to Cognito`,
        );
        emp.actions.repairCognito = true;
      }
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
 *
 * The replayed EMPLOYEE_ADD is subject to auth's own uniqueness guards
 * (cross-table mobile, (short code, company), cross-table ucode). Those are
 * pre-flighted here against the CURRENT corp values — the state the whole
 * replay converges to, even when the stream carries later EMPLOYEE_EDITs — so
 * a duplicate is reported in the preview instead of surfacing later as a row
 * in the auth-backend's Event_Failures table.
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
      blockers: [],
      warnings: [],
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
      blockers: [],
      warnings: [],
      preview,
    };
  }

  // Pre-flight auth's own EMPLOYEE_ADD uniqueness guards (this also covers the
  // "already exists in auth" refusal — the (short code, company) pair is one of
  // the three checks).
  const { blockers, warnings } = await checkReplayIntegrity(environment, corp);

  if (preview) {
    return {
      ok: true,
      message:
        blockers.length > 0
          ? `Replay blocked — ${blockers.length} value${blockers.length === 1 ? "" : "s"} the auth consumer requires to be unique ${blockers.length === 1 ? "is" : "are"} already taken; resolve ${blockers.length === 1 ? "it" : "them"} before replaying ${rows.length} event${rows.length === 1 ? "" : "s"}.`
          : `${rows.length} event${rows.length === 1 ? "" : "s"} on stream ${streamId} would be replayed to the auth queue (in timestamp order).`,
      streamId,
      totalEvents: rows.length,
      events: summaries,
      sent: 0,
      errors: [],
      blockers,
      warnings,
      preview: true,
    };
  }

  if (blockers.length > 0) {
    return {
      ok: false,
      message: `Replay blocked: ${blockers.join(" ")}`,
      streamId,
      totalEvents: rows.length,
      events: summaries,
      sent: 0,
      errors: [],
      blockers,
      warnings,
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
    blockers: [],
    warnings,
    preview: false,
  };
}

/**
 * The three uniqueness guards auth-backend's EMPLOYEE_ADD applies, run against
 * the corp record BEFORE any event is queued:
 *
 *   - `mobile_no` free across `Admin_Users`, `Field_Force_Users`,
 *     `Counter_Company_Lnk`, `Delegate_Users`, `Stockists` (`getUserData`);
 *   - `(short_code, company_code)` free in `Field_Force_Users` (`getOneUser`) —
 *     this is also the "already exists in auth" case, so the replay's original
 *     refusal is now surfaced at preview time instead of only on the live run;
 *   - `ucode` free across `Admin_Users`, `Field_Force_Users`, `Counters`,
 *     `Delegate_Users`, `Stockists` (`getUserDataWithEmail`).
 *
 * The employee is absent from auth, so there is no own row to exclude: any
 * holder at all is a collision. A blank corp value is skipped — auth only
 * checks a mobile when `message.data.mobile_no` is truthy.
 */
async function checkReplayIntegrity(
  environment: Environment,
  corp: CorpRow,
): Promise<{ blockers: string[]; warnings: string[] }> {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const shortCode = norm(corp.emp_shortcode);
  const label = `${shortCode || "this employee"} (corp empmaster ${corp.empmaster_id})`;

  const mobile10 = normalizeMobile(corp.mobile_no);
  const [mobileHolders, pairHolders, ucodeHolders] = await Promise.all([
    mobile10 ? findMobileHolders(environment, [mobile10, norm(corp.mobile_no)]) : [],
    shortCode ? findShortCodePairHolders(environment, shortCode, corp.company_code) : [],
    norm(corp.ucode) ? findUcodeHolders(environment, [norm(corp.ucode)]) : [],
  ]);

  if (mobile10) {
    for (const h of mobileHolders) {
      blockers.push(
        `Mobile ${mobile10} is already held by ${describeHolder(h)} — the replayed EMPLOYEE_ADD would be rejected by auth's cross-table mobile check.${await freeItFirstHint(environment, h, "mobile_no")}`,
      );
    }
  } else {
    warnings.push(
      "Corp has no mobile number for this employee — auth skips its mobile uniqueness check, but the user will land without a mobile.",
    );
  }

  for (const h of pairHolders) {
    blockers.push(
      `Short code ${shortCode} is already used in company ${norm(corp.company_code) || "—"} by ${describeHolder(h)} — replay is only for employees missing in auth.`,
    );
  }

  if (norm(corp.ucode)) {
    for (const h of ucodeHolders) {
      blockers.push(
        `Ucode ${norm(corp.ucode).toLowerCase()} is already held by ${describeHolder(h)} — auth's EMPLOYEE_ADD ucode check spans admin / field force / counter / delegate / stockist.${await freeItFirstHint(environment, h, "ucode")}`,
      );
    }
  }

  if (blockers.length > 0) {
    // Informational, not a violation — kept out of `blockers` so it neither
    // inflates the count in the message nor reads as another collision.
    warnings.push(
      `Nothing was sent for ${label}; the events stay on the corp stream and can be replayed once the collisions above are resolved.`,
    );
  }

  return { blockers, warnings };
}

/**
 * Unlike the corp-sync, a replay cannot be waved through on a "the end state is
 * fine" argument: the auth CONSUMER runs the uniqueness check itself and will
 * reject EMPLOYEE_ADD outright, so the number has to be genuinely free first.
 * When the blocking holder is a field-force employee whose own corp record
 * disagrees with what it stores, say so — syncing that employee is the way out.
 */
async function freeItFirstHint(
  environment: Environment,
  h: Holder,
  column: "mobile_no" | "ucode",
): Promise<string> {
  const corpValue = await corpImpliedValue(environment, h, column);
  if (!corpValue || corpValue === sameFormAs(h.value, column)) return "";
  return ` That employee's corp value is ${corpValue}, so their auth record is itself stale — run "Sync auth with corp" for ${norm(h.shortCode) || `row ${h.id}`} first to free this value, then replay.`;
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
    blockers: [],
    warnings: [],
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
      blockers: [],
      warnings: [],
      updated: false,
      preview,
    };
  }

  // Integrity gate: auth enforces mobile and ucode uniqueness ACROSS all five
  // user tables (admin / field force / counter / delegate / stockist) in
  // application code, with no DB constraint behind it. Writing straight to the
  // table bypasses that guard, so replicate it here against the state the sync
  // would leave behind — a value another record already holds and that this
  // plan does not free is a hard blocker.
  const { blockers, warnings } = await checkAuthSyncIntegrity(
    environment,
    auth,
    changes,
  );

  if (preview) {
    return {
      ok: true,
      message:
        blockers.length > 0
          ? `Sync blocked — ${blockers.length} integrity violation${blockers.length === 1 ? "" : "s"} would result from writing ${changes.map((c) => c.label.toLowerCase()).join(", ")}.`
          : `Would update ${changes.map((c) => c.label.toLowerCase()).join(", ")} on the auth record from corp.`,
      authId: auth.id,
      changes,
      blockers,
      warnings,
      updated: false,
      preview: true,
    };
  }

  if (blockers.length > 0) {
    return { ...fail(`Sync blocked: ${blockers.join(" ")}`), blockers, warnings };
  }

  const pool = getAuthPool(environment);
  const schema = authSchema(environment);
  // Column names come from the fixed allow-list above; values parameterized.
  // Each column carries a before-value predicate so a row changed since the
  // preview is skipped rather than clobbered (same discipline as the repair).
  const sets = changes.map((c, i) => `"${c.column}" = $${i + 1}`).join(", ");
  const params: unknown[] = changes.map((c) => c.after);
  const guards = changes
    .map((c) => {
      params.push(c.before);
      return `"${c.column}" IS NOT DISTINCT FROM $${params.length}`;
    })
    .join(" AND ");
  params.push(auth.id);
  const res = await pool.query(
    `UPDATE "${schema}"."Field_Force_Users" SET ${sets}
      WHERE id = $${params.length}::integer AND ${guards}`,
    params,
  );

  if ((res.rowCount ?? 0) === 0) {
    return {
      ...fail(
        `Auth record ${auth.id} changed since the preview — nothing was written. Re-check and try again.`,
      ),
      changes,
      warnings,
    };
  }

  return {
    ok: true,
    message: `Updated ${changes.map((c) => c.label.toLowerCase()).join(", ")} on auth record ${auth.id} from corp.`,
    authId: auth.id,
    changes,
    blockers: [],
    warnings,
    updated: true,
    preview: false,
  };
}

/**
 * Would the corp-sync leave a duplicate behind? Checks each value it would
 * write against every auth table that auth-backend's own uniqueness chain
 * walks, excluding the row being written (it is allowed to keep its own
 * value). `name` carries no invariant.
 *
 * The mobile check is run twice: raw equality (what auth actually compares, so
 * that is the blocker) and last-10 digits (a looser net, since corp stores
 * numeric(10) and auth varchar — reported as a warning so a formatting-only
 * clash is visible without blocking a write auth itself would accept).
 */
async function checkAuthSyncIntegrity(
  environment: Environment,
  auth: AuthRow,
  changes: CorrectionSyncChange[],
): Promise<{ blockers: string[]; warnings: string[] }> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const selfKey = rowKey("auth", "Field_Force_Users", auth.id);
  const selfLabel = `auth Field_Force_Users row ${auth.id}${norm(auth.short_code) ? ` (${norm(auth.short_code)})` : ""}`;

  const mobileChange = changes.find((c) => c.column === "mobile_no");
  if (mobileChange?.after) {
    const holders = (
      await findMobileHolders(environment, [
        mobileChange.after,
        normalizeMobile(mobileChange.after) ?? "",
      ])
    ).filter((h) => holderKey(h) !== selfKey);
    const { assignments, warnings: pending } = await projectPendingCorrections(
      environment,
      holders,
      "mobile_no",
      { rowKey: selfKey, newValue: mobileChange.after, label: selfLabel },
    );
    warnings.push(...pending);
    blockers.push(
      ...validateNetUniqueness({
        label: "Mobile number",
        assignments,
        holders,
        canon: CANON.exact,
        hint: "auth's EMPLOYEE_EDIT guard would reject this too.",
      }),
    );
    // Loose (last-10) collisions raw equality misses — informational only,
    // since auth itself compares raw strings and would accept the write.
    const loose = validateNetUniqueness({
      label: "Mobile number",
      assignments,
      holders,
      canon: CANON.mobile10,
      hint: "It differs only in formatting, so auth's raw comparison would not catch it.",
    }).filter((v) => !blockers.includes(v));
    warnings.push(...loose);
  }

  const ucodeChange = changes.find((c) => c.column === "ucode");
  if (ucodeChange?.after) {
    const holders = (
      await findUcodeHolders(environment, [ucodeChange.after])
    ).filter((h) => holderKey(h) !== selfKey);
    const { assignments, warnings: pending } = await projectPendingCorrections(
      environment,
      holders,
      "ucode",
      { rowKey: selfKey, newValue: ucodeChange.after, label: selfLabel },
    );
    warnings.push(...pending);
    blockers.push(
      ...validateNetUniqueness({
        label: "Ucode",
        assignments,
        holders,
        canon: CANON.lower,
        hint: "auth's EMPLOYEE_ADD ucode check spans admin / field force / counter / delegate / stockist.",
      }),
    );
  }

  return { blockers, warnings };
}

/**
 * Extends the projected end state with the corrections corp IMPLIES for the
 * other holders, so a crossed pair can be fixed one employee at a time.
 *
 * A sync writes one auth row, but the classic case is two employees whose
 * details got swapped: auth has A holding B's mobile and vice versa. Syncing A
 * alone looks like a duplicate at that instant, yet corp — the source of truth
 * — already says B must move off that number, so the state after both syncs is
 * unique. Any field-force holder whose corp record disagrees with what it
 * currently stores is therefore treated as already assigned its corp value
 * (which un-blocks this sync) and reported as a warning, so the operator knows
 * the second sync is still outstanding.
 *
 * Holders that are NOT field-force employees (counter / stockist / admin /
 * delegate rows), or whose corp record agrees with what they hold, stay in the
 * end state and block — nothing is going to move them.
 */
async function projectPendingCorrections(
  environment: Environment,
  holders: Holder[],
  column: "mobile_no" | "ucode",
  self: Assignment,
): Promise<{ assignments: Assignment[]; warnings: string[] }> {
  const assignments: Assignment[] = [self];
  const warnings: string[] = [];
  for (const h of holders) {
    const corpValue = await corpImpliedValue(environment, h, column);
    // Semantic comparison here (last-10 mobile / lowercased ucode): a
    // formatting-only difference is NOT a pending correction.
    if (!corpValue || corpValue === sameFormAs(h.value, column)) continue;
    const shortCode = norm(h.shortCode);

    assignments.push({
      rowKey: holderKey(h),
      newValue: corpValue,
      label: `auth Field_Force_Users row ${h.id} (${shortCode})`,
    });
    warnings.push(
      `${shortCode} also holds ${column === "mobile_no" ? "this mobile" : "this ucode"}, but corp says theirs is ${corpValue} — their details are crossed with this employee's. This sync is allowed because the end state is unique once BOTH are synced; run "Sync auth with corp" for ${shortCode} too (either order works).`,
    );
  }

  return { assignments, warnings };
}

/**
 * A stored value reduced to the same canonical form `corpImpliedValue` returns,
 * so the two can be compared without formatting noise (last-10 digits for a
 * mobile, lowercase for a ucode).
 */
function sameFormAs(value: string | null, column: "mobile_no" | "ucode"): string {
  return column === "mobile_no"
    ? (normalizeMobile(value) ?? "")
    : norm(value).toLowerCase();
}

/**
 * What corp says this holder's `mobile_no` / `ucode` should be, when that
 * differs from what the holder currently stores — i.e. the holder is itself
 * awaiting a correction. Null when the holder is not a field-force employee,
 * cannot be matched to exactly one corp row, or already agrees with corp.
 */
async function corpImpliedValue(
  environment: Environment,
  h: Holder,
  column: "mobile_no" | "ucode",
): Promise<string | null> {
  if (h.db !== "auth" || h.table !== "Field_Force_Users") return null;
  const shortCode = norm(h.shortCode);
  if (!shortCode) return null;

  const corpRows = (await fetchCorpByShortCode(environment, shortCode)).filter(
    (c) =>
      pairKey(c.emp_shortcode, c.company_code) === pairKey(shortCode, h.companyCode),
  );
  if (corpRows.length !== 1) return null; // ambiguous or corp-less
  const corpValue =
    column === "mobile_no"
      ? (normalizeMobile(corpRows[0].mobile_no) ?? "")
      : norm(corpRows[0].ucode).toLowerCase();
  return corpValue || null;
}


/* ------------- unified repair: cognito_id criss-cross ------------- */

/** Corp events on the employee's stream — replay feasibility for a missing auth record. */
async function countStreamEvents(
  environment: Environment,
  empmasterId: string,
): Promise<number> {
  const pool = getPool({ environment, service: "corp", instance: null });
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM public.events WHERE "eventStreamStreamId" = $1`,
    [`employee_${empmasterId}`],
  );
  return rows[0]?.n ?? 0;
}

type RepairParticipantState = {
  role: "analyzed" | "other";
  corp: CorpRow;
  auth: AuthRow | null;
  /** >1 auth records matched — auth side skipped entirely. */
  authAmbiguous: boolean;
  mobile10: string | null;
  account: CognitoUserInfo | null;
  accountVia: "mobile" | "shortCode" | null;
  needsPhone: boolean;
  replayEvents: number;
  notes: string[];
};

/**
 * The single corrective action for every cognito_id entanglement. In ANY
 * mismatch there are (up to) two users whose details got criss-crossed across
 * corp / auth / Cognito — this discovers both, from every angle available:
 *   - the analyzed employee's rightful account (corp mobile + short code);
 *   - that sub stored on OTHER corp/auth records (their users);
 *   - stored cognito_ids whose Cognito account names a different short code;
 *   - Cognito accounts holding the analyzed employee's mobile under a
 *     different short code.
 * For every discovered user, their rightful account is resolved the same way
 * (corp mobile + short code; or an already-linked account whose SHORT CODE
 * matches — the identity anchor — in which case its Cognito mobile is
 * corrected from THAT user's corp record). The plan then contains, in apply
 * order: Cognito phone updates (the tool's only Cognito write), cognito_id
 * writes onto each user's corp/auth rows, and clears of stale/foreign links.
 * All DB steps carry a before-value predicate so concurrently-changed rows
 * are never clobbered.
 *
 * Participants missing in auth whose account needs linking BLOCK the confirm
 * — the modal offers "Create in auth" (event replay) first, then the repair
 * re-previews. Ambiguities (short code on several corp rows, several auth
 * matches, occupied mobiles) skip that side with a warning instead of
 * guessing.
 */
export async function repairCognitoLinks(
  environment: Environment,
  empmasterId: string,
  preview: boolean,
): Promise<CorrectionRepairResult> {
  const fail = (message: string): CorrectionRepairResult => ({
    ok: false,
    message,
    participants: [],
    steps: [],
    blockers: [],
    warnings: [],
    applied: 0,
    updated: false,
    preview,
  });

  const corpE = await fetchCorpById(environment, empmasterId);
  if (!corpE) return fail(`No corp employee with empmaster_id ${empmasterId}.`);
  const sE = norm(corpE.emp_shortcode);
  if (!sE) return fail("Corp employee has no short code — cannot repair.");
  const mE = normalizeMobile(corpE.mobile_no);
  if (!mE) return fail("Corp employee has no mobile number — cannot repair.");

  const warnings: string[] = [];
  const blockers: string[] = [];

  /* ---------------- cached Cognito lookups ---------------- */
  const mobileCache = new Map<string, CognitoUserInfo[]>();
  const subCache = new Map<string, CognitoUserInfo | null>();
  const byMobile = async (m: string): Promise<CognitoUserInfo[]> => {
    let users = mobileCache.get(m);
    if (!users) {
      users = await lookupByMobile(environment, m);
      mobileCache.set(m, users);
      for (const u of users) subCache.set(norm(u.sub), u);
    }
    return users;
  };
  const bySub = async (sub: string): Promise<CognitoUserInfo | null> => {
    if (subCache.has(sub)) return subCache.get(sub)!;
    const users = await lookupBySub(environment, sub);
    const user = users[0] ?? null;
    subCache.set(sub, user);
    return user;
  };

  const authForCorp = async (corp: CorpRow): Promise<{ auth: AuthRow | null; ambiguous: boolean }> => {
    const matches = (
      await fetchAuthByShortCodes(environment, [norm(corp.emp_shortcode)].filter(Boolean))
    ).filter(
      (a) =>
        pairKey(a.short_code, a.company_code) ===
        pairKey(corp.emp_shortcode, corp.company_code),
    );
    return { auth: matches[0] ?? null, ambiguous: matches.length > 1 };
  };

  try {
    /* ---------------- analyzed employee + Cognito state ---------------- */
    const { auth: authE, ambiguous: authEAmbiguous } = await authForCorp(corpE);
    if (authEAmbiguous) {
      return fail(
        "Multiple auth records match this employee (short code, company code) — resolve the duplicate manually first.",
      );
    }

    const usersByMobileE = await byMobile(mE);
    const targetE = resolveCognitoTarget(usersByMobileE, sE).target;

    // Load every stored sub so foreign owners are known.
    const storedSubsE = Array.from(
      new Set([norm(corpE.cognito_id), norm(authE?.cognito_id)].filter(Boolean)),
    );
    for (const sub of storedSubsE) await bySub(sub);

    // Rows of OTHER users storing the analyzed employee's rightful sub.
    const conflictRows = targetE
      ? await findCorrectionConflicts(
          environment,
          norm(targetE.sub),
          corpE.empmaster_id,
          authE?.id ?? null,
        )
      : [];

    /* ---------------- discover the other intertwined users ---------------- */
    const otherShorts = new Map<string, string>(); // canonical → display form
    const addShort = (sc: string | null | undefined) => {
      const n = norm(sc);
      if (n && !sameCode(n, sE)) otherShorts.set(n.toUpperCase(), n);
    };
    for (const user of subCache.values()) if (user) addShort(user.emp_short_code);
    for (const row of conflictRows) addShort(row.shortCode);

    const participants: RepairParticipantState[] = [
      {
        role: "analyzed",
        corp: corpE,
        auth: authE,
        authAmbiguous: false,
        mobile10: mE,
        account: null,
        accountVia: null,
        needsPhone: false,
        replayEvents: 0,
        notes: [],
      },
    ];

    for (const scDisplay of otherShorts.values()) {
      const corpRows = await fetchCorpByShortCode(environment, scDisplay);
      if (corpRows.length === 0) {
        warnings.push(
          `No corp employee carries short code ${scDisplay} — its Cognito account / stored links are treated as stale.`,
        );
        continue;
      }
      if (corpRows.length > 1) {
        warnings.push(
          `${corpRows.length} corp employees carry short code ${scDisplay} — ambiguous; that user is not auto-repaired (analyze their mobile separately).`,
        );
        continue;
      }
      const corpX = corpRows[0];
      const { auth: authX, ambiguous: authXAmbiguous } = await authForCorp(corpX);
      if (authXAmbiguous) {
        warnings.push(
          `Multiple auth records match ${scDisplay} — their auth side is skipped; resolve the duplicate manually.`,
        );
      }
      // Load THEIR stored subs too so ownership can be judged.
      for (const sub of new Set(
        [norm(corpX.cognito_id), norm(authX?.cognito_id)].filter(Boolean),
      )) {
        await bySub(sub);
      }
      participants.push({
        role: "other",
        corp: corpX,
        auth: authXAmbiguous ? null : authX,
        authAmbiguous: authXAmbiguous,
        mobile10: normalizeMobile(corpX.mobile_no),
        account: null,
        accountVia: null,
        needsPhone: false,
        replayEvents: 0,
        notes: [],
      });
    }

    /* ---------------- resolve each participant's rightful account ---------------- */
    for (const p of participants) {
      const sU = norm(p.corp.emp_shortcode);
      // Primary: corp mobile + short code (the fix rule).
      if (p.mobile10) {
        const users = await byMobile(p.mobile10);
        const target = resolveCognitoTarget(users, sU).target;
        if (target) {
          p.account = target;
          p.accountVia = "mobile";
          continue;
        }
      }
      // Secondary: an already-known account whose SHORT CODE matches — the
      // identity anchor; its phone then gets corrected from THIS user's corp.
      const matches = new Map<string, CognitoUserInfo>();
      for (const user of subCache.values()) {
        if (user && sameCode(user.emp_short_code, sU)) matches.set(norm(user.sub), user);
      }
      if (matches.size === 1) {
        p.account = Array.from(matches.values())[0];
        p.accountVia = "shortCode";
        p.needsPhone =
          p.mobile10 !== null &&
          normalizeMobile(p.account.phone_number) !== p.mobile10;
      } else if (matches.size > 1) {
        warnings.push(
          `${sU}: ${matches.size} linked Cognito accounts carry this short code — ambiguous; not auto-repaired.`,
        );
        p.notes.push("Multiple Cognito accounts carry this short code");
      } else {
        p.notes.push("No Cognito account resolves for this user");
      }
    }

    /* ---------------- build the step plan ---------------- */
    const steps: CorrectionRepairStep[] = [];

    // 1. Cognito phone updates — the only kind of Cognito write. Every needed
    // update is planned unconditionally; whether a contested number actually
    // works out is decided by the end-state check below (a swap nets out, a
    // genuine collision blocks the whole repair). "Other" users are still
    // ordered first so that at APPLY time a contested number is freed before
    // another account claims it.
    const ordered = [
      ...participants.filter((p) => p.role === "other"),
      ...participants.filter((p) => p.role === "analyzed"),
    ];
    for (const p of ordered) {
      if (!p.account || !p.needsPhone || !p.mobile10) continue;
      // Make sure every account currently holding the target number is loaded,
      // so the end-state check can see it.
      await byMobile(p.mobile10);
      steps.push({
        kind: "cognitoPhone",
        sub: norm(p.account.sub),
        username: norm(p.account.username),
        shortCode: norm(p.corp.emp_shortcode),
        before: displayMobile10(p.account.phone_number),
        after: p.mobile10,
      });
    }

    // 2. cognito_id writes onto each participant's rows (+ missing-in-auth
    // blockers: creating the record is the operator's explicit extra step).
    const rowKey = (source: "corp" | "auth", id: string) => `${source}:${id}`;
    const participantRowKeys = new Set<string>();
    for (const p of participants) {
      participantRowKeys.add(rowKey("corp", p.corp.empmaster_id));
      if (p.auth) participantRowKeys.add(rowKey("auth", p.auth.id));
    }

    for (const p of participants) {
      if (p.auth === null && !p.authAmbiguous) {
        p.replayEvents = await countStreamEvents(environment, p.corp.empmaster_id);
      }
      if (!p.account) continue;
      const sub = norm(p.account.sub);
      const sU = norm(p.corp.emp_shortcode);
      if (norm(p.corp.cognito_id) !== sub) {
        steps.push({
          kind: "dbWrite",
          source: "corp",
          id: p.corp.empmaster_id,
          shortCode: sU,
          before: norm(p.corp.cognito_id) || null,
          after: sub,
        });
      }
      if (p.auth) {
        if (norm(p.auth.cognito_id) !== sub) {
          steps.push({
            kind: "dbWrite",
            source: "auth",
            id: p.auth.id,
            shortCode: sU,
            before: norm(p.auth.cognito_id) || null,
            after: sub,
          });
        }
      } else if (!p.authAmbiguous) {
        if (p.replayEvents > 0) {
          blockers.push(
            `${sU} (${norm(p.corp.emp_name) || "—"}) is missing in auth — create them in auth first (replay ${p.replayEvents} event${p.replayEvents === 1 ? "" : "s"}), then the repair links their auth record too.`,
          );
        } else {
          warnings.push(
            `${sU} is missing in auth and has no corp event stream to replay — their auth side is skipped.`,
          );
        }
      }
    }

    // 3. Third-party rows still holding a participant's rightful sub → clear
    // (corp truth: the sub identifies exactly the participant's records).
    const clearKeys = new Set<string>();
    for (const p of participants) {
      if (!p.account) continue;
      const sub = norm(p.account.sub);
      const rows = await findCorrectionConflicts(
        environment,
        sub,
        p.corp.empmaster_id,
        p.auth?.id ?? null,
      );
      for (const row of rows) {
        const key = rowKey(row.source, row.id);
        if (participantRowKeys.has(key)) continue; // that participant's own write/clear covers it
        if (clearKeys.has(key)) continue;
        clearKeys.add(key);
        steps.push({
          kind: "dbClear",
          source: row.source,
          id: row.id,
          shortCode: row.shortCode,
          before: sub,
        });
      }
    }

    // 4. Participant rows storing a sub that is NOT their account: with an
    // account the write above overwrites; without one, clear confirmed
    // stale/foreign links (never on lookup uncertainty — subs are all cached
    // lookups that would have thrown).
    for (const p of participants) {
      if (p.account) continue;
      const sU = norm(p.corp.emp_shortcode);
      const sides: { source: "corp" | "auth"; id: string; stored: string }[] = [];
      if (norm(p.corp.cognito_id)) {
        sides.push({ source: "corp", id: p.corp.empmaster_id, stored: norm(p.corp.cognito_id) });
      }
      if (p.auth && norm(p.auth.cognito_id)) {
        sides.push({ source: "auth", id: p.auth.id, stored: norm(p.auth.cognito_id) });
      }
      for (const side of sides) {
        const owner = subCache.get(side.stored);
        if (owner && sameCode(owner.emp_short_code, sU)) continue; // would have resolved as their account
        const key = rowKey(side.source, side.id);
        if (clearKeys.has(key)) continue;
        clearKeys.add(key);
        steps.push({
          kind: "dbClear",
          source: side.source,
          id: side.id,
          shortCode: sU,
          before: side.stored,
        });
      }
    }

    /* ---------------- projected end-state integrity ---------------- */
    // The plan is complete; now check the state it would LEAVE BEHIND. This is
    // deliberately a net check, not a per-statement one: the whole point of the
    // repair is to un-cross two users, so values legitimately move between
    // rows. Only a duplicate that survives the plan is a violation.
    const knownAccounts = new Map<string, CognitoUserInfo>();
    for (const u of subCache.values()) if (u) knownAccounts.set(norm(u.sub), u);
    for (const users of mobileCache.values()) {
      for (const u of users) knownAccounts.set(norm(u.sub), u);
    }
    blockers.push(
      ...(await checkRepairIntegrity(
        environment,
        participants,
        steps,
        Array.from(knownAccounts.values()),
      )),
    );

    /* ---------------- result shaping ---------------- */
    const participantsOut: CorrectionRepairParticipant[] = participants.map((p) => ({
      role: p.role,
      empmasterId: p.corp.empmaster_id,
      shortCode: norm(p.corp.emp_shortcode),
      companyCode: norm(p.corp.company_code) || null,
      name: p.corp.emp_name,
      mobile10: p.mobile10,
      authId: p.auth?.id ?? null,
      missingInAuth: p.auth === null && !p.authAmbiguous,
      replayEvents: p.replayEvents,
      accountSub: p.account ? norm(p.account.sub) : null,
      accountVia: p.accountVia,
      notes: p.notes,
    }));

    if (steps.length === 0 && blockers.length === 0) {
      return {
        ...fail(
          "No repair needed — cognito_id links are already consistent for everyone involved. Re-run Analyze.",
        ),
        participants: participantsOut,
        warnings,
      };
    }

    const phoneCount = steps.filter((st) => st.kind === "cognitoPhone").length;
    const writeCount = steps.filter((st) => st.kind === "dbWrite").length;
    const clearCount = steps.filter((st) => st.kind === "dbClear").length;
    const summary = [
      phoneCount > 0 ? `${phoneCount} Cognito mobile update${phoneCount === 1 ? "" : "s"}` : null,
      writeCount > 0 ? `${writeCount} cognito_id write${writeCount === 1 ? "" : "s"}` : null,
      clearCount > 0 ? `${clearCount} stale link clear${clearCount === 1 ? "" : "s"}` : null,
    ]
      .filter(Boolean)
      .join(", ");

    if (preview) {
      return {
        ok: true,
        message: `Repair plan for ${participants.length} user${participants.length === 1 ? "" : "s"}: ${summary || "no steps yet"}.${blockers.length > 0 ? ` Blocked by ${blockers.length} issue${blockers.length === 1 ? "" : "s"} — see below.` : ""}`,
        participants: participantsOut,
        steps,
        blockers,
        warnings,
        applied: 0,
        updated: false,
        preview: true,
      };
    }

    if (blockers.length > 0) {
      return fail(`Repair blocked: ${blockers.join(" ")}`);
    }
    if (steps.length === 0) {
      return fail("No steps to apply — re-run Analyze.");
    }

    /* ---------------- apply (phone → writes → clears) ---------------- */
    let applied = 0;
    let skipped = 0;
    for (const st of steps.filter((x) => x.kind === "cognitoPhone")) {
      if (st.kind !== "cognitoPhone") continue;
      await updateUserPhone(environment, st.username, st.after);
      applied += 1;
    }
    const corpPool = getPool({ environment, service: "corp", instance: null });
    const authPool = getAuthPool(environment);
    const schema = authSchema(environment);
    for (const st of steps) {
      if (st.kind === "dbWrite") {
        const res =
          st.source === "corp"
            ? await corpPool.query(
                `UPDATE public.empmaster_hdr SET cognito_id = $1
                 WHERE empmaster_id = $2::integer AND cognito_id IS NOT DISTINCT FROM $3`,
                [st.after, st.id, st.before],
              )
            : await authPool.query(
                `UPDATE "${schema}"."Field_Force_Users" SET cognito_id = $1
                 WHERE id = $2::integer AND cognito_id IS NOT DISTINCT FROM $3`,
                [st.after, st.id, st.before],
              );
        if ((res.rowCount ?? 0) > 0) applied += 1;
        else skipped += 1;
      } else if (st.kind === "dbClear") {
        const res =
          st.source === "corp"
            ? await corpPool.query(
                `UPDATE public.empmaster_hdr SET cognito_id = NULL
                 WHERE empmaster_id = $1::integer AND cognito_id = $2`,
                [st.id, st.before],
              )
            : await authPool.query(
                `UPDATE "${schema}"."Field_Force_Users" SET cognito_id = NULL
                 WHERE id = $1::integer AND cognito_id = $2`,
                [st.id, st.before],
              );
        if ((res.rowCount ?? 0) > 0) applied += 1;
        else skipped += 1;
      }
    }

    return {
      ok: true,
      message: `Applied ${applied} of ${steps.length} repair step${steps.length === 1 ? "" : "s"} (${summary}).${skipped > 0 ? ` ${skipped} step${skipped === 1 ? "" : "s"} skipped — the row changed concurrently; re-check.` : ""} Re-check to confirm all users are consistent.`,
      participants: participantsOut,
      steps,
      blockers,
      warnings,
      applied,
      updated: true,
      preview: false,
    };
  } catch (e) {
    // The repair reads Cognito AND both databases; describeCognitoError would
    // mislabel a pg failure (e.g. a missing auth table during the integrity
    // pass) as a ListUsers error. Either way this fails closed — nothing has
    // been applied at this point.
    const isCognito =
      e instanceof CognitoIdentityProviderServiceException ||
      (e instanceof Error && /Cognito/i.test(e.name));
    return fail(
      isCognito
        ? describeCognitoError(e)
        : `Repair aborted before any change: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
    );
  }
}

/**
 * The repair's projected-end-state gate, run once the step plan is complete.
 *
 * Two invariants, both evaluated NET — a criss-cross that untangles cleanly
 * must pass, only a duplicate that survives the plan may block:
 *
 *  1. `cognito_id` identifies exactly one employee. A sub may legitimately sit
 *     on that employee's own corp `empmaster_hdr` row AND their auth
 *     `Field_Force_Users` row, so ownership is checked per participant rather
 *     than per table. Any OTHER record still holding the sub afterwards — in
 *     any of the five auth user tables or in corp — is a violation, including
 *     tables this tool cannot write (those must be resolved by hand; failing
 *     closed is the point).
 *  2. Cognito `phone_number` is single-holder. The final phone per account is
 *     the planned update where there is one, otherwise the account's current
 *     value. Two accounts landing on the same number blocks the whole repair
 *     rather than silently skipping one update and leaving a half-fixed pair.
 *  3. A number the repair writes is not RESERVED as some other account's
 *     sign-in identifier. Checks 1 and 2 read attributes only, so they are
 *     blind to the reservation index (`UsernameAttributes: ['phone_number']`)
 *     — the exact blind spot that let a number look free while every signup
 *     for it failed as already-existing. Probed with `AdminGetUser`.
 */
async function checkRepairIntegrity(
  environment: Environment,
  participants: RepairParticipantState[],
  steps: CorrectionRepairStep[],
  knownAccounts: CognitoUserInfo[],
): Promise<string[]> {
  const blockers: string[] = [];
  const tableFor = (source: "corp" | "auth") =>
    source === "corp" ? "empmaster_hdr" : "Field_Force_Users";

  /* ---------------- cognito_id ---------------- */

  // Value each touched row holds after the plan runs (absent = unchanged).
  const projected = new Map<string, string | null>();
  for (const st of steps) {
    if (st.kind === "dbWrite") {
      projected.set(rowKey(st.source, tableFor(st.source), st.id), st.after);
    } else if (st.kind === "dbClear") {
      projected.set(rowKey(st.source, tableFor(st.source), st.id), null);
    }
  }

  // Which rows are the rightful owners of each target sub.
  const ownersBySub = new Map<string, { keys: Set<string>; label: string }>();
  for (const p of participants) {
    if (!p.account) continue;
    const sub = norm(p.account.sub);
    if (!sub) continue;
    const label = `${norm(p.corp.emp_shortcode) || "—"} (corp empmaster ${p.corp.empmaster_id})`;
    const existing = ownersBySub.get(sub);
    if (existing) {
      blockers.push(
        `cognito_id ${sub} resolves as the rightful account of BOTH ${existing.label} and ${label} — two employees cannot share one Cognito account. Analyze each mobile separately and fix the short codes first.`,
      );
      continue;
    }
    const keys = new Set<string>([
      rowKey("corp", "empmaster_hdr", p.corp.empmaster_id),
    ]);
    if (p.auth) keys.add(rowKey("auth", "Field_Force_Users", p.auth.id));
    ownersBySub.set(sub, { keys, label });
  }

  const targetSubs = Array.from(ownersBySub.keys());
  const holders: Holder[] =
    targetSubs.length > 0 ? await findCognitoHolders(environment, targetSubs) : [];
  for (const h of holders) {
    const owner = ownersBySub.get(norm(h.value));
    if (!owner) continue;
    const key = holderKey(h);
    if (owner.keys.has(key)) continue; // the rightful owner's own row
    if (projected.has(key) && norm(projected.get(key)) !== norm(h.value)) {
      continue; // the plan moves this row off the sub
    }
    blockers.push(
      `cognito_id ${norm(h.value)} would still be on ${describeHolder(h)} after the repair, alongside ${owner.label} — a cognito_id must identify exactly one employee. Clear that record first (this tool only writes corp empmaster_hdr and auth Field_Force_Users).`,
    );
  }

  /* ---------------- Cognito phone_number ---------------- */

  const desired = new Map<string, string>();
  for (const st of steps) {
    if (st.kind === "cognitoPhone") desired.set(norm(st.sub), st.after);
  }

  const labelForSub = new Map<string, string>();
  const finalPhone = new Map<string, string>();
  for (const u of knownAccounts) {
    const sub = norm(u.sub);
    if (!sub) continue;
    labelForSub.set(
      sub,
      `${norm(u.emp_short_code) || norm(u.username) || sub}${norm(u.name) ? ` (${norm(u.name)})` : ""}`,
    );
    const phone = desired.get(sub) ?? normalizeMobile(u.phone_number) ?? "";
    if (phone) finalPhone.set(sub, phone);
  }
  // An account we plan to write but never loaded (defensive — byMobile /
  // bySub populate the cache for everything the plan touches).
  for (const [sub, phone] of desired) {
    if (!finalPhone.has(sub)) finalPhone.set(sub, phone);
    if (!labelForSub.has(sub)) labelForSub.set(sub, sub);
  }

  const subsByPhone = new Map<string, string[]>();
  for (const [sub, phone] of finalPhone) {
    const list = subsByPhone.get(phone);
    if (list) list.push(sub);
    else subsByPhone.set(phone, [sub]);
  }
  for (const [phone, subs] of subsByPhone) {
    if (subs.length < 2) continue;
    // Only report when the plan is what puts them there — a pre-existing
    // duplicate the repair neither creates nor touches is not this run's fault.
    if (!subs.some((sub) => desired.has(sub))) continue;
    blockers.push(
      `Cognito mobile ${phone} would end up on ${subs.length} accounts (${subs
        .map((sub) => labelForSub.get(sub) ?? sub)
        .join(", ")}) — a number must identify one account. Repair the other user first, or correct their corp mobile.`,
    );
  }

  /* ------- Cognito sign-in reservation (invisible to the checks above) ------- */

  // Every number this repair writes may already be reserved as the sign-in
  // identifier of an account no attribute search can find. Reassigning the
  // attribute onto our participant does not take that reservation away, so the
  // other account keeps the number and any signup for it keeps failing — flag
  // it here instead of leaving the operator with an inexplicable half-fix.
  const knownSubs = new Set(knownAccounts.map((u) => norm(u.sub)).filter(Boolean));
  for (const [sub, phone] of desired) {
    knownSubs.add(sub);
    try {
      const reserved = await lookupByReservedMobile(environment, phone);
      if (!reserved || knownSubs.has(norm(reserved.sub))) continue;
      blockers.push(
        `Cognito mobile ${displayMobile10(phone)} is reserved as the sign-in number of another account — ${norm(reserved.sub) || reserved.username} (short code ${norm(reserved.emp_short_code) || "—"}, phone attribute ${displayMobile10(reserved.phone_number) || "—"}${reserved.enabled === false ? ", disabled" : ""}) — which no attribute search can see. Writing it onto ${labelForSub.get(sub) ?? sub} would not take the reservation away. Use “Change Cognito mobile / release reserved number” on that account first.`,
      );
    } catch (e) {
      // A probe failure must not silently pass the gate.
      blockers.push(
        `Could not verify whether ${displayMobile10(phone)} is reserved by another Cognito account: ${describeCognitoError(e, "AdminGetUser")}`,
      );
    }
  }

  return blockers;
}

/* ------------- action 4: change Cognito mobile / release number ------------- */

/**
 * Why this action exists.
 *
 * The pool is configured `UsernameAttributes: ['phone_number']`, so the number
 * supplied at SIGN-UP becomes the account's sign-in identifier and lives in an
 * internal index that is not the `phone_number` attribute. Every other tool
 * here — and the Cognito console, and the signup Lambdas — reads attributes
 * only, so an account can hold a number as its sign-in identifier while being
 * invisible to every search for it. When that happens, signup for that number
 * fails with `UsernameExistsException` and nothing on screen explains why.
 *
 * This action is the one place that reads BOTH views (`lookupByReservedMobile`
 * for the reservation, `lookupByMobile`/`lookupBySub` for the attribute), shows
 * the operator where they disagree, repoints an account's mobile, and — when
 * another account is squatting on the wanted number — releases it the same way
 * auth-backend does (randomize the phone, then disable).
 *
 * Scope is deliberately Cognito-only: corp/auth `mobile_no` are owned by the
 * event pipeline, and a second writer is what produced this drift in the first
 * place. The DB mobiles are shown for context, never written.
 *
 * Nothing is assumed to have worked: every write is followed by a re-probe and
 * each outcome is reported, because auth-backend's version of this sequence
 * cannot fail visibly and that is why the production case went unnoticed.
 */
function toMobileAccount(u: CognitoUserInfo): CorrectionMobileAccount {
  return {
    sub: u.sub,
    username: u.username,
    shortCode: u.emp_short_code,
    name: u.name,
    status: u.status,
    enabled: u.enabled,
    attributeMobile10: normalizeMobile(u.phone_number),
  };
}

function describeAccount(a: CorrectionMobileAccount): string {
  const bits = [
    a.shortCode ? `short code ${a.shortCode}` : null,
    a.status,
    a.enabled === false ? "disabled" : null,
    a.attributeMobile10 ? `phone attribute ${displayMobile10(a.attributeMobile10)}` : null,
  ].filter(Boolean);
  return `${a.sub ?? a.username ?? "unknown account"}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

export async function changeMobileAndRelease(
  environment: Environment,
  empmasterId: string,
  newMobileInput: string,
  releaseConflicting: boolean,
  preview: boolean,
): Promise<CorrectionMobileChangeResult> {
  const newMobile10 = normalizeMobile(newMobileInput) ?? "";

  const base: CorrectionMobileChangeResult = {
    ok: false,
    message: "",
    newMobile10,
    target: null,
    targetVia: null,
    oldMobile10: null,
    newNumberHolder: null,
    oldNumberHolder: null,
    dbMobile10: { corp: null, auth: null },
    steps: [],
    verifications: [],
    blockers: [],
    warnings: [],
    applied: 0,
    updated: false,
    preview,
  };
  const fail = (
    message: string,
    extra: Partial<CorrectionMobileChangeResult> = {},
  ): CorrectionMobileChangeResult => ({ ...base, ...extra, ok: false, message });

  if (!/^\d{10}$/.test(newMobile10)) {
    return fail("Enter a valid 10-digit mobile number.");
  }

  const corp = await fetchCorpById(environment, empmasterId);
  if (!corp) return fail(`No corp employee with empmaster_id ${empmasterId}.`);
  const corpShortCode = norm(corp.emp_shortcode);
  const corpMobile = normalizeMobile(corp.mobile_no);

  const authMatches = (
    await fetchAuthByShortCodes(environment, [corpShortCode].filter(Boolean))
  ).filter(
    (a) =>
      pairKey(a.short_code, a.company_code) ===
      pairKey(corp.emp_shortcode, corp.company_code),
  );
  const auth = authMatches.length === 1 ? authMatches[0] : null;
  const dbMobile10 = {
    corp: corpMobile,
    auth: auth ? normalizeMobile(auth.mobile_no) : null,
  };

  const warnings: string[] = [];
  const blockers: string[] = [];
  if (authMatches.length > 1) {
    warnings.push(
      `${authMatches.length} auth records match (short code, company code) — the auth mobile shown may not be the right row.`,
    );
  }

  /* ---------------- resolve the account to repoint ---------------- */
  let target: CognitoUserInfo | null = null;
  let targetVia: CorrectionMobileChangeResult["targetVia"] = null;
  try {
    const storedSub = norm(corp.cognito_id) || norm(auth?.cognito_id);
    if (storedSub) {
      target = (await lookupBySub(environment, storedSub))[0] ?? null;
      if (target) targetVia = "sub";
      else
        warnings.push(
          `Stored cognito_id ${storedSub} matches no Cognito account — resolving by mobile instead.`,
        );
    }
    if (!target && corpMobile) {
      const res = resolveCognitoTarget(
        await lookupByMobile(environment, corpMobile),
        corpShortCode,
      );
      if (res.target) {
        target = res.target;
        targetVia = "mobile";
      }
    }
    // Last resort, and the case that matters: the account is findable ONLY
    // through the reservation index because its phone attribute was rewritten.
    // Try the corp mobile, then the wanted number — an account already
    // reserving the wanted number whose short code matches corp IS this
    // employee's account, and repointing it is a realignment, not a claim.
    if (!target) {
      for (const probe of [corpMobile, newMobile10].filter(Boolean) as string[]) {
        const held = await lookupByReservedMobile(environment, probe);
        if (held && (sameCode(held.emp_short_code, corpShortCode) || probe === corpMobile)) {
          target = held;
          targetVia = "reserved";
          break;
        }
      }
    }
  } catch (e) {
    return fail(describeCognitoError(e, "lookup"), { dbMobile10, warnings });
  }

  if (!target) {
    return fail(
      "No Cognito account could be resolved for this employee — by stored cognito_id, by corp mobile, or by reservation. Nothing to repoint.",
      { dbMobile10, warnings },
    );
  }

  const targetAccount = toMobileAccount(target);
  const oldMobile10 = targetAccount.attributeMobile10;
  if (targetVia === "reserved") {
    warnings.push(
      "This account was found only through Cognito's sign-in reservation index — no attribute search can see it, which is why signup for its number fails.",
    );
  }
  if (!sameCode(target.emp_short_code, corpShortCode)) {
    warnings.push(
      `Cognito short code (${norm(target.emp_short_code) || "—"}) ≠ corp short code (${corpShortCode || "—"}) — the account's custom:* attributes are stale and will carry the previous position's claims into RBAC until they are re-synced.`,
    );
  }

  /* ---------------- who holds the numbers involved ---------------- */
  let newNumberHolder: CognitoUserInfo | null = null;
  let oldNumberHolder: CognitoUserInfo | null = null;
  try {
    newNumberHolder = await lookupByReservedMobile(environment, newMobile10);
    oldNumberHolder =
      oldMobile10 && oldMobile10 !== newMobile10
        ? await lookupByReservedMobile(environment, oldMobile10)
        : null;
  } catch (e) {
    return fail(describeCognitoError(e, "AdminGetUser"), {
      target: targetAccount,
      targetVia,
      oldMobile10,
      dbMobile10,
      warnings,
    });
  }

  const sameAccount = (u: CognitoUserInfo | null): boolean =>
    !!u && !!target && norm(u.sub) === norm(target.sub);

  const steps: CorrectionMobileStep[] = [];

  if (newNumberHolder && !sameAccount(newNumberHolder)) {
    const holder = toMobileAccount(newNumberHolder);
    if (!releaseConflicting) {
      blockers.push(
        `${displayMobile10(newMobile10)} is reserved as the sign-in number of another account — ${describeAccount(holder)}. Tick “release the other account” to park a placeholder number on it and disable it, or repoint that employee first.`,
      );
    } else if (!newNumberHolder.username) {
      blockers.push(
        `${displayMobile10(newMobile10)} is reserved by ${describeAccount(holder)}, but that account has no username to write to — release it manually.`,
      );
    } else {
      steps.push({
        kind: "cognitoRelease",
        sub: holder.sub,
        username: newNumberHolder.username,
        shortCode: holder.shortCode,
        mobile10: newMobile10,
      });
    }
  }

  if (!target.username) {
    blockers.push("The target Cognito account has no username — cannot write to it.");
  } else if (oldMobile10 === newMobile10) {
    warnings.push(
      `The account's phone attribute is already ${displayMobile10(newMobile10)} — no attribute write needed.`,
    );
  } else {
    steps.push({
      kind: "cognitoPhone",
      sub: targetAccount.sub,
      username: target.username,
      shortCode: targetAccount.shortCode,
      before: oldMobile10,
      after: newMobile10,
    });
  }

  // The reservation cannot be moved by an attribute write, so state plainly
  // what will and will not be true afterwards rather than implying a full move.
  if (sameAccount(newNumberHolder)) {
    warnings.push(
      `${displayMobile10(newMobile10)} is already this account's sign-in number — this realigns the phone attribute to it.`,
    );
  } else if (!newNumberHolder) {
    warnings.push(
      `${displayMobile10(newMobile10)} is not reserved as any account's sign-in number, so it can only be used for attribute-based flows (OTP/SMS), not for sign-in by number on this account. Sign-in numbers are fixed at signup.`,
    );
  }
  if (oldNumberHolder && sameAccount(oldNumberHolder)) {
    warnings.push(
      `${displayMobile10(oldMobile10!)} stays reserved as this account's sign-in number even after the attribute moves — a fresh signup for it will keep failing with UsernameExistsException.`,
    );
  }

  const summary = steps
    .map((s) =>
      s.kind === "cognitoRelease"
        ? `release ${displayMobile10(s.mobile10)} from ${s.shortCode || s.sub || "the other account"}`
        : `set the phone attribute to ${displayMobile10(s.after)}`,
    )
    .join(", ");

  const withState = (
    extra: Partial<CorrectionMobileChangeResult>,
  ): CorrectionMobileChangeResult => ({
    ...base,
    target: targetAccount,
    targetVia,
    oldMobile10,
    newNumberHolder: newNumberHolder ? toMobileAccount(newNumberHolder) : null,
    oldNumberHolder: oldNumberHolder ? toMobileAccount(oldNumberHolder) : null,
    dbMobile10,
    steps,
    blockers,
    warnings,
    ...extra,
  });

  if (preview) {
    return withState({
      ok: true,
      preview: true,
      message:
        blockers.length > 0
          ? `Blocked — ${blockers.length} problem${blockers.length === 1 ? "" : "s"} must be resolved first.`
          : steps.length === 0
            ? "Nothing to change — the account already carries this number."
            : `Would ${summary}.`,
    });
  }

  if (blockers.length > 0) {
    return withState({ ok: false, message: `Blocked: ${blockers.join(" ")}` });
  }
  if (steps.length === 0) {
    return withState({
      ok: true,
      message: "Nothing to change — the account already carries this number.",
    });
  }

  /* ---------------- apply, each write awaited then verified ---------------- */
  const verifications: CorrectionMobileVerification[] = [];
  let applied = 0;
  try {
    for (const step of steps) {
      if (step.kind === "cognitoRelease") {
        const outcome = await releaseUserPhone(environment, step.username, step.mobile10);
        applied += 1;
        verifications.push({
          label: `${displayMobile10(step.mobile10)} released by ${step.shortCode || step.sub || step.username}`,
          ok: outcome.released,
          detail: outcome.released
            ? `Parked placeholder +91${outcome.placeholder}${outcome.disabled ? " and disabled the account" : " (disable FAILED — see server logs)"}; the number is no longer reserved.`
            : `Parked placeholder +91${outcome.placeholder}${outcome.disabled ? " and disabled the account" : " (disable also FAILED)"}, but the number is STILL reserved by ${outcome.stillHeldBy ? describeAccount(toMobileAccount(outcome.stillHeldBy)) : "an account"}. Signup for it will keep failing.`,
        });
        if (!outcome.released) {
          // Never claim a number was freed when the re-probe says otherwise,
          // and never go on to write it onto another account.
          console.error(
            "[mobile-change] release not verified",
            environment,
            step.mobile10,
            outcome,
          );
          return withState({
            ok: false,
            applied,
            updated: true,
            verifications,
            message: `${displayMobile10(step.mobile10)} could not be released — it is still reserved. Stopped before repointing the employee; nothing else was written.`,
          });
        }
      } else {
        await updateUserPhone(environment, step.username, step.after);
        applied += 1;
        const holderNow = await lookupByReservedMobile(environment, step.after);
        verifications.push({
          label: `Phone attribute set to ${displayMobile10(step.after)}`,
          ok: true,
          detail: "Written and marked verified.",
        });
        verifications.push({
          label: `${displayMobile10(step.after)} usable as this account's sign-in number`,
          ok: sameAccount(holderNow),
          detail: sameAccount(holderNow)
            ? "The reservation already points at this account, so sign-in by this number works."
            : holderNow
              ? `Reserved by a different account — ${describeAccount(toMobileAccount(holderNow))}.`
              : "Not reserved by any account. OTP/SMS flows that read the attribute work; sign-in by this number does not, because sign-in numbers are fixed at signup.",
        });
        if (step.before) {
          const oldNow = await lookupByReservedMobile(environment, step.before);
          verifications.push({
            label: `${displayMobile10(step.before)} free for a new signup`,
            ok: oldNow === null,
            detail:
              oldNow === null
                ? "No longer reserved — a new account can use it."
                : `Still reserved by ${describeAccount(toMobileAccount(oldNow))}. A signup for it will fail with UsernameExistsException.`,
          });
        }
      }
    }
  } catch (e) {
    return withState({
      ok: false,
      applied,
      updated: applied > 0,
      verifications,
      message: `${describeCognitoError(e, "AdminUpdateUserAttributes")} — ${applied} of ${steps.length} step(s) had been applied.`,
    });
  }

  // No audit table exists in this app; the log line is the only trail.
  console.log("[mobile-change]", environment, empmasterId, newMobile10, verifications);

  const failed = verifications.filter((v) => !v.ok);
  return withState({
    ok: true,
    applied,
    updated: true,
    verifications,
    message:
      failed.length === 0
        ? `Applied: ${summary}. All checks passed.`
        : `Applied: ${summary}. ${failed.length} check${failed.length === 1 ? "" : "s"} did not pass — read them before telling the user it is fixed.`,
  });
}

/* ---------------- action 5: release a reserved mobile number ---------------- */

/**
 * Free a mobile number that is stuck as some other account's sign-in
 * identifier, keyed on the NUMBER alone.
 *
 * This is the counterpart to `changeMobileAndRelease`, and the one that fits
 * the actual production symptom. There, an operator knows which employee needs
 * a number; here they only know that a number cannot be signed up: it appears
 * nowhere in Cognito (no account carries it as a `phone_number` attribute, no
 * search finds it, the console shows nothing) yet `SignUp` rejects it as
 * already existing. That happens because the number is still the sign-in
 * identifier of a DIFFERENT account whose phone attribute was rewritten —
 * typically auth-backend's randomize-then-disable release on a deactivation or
 * replace-add, half-applied so that the attribute moved but the sign-in index
 * did not.
 *
 * Releasing it here — rather than reusing the stale account — is the better
 * outcome: once the number is free, the ordinary signup chain runs in full
 * (Pre Sign-up → CustomMessage_SignUp → Post Confirmation), so the new
 * employee gets a fresh account with correct `custom:*` and a `cognito_id`
 * link, instead of inheriting the predecessor's identity attributes.
 *
 * Two attempts, in order, because which one is needed depends on why the index
 * is stale:
 *   1. **re-assert** — write the holder's phone attribute back to the value it
 *      already carries. A write Cognito processes fully re-syncs the sign-in
 *      index, which is all that is needed when a previous write half-applied.
 *   2. **placeholder** — if the number is still reserved, write a fresh
 *      `1`+9-digit placeholder (auth-backend's shape), i.e. move the attribute
 *      to a value the account has never held.
 * Each attempt is verified with `lookupByReservedMobile` before the next is
 * tried, and the tool never claims a release it did not observe.
 *
 * It deliberately does NOT disable the holder, touch its `custom:*`, or write
 * any DB column: the only thing standing between the operator and a working
 * signup is the number.
 */
export async function releaseReservedNumber(
  environment: Environment,
  mobileInput: string,
  preview: boolean,
): Promise<CorrectionReleaseNumberResult> {
  const mobile10 = normalizeMobile(mobileInput) ?? "";
  const base: CorrectionReleaseNumberResult = {
    ok: false,
    message: "",
    mobile10,
    holder: null,
    owners: [],
    attributeMatches: false,
    attempts: [],
    released: false,
    blockers: [],
    warnings: [],
    preview,
  };

  if (!/^\d{10}$/.test(mobile10)) {
    return { ...base, message: "Enter a valid 10-digit mobile number." };
  }

  let held: CognitoUserInfo | null;
  try {
    held = await lookupByReservedMobile(environment, mobile10);
  } catch (e) {
    return { ...base, message: describeCognitoError(e, "AdminGetUser") };
  }

  if (!held) {
    // Worth stating plainly: the number is available, so whatever failed was
    // not a reservation collision and releasing nothing would not fix it.
    return {
      ...base,
      ok: true,
      released: true,
      message: `${displayMobile10(mobile10)} is not reserved by any Cognito account — it is free for a signup. If a signup for it still fails, the cause is elsewhere (check the Pre Sign-up gate and the auth record).`,
    };
  }

  const holder = toMobileAccount(held);
  const attributeMatches = holder.attributeMobile10 === mobile10;
  const blockers: string[] = [];
  const warnings: string[] = [];

  // Who does this account belong to? Releasing a number from an account that a
  // live employee still uses would break their login, so show every row that
  // stores the sub and refuse when the account looks genuinely in use.
  let owners: CorrectionReleaseOwner[] = [];
  if (holder.sub) {
    try {
      owners = (await findCognitoHolders(environment, [holder.sub])).map((h) => ({
        db: h.db,
        table: h.table,
        id: h.id,
        name: h.name,
        shortCode: h.shortCode,
      }));
    } catch (e) {
      warnings.push(
        `Could not check which records store this account's cognito_id: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (attributeMatches) {
    blockers.push(
      `${displayMobile10(mobile10)} is genuinely in use: ${describeAccount(holder)} both reserves it AND carries it as its phone attribute. This is a working account, not a stale reservation — releasing it would break that user's login. If the number must move to someone else, run “Change Cognito mobile” on THAT employee first.`,
    );
  }
  if (owners.length > 0) {
    warnings.push(
      `This account is still linked from ${owners
        .map((o) => `${o.db} ${o.table} row ${o.id}${o.shortCode ? ` (${o.shortCode})` : ""}`)
        .join(", ")} — releasing the number does not unlink it, and those records keep working. Verify none of them is a currently active user of this number.`,
    );
  }
  if (holder.enabled !== false) {
    warnings.push(
      "The holder account is still ENABLED, although a completed release always disables it — further evidence the earlier release half-applied.",
    );
  }

  const state = (
    extra: Partial<CorrectionReleaseNumberResult>,
  ): CorrectionReleaseNumberResult => ({
    ...base,
    holder,
    owners,
    attributeMatches,
    blockers,
    warnings,
    ...extra,
  });

  if (preview) {
    return state({
      ok: true,
      preview: true,
      message:
        blockers.length > 0
          ? "Blocked — see below."
          : `${displayMobile10(mobile10)} is reserved by ${describeAccount(holder)}, whose phone attribute is ${holder.attributeMobile10 ? displayMobile10(holder.attributeMobile10) : "not set"} — which is why no search finds the number. Releasing it re-writes that account's phone attribute (first to the value it already holds, then to a fresh placeholder if needed) until the number is verified free.`,
    });
  }

  if (blockers.length > 0) {
    return state({ message: `Blocked: ${blockers.join(" ")}` });
  }
  if (!held.username) {
    return state({
      message: "The holder account has no username to write to — release it manually.",
    });
  }
  const username = held.username;

  const attempts: CorrectionReleaseAttempt[] = [];
  const currentAttr = held.phone_number;
  try {
    // Attempt 1 — re-assert the existing attribute value verbatim (never
    // reconstructed from the 10-digit form, so a differently-formatted value is
    // preserved exactly).
    if (currentAttr) {
      await updateUserAttributes(environment, username, {
        phone_number: currentAttr,
        phone_number_verified: "true",
      });
      const stillHeld = await lookupByReservedMobile(environment, mobile10);
      attempts.push({
        kind: "reassert",
        wrote: currentAttr,
        released: stillHeld === null,
        detail:
          stillHeld === null
            ? "Re-writing the account's existing phone attribute re-synced the sign-in index and freed the number."
            : `Still reserved by ${describeAccount(toMobileAccount(stillHeld))} — trying a fresh placeholder next.`,
      });
    }

    // Attempt 2 — move the attribute to a value the account has never held.
    if (!attempts.some((a) => a.released)) {
      const placeholder = `+91${generateRandomPhoneNumber()}`;
      await updateUserAttributes(environment, username, {
        phone_number: placeholder,
        phone_number_verified: "true",
      });
      const stillHeld = await lookupByReservedMobile(environment, mobile10);
      attempts.push({
        kind: "placeholder",
        wrote: placeholder,
        released: stillHeld === null,
        detail:
          stillHeld === null
            ? "Moving the phone attribute to a fresh placeholder freed the number."
            : `Still reserved by ${describeAccount(toMobileAccount(stillHeld))}. The sign-in identifier is not moving — in this pool it may be permanent, in which case the number can only be reused by reusing that account (mobile-verification's ensureCognitoAccount does exactly that on the next login).`,
      });
    }
  } catch (e) {
    return state({
      attempts,
      message: `${describeCognitoError(e, "AdminUpdateUserAttributes")} — ${attempts.length} attempt(s) had been made.`,
    });
  }

  const released = attempts.some((a) => a.released);
  console.log("[release-number]", environment, mobile10, {
    holder: holder.sub,
    attempts,
    released,
  });

  return state({
    ok: released,
    released,
    attempts,
    message: released
      ? `${displayMobile10(mobile10)} is now free — verified with AdminGetUser. A signup for it will go through the normal chain (Pre Sign-up → CustomMessage_SignUp → Post Confirmation), so the new account gets its own custom:* attributes and cognito_id.`
      : `${displayMobile10(mobile10)} is STILL reserved by ${describeAccount(holder)} after ${attempts.length} attempt(s). Nothing else was changed — do not retry blindly; read the attempt details.`,
  });
}
