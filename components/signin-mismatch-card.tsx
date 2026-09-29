"use client";

import { useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  Info,
  Loader2,
  LogIn,
  Search,
  Wrench,
} from "lucide-react";
import { displayMobile10 } from "@/lib/format";
import type {
  CorrectionSigninMismatchResult,
  Environment,
  SigninIndexVerdict,
} from "@/lib/types";

/**
 * Sign-in number mismatch — the inverse of the Reserved mobile number card
 * directly above it, and a separate card because it is a different failure with
 * a different repair.
 *
 * That card answers "who is holding this number?" — a number nothing can sign
 * up. This one answers "does this account's number actually sign in?" — a
 * number that looks perfectly healthy in the console and on every comparison
 * card, yet throws `UserNotFoundException` on every login attempt.
 *
 * The pool is `UsernameAttributes: ['phone_number']`, so a number lives in two
 * indexes: the SIGN-IN identifier (`AdminGetUser`, the only lookup
 * `InitiateAuth` agrees with) and the editable `phone_number` ATTRIBUTE
 * (`ListUsers`, console search). A changed number becomes the new sign-in name
 * only when it is free AND the update is marked verified, so a write that left
 * `phone_number_verified` unparseable updates the attribute and strands the
 * sign-in name on the OLD number.
 *
 * Unlike "Change Cognito mobile", this is keyed on a number or a sub rather
 * than an employee id, so it works for counters and stockists too — which is
 * where it was first seen in production.
 */
export function SigninMismatchCard({
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

  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<
    "idle" | "checking" | "checked" | "running" | "done"
  >("idle");
  const [preview, setPreview] = useState<CorrectionSigninMismatchResult | null>(
    null,
  );
  const [result, setResult] = useState<CorrectionSigninMismatchResult | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const busy = phase === "checking" || phase === "running";

  // One box for both inputs: a sub is unmistakable (it has hyphens and letters),
  // so making the operator choose a field would be friction for no gain.
  const trimmed = input.trim();
  const looksLikeSub = /[a-f-]/i.test(trimmed);

  async function run(isPreview: boolean) {
    setError(null);
    if (isPreview) {
      setPreview(null);
      setResult(null);
    }
    setPhase(isPreview ? "checking" : "running");
    try {
      const data = await post<CorrectionSigninMismatchResult>(
        "/api/auth-comparison/correction/signin-mismatch",
        {
          environment,
          mobile: looksLikeSub ? "" : trimmed,
          sub: looksLikeSub ? trimmed : "",
          preview: isPreview,
        },
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
  // Repair is only meaningful for the one verdict it can actually fix.
  const repairable = preview?.verdict === "attribute-only";
  const blocked = (preview?.blockers.length ?? 0) > 0 || !repairable;

  return (
    <section className="card p-5 sm:p-6 space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <LogIn className="h-4 w-4 text-[hsl(var(--primary))]" />
        <h2 className="text-sm font-semibold uppercase tracking-wider">
          Sign-in number mismatch
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
          writes on repair
        </span>
        <span className="pill bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
          Cognito sign-in index
        </span>
      </div>
      <p className="text-xs text-[hsl(var(--muted-foreground))]">
        For a user who <strong>cannot log in</strong> (
        <code>UserNotFoundException</code>) although the Cognito console shows
        their number on the account, verified. The number was written to the{" "}
        <code>phone_number</code> attribute without the sign-in name following —
        typically after a mobile change. Check compares both indexes; Repair
        re-asserts the attribute as verified and confirms the number signs in
        again. Works for any user type, counters included.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input-base w-80 font-mono text-[13px]"
          placeholder="10-digit mobile, or Cognito sub"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setPhase("idle");
            setPreview(null);
            setResult(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy && trimmed) run(true);
          }}
        />
        <button
          type="button"
          className="btn-ghost h-9"
          onClick={() => run(true)}
          disabled={busy || !trimmed}
        >
          {phase === "checking" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          Check
        </button>
        {phase !== "idle" && preview && (
          <button
            type="button"
            className={isProd ? "btn-danger" : "btn-primary"}
            onClick={() => run(false)}
            disabled={busy || blocked}
            title={
              blocked
                ? "Only an attribute-only mismatch can be repaired here — see the message below"
                : undefined
            }
          >
            {phase === "running" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Wrench className="h-4 w-4" />
            )}
            Repair the sign-in number
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

      {/* The two indexes, side by side — the whole point of the card. */}
      {shown && (shown.attributeAccount || shown.signinAccount) && (
        <div className="rounded-lg border border-[hsl(var(--border))] overflow-x-auto">
          <table className="w-full text-xs">
            <tbody>
              <Row
                label="Verdict"
                value={VERDICT_LABEL[shown.verdict]}
                note={VERDICT_NOTE[shown.verdict]}
              />
              <Row
                label="Number checked"
                value={displayMobile10(shown.mobile10) ?? "—"}
              />
              <Row
                label="Carries it as an attribute"
                value={
                  shown.attributeAccount
                    ? (shown.attributeAccount.sub ??
                      shown.attributeAccount.username ??
                      "—")
                    : "no account"
                }
                note={
                  shown.attributeAccount
                    ? [
                        shown.attributeAccount.name,
                        shown.attributeAccount.shortCode,
                        shown.attributeAccount.status,
                        shown.attributeAccount.enabled === false
                          ? "disabled"
                          : "enabled",
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "what the console and every search see"
                }
              />
              <Row
                label="Signs in as"
                value={
                  shown.signinAccount
                    ? (shown.signinAccount.sub ??
                      shown.signinAccount.username ??
                      "—")
                    : "nothing — the number signs in nowhere"
                }
                note={
                  shown.signinAccount
                    ? [
                        shown.signinAccount.name,
                        shown.signinAccount.shortCode,
                        shown.signinAccount.attributeMobile10
                          ? `phone attribute ${displayMobile10(shown.signinAccount.attributeMobile10)}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "this is what InitiateAuth and AdminGetUser see, and why login 404s"
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
        <Notices blockers={shown!.blockers} warnings={shown!.warnings} />
      ) : null}

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
                a.repaired
                  ? "text-emerald-700 dark:text-emerald-400"
                  : "text-amber-700 dark:text-amber-400",
              )}
            >
              {a.repaired ? "✓" : "✕"} {i + 1}. re-asserted the phone attribute as
              verified <span className="font-mono">{a.wrote}</span> — {a.detail}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

const VERDICT_LABEL: Record<SigninIndexVerdict, string> = {
  aligned: "Aligned",
  "attribute-only": "Attribute only — repairable here",
  "reserved-only": "Reserved only",
  conflict: "Conflict",
  free: "Free",
};

const VERDICT_NOTE: Record<SigninIndexVerdict, string> = {
  aligned: "both indexes agree; the login failure has another cause",
  "attribute-only":
    "the account carries the number but it signs in nowhere — this is the mobile-change bug",
  "reserved-only":
    "the number signs in but its holder's attribute differs — use the Reserved mobile number card",
  conflict: "the two indexes resolve to different accounts; reconcile by hand",
  free: "neither index knows this number",
};

/** One label/value line of the comparison table. */
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

/** Refusals (red — the repair button is disabled) and cautions (amber). */
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
