"use client";

import clsx from "clsx";
import type { EmployeeCognitoRow } from "@/lib/types";

/**
 * Results table for the Employee ↔ Cognito Check card. One row per mismatched
 * auth employee; each field stacks the auth / cognito / corp values (the auth
 * record is the scan base; the Cognito user is matched by the stored
 * cognito_id, the corp record by the (short code, company code) pair), and
 * fields that disagree are tinted red.
 */
export function EmployeeCognitoTable({ rows }: { rows: EmployeeCognitoRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-[hsl(var(--muted-foreground))] py-6 text-center">
        No mismatches to display.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-[hsl(var(--border))]">
      <table className="w-full text-xs">
        <thead className="bg-[hsl(var(--muted))]/60 text-[hsl(var(--muted-foreground))]">
          <tr>
            <Th>Company</Th>
            <Th>Short code</Th>
            <Th>Name</Th>
            <Th>Mobile</Th>
            <Th>Cognito ID</Th>
            <Th>Cognito user</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.key}
              className="border-t border-[hsl(var(--border))] align-top hover:bg-[hsl(var(--muted))]/40"
            >
              <Td className="font-mono whitespace-nowrap">
                {r.auth.company_code || "—"}
              </Td>

              {/* Short code: auth vs cognito custom:emp_short_code vs corp key */}
              <Td>
                <Stack mismatch={r.flags.shortCodeMismatch}>
                  <Line label="auth" value={r.auth.short_code} mono />
                  <CognitoLine row={r} value={r.cognito?.emp_short_code} mono />
                  <CorpLine row={r} value={r.corp?.emp_shortcode} mono />
                </Stack>
              </Td>

              {/* Name: auth vs cognito vs corp */}
              <Td>
                <Stack mismatch={r.flags.corpNameMismatch}>
                  <Line label="auth" value={r.auth.name} />
                  <CognitoLine row={r} value={r.cognito?.name} />
                  <CorpLine row={r} value={r.corp?.emp_name} />
                </Stack>
              </Td>

              {/* Mobile: auth vs cognito phone_number vs corp */}
              <Td>
                <Stack
                  mismatch={r.flags.mobileMismatch || r.flags.corpMobileMismatch}
                >
                  <Line label="auth" value={r.auth.mobile_no} mono />
                  <CognitoLine row={r} value={r.cognito?.phone_number} mono />
                  <CorpLine row={r} value={r.corp?.mobile_no} mono />
                </Stack>
              </Td>

              {/* Cognito ID: auth (the looked-up sub) vs corp's stored copy */}
              <Td>
                <Stack
                  mismatch={
                    r.flags.notFoundInCognito || r.flags.corpCognitoIdMismatch
                  }
                >
                  <Line label="auth" value={r.auth.cognito_id} mono />
                  <CorpLine row={r} value={r.corp?.cognito_id} mono />
                </Stack>
              </Td>

              {/* Cognito account state, for context on the matched user */}
              <Td className="whitespace-nowrap">
                {r.cognito ? (
                  <div className="flex flex-col gap-0.5 leading-tight">
                    <span className="font-mono break-all">
                      {r.cognito.username || "—"}
                    </span>
                    <span className="text-[hsl(var(--muted-foreground))]">
                      {r.cognito.status ?? "—"}
                      {r.cognito.enabled === false ? " · disabled" : ""}
                    </span>
                  </div>
                ) : (
                  <span className="text-[hsl(var(--muted-foreground))] italic">
                    {r.error ? "error" : "not found"}
                  </span>
                )}
              </Td>

              <Td>
                <div className="flex flex-col gap-1 items-start">
                  {r.statuses.map((s, j) => (
                    <span
                      key={j}
                      className="pill bg-amber-500/15 text-amber-700 dark:text-amber-400 whitespace-nowrap"
                      title={s === "Cognito lookup error" ? r.error : undefined}
                    >
                      {s}
                    </span>
                  ))}
                </div>
              </Td>
            </tr>
          ))}
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

function LabeledValue({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5 leading-tight">
      <span className="text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))] w-9 shrink-0">
        {label}
      </span>
      <span className={clsx(mono && "font-mono", "break-all")}>{children}</span>
    </div>
  );
}

function Line({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <LabeledValue label={label} mono={mono}>
      {value && value.trim() ? (
        value
      ) : (
        <span className="text-[hsl(var(--muted-foreground))]">—</span>
      )}
    </LabeledValue>
  );
}

/** The Cognito line — shows the live value, or why it's absent. */
function CognitoLine({
  row,
  value,
  mono,
}: {
  row: EmployeeCognitoRow;
  value: string | null | undefined;
  mono?: boolean;
}) {
  let content: React.ReactNode;
  if (row.error) {
    content = <span className="text-red-600 dark:text-red-400">error</span>;
  } else if (row.cognito === null) {
    content = (
      <span className="text-[hsl(var(--muted-foreground))] italic">
        not found
      </span>
    );
  } else if (value && value.trim()) {
    content = value;
  } else {
    content = <span className="text-[hsl(var(--muted-foreground))]">—</span>;
  }
  return (
    <LabeledValue label="cog" mono={mono}>
      {content}
    </LabeledValue>
  );
}

/** The corp line — shows the corp value, or that no corp record matched. */
function CorpLine({
  row,
  value,
  mono,
}: {
  row: EmployeeCognitoRow;
  value: string | null | undefined;
  mono?: boolean;
}) {
  let content: React.ReactNode;
  if (row.corp === null) {
    content = (
      <span className="text-[hsl(var(--muted-foreground))] italic">
        not found
      </span>
    );
  } else if (value && value.trim()) {
    content = value;
  } else {
    content = <span className="text-[hsl(var(--muted-foreground))]">—</span>;
  }
  return (
    <LabeledValue label="corp" mono={mono}>
      {content}
    </LabeledValue>
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
