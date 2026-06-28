"use client";

import clsx from "clsx";
import type {
  AuthComparisonRow,
  CognitoLookup,
  CognitoUserInfo,
} from "@/lib/types";

/** Status messages that mean the stored cognito_id disagrees with live Cognito. */
const COGNITO_CROSSCHECK_STATUSES = new Set([
  "auth cognito_id ≠ Cognito (by mobile)",
  "corp cognito_id ≠ Cognito (by mobile)",
  "cognito_id not found in Cognito",
  "No Cognito user for mobile",
  "Cognito phone ≠ DB mobile (by sub)",
]);

/**
 * Read-only three-way comparison table for the Auth Details Comparison tab.
 * One row per reconciled employee; each compared field stacks the auth / corp /
 * cognito values so disagreements are visible at a glance. Mismatching cells are
 * tinted red.
 */
export function AuthComparisonTable({ rows }: { rows: AuthComparisonRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-[hsl(var(--muted-foreground))] py-6 text-center">
        No records to display.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-[hsl(var(--border))]">
      <table className="w-full text-xs">
        <thead className="bg-[hsl(var(--muted))]/60 text-[hsl(var(--muted-foreground))]">
          <tr>
            <Th>Short code</Th>
            <Th>Company</Th>
            <Th>Name</Th>
            <Th>Mobile</Th>
            <Th>Cognito ID</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const cognitoIdCellMismatch =
              r.flags.cognitoIdMismatch ||
              r.statuses.some((s) => COGNITO_CROSSCHECK_STATUSES.has(s));
            return (
            <tr
              key={`${r.key}-${i}`}
              className="border-t border-[hsl(var(--border))] align-top hover:bg-[hsl(var(--muted))]/40"
            >
              <Td className="font-mono whitespace-nowrap">{r.shortCode || "—"}</Td>
              <Td className="font-mono whitespace-nowrap">{r.companyCode || "—"}</Td>

              {/* Name: auth / corp / cognito (by mobile) */}
              <Td>
                <Stack mismatch={r.flags.nameMismatch}>
                  <Line label="auth" value={r.auth?.name} present={r.flags.presentInAuth} />
                  <Line label="corp" value={r.corp?.emp_name} present={r.flags.presentInCorp} />
                  <CognitoLine
                    cognito={r.cognito}
                    pick={(u) => u.name}
                  />
                </Stack>
              </Td>

              {/* Mobile: auth / corp / cognito (by mobile) */}
              <Td>
                <Stack mismatch={r.flags.mobileMismatch}>
                  <Line
                    label="auth"
                    value={r.auth?.mobile_no}
                    present={r.flags.presentInAuth}
                    mono
                  />
                  <Line
                    label="corp"
                    value={r.corp?.mobile_no}
                    present={r.flags.presentInCorp}
                    mono
                  />
                  <CognitoLine cognito={r.cognito} pick={(u) => u.phone_number} mono />
                </Stack>
              </Td>

              {/* Cognito ID: auth.cognito_id / corp.cognito_id / live sub by mobile */}
              <Td>
                <Stack mismatch={cognitoIdCellMismatch}>
                  <Line
                    label="auth"
                    value={r.auth?.cognito_id}
                    present={r.flags.presentInAuth}
                    mono
                  />
                  <Line
                    label="corp"
                    value={r.corp?.cognito_id}
                    present={r.flags.presentInCorp}
                    mono
                  />
                  <CognitoLine cognito={r.cognito} pick={(u) => u.sub} mono labelText="cog" />
                </Stack>
              </Td>

              {/* Status chips */}
              <Td>
                {r.statuses.length === 0 ? (
                  <span className="pill bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                    Consistent
                  </span>
                ) : (
                  <div className="flex flex-col gap-1 items-start">
                    {r.statuses.map((s, j) => (
                      <span
                        key={j}
                        className="pill bg-amber-500/15 text-amber-700 dark:text-amber-400 whitespace-nowrap"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )}
              </Td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Stack({
  children,
  mismatch,
}: {
  children: React.ReactNode;
  mismatch?: boolean;
}) {
  return (
    <div
      className={clsx(
        "flex flex-col gap-0.5 rounded px-1.5 py-1",
        mismatch && "bg-red-500/10 ring-1 ring-red-500/30",
      )}
    >
      {children}
    </div>
  );
}

function Line({
  label,
  value,
  present,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  present: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5 leading-tight">
      <span className="text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))] w-9 shrink-0">
        {label}
      </span>
      <span className={clsx(mono && "font-mono", "break-all")}>
        {!present ? (
          <span className="text-[hsl(var(--muted-foreground))] italic">absent</span>
        ) : value && value.trim() ? (
          value
        ) : (
          <span className="text-[hsl(var(--muted-foreground))]">—</span>
        )}
      </span>
    </div>
  );
}

/** The Cognito "by mobile" line — shows the live value, or why it's absent. */
function CognitoLine({
  cognito,
  pick,
  mono,
  labelText = "cog",
}: {
  cognito: CognitoLookup;
  pick: (u: CognitoUserInfo) => string | null;
  mono?: boolean;
  labelText?: string;
}) {
  let content: React.ReactNode;
  if (!cognito.checked) {
    content = (
      <span className="text-[hsl(var(--muted-foreground))] italic">
        not checked
      </span>
    );
  } else if (cognito.error) {
    content = <span className="text-red-600 dark:text-red-400">error</span>;
  } else if (cognito.byMobile.length === 0) {
    content = (
      <span className="text-[hsl(var(--muted-foreground))] italic">
        no match
      </span>
    );
  } else {
    const values = Array.from(
      new Set(cognito.byMobile.map((u) => (pick(u) ?? "").trim()).filter(Boolean)),
    );
    content = values.length ? (
      values.join(", ")
    ) : (
      <span className="text-[hsl(var(--muted-foreground))]">—</span>
    );
  }
  return (
    <div className="flex items-baseline gap-1.5 leading-tight">
      <span className="text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))] w-9 shrink-0">
        {labelText}
      </span>
      <span className={clsx(mono && "font-mono", "break-all")}>{content}</span>
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
  return <td className={clsx("px-3 py-2", className)}>{children}</td>;
}
