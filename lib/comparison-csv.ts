import type {
  AuthComparisonResult,
  AuthComparisonRow,
  CognitoUserInfo,
} from "./types";

/**
 * Flattens an AuthComparisonResult into a spreadsheet-friendly CSV: each
 * compared field gets one column per source (auth / corp / cognito) sitting
 * side by side, followed by the per-field mismatch flags and the status notes.
 * Type-only imports keep this module safe to use from the client bundle.
 */

const HEADERS = [
  "Short Code",
  "Present in Auth",
  "Present in Corp",
  "Name (Auth)",
  "Name (Corp)",
  "Name (Cognito)",
  "Name Mismatch",
  "Mobile (Auth)",
  "Mobile (Corp)",
  "Mobile (Cognito)",
  "Mobile Mismatch",
  "Cognito ID (Auth)",
  "Cognito ID (Corp)",
  "Cognito Sub (by Mobile)",
  "Cognito ID Mismatch (Auth vs Corp)",
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
    r.key,
    yn(r.flags.presentInAuth),
    yn(r.flags.presentInCorp),
    r.auth?.name ?? "",
    r.corp?.emp_name ?? "",
    live ? joinCognito(c.byMobile, (u) => u.name) : "",
    yn(r.flags.nameMismatch),
    r.auth?.mobile_no ?? "",
    r.corp?.mobile_no ?? "",
    live ? joinCognito(c.byMobile, (u) => u.phone_number) : "",
    yn(r.flags.mobileMismatch),
    r.auth?.cognito_id ?? "",
    r.corp?.cognito_id ?? "",
    live ? joinCognito(c.byMobile, (u) => u.sub) : "",
    yn(r.flags.cognitoIdMismatch),
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
