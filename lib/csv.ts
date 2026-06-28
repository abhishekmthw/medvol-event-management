import type { CounterColumn } from "./types";

/**
 * Serialize rows to CSV text (RFC-4180-ish). Fields containing a comma, quote,
 * or newline are wrapped in double quotes with embedded quotes doubled. The
 * header row uses the column labels; cells are read by each column's `key`.
 */
export function rowsToCsv(
  columns: CounterColumn[],
  rows: Record<string, unknown>[],
): string {
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => escape(c.label)).join(",");
  const body = rows.map((row) => columns.map((c) => escape(row[c.key])).join(","));
  return [header, ...body].join("\r\n");
}
