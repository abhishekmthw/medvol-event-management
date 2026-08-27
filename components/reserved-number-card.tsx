"use client";

import { useState } from "react";
import clsx from "clsx";
import { AlertTriangle, Info, KeyRound, Loader2, Search, Wrench } from "lucide-react";
import { displayMobile10 } from "@/lib/format";
import type { CorrectionReleaseNumberResult, Environment } from "@/lib/types";

/**
 * Reserved mobile number — its own card because it is keyed on a NUMBER, not on
 * an employee, and it is the one writing surface left on this page.
 *
 * The pool is `UsernameAttributes: ['phone_number']`, so the number given at
 * sign-up becomes an account's sign-in identifier in an internal index that
 * `ListUsers` — and therefore the console search and every comparison card —
 * cannot see. When that account's `phone_number` attribute is later rewritten
 * (auth-backend's randomize-then-disable release on a deactivation or
 * replace-add), the account disappears from every search while still HOLDING
 * the number: signups fail `UsernameExistsException` with nothing on screen to
 * explain it. No employee-driven analysis can find that account, which is
 * exactly why this tool takes only a number.
 */

/**
 * "This number cannot be signed up, but Cognito shows nothing" — keyed on the
 * NUMBER, not on an employee, because in this state no analysis can find the
 * account: it holds the number only as a sign-in identifier (the pool is
 * `UsernameAttributes: ['phone_number']`) while its `phone_number` attribute
 * points somewhere else, so it is invisible to every search and to the console.
 *
 * Check is the read-only preview; Release performs the writes. Releasing is
 * preferable to reusing the stale account — once the number is free the normal
 * signup chain runs in full and the new user gets their own `custom:*` and
 * `cognito_id`.
 */
