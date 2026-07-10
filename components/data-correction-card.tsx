"use client";

import { useRef, useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  CircleAlert,
  Info,
  Loader2,
  RefreshCw,
  Search,
  Wrench,
} from "lucide-react";
import { displayMobile10 } from "@/lib/format";
import type {
  CorrectionAnalyzeResult,
  CorrectionClearResult,
  CorrectionEmployee,
  CorrectionField,
  CorrectionFixResult,
  CorrectionReleaseResult,
  CorrectionReplayResult,
  CorrectionSyncResult,
  Environment,
} from "@/lib/types";

/**
 * Employee Data Correction card (Auth Details Comparison tab).
 *
 * Corp-driven and mobile-keyed: enter a mobile → the corp employee(s) holding
 * it are analyzed against auth and Cognito (corp = truth for short code /
 * mobile / name / ucode; Cognito = truth for cognito_id). Two corrective
 * actions, each preview-then-confirm:
 *   1. Missing in auth → replay the employee's corp event stream onto the V1
 *      auth SQS queue, then poll until the user appears in auth.
 *   2. Fix cognito_id → write the live Cognito sub (matched by corp mobile +
 *      short code) into corp and auth.
 */

type ActionKind = "replay" | "fix" | "sync" | "release" | "clear";

type ActionState = {
  kind: ActionKind;
  empmasterId: string;
  shortCode: string;
  phase: "previewing" | "confirm" | "running" | "done";
  replayPreview?: CorrectionReplayResult;
  replayResult?: CorrectionReplayResult;
  fixPreview?: CorrectionFixResult;
  fixResult?: CorrectionFixResult;
  syncPreview?: CorrectionSyncResult;
  syncResult?: CorrectionSyncResult;
  releasePreview?: CorrectionReleaseResult;
  releaseResult?: CorrectionReleaseResult;
  clearPreview?: CorrectionClearResult;
  clearResult?: CorrectionClearResult;
  error?: string;
};

const POLL_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 3000;

