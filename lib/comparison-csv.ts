import type {
  AuthComparisonResult,
  AuthComparisonRow,
  CognitoUserInfo,
  EmployeeCognitoRow,
} from "./types";

/**
 * Flattens an AuthComparisonResult into a spreadsheet-friendly CSV. Corp is the
 * base + source of truth (its value comes first per field); auth and the live
 * Cognito user are compared against it. Columns: identity, presence, then each
 * field with corp/auth/cognito values + the deviation flags, then status notes.
 * Type-only imports keep this module safe to use from the client bundle.
 */

const HEADERS = [
  "Short Code",
  "Company Code",
  "Present in Auth",
  "Name (Corp)",
  "Name (Auth)",
  "Name (Cognito)",
  "Name Differs From Corp",
  "Mobile (Corp)",
  "Mobile (Auth)",
  "Mobile (Cognito)",
  "Mobile Differs From Corp",
  "Cognito ID (Corp)",
  "Cognito ID (Auth)",
  "Cognito Sub (by Mobile)",
  "auth vs corp cognito_id",
  "corp cognito_id vs Cognito",
  "auth cognito_id vs Cognito",
  "Cognito Checked",
  "Cognito Note",
  "Status",
];

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  // Quote when the value contains a delimiter/quote/newline or padding space.
  if (/[",\r\n]/.test(s) || s !== s.trim()) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function yn(b: boolean): string {
  return b ? "Yes" : "No";
}

function joinCognito(
  users: CognitoUserInfo[],
  pick: (u: CognitoUserInfo) => string | null,
): string {
  const vals = Array.from(
    new Set(users.map((u) => (pick(u) ?? "").trim()).filter(Boolean)),
  );
  return vals.join(" | ");
}

function rowCells(r: AuthComparisonRow): string[] {
  const c = r.cognito;
  const live = c.checked && !c.error;
  const cogNote = !c.checked
    ? c.skippedReason ?? "Not checked"
    : c.error ?? "";
  return [
    r.shortCode,
    r.companyCode,
    yn(r.flags.presentInAuth),
    r.corp?.emp_name ?? "",
    r.auth?.name ?? "",
    live ? joinCognito(c.byMobile, (u) => u.name) : "",
    yn(r.flags.nameMismatch),
    r.corp?.mobile_no ?? "",
    r.auth?.mobile_no ?? "",
    live ? joinCognito(c.byMobile, (u) => u.phone_number) : "",
    yn(r.flags.mobileMismatch),
    r.corp?.cognito_id ?? "",
    r.auth?.cognito_id ?? "",
    live ? joinCognito(c.byMobile, (u) => u.sub) : "",
    yn(r.flags.authCorpCognitoMismatch),
    yn(r.flags.corpCognitoMismatch),
    yn(r.flags.authCognitoMismatch),
    yn(c.checked),
    cogNote,
    r.statuses.join("; "),
  ];
}

/** UTF-8 byte-order mark so Excel renders non-ASCII (e.g. "≠") correctly. */
const BOM = String.fromCharCode(0xfeff);

export function toComparisonCsv(result: AuthComparisonResult): string {
  const rows = [HEADERS, ...result.rows.map(rowCells)];
  const body = rows.map((cells) => cells.map(csvCell).join(",")).join("\r\n");
  return BOM + body + "\r\n";
}

/* ------------- Employee ↔ Cognito Check (mismatches only) ------------- */

const EMP_COGNITO_HEADERS = [
  "Auth ID",
  "Company Code",
  "Name (Auth)",
  "Short Code (Auth)",
  "Short Code (Cognito)",
  "Short Code Mismatch",
  "Mobile (Auth)",
  "Mobile (Cognito)",
  "Mobile Mismatch",
  "Cognito ID (Auth)",
  "Found in Cognito",
  "Cognito Username",
  "Cognito Status",
  "Cognito Enabled",
  "Cognito Note",
  "Status",
];

function empCognitoRowCells(r: EmployeeCognitoRow): string[] {
  return [
    r.auth.id,
    r.auth.company_code ?? "",
    r.auth.name ?? "",
    r.auth.short_code ?? "",
    r.cognito?.emp_short_code ?? "",
    yn(r.flags.shortCodeMismatch),
    r.auth.mobile_no ?? "",
    r.cognito?.phone_number ?? "",
    yn(r.flags.mobileMismatch),
    r.auth.cognito_id ?? "",
    yn(r.cognito !== null),
    r.cognito?.username ?? "",
    r.cognito?.status ?? "",
    r.cognito ? yn(r.cognito.enabled !== false) : "",
    r.error ?? "",
    r.statuses.join("; "),
  ];
}

export function toEmployeeCognitoCsv(rows: EmployeeCognitoRow[]): string {
  const all = [EMP_COGNITO_HEADERS, ...rows.map(empCognitoRowCells)];
  const body = all.map((cells) => cells.map(csvCell).join(",")).join("\r\n");
  return BOM + body + "\r\n";
}
