export type Environment = "prod" | "stage";
export type Service = "corp" | "oms";

export type Target = {
  environment: Environment;
  service: Service;
  /** Private-instance id (matches PRIVATE_INSTANCE_{ID}_*). null = shared. */
  instance: string | null;
};

/** Payload returned by GET /api/instances and consumed by the UI. */
export type InstanceOption = {
  id: string;
  label: string;
  service: Service;
};

export type ActionKey =
  | "clear-by-event-ids"
  | "refire-by-event-ids"
  | "clear-by-stream-ids"
  | "clear-batch"
  | "status";

export const ACTIONS: {
  key: ActionKey;
  label: string;
  description: string;
  inputLabel: string;
  inputPlaceholder: string;
  inputHint: string;
  danger?: boolean;
}[] = [
  {
    key: "clear-by-event-ids",
    label: "Clear by Event IDs",
    description:
      "Force-success failed V2 events. Deletes the SQS message and sets forceStatus=true.",
    inputLabel: "Event IDs",
    inputPlaceholder: "45635815, 28156150, 28120800",
    inputHint: "Comma-separated numeric event IDs.",
    danger: true,
  },
  {
    key: "refire-by-event-ids",
    label: "Refire by Event IDs",
    description:
      "Change SQS visibility so failed V2 events are re-processed by the consumer.",
    inputLabel: "Event IDs",
    inputPlaceholder: "28156150, 28120800",
    inputHint: "Comma-separated numeric event IDs.",
  },
  {
    key: "clear-by-stream-ids",
    label: "Clear by Stream IDs",
    description:
      "Force-success every failed V2 event currently on the given stream(s).",
    inputLabel: "Stream IDs",
    inputPlaceholder: "counter_200746, order_375159",
    inputHint: "Comma-separated stream IDs (domain_primaryKey).",
    danger: true,
  },
  {
    key: "clear-batch",
    label: "Clear Batch Events",
    description:
      "Delete the EventBridge scheduler for failed batch_event_status rows and mark them ForceSuccess.",
    inputLabel: "Batch IDs",
    inputPlaceholder: "batch_20250908101020465, batch_20250911113445795",
    inputHint: "Comma-separated batch IDs (from batch_event_status.batch_id).",
    danger: true,
  },
  {
    key: "status",
    label: "Check Status",
    description:
      "Look up current event_consumer_status rows for the given event IDs or stream IDs.",
    inputLabel: "Event IDs or Stream IDs",
    inputPlaceholder: "45635815  •or•  counter_200746",
    inputHint:
      "Comma-separated. Numeric tokens are treated as event IDs; non-numeric as stream IDs.",
  },
];

export type EventStatusRow = {
  id: number;
  eventid: string;
  streamid: string;
  consumer_name: string;
  event_status: string;
  forceStatus: boolean;
  receipthandle: string | null;
  approximatereceivecount: number | null;
  sentry_issue_id: string | null;
  sentry_issue_status: string | null;
  error_message: string | null;
  modified_date: string | null;
  event_type: string | null;
};

export type BatchStatusRow = {
  id: number;
  batch_id: string;
  batch_sequence: number | string;
  event_type: string;
  event_status: string;
  force_status: boolean;
  data: unknown;
  modified_date: string | null;
};

/* ------------------------------------------------------------------ *
 * Counter Events — read-only browser over public.events (Corp DB).
 * ------------------------------------------------------------------ */

export type CounterView = "division" | "products" | "stockist";

/** A column in a counter results table — drives both the SQL alias and the UI header. */
export type CounterColumn = {
  /** Matches the SELECT alias / row key. */
  key: string;
  label: string;
  /** Render as a localized date/time. */
  isDate?: boolean;
};

/** Filters for a counter-events query. `streamIds` is mandatory; the rest are optional. */
export type CounterFilters = {
  streamIds: string[];
  companyCode?: string | null;
  /** company_divisioncode — applies to products + division views only. */
  divisionCode?: string | null;
  locationCode?: string | null;
  /** ISO date (YYYY-MM-DD), inclusive lower bound on events.timestamp. */
  fromDate?: string | null;
  /** ISO date (YYYY-MM-DD), inclusive upper bound (matched as `< toDate + 1 day`). */
  toDate?: string | null;
};

export type CounterQueryResult = {
  ok: boolean;
  columns: CounterColumn[];
  rows: Record<string, unknown>[];
  count: number;
  /** True when the row cap was hit and results were trimmed. */
  truncated: boolean;
  message: string;
};