export function DataCorrectionCard({
  environment,
  onSessionExpired,
}: {
  environment: Environment;
  onSessionExpired: () => Promise<void>;
}) {
  const isProd = environment === "prod";

  const [mobile, setMobile] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<CorrectionAnalyzeResult | null>(null);
  const [topError, setTopError] = useState<string | null>(null);
  const [action, setAction] = useState<ActionState | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollNote, setPollNote] = useState<string | null>(null);
  /** Bumped on every new analyze/action so stale async flows stop writing state. */
  const genRef = useRef(0);

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

  async function analyze(silent = false) {
    // A user-initiated analyze supersedes any in-flight flow (bumps the
    // generation); a silent re-check (post-action refresh, polling) must NOT
    // bump it, or it would cancel the very poll loop that called it.
    const gen = silent ? genRef.current : ++genRef.current;
    if (!silent) {
      setTopError(null);
      setResult(null);
      setAction(null);
      setPolling(false);
      setPollNote(null);
      setAnalyzing(true);
    }
    try {
      const data = await post<CorrectionAnalyzeResult>(
        "/api/auth-comparison/correction/analyze",
        { environment, mobile: mobile.trim() },
      );
      if (gen !== genRef.current || data === null) return null;
      setResult(data);
      return data;
    } catch (e) {
      if (gen === genRef.current) {
        setTopError(e instanceof Error ? e.message : String(e));
      }
      return null;
    } finally {
      if (!silent && gen === genRef.current) setAnalyzing(false);
    }
  }

  /* ------------------------- replay (create in auth) ------------------------- */

  async function startReplay(emp: CorrectionEmployee) {
    setPollNote(null);
    setAction({
      kind: "replay",
      empmasterId: emp.empmasterId,
      shortCode: emp.shortCode,
      phase: "previewing",
    });
    try {
      const preview = await post<CorrectionReplayResult>(
        "/api/auth-comparison/correction/replay",
        { environment, empmasterId: emp.empmasterId, preview: true },
      );
      if (preview === null) return;
      if (!preview.ok) {
        setAction((a) => a && { ...a, phase: "done", error: preview.message });
        return;
      }
      setAction((a) => a && { ...a, phase: "confirm", replayPreview: preview });
    } catch (e) {
      setAction(
        (a) =>
          a && {
            ...a,
            phase: "done",
            error: e instanceof Error ? e.message : String(e),
          },
      );
    }
  }

  async function confirmReplay() {
    if (!action || action.kind !== "replay") return;
    setAction({ ...action, phase: "running" });
    try {
      const run = await post<CorrectionReplayResult>(
        "/api/auth-comparison/correction/replay",
        { environment, empmasterId: action.empmasterId, preview: false },
      );
      if (run === null) return;
      setAction((a) => a && { ...a, phase: "done", replayResult: run });
      if (run.ok) await pollUntilInAuth(action.empmasterId);
    } catch (e) {
      setAction(
        (a) =>
          a && {
            ...a,
            phase: "done",
            error: e instanceof Error ? e.message : String(e),
          },
      );
    }
  }

  /** After a replay, poll the analysis until the employee shows up in auth. */
  async function pollUntilInAuth(empmasterId: string) {
    const gen = genRef.current;
    setPolling(true);
    try {
      for (let i = 1; i <= POLL_ATTEMPTS; i++) {
        setPollNote(
          `Waiting for the auth consumer… re-checking (${i}/${POLL_ATTEMPTS})`,
        );
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (gen !== genRef.current) return;
        const data = await analyze(true);
        if (gen !== genRef.current) return;
        const emp = data?.employees.find((e) => e.empmasterId === empmasterId);
        if (emp?.presentInAuth) {
          setPollNote(
            "Employee is now present in auth — review the comparison below and fix the cognito_id if still needed.",
          );
          return;
        }
      }
      setPollNote(
        "Employee has not appeared in auth yet. The consumer may still be processing (or the event failed — check the auth-backend Event_Failures). Use Re-check to try again.",
      );
    } finally {
      if (gen === genRef.current) setPolling(false);
    }
  }

  /* --------------------------- fix cognito_id --------------------------- */

  async function startFix(emp: CorrectionEmployee) {
    setPollNote(null);
    setAction({
      kind: "fix",
      empmasterId: emp.empmasterId,
      shortCode: emp.shortCode,
      phase: "previewing",
    });
    try {
      const preview = await post<CorrectionFixResult>(
        "/api/auth-comparison/correction/fix-cognito",
        { environment, empmasterId: emp.empmasterId, preview: true },
      );
      if (preview === null) return;
      if (!preview.ok || (!preview.corp.needsUpdate && !preview.auth.needsUpdate)) {
        setAction((a) => a && { ...a, phase: "done", error: preview.message });
        return;
      }
      setAction((a) => a && { ...a, phase: "confirm", fixPreview: preview });
    } catch (e) {
      setAction(
        (a) =>
          a && {
            ...a,
            phase: "done",
            error: e instanceof Error ? e.message : String(e),
          },
      );
    }
  }

  async function confirmFix() {
    if (!action || action.kind !== "fix") return;
    setAction({ ...action, phase: "running" });
    try {
      const run = await post<CorrectionFixResult>(
        "/api/auth-comparison/correction/fix-cognito",
        { environment, empmasterId: action.empmasterId, preview: false },
      );
      if (run === null) return;
      setAction((a) => a && { ...a, phase: "done", fixResult: run });
      await analyze(true);
    } catch (e) {
      setAction(
        (a) =>
          a && {
            ...a,
            phase: "done",
            error: e instanceof Error ? e.message : String(e),
          },
      );
    }
  }

  /* --------------------------- sync auth from corp --------------------------- */

  async function startSync(emp: CorrectionEmployee) {
    setPollNote(null);
    setAction({
      kind: "sync",
      empmasterId: emp.empmasterId,
      shortCode: emp.shortCode,
      phase: "previewing",
    });
    try {
      const preview = await post<CorrectionSyncResult>(
        "/api/auth-comparison/correction/sync-auth",
        { environment, empmasterId: emp.empmasterId, preview: true },
      );
      if (preview === null) return;
      if (!preview.ok || preview.changes.length === 0) {
        setAction((a) => a && { ...a, phase: "done", error: preview.message });
        return;
      }
      setAction((a) => a && { ...a, phase: "confirm", syncPreview: preview });
    } catch (e) {
      setAction(
        (a) =>
          a && {
            ...a,
            phase: "done",
            error: e instanceof Error ? e.message : String(e),
          },
      );
    }
  }

  async function confirmSync() {
    if (!action || action.kind !== "sync") return;
    setAction({ ...action, phase: "running" });
    try {
      const run = await post<CorrectionSyncResult>(
        "/api/auth-comparison/correction/sync-auth",
        { environment, empmasterId: action.empmasterId, preview: false },
      );
      if (run === null) return;
      setAction((a) => a && { ...a, phase: "done", syncResult: run });
      await analyze(true);
    } catch (e) {
      setAction(
        (a) =>
          a && {
            ...a,
            phase: "done",
            error: e instanceof Error ? e.message : String(e),
          },
      );
    }
  }

  /* --------------------- release duplicate cognito_id --------------------- */

  async function startRelease(emp: CorrectionEmployee) {
    setPollNote(null);
    setAction({
      kind: "release",
      empmasterId: emp.empmasterId,
      shortCode: emp.shortCode,
      phase: "previewing",
    });
    try {
      const preview = await post<CorrectionReleaseResult>(
        "/api/auth-comparison/correction/release-cognito",
        { environment, empmasterId: emp.empmasterId, preview: true },
      );
      if (preview === null) return;
      if (!preview.ok || preview.conflicts.length === 0) {
        setAction((a) => a && { ...a, phase: "done", error: preview.message });
        return;
      }
      setAction((a) => a && { ...a, phase: "confirm", releasePreview: preview });
    } catch (e) {
      setAction(
        (a) =>
          a && {
            ...a,
            phase: "done",
            error: e instanceof Error ? e.message : String(e),
          },
      );
    }
  }

  async function confirmRelease() {
    if (!action || action.kind !== "release") return;
    setAction({ ...action, phase: "running" });
    try {
      const run = await post<CorrectionReleaseResult>(
        "/api/auth-comparison/correction/release-cognito",
        { environment, empmasterId: action.empmasterId, preview: false },
      );
      if (run === null) return;
      setAction((a) => a && { ...a, phase: "done", releaseResult: run });
      await analyze(true);
    } catch (e) {
      setAction(
        (a) =>
          a && {
            ...a,
            phase: "done",
            error: e instanceof Error ? e.message : String(e),
          },
      );
    }
  }

  /* ----------------------- clear wrong cognito_id ----------------------- */

  async function startClear(emp: CorrectionEmployee) {
    setPollNote(null);
    setAction({
      kind: "clear",
      empmasterId: emp.empmasterId,
      shortCode: emp.shortCode,
      phase: "previewing",
    });
    try {
      const preview = await post<CorrectionClearResult>(
        "/api/auth-comparison/correction/clear-cognito",
        { environment, empmasterId: emp.empmasterId, preview: true },
      );
      if (preview === null) return;
      if (!preview.ok || preview.targets.length === 0) {
        setAction((a) => a && { ...a, phase: "done", error: preview.message });
        return;
      }
      setAction((a) => a && { ...a, phase: "confirm", clearPreview: preview });
    } catch (e) {
      setAction(
        (a) =>
          a && {
            ...a,
            phase: "done",
            error: e instanceof Error ? e.message : String(e),
          },
      );
    }
  }

  async function confirmClear() {
    if (!action || action.kind !== "clear") return;
    setAction({ ...action, phase: "running" });
    try {
      const run = await post<CorrectionClearResult>(
        "/api/auth-comparison/correction/clear-cognito",
        { environment, empmasterId: action.empmasterId, preview: false },
      );
      if (run === null) return;
      setAction((a) => a && { ...a, phase: "done", clearResult: run });
      await analyze(true);
    } catch (e) {
      setAction(
        (a) =>
          a && {
            ...a,
            phase: "done",
            error: e instanceof Error ? e.message : String(e),
          },
      );
    }
  }

  const busy =
    analyzing ||
    polling ||
    action?.phase === "previewing" ||
    action?.phase === "running";

  return (
    <section className="card p-5 sm:p-6 space-y-5 animate-fade-in">
      <div className="flex items-center gap-2">
        <Wrench className="h-4 w-4 text-[hsl(var(--primary))]" />
        <h2 className="text-sm font-semibold uppercase tracking-wider">
          Employee Data Correction
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
          writes on confirm
        </span>
      </div>

      <p className="text-xs text-[hsl(var(--muted-foreground))]">
        <b>Corp is the source of truth.</b> Enter a mobile number — the corp
        employee(s) (<code>empmaster_hdr</code>) holding it are checked first,
        then compared against auth and Cognito on <b>short code</b>,{" "}
        <b>mobile</b>, <b>name</b> and <b>ucode</b>. If the employee is missing
        in auth, its corp event stream (<code>employee_&lt;empmaster id&gt;</code>)
        can be replayed onto the auth queue to re-create it; if it exists but
        its name / mobile / ucode drifted, they can be synced onto the auth
        record from corp; and the live Cognito user (matched by corp mobile +
        short code) supplies the correct <b>cognito_id</b>, which is then
        written to corp and auth. Every action previews first and asks for
        confirmation.
      </p>

      <div className="space-y-2">
        <label
          htmlFor="correction-mobile-input"
          className="block text-xs font-medium text-[hsl(var(--muted-foreground))]"
        >
          Mobile Number
        </label>
        <input
          id="correction-mobile-input"
          value={mobile}
          onChange={(e) => setMobile(e.target.value)}
          placeholder="9876543210"
          inputMode="numeric"
          className="input-base font-mono text-[13px]"
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy && mobile.trim()) analyze();
          }}
        />
      </div>

      {topError && (
        <div
          role="alert"
          className="rounded-lg border border-[hsl(var(--danger))]/40 bg-[hsl(var(--danger))]/10
                     text-[hsl(var(--danger))] px-3 py-2 text-xs flex items-start gap-2 animate-fade-in"
        >
          <CircleAlert className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{topError}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-[hsl(var(--muted-foreground))]">
          Analyze is read-only; corrections run only after an explicit confirm.
        </p>
        <div className="flex items-center gap-2">
          {result && (
            <button
              type="button"
              className="btn-ghost h-9"
              onClick={() => analyze()}
              disabled={busy || !mobile.trim()}
              title="Re-run the analysis for this mobile"
            >
              <RefreshCw className="h-4 w-4" />
              Re-check
            </button>
          )}
          <button
            type="button"
            className="btn-primary min-w-[130px]"
            onClick={() => analyze()}
            disabled={busy || !mobile.trim()}
          >
            {analyzing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Analyzing…
              </>
            ) : (
              <>
                <Search className="h-4 w-4" />
                Analyze
              </>
            )}
          </button>
        </div>
      </div>

      {pollNote && (
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs text-sky-700 dark:text-sky-400 flex items-start gap-2 animate-fade-in">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          {pollNote}
        </div>
      )}

      {result && (
        <div className="space-y-4">
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            {result.message}
          </p>
          {result.employees.map((emp) => (
            <EmployeePanel
              key={emp.empmasterId}
              emp={emp}
              isProd={isProd}
              busy={Boolean(busy)}
              action={action?.empmasterId === emp.empmasterId ? action : null}
              onCreateInAuth={() => startReplay(emp)}
              onFixCognito={() => startFix(emp)}
              onSyncAuth={() => startSync(emp)}
              onReleaseDuplicate={() => startRelease(emp)}
              onClearWrong={() => startClear(emp)}
            />
          ))}
        </div>
      )}

      {/* Confirm modal */}
      {action?.phase === "confirm" && (
        <ConfirmModal
          action={action}
          isProd={isProd}
          environment={environment}
          onCancel={() => setAction(null)}
          onConfirm={
            action.kind === "replay"
              ? confirmReplay
              : action.kind === "fix"
                ? confirmFix
                : action.kind === "sync"
                  ? confirmSync
                  : action.kind === "release"
                    ? confirmRelease
                    : confirmClear
          }
        />
      )}
    </section>
  );
}

