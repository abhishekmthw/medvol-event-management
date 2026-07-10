import { authSchema, getAuthPool, getPool } from "./db";
import { describeCognitoError, lookupByMobile } from "./cognito";
import { norm, normalizeMobile, pairKey } from "./auth-comparison";
import { displayMobile10, normalizeName } from "./format";
import { sendAuthQueueMessage } from "./sqs";
import type {
  CognitoUserInfo,
  CorrectionAnalyzeResult,
  CorrectionEmployee,
  CorrectionEventSummary,
  CorrectionField,
  CorrectionFixResult,
  CorrectionReplayResult,
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

/** Another corp/auth record already holding a cognito_id we'd write. */
type CognitoIdConflict = {
  source: "corp" | "auth";
  id: string;
  shortCode: string | null;
  companyCode: string | null;
  name: string | null;
};

/**
 * Rows OTHER than the employee being corrected that already store the given
 * sub as their cognito_id — in corp `empmaster_hdr` and auth
 * `Field_Force_Users`. A cognito_id must identify exactly one record per
 * table; writing a sub that exists elsewhere would create a duplicate (this
 * happened once in production), so any hit blocks the fix.
 */
async function findCognitoIdConflicts(
  environment: Environment,
  sub: string,
  excludeCorpId: string,
  excludeAuthId: string | null,
): Promise<CognitoIdConflict[]> {
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
      (r): CognitoIdConflict => ({
        source: "corp",
        id: r.id,
        shortCode: r.short_code,
        companyCode: r.company_code,
        name: r.name,
      }),
    ),
    ...authRes.rows.map(
      (r): CognitoIdConflict => ({
        source: "auth",
        id: r.id,
        shortCode: r.short_code,
        companyCode: r.company_code,
        name: r.name,
      }),
    ),
  ];
}

function describeConflicts(conflicts: CognitoIdConflict[]): string {
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
  } else if (sub === "" && (norm(corp.cognito_id) || norm(auth?.cognito_id))) {
    // A cognito_id is stored somewhere but no live user could be resolved.
    statuses.push("Stored cognito_id could not be validated against Cognito");
  }

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
    fields,
    actions: {
      createInAuth: !presentInAuth,
      fixCognitoId: cognitoIdNeedsFix && presentInAuth && authMatches.length <= 1,
      fixCognitoIdBlockedReason: fixBlockedReason,
      syncAuthFromCorp: syncNeeded && !syncBlockedReason,
      syncAuthBlockedReason: syncBlockedReason,
      cognitoAttributeDrift,
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
    const conflicts = await findCognitoIdConflicts(
      environment,
      sub,
      emp.empmasterId,
      emp.authId,
    );
    if (conflicts.length > 0) {
      emp.blockers.push(
        `Cognito sub is also stored on: ${describeConflicts(conflicts)} — a cognito_id must identify exactly one record`,
      );
      if (emp.actions.fixCognitoId) {
        emp.actions.fixCognitoId = false;
        emp.actions.fixCognitoIdBlockedReason =
          "The live sub is already stored on another record — resolve the duplicate first";
      }
      emp.consistent = false;
    }
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
  const conflicts = await findCognitoIdConflicts(
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