/** Option for the company / division cascading dropdowns (name shown, code submitted). */
export type CounterOption = { code: string; name: string };

export type OperationResult = {
  ok: boolean;
  message: string;
  attempted: number;
  cleared: number;
  errors: { id: string | number; reason: string }[];
  events?: EventStatusRow[];
  batch?: BatchStatusRow[];
  /** When true, no mutations were performed; rows shown are candidates. */
  preview?: boolean;
  /** Number of rows that would be mutated if executed (preview only). */
  candidates?: number;
  /**
   * Subset of `cleared` where the SQS message was already gone (receipt
   * handle expired after 15 days, or absent). The DB row was still updated.
   * Always 0 for refire / changeVisibility, which never updates the DB.
   */
  gone?: number;
};

/* ------------------------------------------------------------------ *
 * 24h OTP Block — clears otp_retry_count + lockup_date on the V1 auth
 * user tables (auth-backend / Corp DB) so a locked-out user can log in.
 * ------------------------------------------------------------------ */

export type OtpUserType =
  | "stockist"
  | "fieldforce"
  | "counter"
  | "delegate"
  | "admin";

/** UI ordering + labels for the user-type selector. Also the allow-list. */
export const OTP_USER_TYPES: { value: OtpUserType; label: string }[] = [
  { value: "stockist", label: "Stockist" },
  { value: "fieldforce", label: "Field Force" },
  { value: "counter", label: "Counter" },
  { value: "delegate", label: "Delegate" },
  { value: "admin", label: "Admin" },
];

/** A matched user row, with its current OTP-block state. */
export type OtpBlockRow = {
  id: string;
  mobile_no: string | null;
  /** null for the Counter link table, which has no `name` column. */
  name: string | null;
  otp_retry_count: number | null;
  lockup_date: string | null;
};

export type OtpBlockResult = {
  ok: boolean;
  message: string;
  /** Rows matched by the supplied mobile number(s). */
  attempted: number;
  /** Rows actually updated (otp_retry_count + lockup_date set NULL). */
  cleared: number;
  /** Informational notes — e.g. mobile numbers with no matching user. */
  errors: { mobile: string; reason: string }[];
  /** Current state of the matched rows (before on preview, after on run). */
  rows: OtpBlockRow[];
  /** When true, no mutations were performed; rows shown are candidates. */
  preview?: boolean;
  /** Number of rows that would be mutated if executed (preview only). */
  candidates?: number;
};

/* ------------------------------------------------------------------ *
 * Auth Details Comparison — READ-ONLY three-way reconciliation of
 * field-force employees across the auth DB (Field_Force_Users), the
 * corp DB (empmaster_hdr) and AWS Cognito. Compares name, short code,
 * mobile number and cognito id. No writes anywhere.
 * ------------------------------------------------------------------ */

/** Which employees to include in the comparison. */
export type EmployeeScope = "active" | "all";

export const EMPLOYEE_SCOPES: { value: EmployeeScope; label: string }[] = [
  { value: "active", label: "Active only" },
  { value: "all", label: "All employees" },
];

/** A field-force employee row from the auth DB (`Field_Force_Users`). */
export type AuthEmployeeRow = {
  id: string;
  short_code: string | null;
  company_code: string | null;
  name: string | null;
  mobile_no: string | null;
  cognito_id: string | null;
  active_status: string | null;
};

/** A field-force employee row from the corp DB (`empmaster_hdr`). */
export type CorpEmployeeRow = {
  empmaster_id: string;
  emp_shortcode: string | null;
  company_code: string | null;
  emp_name: string | null;
  mobile_no: string | null;
  cognito_id: string | null;
  active_status: string | null;
};

/** A Cognito user parsed from a `ListUsers` result. */
export type CognitoUserInfo = {
  sub: string | null;
  name: string | null;
  phone_number: string | null;
  /** `custom:emp_short_code` — the field-force short code stored on the Cognito user. */
  emp_short_code: string | null;
  /** `custom:ucode` — the user's ucode stored on the Cognito user. */
  ucode: string | null;
  username: string | null;
  status: string | null;
  enabled: boolean | null;
};