/* ---------------------------- employee panel ---------------------------- */

function EmployeePanel({
  emp,
  isProd,
  busy,
  action,
  onCreateInAuth,
  onFixCognito,
  onSyncAuth,
  onReleaseDuplicate,
  onClearWrong,
}: {
  emp: CorrectionEmployee;
  isProd: boolean;
  busy: boolean;
  action: ActionState | null;
  onCreateInAuth: () => void;
  onFixCognito: () => void;
  onSyncAuth: () => void;
  onReleaseDuplicate: () => void;
  onClearWrong: () => void;
}) {
  const working = action?.phase === "previewing" || action?.phase === "running";
  return (
    <div className="rounded-lg border border-[hsl(var(--border))] p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold">{emp.shortCode || "—"}</span>
        <span className="pill bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
          company {emp.companyCode || "—"}
        </span>
        <span className="pill bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
          empmaster {emp.empmasterId}
        </span>
        {emp.activeStatus && emp.activeStatus !== "Y" && (
          <span className="pill bg-amber-500/15 text-amber-700 dark:text-amber-400">
            inactive in corp
          </span>
        )}
        {emp.consistent ? (
          <span className="pill bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ml-auto">
            Consistent
          </span>
        ) : (
          <span className="pill bg-amber-500/15 text-amber-700 dark:text-amber-400 ml-auto">
            Needs attention
          </span>
        )}
      </div>

      <FieldTable fields={emp.fields} />

      {/* Who actually owns the stored cognito_id (looked up by sub). */}
      {emp.storedSubOwners.length > 0 && (
        <div className="rounded-lg border border-[hsl(var(--border))] px-3 py-2 space-y-1.5 text-xs">
          <p className="font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide text-[10px]">
            Stored cognito_id owner{emp.storedSubOwners.length === 1 ? "" : "s"}
          </p>
          {emp.storedSubOwners.map((o) => (
            <div key={o.sub} className="leading-snug">
              <span className="font-mono break-all">{o.sub}</span>{" "}
              <span className="text-[hsl(var(--muted-foreground))]">
                (stored in {o.sources.join(" + ")})
              </span>{" "}
              {o.error ? (
                <span className="text-red-600 dark:text-red-400">
                  — lookup failed
                </span>
              ) : o.user === null ? (
                <span className="text-amber-700 dark:text-amber-400">
                  — not found in Cognito (stale)
                </span>
              ) : (
                <>
                  — belongs to Cognito user{" "}
                  <span className="font-mono">
                    {o.user.emp_short_code?.trim() || o.user.username || "—"}
                  </span>
                  {o.user.name?.trim() ? <> ({o.user.name})</> : null}
                  {o.user.phone_number ? (
                    <>
                      , mobile{" "}
                      <span className="font-mono">
                        {displayMobile10(o.user.phone_number)}
                      </span>
                      {o.wrong && (
                        <span className="text-[hsl(var(--muted-foreground))]">
                          {" "}
                          — analyze that mobile to correct the owner&apos;s
                          records
                        </span>
                      )}
                    </>
                  ) : null}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {(emp.statuses.length > 0 || emp.blockers.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {emp.statuses.map((s, i) => (
            <span
              key={`s${i}`}
              className="pill bg-amber-500/15 text-amber-700 dark:text-amber-400"
            >
              {s}
            </span>
          ))}
          {emp.blockers.map((b, i) => (
            <span
              key={`b${i}`}
              className="pill bg-red-500/15 text-red-600 dark:text-red-400"
            >
              {b}
            </span>
          ))}
        </div>
      )}

      {/* Action results / errors for this employee */}
      {action?.phase === "done" && (
        <div
          className={clsx(
            "rounded-lg px-3 py-2 text-xs flex items-start gap-2",
            action.error ||
              (action.kind === "replay" && !action.replayResult?.ok) ||
              (action.kind === "fix" && !action.fixResult?.ok) ||
              (action.kind === "sync" && !action.syncResult?.ok) ||
              (action.kind === "release" && !action.releaseResult?.ok) ||
              (action.kind === "clear" && !action.clearResult?.ok)
              ? "border border-[hsl(var(--danger))]/40 bg-[hsl(var(--danger))]/10 text-[hsl(var(--danger))]"
              : "border border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
          )}
        >
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            {action.error ??
              (action.kind === "replay"
                ? action.replayResult?.message
                : action.kind === "fix"
                  ? action.fixResult?.message
                  : action.kind === "sync"
                    ? action.syncResult?.message
                    : action.kind === "release"
                      ? action.releaseResult?.message
                      : action.clearResult?.message)}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {emp.actions.createInAuth && (
          <button
            type="button"
            className={isProd ? "btn-danger" : "btn-primary"}
            onClick={onCreateInAuth}
            disabled={busy}
          >
            {working && action?.kind === "replay" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Create in auth (replay events)
          </button>
        )}
        {emp.actions.syncAuthFromCorp && (
          <button
            type="button"
            className={isProd ? "btn-danger" : "btn-primary"}
            onClick={onSyncAuth}
            disabled={busy}
          >
            {working && action?.kind === "sync" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Sync auth with corp
          </button>
        )}
        {emp.actions.releaseDuplicateCognitoId && (
          <button
            type="button"
            className={isProd ? "btn-danger" : "btn-primary"}
            onClick={onReleaseDuplicate}
            disabled={busy}
          >
            {working && action?.kind === "release" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Release duplicate cognito_id
          </button>
        )}
        {emp.actions.clearWrongCognitoId && (
          <button
            type="button"
            className={isProd ? "btn-danger" : "btn-primary"}
            onClick={onClearWrong}
            disabled={busy}
          >
            {working && action?.kind === "clear" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Clear wrong cognito_id
          </button>
        )}
        {emp.actions.fixCognitoId && (
          <button
            type="button"
            className={isProd ? "btn-danger" : "btn-primary"}
            onClick={onFixCognito}
            disabled={busy}
          >
            {working && action?.kind === "fix" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Fix cognito_id in corp + auth
          </button>
        )}
        {emp.actions.syncAuthBlockedReason && (
          <span className="text-xs text-[hsl(var(--muted-foreground))]">
            auth sync blocked: {emp.actions.syncAuthBlockedReason}
          </span>
        )}
        {emp.actions.fixCognitoIdBlockedReason && (
          <span className="text-xs text-[hsl(var(--muted-foreground))]">
            cognito_id fix blocked: {emp.actions.fixCognitoIdBlockedReason}
          </span>
        )}
      </div>

      {emp.actions.cognitoAttributeDrift && (
        <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
          Note: the Cognito user&apos;s name/ucode differ from corp. This tool
          never writes to Cognito (those are login-critical attributes) — fix
          them in Cognito manually if needed.
        </p>
      )}
    </div>
  );
}

/* ----------------------------- field table ----------------------------- */

function FieldTable({ fields }: { fields: CorrectionField[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-[hsl(var(--border))]">
      <table className="w-full text-xs">
        <thead className="bg-[hsl(var(--muted))]/60 text-[hsl(var(--muted-foreground))]">
          <tr>
            <th className="text-left font-medium px-3 py-2 whitespace-nowrap">Field</th>
            <th className="text-left font-medium px-3 py-2 whitespace-nowrap">Corp</th>
            <th className="text-left font-medium px-3 py-2 whitespace-nowrap">Auth</th>
            <th className="text-left font-medium px-3 py-2 whitespace-nowrap">Cognito</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.key} className="border-t border-[hsl(var(--border))] align-top">
              <td className="px-3 py-2 whitespace-nowrap font-medium">
                {f.label}
                {f.key === "cognitoId" ? (
                  <span className="block text-[10px] text-[hsl(var(--muted-foreground))]">
                    truth: Cognito
                  </span>
                ) : (
                  <span className="block text-[10px] text-[hsl(var(--muted-foreground))]">
                    truth: corp
                  </span>
                )}
              </td>
              <ValueCell value={f.corp.value} present mismatch={f.corp.mismatch} />
              <ValueCell
                value={f.auth.value}
                present={f.auth.present}
                mismatch={f.auth.mismatch}
                absentLabel="missing in auth"
              />
              <ValueCell
                value={f.cognito.value}
                present={f.cognito.present}
                mismatch={f.cognito.mismatch}
                absentLabel="no user resolved"
              />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ValueCell({
  value,
  present,
  mismatch,
  absentLabel = "absent",
}: {
  value: string | null;
  present: boolean;
  mismatch: boolean;
  absentLabel?: string;
}) {
  return (
    <td className="px-3 py-2">
      <span
        className={clsx(
          "font-mono break-all rounded px-1 py-0.5 inline-block",
          mismatch && "bg-red-500/10 ring-1 ring-red-500/30 text-red-700 dark:text-red-400",
        )}
      >
        {!present ? (
          <span className="italic text-[hsl(var(--muted-foreground))] font-sans">
            {absentLabel}
          </span>
        ) : value && value.trim() ? (
          value
        ) : (
          <span className="text-[hsl(var(--muted-foreground))]">—</span>
        )}
      </span>
    </td>
  );
}

/* ----------------------------- confirm modal ----------------------------- */

function ConfirmModal({
  action,
  isProd,
  environment,
  onCancel,
  onConfirm,
}: {
  action: ActionState;
  isProd: boolean;
  environment: Environment;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isReplay = action.kind === "replay";
  const isSync = action.kind === "sync";
  const isRelease = action.kind === "release";
  const isClear = action.kind === "clear";
  const rp = action.replayPreview;
  const fp = action.fixPreview;
  const sp = action.syncPreview;
  const lp = action.releasePreview;
  const cp = action.clearPreview;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-lg p-5 space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center gap-2">
          <AlertTriangle
            className={clsx(
              "h-4 w-4",
              isProd ? "text-red-500" : "text-amber-500",
            )}
          />
          <h3 className="text-sm font-semibold">
            {isReplay
              ? `Replay events to auth — ${action.shortCode}`
              : isSync
                ? `Sync auth with corp — ${action.shortCode}`
                : isRelease
                  ? `Release duplicate cognito_id — ${action.shortCode}`
                  : isClear
                    ? `Clear wrong cognito_id — ${action.shortCode}`
                    : `Fix cognito_id — ${action.shortCode}`}
          </h3>
          <span
            className={clsx(
              "ml-auto pill",
              isProd
                ? "bg-red-500/15 text-red-600 dark:text-red-400"
                : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
            )}
          >
            {environment}
          </span>
        </div>

        {isReplay && rp && (
          <>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              {rp.totalEvents} event{rp.totalEvents === 1 ? "" : "s"} on stream{" "}
              <code>{rp.streamId}</code> will be sent to the V1 auth consumer
              queue in timestamp order. The auth-backend will re-process the
              employee&apos;s full history.
            </p>
            <div className="max-h-56 overflow-y-auto rounded-lg border border-[hsl(var(--border))]">
              <table className="w-full text-xs">
                <thead className="bg-[hsl(var(--muted))]/60 text-[hsl(var(--muted-foreground))]">
                  <tr>
                    <th className="text-left font-medium px-3 py-1.5">Event ID</th>
                    <th className="text-left font-medium px-3 py-1.5">Type</th>
                    <th className="text-left font-medium px-3 py-1.5">Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {rp.events.map((e) => (
                    <tr key={e.eventId} className="border-t border-[hsl(var(--border))]">
                      <td className="px-3 py-1.5 font-mono">{e.eventId}</td>
                      <td className="px-3 py-1.5">{e.event_type}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {e.timestamp ? new Date(e.timestamp).toLocaleString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {isSync && sp && (
          <>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              The following auth columns will be overwritten with the corp
              (source of truth) values:
            </p>
            <div className="rounded-lg border border-[hsl(var(--border))] overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-[hsl(var(--muted))]/60 text-[hsl(var(--muted-foreground))]">
                  <tr>
                    <th className="text-left font-medium px-3 py-1.5">Field</th>
                    <th className="text-left font-medium px-3 py-1.5">Auth (before)</th>
                    <th className="text-left font-medium px-3 py-1.5">Corp (after)</th>
                  </tr>
                </thead>
                <tbody>
                  {sp.changes.map((c) => (
                    <tr key={c.column} className="border-t border-[hsl(var(--border))]">
                      <td className="px-3 py-1.5 font-medium whitespace-nowrap">{c.label}</td>
                      <td className="px-3 py-1.5 font-mono break-all">
                        {c.before?.trim() || "—"}
                      </td>
                      <td className="px-3 py-1.5 font-mono break-all text-emerald-700 dark:text-emerald-400">
                        {c.after?.trim() || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {isRelease && lp && (
          <>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              The sub <code className="font-mono break-all">{lp.sub}</code>{" "}
              belongs to <b>{action.shortCode}</b> (verified by corp mobile +
              short code) but is also stored on the record
              {lp.conflicts.length === 1 ? "" : "s"} below. Their{" "}
              <code>cognito_id</code> will be set to <b>NULL</b> so the sub
              identifies exactly one record. This employee&apos;s own rows are
              not touched.
            </p>
            <div className="rounded-lg border border-[hsl(var(--border))] overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-[hsl(var(--muted))]/60 text-[hsl(var(--muted-foreground))]">
                  <tr>
                    <th className="text-left font-medium px-3 py-1.5">Source</th>
                    <th className="text-left font-medium px-3 py-1.5">Record</th>
                    <th className="text-left font-medium px-3 py-1.5">Short code</th>
                    <th className="text-left font-medium px-3 py-1.5">Company</th>
                    <th className="text-left font-medium px-3 py-1.5">Name</th>
                  </tr>
                </thead>
                <tbody>
                  {lp.conflicts.map((c) => (
                    <tr
                      key={`${c.source}-${c.id}`}
                      className="border-t border-[hsl(var(--border))]"
                    >
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {c.source === "corp" ? "corp empmaster_hdr" : "auth Field_Force_Users"}
                      </td>
                      <td className="px-3 py-1.5 font-mono">{c.id}</td>
                      <td className="px-3 py-1.5 font-mono">{c.shortCode?.trim() || "—"}</td>
                      <td className="px-3 py-1.5 font-mono">{c.companyCode?.trim() || "—"}</td>
                      <td className="px-3 py-1.5">{c.name?.trim() || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
              Note: the cleared record{lp.conflicts.length === 1 ? "" : "s"} will
              be left without a cognito_id. If that user should have one, run a
              correction for their mobile number afterwards.
            </p>
          </>
        )}

        {isClear && cp && (
          <>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              No Cognito user belongs to <b>{action.shortCode}</b>, and the
              stored cognito_id is not this employee&apos;s. It will be set to{" "}
              <b>NULL</b> on the record{cp.targets.length === 1 ? "" : "s"}{" "}
              below:
            </p>
            <div className="rounded-lg border border-[hsl(var(--border))] overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-[hsl(var(--muted))]/60 text-[hsl(var(--muted-foreground))]">
                  <tr>
                    <th className="text-left font-medium px-3 py-1.5">Source</th>
                    <th className="text-left font-medium px-3 py-1.5">Record</th>
                    <th className="text-left font-medium px-3 py-1.5">Stored cognito_id</th>
                    <th className="text-left font-medium px-3 py-1.5">Why wrong</th>
                  </tr>
                </thead>
                <tbody>
                  {cp.targets.map((t) => (
                    <tr
                      key={`${t.source}-${t.id}`}
                      className="border-t border-[hsl(var(--border))]"
                    >
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {t.source === "corp" ? "corp empmaster_hdr" : "auth Field_Force_Users"}
                      </td>
                      <td className="px-3 py-1.5 font-mono">{t.id}</td>
                      <td className="px-3 py-1.5 font-mono break-all">{t.sub}</td>
                      <td className="px-3 py-1.5">{t.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
              If the sub belongs to another user, correct that user by analyzing
              their mobile number afterwards. If this employee should have a
              Cognito account, it must be created via signup separately.
            </p>
          </>
        )}

        {action.kind === "fix" && fp && (
          <>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              {fp.message}
            </p>
            <div className="rounded-lg border border-[hsl(var(--border))] text-xs divide-y divide-[hsl(var(--border))]">
              <div className="px-3 py-2 flex items-baseline gap-2">
                <span className="w-24 shrink-0 text-[hsl(var(--muted-foreground))]">
                  Live sub
                </span>
                <span className="font-mono break-all">{fp.sub}</span>
              </div>
              <div className="px-3 py-2 flex items-baseline gap-2">
                <span className="w-24 shrink-0 text-[hsl(var(--muted-foreground))]">
                  corp before
                </span>
                <span className="font-mono break-all">
                  {fp.corp.before?.trim() || "—"}
                </span>
                {!fp.corp.needsUpdate && (
                  <span className="pill bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ml-auto">
                    already correct
                  </span>
                )}
              </div>
              <div className="px-3 py-2 flex items-baseline gap-2">
                <span className="w-24 shrink-0 text-[hsl(var(--muted-foreground))]">
                  auth before
                </span>
                <span className="font-mono break-all">
                  {fp.auth.before?.trim() || "—"}
                </span>
                {!fp.auth.needsUpdate && (
                  <span className="pill bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ml-auto">
                    already correct
                  </span>
                )}
              </div>
            </div>
          </>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost h-9" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={isProd ? "btn-danger" : "btn-primary"}
            onClick={onConfirm}
          >
            {isReplay
              ? "Confirm replay"
              : isSync
                ? "Confirm sync"
                : isRelease
                  ? "Confirm release"
                  : isClear
                    ? "Confirm clear"
                    : "Confirm update"}
          </button>
        </div>
      </div>
    </div>
  );
}