export function ReservedNumberCard({
  environment,
  onSessionExpired,
}: {
  environment: Environment;
  onSessionExpired: () => Promise<void>;
}) {
  const isProd = environment === "prod";
  async function post<T>(url: string, body: unknown): Promise<T | null> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      await onSessionExpired();
      return null;
    }
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error ?? `Request failed (HTTP ${res.status}).`);
    }
    return data as T;
  }

  const [mobile, setMobile] = useState("");
  const [phase, setPhase] = useState<"idle" | "checking" | "checked" | "running" | "done">(
    "idle",
  );
  const [preview, setPreview] = useState<CorrectionReleaseNumberResult | null>(null);
  const [result, setResult] = useState<CorrectionReleaseNumberResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = phase === "checking" || phase === "running";

  async function run(isPreview: boolean) {
    setError(null);
    if (isPreview) {
      setPreview(null);
      setResult(null);
    }
    setPhase(isPreview ? "checking" : "running");
    try {
      const data = await post<CorrectionReleaseNumberResult>(
        "/api/auth-comparison/correction/release-number",
        { environment, mobile: mobile.trim(), preview: isPreview },
      );
      if (data === null) return;
      if (isPreview) {
        setPreview(data);
        setPhase("checked");
      } else {
        setResult(data);
        setPhase("done");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase(isPreview ? "idle" : "checked");
    }
  }

  const shown = result ?? preview;
  const blocked = (preview?.blockers.length ?? 0) > 0 || !preview?.holder;

  return (
    <section className="card p-5 sm:p-6 space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-[hsl(var(--primary))]" />
        <h2 className="text-sm font-semibold uppercase tracking-wider">
          Reserved mobile number
        </h2>
        <span
          className={clsx(
            "ml-auto pill",
            isProd
              ? "bg-red-500/15 text-red-600 dark:text-red-400"
              : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
          )}
        >
          <AlertTriangle className="h-3 w-3" />
          writes on release
        </span>
        <span className="pill bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
          Cognito sign-in index
        </span>
      </div>
      <p className="text-xs text-[hsl(var(--muted-foreground))]">
        For a number that <strong>cannot be signed up</strong> (
        <code>UsernameExistsException</code>) although no Cognito search — the
        console included — finds it. The number is still the sign-in identifier
        of another account whose phone attribute was rewritten. Check identifies
        that account; Release frees the number so a normal signup can claim it.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input-base w-44 font-mono text-[13px]"
          placeholder="10-digit mobile"
          inputMode="numeric"
          maxLength={13}
          value={mobile}
          onChange={(e) => {
            setMobile(e.target.value);
            setPhase("idle");
            setPreview(null);
            setResult(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy && mobile.trim()) run(true);
          }}
        />
        <button
          type="button"
          className="btn-ghost h-9"
          onClick={() => run(true)}
          disabled={busy || !mobile.trim()}
        >
          {phase === "checking" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          Check
        </button>
        {phase !== "idle" && preview?.holder && (
          <button
            type="button"
            className={isProd ? "btn-danger" : "btn-primary"}
            onClick={() => run(false)}
            disabled={busy || blocked}
            title={
              blocked ? "Resolve the blocker first — see the message below" : undefined
            }
          >
            {phase === "running" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Wrench className="h-4 w-4" />
            )}
            Release the number
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      {shown && (
        <div
          className={clsx(
            "rounded-lg px-3 py-2 text-xs flex items-start gap-2",
            shown.blockers.length > 0 || (phase === "done" && !shown.ok)
              ? "border border-[hsl(var(--danger))]/40 bg-[hsl(var(--danger))]/10 text-[hsl(var(--danger))]"
              : "border border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
          )}
        >
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{shown.message}</span>
        </div>
      )}

      {/* The holder — the account no search can find. */}
      {shown?.holder && (
        <div className="rounded-lg border border-[hsl(var(--border))] overflow-x-auto">
          <table className="w-full text-xs">
            <tbody>
              <Row
                label="Reserved by"
                value={shown.holder.sub ?? shown.holder.username ?? "—"}
                note={[
                  shown.holder.name,
                  shown.holder.shortCode,
                  shown.holder.status,
                  shown.holder.enabled === false ? "disabled" : "enabled",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
              <Row
                label="Its phone attribute"
                value={
                  (shown.holder.attributeMobile10 &&
                    displayMobile10(shown.holder.attributeMobile10)) ||
                  "not set"
                }
                note={
                  shown.attributeMatches
                    ? "same as the number — this account is genuinely using it"
                    : "different from the number — why no search finds it"
                }
              />
              {shown.owners.length > 0 && (
                <Row
                  label="cognito_id stored in"
                  value={shown.owners
                    .map(
                      (o) =>
                        `${o.db} ${o.table} #${o.id}${o.shortCode ? ` (${o.shortCode})` : ""}`,
                    )
                    .join(", ")}
                />
              )}
            </tbody>
          </table>
        </div>
      )}

      {(shown?.blockers.length ?? 0) > 0 || (shown?.warnings.length ?? 0) > 0 ? (
        <Notices
          blockers={shown!.blockers}
          warnings={shown!.warnings}
        />
      ) : null}

      {/* Attempts, in the order they were tried, each verified. */}
      {result && result.attempts.length > 0 && (
        <div className="rounded-lg border border-[hsl(var(--border))] px-3 py-2 space-y-1 text-[11px]">
          <p className="font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide text-[10px]">
            Attempts
          </p>
          {result.attempts.map((a, i) => (
            <p
              key={i}
              className={clsx(
                "leading-snug",
                a.released
                  ? "text-emerald-700 dark:text-emerald-400"
                  : "text-amber-700 dark:text-amber-400",
              )}
            >
              {a.released ? "✓" : "✕"} {i + 1}.{" "}
              {a.kind === "reassert"
                ? "re-wrote the existing phone attribute"
                : "moved the phone attribute to a fresh placeholder"}{" "}
              <span className="font-mono">{a.wrote}</span> — {a.detail}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

/** One label/value line of the holder table. */
function Row({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <tr className="border-t border-[hsl(var(--border))] first:border-t-0">
      <td className="px-3 py-1.5 whitespace-nowrap text-[hsl(var(--muted-foreground))]">
        {label}
      </td>
      <td className="px-3 py-1.5 font-mono break-all">
        {value}
        {note ? (
          <span className="block text-[10px] font-sans text-[hsl(var(--muted-foreground))] break-all">
            {note}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

/** Refusals (red — the release button is disabled) and cautions (amber). */
function Notices({
  blockers,
  warnings,
}: {
  blockers: string[];
  warnings: string[];
}) {
  return (
    <>
      {blockers.length > 0 && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 space-y-1 text-xs text-red-600 dark:text-red-400">
          {blockers.map((b, i) => (
            <p key={i}>{b}</p>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 space-y-1 text-[11px] text-amber-700 dark:text-amber-400">
          {warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}
    </>
  );
}