/** Cognito enrichment attached to one comparison record. */
export type CognitoLookup = {
  /** False when the lookup was skipped (cognito_id null in both DBs). */
  checked: boolean;
  /** Why the lookup was skipped, when `checked` is false. */
  skippedReason?: string;
  /** Users matched by `phone_number = "+91<mobile>"`. */
  byMobile: CognitoUserInfo[];
  /** Users matched by `sub = "<cognito_id>"`, per distinct stored cognito_id. */
  bySub: { cognitoId: string; users: CognitoUserInfo[] }[];
  /** Non-fatal error encountered while querying Cognito for this record. */
  error?: string;
};

/**
 * Disagreement flags for one corp employee (corp is the base + source of truth
 * for name/short code/company code/mobile; Cognito is the source of truth for
 * cognito_id). All comparisons are "X deviates from the source of truth".
 */
export type AuthComparisonFlags = {
  /** A matching auth record was found for this corp (short_code, company_code). */
  presentInAuth: boolean;
  /** auth.name differs from corp.emp_name (corp = truth). */
  nameMismatch: boolean;
  /** auth.mobile_no differs from corp.mobile_no (corp = truth). */
  mobileMismatch: boolean;
  /** auth.cognito_id differs from corp.cognito_id (cheap DB-vs-DB proxy). */
  authCorpCognitoMismatch: boolean;
  /** corp.cognito_id differs from the live Cognito sub (set after enrichment). */
  corpCognitoMismatch: boolean;
  /** auth.cognito_id differs from the live Cognito sub (set after enrichment). */
  authCognitoMismatch: boolean;
};

/** One corp employee reconciled against auth and Cognito. */
export type AuthComparisonRow = {
  /** Unique row key (corp empmaster_id) — React key / dedup only. */
  key: string;
  /** Employee short code (corp = source of truth). */
  shortCode: string;
  /** Company code (corp = source of truth). */
  companyCode: string;
  /** The corp employee — always present (corp is the base set). */
  corp: CorpEmployeeRow | null;
  /** The matching auth record, or null when missing in auth. */
  auth: AuthEmployeeRow | null;
  cognito: CognitoLookup;
  flags: AuthComparisonFlags;
  /** True if missing in auth or any field deviates from its source of truth. */
  inconsistent: boolean;
  /** Human-readable status chips (e.g. "Missing in auth", "corp cognito_id ≠ Cognito"). */
  statuses: string[];
};

export type AuthComparisonResult = {
  ok: boolean;
  message: string;
  mode: "single" | "bulk";
  environment: Environment;
  scope: EmployeeScope;
  /** Bulk mode: total inconsistent records found before truncation. */
  totalInconsistent?: number;
  /** Bulk mode: true when results were capped at the limit. */
  truncated?: boolean;
  rows: AuthComparisonRow[];
};

/* ------------------------------------------------------------------ *
 * Employee ↔ Cognito Check — READ-ONLY scan of ALL auth employees
 * (Field_Force_Users) that have a cognito_id: each is looked up in
 * Cognito by sub, then mobile number and short code are compared
 * between the auth record and the live Cognito user. The scan is
 * chunked (one API call per chunk) so the client can walk the whole
 * table without hitting serverless timeouts.
 * ------------------------------------------------------------------ */

/** Disagreement flags for one auth employee vs Cognito and corp. */
export type EmployeeCognitoFlags = {
  /** The stored cognito_id matched no Cognito user (stale sub). */
  notFoundInCognito: boolean;
  /** auth.mobile_no differs from the Cognito phone_number. */
  mobileMismatch: boolean;
  /** auth.short_code differs from Cognito custom:emp_short_code. */
  shortCodeMismatch: boolean;
  /** No corp empmaster_hdr record for the auth (short code, company code). */
  missingInCorp: boolean;
  /** auth.name differs from corp.emp_name. */
  corpNameMismatch: boolean;
  /** auth.mobile_no differs from corp.mobile_no. */
  corpMobileMismatch: boolean;
  /** auth.cognito_id differs from corp.cognito_id. */
  corpCognitoIdMismatch: boolean;
};

/** One auth employee checked against Cognito + corp (only mismatches are returned). */
export type EmployeeCognitoRow = {
  /** Unique row key (auth Field_Force_Users.id). */
  key: string;
  auth: AuthEmployeeRow;
  /** The Cognito user matched by sub, or null when not found / lookup failed. */
  cognito: CognitoUserInfo | null;
  /** The corp record matched by (short code, company code), or null when missing. */
  corp: CorpEmployeeRow | null;
  /** Corp records matching the pair (>1 = duplicate short code in corp). */
  corpMatchCount: number;
  /** Non-fatal Cognito error for this record (lookup skipped comparison). */
  error?: string;
  flags: EmployeeCognitoFlags;
  /** Human-readable status chips (e.g. "Mobile ≠ Cognito"). */
  statuses: string[];
};

