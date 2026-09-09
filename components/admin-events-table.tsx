"use client";

import clsx from "clsx";
import type {
  AdminEventRow,
  AdminEventUser,
  AdminRoleGroup,
} from "@/lib/types";

const GROUP_LABEL: Record<AdminRoleGroup, string> = {
  "all-companies": "All companies",
  "specific-companies": "Specific companies",
};

function GroupPill({ group }: { group: AdminRoleGroup }) {
  return (
    <span
      className={clsx(
        "pill whitespace-nowrap",
        group === "specific-companies"
          ? "bg-violet-500/15 text-violet-600 dark:text-violet-400"
          : "bg-sky-500/15 text-sky-600 dark:text-sky-400",
      )}
    >
      {GROUP_LABEL[group]}
    </span>
  );
}

/** Candidate users shown in the preview modal, before anything is sent. */
export function AdminEventUsersTable({ users }: { users: AdminEventUser[] }) {
  if (users.length === 0) {
    return (
      <p className="text-sm text-[hsl(var(--muted-foreground))] py-4 text-center">
        No eligible admin users matched.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-[hsl(var(--border))]">
      <table className="w-full text-xs">
        <thead className="bg-[hsl(var(--muted))]/60 text-[hsl(var(--muted-foreground))]">
          <tr>
            <Th>ID</Th>
            <Th>Name</Th>
            <Th>Mobile</Th>
            <Th>Email</Th>
            <Th>Role ID</Th>
            <Th>Body</Th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr
              key={u.id}
              className="border-t border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))]/40"
            >
              <Td className="font-mono">{u.id}</Td>
              <Td>{u.name ?? "—"}</Td>
              <Td className="font-mono">{u.mobile_no ?? "—"}</Td>
              <Td className="max-w-[220px] truncate">{u.email ?? "—"}</Td>
              <Td className="font-mono">{u.user_role_id}</Td>
              <Td>
                <GroupPill group={u.group} />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Per-user push outcomes, accumulated across chunks. */
export function AdminEventsTable({ rows }: { rows: AdminEventRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-[hsl(var(--muted-foreground))] py-4 text-center">
        No results yet.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-[hsl(var(--border))]">
      <table className="w-full text-xs">
        <thead className="bg-[hsl(var(--muted))]/60 text-[hsl(var(--muted-foreground))]">
          <tr>
            <Th>ID</Th>
            <Th>Name</Th>
            <Th>Mobile</Th>
            <Th>Role ID</Th>
            <Th>Body</Th>
            <Th>Result</Th>
            <Th>HTTP</Th>
            <Th>Response</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-t border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))]/40"
            >
              <Td className="font-mono">{r.id}</Td>
              <Td>{r.name ?? "—"}</Td>
              <Td className="font-mono">{r.mobile_no ?? "—"}</Td>
              <Td className="font-mono">{r.user_role_id}</Td>
              <Td>
                <GroupPill group={r.group} />
              </Td>
              <Td>
                <span
                  className={clsx(
                    "pill",
                    r.ok
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-red-500/15 text-red-600 dark:text-red-400",
                  )}
                >
                  {r.ok ? "Sent" : "Failed"}
                </span>
              </Td>
              <Td className="font-mono">{r.status ?? "—"}</Td>
              <Td className="max-w-[360px]">
                <span className="block truncate" title={r.detail}>
                  {r.detail}
                </span>
              </Td>
            </tr>
          ))}
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
