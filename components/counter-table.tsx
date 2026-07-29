"use client";

import type { CounterColumn } from "@/lib/types";

/**
 * Generic, column-driven results table for the Counter Events views. Unlike the
 * fixed-shape EventTable/BatchTable, columns vary per view, so they're passed in.
 */
export function CounterTable({
  columns,
  rows,
}: {
  columns: CounterColumn[];
  rows: Record<string, unknown>[];
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-[hsl(var(--muted-foreground))] py-4 text-center">
        No rows to display.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-[hsl(var(--border))]">
      <table className="w-full text-xs">
        <thead className="bg-[hsl(var(--muted))]/60 text-[hsl(var(--muted-foreground))]">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className="text-left font-medium px-3 py-2 whitespace-nowrap"
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className="border-t border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))]/40"
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={
                    c.json
                      ? "px-3 py-2 align-top font-mono"
                      : "px-3 py-2 align-middle font-mono"
                  }
                >
                  {c.json ? (
                    <JsonCell value={row[c.key]} />
                  ) : (
                    formatCell(row[c.key], c.isDate)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(value: unknown, isDate?: boolean): string {
  if (value === null || value === undefined || value === "") return "—";
  if (isDate) {
    const d = new Date(value as string);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
  }
  return String(value);
}

/**
 * Renders a JSON payload cell. The value arrives as a JSON string (from
 * `jsonb::text`); we pretty-print it for readability and keep it inside a
 * bounded, scrollable box so a large payload never blows out the table layout.
 * Falls back to the raw string if it isn't valid JSON.
 */
function JsonCell({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return <span>—</span>;
  }
  const raw = String(value);
  let text = raw;
  try {
    text = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // Not JSON — show the raw string as-is.
  }
  return (
    <pre className="max-w-[520px] max-h-56 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-snug">
      {text}
    </pre>
  );
}