/* ------------------------------------------------------------------ *
 * Employee Data Correction — corp-driven, mobile-keyed. Corp
 * (empmaster_hdr) is the source of truth for short code / mobile /
 * name / ucode; Cognito is the source of truth for cognito_id. Two
 * corrective actions, both preview-then-confirm:
 *   1. Missing in auth → replay the employee_<empmaster_id> stream
 *      events from corp public.events onto the V1 auth SQS FIFO queue
 *      (the auth-backend consumer re-creates the user).
 *   2. Fix cognito_id → resolve the live Cognito user by corp mobile
 *      (guarded by custom:emp_short_code = corp short code) and write
 *      its sub into corp.empmaster_hdr and auth.Field_Force_Users.
 * ------------------------------------------------------------------ */

/** One compared field with its per-source values + deviation flags. */
export type CorrectionField = {
  key: string;
  label: string;
  /** mismatch = corp deviates from THIS FIELD's source of truth (only ever
   * true for cognito_id, where Cognito is the truth). */
  corp: { value: string | null; mismatch: boolean };
  auth: { value: string | null; present: boolean; mismatch: boolean };
  cognito: { value: string | null; present: boolean; mismatch: boolean };
};

/** One corp employee analyzed for correction. */
export type CorrectionEmployee = {
  empmasterId: string;
  /** The event stream that would be replayed to create the user in auth. */
  streamId: string;
  shortCode: string;
  companyCode: string;
  activeStatus: string | null;
  presentInAuth: boolean;
  /** Auth Field_Force_Users.id of the matched record (null when missing). */
  authId: string | null;
  /** Auth records matching (short code, company code) — >1 blocks fixes. */
  authMatchCount: number;
  /** The live Cognito user resolved by corp mobile + matching short code. */
  cognitoTarget: CognitoUserInfo | null;
  /** All Cognito users found for the corp mobile (context / ambiguity). */
  cognitoByMobileCount: number;
  fields: CorrectionField[];
  actions: {
    /** Missing in auth → offer the event replay. */
    createInAuth: boolean;
    /** A resolved Cognito sub differs from corp/auth cognito_id → offer fix. */
    fixCognitoId: boolean;
    /** Why the cognito_id fix is currently blocked (when it IS needed). */
    fixCognitoIdBlockedReason?: string;
  };
  /** Conditions that prevent automatic correction (need manual attention). */
  blockers: string[];
  statuses: string[];
  consistent: boolean;
  /** Non-fatal Cognito lookup error for this employee. */
  cognitoError?: string;
};

export type CorrectionAnalyzeResult = {
  ok: boolean;
  message: string;
  environment: Environment;
  mobile10: string;
  employees: CorrectionEmployee[];
};

/** Summary of one corp event row (for the replay preview list). */
export type CorrectionEventSummary = {
  eventId: string;
  event_type: string;
  timestamp: string | null;
};

export type CorrectionReplayResult = {
  ok: boolean;
  message: string;
  streamId: string;
  totalEvents: number;
  events: CorrectionEventSummary[];
  /** Messages actually sent to the auth queue (0 in preview). */
  sent: number;
  errors: { eventId: string; reason: string }[];
  preview: boolean;
};

export type CorrectionFixResult = {
  ok: boolean;
  message: string;
  /** The live Cognito sub being written. */
  sub: string;
  corp: { empmasterId: string; before: string | null; needsUpdate: boolean; updated: boolean };
  auth: { id: string; before: string | null; needsUpdate: boolean; updated: boolean };
  preview: boolean;
};

/** One chunk of the employee ↔ Cognito scan. */
export type EmployeeCognitoChunk = {
  ok: boolean;
  environment: Environment;
  scope: EmployeeScope;
  /** Employees in scope (regardless of cognito_id) — context only. */
  totalEmployees: number;
  /** Employees in scope that have a cognito_id — the scan base. */
  totalWithCognitoId: number;
  /** Offset of this chunk within the scan base. */
  offset: number;
  /** Employees checked in this chunk. */
  checked: number;
  /** Offset to request next, or null when the scan is complete. */
  nextOffset: number | null;
  /** Mismatched employees found in this chunk. */
  rows: EmployeeCognitoRow[];
};
