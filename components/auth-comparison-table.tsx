"use client";

import clsx from "clsx";
import type {
  AuthComparisonRow,
  CognitoLookup,
  CognitoUserInfo,
} from "@/lib/types";

/**
 * Read-only comparison table for the Auth Details Comparison tab. Corp is the
 * base + source of truth (shown first); auth and the live Cognito user are
 * compared against it. One row per corp employee; each field stacks the
 * corp / auth / cognito values, and cells that deviate from their source of
 * truth are tinted red.
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
          {rows.map((r) => {
            const cognitoMismatch =
              r.flags.authCorpCognitoMismatch ||
              r.flags.corpCognitoMismatch ||
              r.flags.authCognitoMismatch;
            return (
              <tr
                key={r.key}
                className="border-t border-[hsl(var(--border))] align-top hover:bg-[hsl(var(--muted))]/40"
              >
                <Td className="font-mono whitespace-nowrap">{r.shortCode || "—"}</Td>
                <Td className="font-mono whitespace-nowrap">{r.companyCode || "—"}</Td>

                {/* Name: corp (truth) / auth / cognito (by mobile) */}
                <Td>
                  <Stack mismatch={r.flags.nameMismatch}>
                    <Line label="corp" value={r.corp?.emp_name} present={r.corp != null} />
                    <Line label="auth" value={r.auth?.name} present={r.flags.presentInAuth} />
                    <CognitoLine cognito={r.cognito} pick={(u) => u.name} />
                  </Stack>
                </Td>

                {/* Mobile: corp (truth) / auth / cognito (by mobile) */}
                <Td>
                  <Stack mismatch={r.flags.mobileMismatch}>
                    <Line label="corp" value={r.corp?.mobile_no} present={r.corp != null} mono />
                    <Line label="auth" value={r.auth?.mobile_no} present={r.flags.presentInAuth} mono />
                    <CognitoLine cognito={r.cognito} pick={(u) => u.phone_number} mono />
                  </Stack>
                </Td>

                {/* Cognito ID: corp / auth / live sub by mobile (the truth) */}
                <Td>
                  <Stack mismatch={cognitoMismatch}>
                    <Line label="corp" value={r.corp?.cognito_id} present={r.corp != null} mono />
                    <Line label="auth" value={r.auth?.cognito_id} present={r.flags.presentInAuth} mono />
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
