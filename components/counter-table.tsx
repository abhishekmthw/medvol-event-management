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
                <td key={c.key} className="px-3 py-2 align-middle font-mono">
                  {formatCell(row[c.key], c.isDate)}
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
