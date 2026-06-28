"use client";

import clsx from "clsx";
import type { OtpBlockRow } from "@/lib/types";

/** Results / candidates table for the 24h OTP Block tab. */
export function OtpBlockTable({ rows }: { rows: OtpBlockRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-[hsl(var(--muted-foreground))] py-4 text-center">
        No matching user rows to display.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-[hsl(var(--border))]">
      <table className="w-full text-xs">
        <thead className="bg-[hsl(var(--muted))]/60 text-[hsl(var(--muted-foreground))]">
          <tr>
            <Th>ID</Th>
            <Th>Mobile</Th>
            <Th>Name</Th>
            <Th>OTP Retry Count</Th>
            <Th>Lockup Date</Th>
            <Th>State</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const blocked =
              r.otp_retry_count != null || r.lockup_date != null;
            return (
              <tr
                key={r.id}
                className="border-t border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))]/40"
              >
                <Td className="font-mono">{r.id}</Td>
                <Td className="font-mono">{r.mobile_no ?? "—"}</Td>
                <Td>{r.name ?? "—"}</Td>
                <Td className="font-mono">{r.otp_retry_count ?? "—"}</Td>
                <Td className="whitespace-nowrap">
                  {r.lockup_date
                    ? new Date(r.lockup_date).toLocaleString()
                    : "—"}
                </Td>
                <Td>
                  <span
                    className={clsx(
                      "pill",
                      blocked
                        ? "bg-red-500/15 text-red-600 dark:text-red-400"
                        : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
                    )}
                  >
                    {blocked ? "Blocked" : "Clear"}
                  </span>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-left font-medium px-3 py-2 whitespace-nowrap">
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={clsx("px-3 py-2 align-middle", className)}>{children}</td>
  );
}
