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
  CorrectionConflict,
  CorrectionEmployee,
  CorrectionEventSummary,
  CorrectionField,
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

    // 1. Cognito phone updates — "other" users first so a contested mobile is
    // freed before another account claims it. The only kind of Cognito write.
    const plannedPhones = new Map<string, string>(); // sub → new mobile
    const ordered = [
      ...participants.filter((p) => p.role === "other"),
      ...participants.filter((p) => p.role === "analyzed"),
    ];
    for (const p of ordered) {
      if (!p.account || !p.needsPhone || !p.mobile10) continue;
      const holders = (await byMobile(p.mobile10)).filter(
        (u) => norm(u.sub) !== norm(p.account!.sub),
      );
      const blocking = holders.filter((u) => {
        const moved = plannedPhones.get(norm(u.sub));
        return moved === undefined || moved === p.mobile10;
      });
      if (blocking.length > 0) {
        warnings.push(
          `Cannot set ${norm(p.corp.emp_shortcode)}'s Cognito mobile to ${p.mobile10} — account ${blocking
            .map((u) => norm(u.emp_short_code) || norm(u.sub))
            .join(", ")} already holds it; that update is skipped (repair that user first).`,
        );
        p.notes.push("Cognito mobile update skipped — number occupied");
        continue;
      }
      steps.push({
        kind: "cognitoPhone",
        sub: norm(p.account.sub),
        username: norm(p.account.username),
        shortCode: norm(p.corp.emp_shortcode),
        before: displayMobile10(p.account.phone_number),
        after: p.mobile10,
      });
      plannedPhones.set(norm(p.account.sub), p.mobile10);
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
        message: `Repair plan for ${participants.length} user${participants.length === 1 ? "" : "s"}: ${summary || "no steps yet"}.${blockers.length > 0 ? " Blocked until the missing auth record(s) are created." : ""}`,
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
    return fail(describeCognitoError(e));
  }
}
