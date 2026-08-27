"use client";

import { useRef, useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  Check,
  CircleAlert,
  Copy,
  GitCompareArrows,
  Info,
  Loader2,
  RefreshCw,
  KeyRound,
  Phone,
  Search,
  Wrench,
} from "lucide-react";
import { displayMobile10 } from "@/lib/format";
import {
  CORRECTION_WRITES_DISABLED_MESSAGE,
  CORRECTION_WRITES_ENABLED,
} from "@/lib/write-guard";
import type {
  CorrectionAnalyzeResult,
  CorrectionEmployee,
  CorrectionField,
  CorrectionMobileChangeResult,
  CorrectionReleaseNumberResult,
  CorrectionRepairResult,
  CorrectionReplayResult,
  CorrectionSyncResult,
  Environment,
} from "@/lib/types";

/**
 * Employee Data Correction card (Auth Details Comparison tab).
 *
 * Corp-driven and mobile-keyed: enter a mobile → the corp employee(s) holding
 * it are analyzed against auth and Cognito (corp = truth for short code /
 * mobile / name / ucode; Cognito = truth for cognito_id). Three corrective
 * actions, each preview-then-confirm:
 *   1. Missing in auth → replay the employee's corp event stream onto the V1
 *      auth SQS queue, then poll until the user appears in auth.
 *   2. Sync auth with corp → overwrite drifted auth name / mobile / ucode.
 *   3. Reassign / repair cognito_id → the single step for EVERY cognito_id
 *      entanglement: discovers the two users whose details criss-crossed
 *      (via cognito_id or mobile across all three datasources) and repairs
 *      both in one confirmed run; participants missing in auth get a create
 *      button inside the modal first.
 *   4. Change Cognito mobile / release number → the only tool that reads
 *      Cognito's sign-in RESERVATION index (`AdminGetUser`) as well as the
 *      phone attribute, so it can show why a number that appears free is
 *      rejected as already taken, repoint the employee's account, and — on
 *      explicit opt-in — release the number from the account squatting on it.
 *
 * Plus one card-level tool that is keyed on a NUMBER rather than an employee:
 * "Reserved mobile number", for the case where a number cannot be signed up
 * even though nothing in Cognito appears to hold it.
 */

type ActionKind = "replay" | "sync" | "repair" | "mobileChange";

type ActionState = {
  kind: ActionKind;
  empmasterId: string;
  shortCode: string;
  phase: "previewing" | "confirm" | "running" | "done";
  replayPreview?: CorrectionReplayResult;
  replayResult?: CorrectionReplayResult;
  syncPreview?: CorrectionSyncResult;
  syncResult?: CorrectionSyncResult;
  repairPreview?: CorrectionRepairResult;
  repairResult?: CorrectionRepairResult;
  mobilePreview?: CorrectionMobileChangeResult;
  mobileResult?: CorrectionMobileChangeResult;
  /** The 10-digit number being set (normalized), carried preview → confirm. */
  mobileNew?: string;
  /** Operator opted in to freeing the number from the account holding it. */
  releaseConflicting?: boolean;
  /** empmasterId of the participant being created in auth from the repair modal. */
  creating?: string;
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

  /* ------------- change Cognito mobile / release reserved number ------------- */

  async function previewMobileChange(
    empmasterId: string,
    shortCode: string,
    newMobile10: string,
    releaseConflicting: boolean,
  ) {
    setPollNote(null);
    setAction({
      kind: "mobileChange",
      empmasterId,
      shortCode,
      phase: "previewing",
      mobileNew: newMobile10,
      releaseConflicting,
    });
    try {
      const preview = await post<CorrectionMobileChangeResult>(
        "/api/auth-comparison/correction/mobile-change",
        {
          environment,
          empmasterId,
          newMobile: newMobile10,
          releaseConflicting,
          preview: true,
        },
      );
      if (preview === null) return;
      if (!preview.ok) {
        setAction((a) => a && { ...a, phase: "done", error: preview.message });
        return;
      }
      setAction((a) => a && { ...a, phase: "confirm", mobilePreview: preview });
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

  async function startMobileChange(emp: CorrectionEmployee, input: string) {
    const digits = input.replace(/\D/g, "");
    const newMobile10 = digits.length > 10 ? digits.slice(-10) : digits;
    if (!/^\d{10}$/.test(newMobile10)) {
      setTopError(
        "Enter a valid 10-digit mobile number to set on the Cognito account.",
      );
      return;
    }
    setTopError(null);
    await previewMobileChange(emp.empmasterId, emp.shortCode, newMobile10, false);
  }

  /** Re-preview with the release of the squatting account opted in. */
  async function optInReleaseAndRepreview() {
    if (!action || action.kind !== "mobileChange" || !action.mobileNew) return;
    await previewMobileChange(
      action.empmasterId,
      action.shortCode,
      action.mobileNew,
      true,
    );
  }

  async function confirmMobileChange() {
    if (!action || action.kind !== "mobileChange" || !action.mobileNew) return;
    setAction({ ...action, phase: "running" });
    try {
      const run = await post<CorrectionMobileChangeResult>(
        "/api/auth-comparison/correction/mobile-change",
        {
          environment,
          empmasterId: action.empmasterId,
          newMobile: action.mobileNew,
          releaseConflicting: action.releaseConflicting === true,
          preview: false,
        },
      );
      if (run === null) return;
      setAction((a) => a && { ...a, phase: "done", mobileResult: run });
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

  /* --------------------- unified cognito_id repair --------------------- */

  async function startRepair(emp: CorrectionEmployee) {
    setPollNote(null);
    setAction({
      kind: "repair",
      empmasterId: emp.empmasterId,
      shortCode: emp.shortCode,
      phase: "previewing",
    });
    try {
      const preview = await post<CorrectionRepairResult>(
        "/api/auth-comparison/correction/repair",
        { environment, empmasterId: emp.empmasterId, preview: true },
      );
      if (preview === null) return;
      if (!preview.ok) {
        setAction((a) => a && { ...a, phase: "done", error: preview.message });
        return;
      }
      setAction((a) => a && { ...a, phase: "confirm", repairPreview: preview });
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

  async function confirmRepair() {
    if (!action || action.kind !== "repair") return;
    setAction({ ...action, phase: "running" });
    try {
      const run = await post<CorrectionRepairResult>(
        "/api/auth-comparison/correction/repair",
        { environment, empmasterId: action.empmasterId, preview: false },
      );
      if (run === null) return;
      setAction((a) => a && { ...a, phase: "done", repairResult: run });
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

  /**
   * From the repair modal: create a missing-in-auth participant by replaying
   * their corp event stream, then poll the repair preview until the auth
   * consumer has created the record — the missing-in-auth blocker lifts and
   * the confirm unlocks without leaving the modal.
   */
  async function createParticipantInAuth(participantId: string) {
    if (!action || action.kind !== "repair") return;
    const baseId = action.empmasterId;
    const gen = genRef.current;
    setAction((a) => a && { ...a, creating: participantId, error: undefined });
    try {
      const run = await post<CorrectionReplayResult>(
        "/api/auth-comparison/correction/replay",
        { environment, empmasterId: participantId, preview: false },
      );
      if (run === null || gen !== genRef.current) return;
      if (!run.ok) {
        setAction((a) => a && { ...a, error: run.message });
        return;
      }
      for (let i = 1; i <= POLL_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (gen !== genRef.current) return;
        const p = await post<CorrectionRepairResult>(
          "/api/auth-comparison/correction/repair",
          { environment, empmasterId: baseId, preview: true },
        );
        if (p === null || gen !== genRef.current) return;
        setAction((a) =>
          a && a.kind === "repair" && a.phase === "confirm"
            ? { ...a, repairPreview: p }
            : a,
        );
        const part = p.participants.find((x) => x.empmasterId === participantId);
        if (part && !part.missingInAuth) return;
      }
      setAction(
        (a) =>
          a && {
            ...a,
            error:
              "The auth consumer has not created the record yet — it may still be processing. Cancel and re-open the repair in a moment (do not resend the events).",
          },
      );
    } catch (e) {
      setAction(
        (a) =>
          a && { ...a, error: e instanceof Error ? e.message : String(e) },
      );
    } finally {
      if (gen === genRef.current) {
        setAction((a) => a && { ...a, creating: undefined });
      }
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
        <GitCompareArrows className="h-4 w-4 text-[hsl(var(--primary))]" />
        <h2 className="text-sm font-semibold uppercase tracking-wider">
          Compare Auth / Corp / Cognito
        </h2>
        {CORRECTION_WRITES_ENABLED ? (
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
        ) : (
          <span className="ml-auto pill bg-sky-500/15 text-sky-600 dark:text-sky-400">
            <Info className="h-3 w-3" />
            read-only
          </span>
        )}
      </div>

      <p className="text-xs text-[hsl(var(--muted-foreground))]">
        <b>Corp is the source of truth.</b> Enter a mobile number — the corp
        employee(s) (<code>empmaster_hdr</code>) holding it are checked first,
        then compared against auth and Cognito on <b>short code</b>,{" "}
        <b>mobile</b>, <b>name</b> and <b>ucode</b>. If the employee is missing
        in auth, or its name / mobile / ucode drifted, or its <b>cognito_id</b>
        is mismatched / duplicated / stale / criss-crossed with another user,
        the comparison says so — including who actually owns each stored
        cognito_id, resolved live from Cognito by sub.{" "}
        {CORRECTION_WRITES_ENABLED
          ? "Every correction previews first and asks for confirmation."
          : "This view is read-only: it reports the deviations it finds and performs no writes."}
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
          {CORRECTION_WRITES_ENABLED
            ? "Analyze is read-only; corrections run only after an explicit confirm."
            : CORRECTION_WRITES_DISABLED_MESSAGE}
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
              onSyncAuth={() => startSync(emp)}
              onRepair={() => startRepair(emp)}
              onChangeMobile={(input) => startMobileChange(emp, input)}
            />
          ))}
        </div>
      )}

      {/* Confirm modal — never reachable in display-only mode (no action
          affordance opens it), gated anyway so the write path is one flag. */}
      {CORRECTION_WRITES_ENABLED && action?.phase === "confirm" && (
        <ConfirmModal
          action={action}
          isProd={isProd}
          environment={environment}
          onCancel={() => setAction(null)}
          onConfirm={
            action.kind === "replay"
              ? confirmReplay
              : action.kind === "sync"
                ? confirmSync
                : action.kind === "mobileChange"
                  ? confirmMobileChange
                  : confirmRepair
          }
          onCreateParticipant={createParticipantInAuth}
          onOptInRelease={optInReleaseAndRepreview}
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
  onSyncAuth,
  onRepair,
  onChangeMobile,
}: {
  emp: CorrectionEmployee;
  isProd: boolean;
  busy: boolean;
  action: ActionState | null;
  onCreateInAuth: () => void;
  onSyncAuth: () => void;
  onRepair: () => void;
  onChangeMobile: (input: string) => void;
}) {
  const working = action?.phase === "previewing" || action?.phase === "running";
  const [newMobile, setNewMobile] = useState("");
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
              <span className="font-mono break-all">{o.sub}</span>
              <CopyButton value={o.sub} />{" "}
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
              (action.kind === "sync" && !action.syncResult?.ok) ||
              (action.kind === "repair" && !action.repairResult?.ok) ||
              (action.kind === "mobileChange" && !action.mobileResult?.ok)
              ? "border border-[hsl(var(--danger))]/40 bg-[hsl(var(--danger))]/10 text-[hsl(var(--danger))]"
              : "border border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
          )}
        >
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            {action.error ??
              (action.kind === "replay"
                ? action.replayResult?.message
                : action.kind === "sync"
                  ? action.syncResult?.message
                  : action.kind === "mobileChange"
                    ? action.mobileResult?.message
                    : action.repairResult?.message)}
          </span>
        </div>
      )}

      {/* Post-run verification outcomes — the only record that the writes did
          what they claimed (this app has no audit table). */}
      {action?.phase === "done" &&
        action.kind === "mobileChange" &&
        (action.mobileResult?.verifications.length ?? 0) > 0 && (
          <div className="rounded-lg border border-[hsl(var(--border))] px-3 py-2 space-y-1 text-[11px]">
            <p className="font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide text-[10px]">
              Verification
            </p>
            {action.mobileResult!.verifications.map((v, i) => (
              <p
                key={i}
                className={clsx(
                  "leading-snug",
                  v.ok
                    ? "text-emerald-700 dark:text-emerald-400"
                    : "text-amber-700 dark:text-amber-400",
                )}
              >
                {v.ok ? "✓" : "✕"} {v.label} — {v.detail}
              </p>
            ))}
          </div>
        )}

      <div className="flex flex-wrap items-center gap-2">
        {CORRECTION_WRITES_ENABLED && emp.actions.createInAuth && (
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
        {CORRECTION_WRITES_ENABLED && emp.actions.syncAuthFromCorp && (
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
        {CORRECTION_WRITES_ENABLED && emp.actions.repairCognito && (
          <button
            type="button"
            className={isProd ? "btn-danger" : "btn-primary"}
            onClick={onRepair}
            disabled={busy}
          >
            {working && action?.kind === "repair" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Reassign / repair cognito_id
          </button>
        )}
        {emp.actions.syncAuthBlockedReason && (
          <span className="text-xs text-[hsl(var(--muted-foreground))]">
            auth sync blocked: {emp.actions.syncAuthBlockedReason}
          </span>
        )}
      </div>

      {/* Unlike the actions above this one is not driven by the analysis,
          because the condition it fixes (a number reserved as a sign-in
          identifier while its phone attribute says otherwise) is invisible to
          every attribute-based check the analysis runs. Hidden in display-only
          mode; the standalone "Reserved mobile number" card covers the
          read/release path operators actually use. */}
      {CORRECTION_WRITES_ENABLED && (
      <div className="rounded-lg border border-[hsl(var(--border))] px-3 py-2.5 space-y-2">
        <p className="text-[11px] font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wide text-[10px]">
          Change Cognito mobile / release reserved number
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input-base w-40 font-mono text-[13px]"
            placeholder="new 10-digit mobile"
            inputMode="numeric"
            maxLength={13}
            value={newMobile}
            onChange={(e) => setNewMobile(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) onChangeMobile(newMobile);
            }}
          />
          <button
            type="button"
            className={isProd ? "btn-danger" : "btn-primary"}
            onClick={() => onChangeMobile(newMobile)}
            disabled={busy || !newMobile.trim()}
          >
            {working && action?.kind === "mobileChange" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Phone className="h-4 w-4" />
            )}
            Preview change
          </button>
        </div>
        <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
          Writes Cognito only — corp/auth <code>mobile_no</code> stay owned by
          the event pipeline. The preview shows the account&apos;s reserved
          sign-in number next to its phone attribute, and who holds the number
          you are asking for.
        </p>
      </div>
      )}

      {emp.actions.cognitoAttributeDrift && (
        <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
          Note: the Cognito user&apos;s name/ucode differ from corp. Nothing
          here rewrites them — fix name/ucode in Cognito manually if needed.
        </p>
      )}
    </div>
  );
}

/* ------------------------------ copy button ------------------------------ */

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center align-middle ml-1.5 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
      title="Copy to clipboard"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard unavailable (permissions/insecure context) — ignore.
        }
      }}
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-500" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
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
              <ValueCell
                value={f.corp.value}
                present
                mismatch={f.corp.mismatch}
                copyable={f.key === "cognitoId"}
              />
              <ValueCell
                value={f.auth.value}
                present={f.auth.present}
                mismatch={f.auth.mismatch}
                absentLabel="missing in auth"
                copyable={f.key === "cognitoId"}
              />
              <ValueCell
                value={f.cognito.value}
                present={f.cognito.present}
                mismatch={f.cognito.mismatch}
                absentLabel="no user resolved"
                copyable={f.key === "cognitoId"}
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
  copyable,
}: {
  value: string | null;
  present: boolean;
  mismatch: boolean;
  absentLabel?: string;
  copyable?: boolean;
}) {
  const hasValue = present && Boolean(value && value.trim());
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
        ) : hasValue ? (
          value
        ) : (
          <span className="text-[hsl(var(--muted-foreground))]">—</span>
        )}
      </span>
      {copyable && hasValue && <CopyButton value={value!.trim()} />}
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
  onCreateParticipant,
  onOptInRelease,
}: {
  action: ActionState;
  isProd: boolean;
  environment: Environment;
  onCancel: () => void;
  onConfirm: () => void;
  onCreateParticipant: (empmasterId: string) => void;
  onOptInRelease: () => void;
}) {
  const isReplay = action.kind === "replay";
  const isSync = action.kind === "sync";
  const isRepair = action.kind === "repair";
  const isMobile = action.kind === "mobileChange";
  const rp = action.replayPreview;
  const sp = action.syncPreview;
  const xp = action.repairPreview;
  const mp = action.mobilePreview;
  const creating = action.creating;
  // Confirm is refused whenever the previewed plan would violate an auth/corp
  // invariant (duplicate mobile / ucode / cognito_id / Cognito phone) — the
  // server refuses it too, this just makes it visible before the click.
  const previewBlockers = isRepair
    ? (xp?.blockers ?? [])
    : isSync
      ? (sp?.blockers ?? [])
      : isMobile
        ? (mp?.blockers ?? [])
        : (rp?.blockers ?? []);
  const previewWarnings = isRepair
    ? (xp?.warnings ?? [])
    : isSync
      ? (sp?.warnings ?? [])
      : isMobile
        ? (mp?.warnings ?? [])
        : (rp?.warnings ?? []);
  const blocked = previewBlockers.length > 0 || Boolean(creating);
  const stepLabel = (source: "corp" | "auth") =>
    source === "corp" ? "corp empmaster_hdr" : "auth Field_Force_Users";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto">
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
                : isMobile
                  ? `Change Cognito mobile — ${action.shortCode}`
                  : `Reassign / repair cognito_id — ${action.shortCode}`}
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

        {isMobile && mp && (
          <>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              The account was resolved{" "}
              {mp.targetVia === "sub"
                ? "from the stored cognito_id"
                : mp.targetVia === "mobile"
                  ? "by its phone attribute"
                  : "ONLY through Cognito's sign-in reservation index"}
              . Cognito keeps two separate views of a mobile: the{" "}
              <strong>reserved sign-in number</strong> fixed at signup (what
              makes a new signup fail as “already exists”) and the{" "}
              <strong>phone attribute</strong> (what every search and the
              console show). Where they disagree, only this table tells you.
            </p>
            <div className="rounded-lg border border-[hsl(var(--border))] overflow-x-auto">
              <table className="w-full text-xs">
                <tbody>
                  <MobileRow
                    label="Cognito account"
                    value={mp.target?.sub ?? "—"}
                    note={[
                      mp.target?.shortCode,
                      mp.target?.status,
                      mp.target?.enabled === false ? "disabled" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  />
                  <MobileRow
                    label="Phone attribute (searchable)"
                    value={
                      (mp.oldMobile10 && displayMobile10(mp.oldMobile10)) || "—"
                    }
                  />
                  <MobileRow
                    label={`Reserves ${mp.oldMobile10 ? displayMobile10(mp.oldMobile10) : "its old number"}?`}
                    value={mp.oldNumberHolder ? "yes — still held" : "no"}
                    note={
                      mp.oldNumberHolder
                        ? (mp.oldNumberHolder.sub ?? "")
                        : undefined
                    }
                  />
                  <MobileRow
                    label="New number"
                    value={displayMobile10(mp.newMobile10) ?? mp.newMobile10}
                  />
                  <MobileRow
                    label="New number reserved by"
                    value={
                      mp.newNumberHolder
                        ? mp.newNumberHolder.sub === mp.target?.sub
                          ? "this same account"
                          : "ANOTHER account"
                        : "nobody"
                    }
                    note={
                      mp.newNumberHolder &&
                      mp.newNumberHolder.sub !== mp.target?.sub
                        ? [
                            mp.newNumberHolder.sub,
                            mp.newNumberHolder.shortCode,
                            mp.newNumberHolder.status,
                            mp.newNumberHolder.enabled === false
                              ? "disabled"
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : undefined
                    }
                  />
                  <MobileRow
                    label="DB mobile (corp / auth, not written)"
                    value={`${mp.dbMobile10.corp ? displayMobile10(mp.dbMobile10.corp) : "—"} / ${mp.dbMobile10.auth ? displayMobile10(mp.dbMobile10.auth) : "—"}`}
                  />
                </tbody>
              </table>
            </div>

            {mp.steps.length > 0 && (
              <div className="rounded-lg border border-[hsl(var(--border))] overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-[hsl(var(--muted))]/60 text-[hsl(var(--muted-foreground))]">
                    <tr>
                      <th className="text-left font-medium px-3 py-1.5">#</th>
                      <th className="text-left font-medium px-3 py-1.5">Step</th>
                      <th className="text-left font-medium px-3 py-1.5">Target</th>
                      <th className="text-left font-medium px-3 py-1.5">Effect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mp.steps.map((st, i) => (
                      <tr
                        key={i}
                        className="border-t border-[hsl(var(--border))] align-top"
                      >
                        <td className="px-3 py-1.5">{i + 1}</td>
                        {st.kind === "cognitoRelease" ? (
                          <>
                            <td className="px-3 py-1.5 whitespace-nowrap text-red-600 dark:text-red-400">
                              release number
                            </td>
                            <td className="px-3 py-1.5">
                              <span className="font-mono">
                                {st.shortCode || "—"}
                              </span>
                              <span className="block text-[10px] font-mono text-[hsl(var(--muted-foreground))] break-all">
                                {st.sub}
                              </span>
                            </td>
                            <td className="px-3 py-1.5">
                              parks a random placeholder number on it and
                              disables the account, freeing{" "}
                              <span className="font-mono">
                                {displayMobile10(st.mobile10)}
                              </span>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-3 py-1.5 whitespace-nowrap">
                              phone attribute
                            </td>
                            <td className="px-3 py-1.5">
                              <span className="font-mono">
                                {st.shortCode || "—"}
                              </span>
                              <span className="block text-[10px] font-mono text-[hsl(var(--muted-foreground))] break-all">
                                {st.sub}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 font-mono">
                              {st.before ? displayMobile10(st.before) : "—"} →{" "}
                              <span className="text-emerald-700 dark:text-emerald-400">
                                {displayMobile10(st.after)}
                              </span>
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* The number is squatted and the operator has not opted in yet —
                offer the release explicitly rather than doing it silently. */}
            {mp.newNumberHolder &&
              mp.newNumberHolder.sub !== mp.target?.sub &&
              action.releaseConflicting !== true && (
                <button
                  type="button"
                  className="btn-ghost h-9 text-xs"
                  onClick={onOptInRelease}
                >
                  <Wrench className="h-3.5 w-3.5" />
                  Release {displayMobile10(mp.newMobile10)} from that account
                  and re-preview
                </button>
              )}

            <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
              Every write is re-probed afterwards and the result is reported
              per check — a release that did not actually free the number is
              shown as failed, and the employee is not repointed.
            </p>
          </>
        )}

        {!isRepair && (previewBlockers.length > 0 || previewWarnings.length > 0) && (
          <IntegrityNotices blockers={previewBlockers} warnings={previewWarnings} />
        )}

        {isRepair && xp && (
          <>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              One run repairs every user whose details are intertwined with{" "}
              <b>{action.shortCode}</b> — corp is the source of truth for who
              owns which mobile and short code, Cognito for the cognito_id,
              and the only Cognito write is the mobile number. {xp.message}
            </p>

            <div className="rounded-lg border border-[hsl(var(--border))] overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-[hsl(var(--muted))]/60 text-[hsl(var(--muted-foreground))]">
                  <tr>
                    <th className="text-left font-medium px-3 py-1.5">User</th>
                    <th className="text-left font-medium px-3 py-1.5">Short code</th>
                    <th className="text-left font-medium px-3 py-1.5">Name</th>
                    <th className="text-left font-medium px-3 py-1.5">Mobile</th>
                    <th className="text-left font-medium px-3 py-1.5">Cognito account</th>
                    <th className="text-left font-medium px-3 py-1.5">Auth</th>
                  </tr>
                </thead>
                <tbody>
                  {xp.participants.map((pt) => (
                    <tr key={pt.empmasterId} className="border-t border-[hsl(var(--border))] align-top">
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {pt.role === "analyzed" ? "analyzed" : "intertwined"}
                        <span className="block text-[10px] text-[hsl(var(--muted-foreground))]">
                          empmaster {pt.empmasterId}
                          {pt.companyCode ? ` · co ${pt.companyCode}` : ""}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 font-mono">{pt.shortCode || "—"}</td>
                      <td className="px-3 py-1.5">{pt.name?.trim() || "—"}</td>
                      <td className="px-3 py-1.5 font-mono">{pt.mobile10 || "—"}</td>
                      <td className="px-3 py-1.5">
                        {pt.accountSub ? (
                          <>
                            <span className="font-mono break-all">{pt.accountSub}</span>
                            <span className="block text-[10px] text-[hsl(var(--muted-foreground))]">
                              {pt.accountVia === "mobile"
                                ? "matched by corp mobile + short code"
                                : "matched by short code — mobile gets corrected"}
                            </span>
                          </>
                        ) : (
                          <span className="italic text-[hsl(var(--muted-foreground))]">none resolves</span>
                        )}
                        {pt.notes.map((n, i) => (
                          <span key={i} className="block text-[10px] text-amber-700 dark:text-amber-400">
                            {n}
                          </span>
                        ))}
                      </td>
                      <td className="px-3 py-1.5">
                        {pt.missingInAuth ? (
                          <span className="pill bg-red-500/15 text-red-600 dark:text-red-400">
                            missing
                          </span>
                        ) : pt.authId ? (
                          <span className="font-mono">{pt.authId}</span>
                        ) : (
                          <span className="text-[hsl(var(--muted-foreground))]">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {xp.blockers.length > 0 && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 space-y-2 text-xs text-red-600 dark:text-red-400">
                {xp.blockers.map((b, i) => (
                  <p key={i}>{b}</p>
                ))}
                {xp.participants
                  .filter((pt) => pt.missingInAuth && pt.replayEvents > 0)
                  .map((pt) => (
                    <button
                      key={pt.empmasterId}
                      type="button"
                      className={isProd ? "btn-danger" : "btn-primary"}
                      onClick={() => onCreateParticipant(pt.empmasterId)}
                      disabled={Boolean(creating)}
                    >
                      {creating === pt.empmasterId ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : null}
                      Create {pt.shortCode || pt.empmasterId} in auth (replay{" "}
                      {pt.replayEvents} event{pt.replayEvents === 1 ? "" : "s"})
                    </button>
                  ))}
                {creating && (
                  <p className="text-[11px]">
                    Waiting for the auth consumer to create the record — the
                    plan refreshes automatically…
                  </p>
                )}
              </div>
            )}

            {action.error && (
              <p className="text-xs text-red-600 dark:text-red-400">{action.error}</p>
            )}

            {xp.steps.length > 0 && (
              <>
                <p className="text-xs text-[hsl(var(--muted-foreground))]">
                  Steps, in apply order (Cognito mobile → cognito_id writes →
                  stale-link clears; DB steps only apply if the row is
                  unchanged since this preview):
                </p>
                <div className="rounded-lg border border-[hsl(var(--border))] overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-[hsl(var(--muted))]/60 text-[hsl(var(--muted-foreground))]">
                      <tr>
                        <th className="text-left font-medium px-3 py-1.5">#</th>
                        <th className="text-left font-medium px-3 py-1.5">Step</th>
                        <th className="text-left font-medium px-3 py-1.5">Target</th>
                        <th className="text-left font-medium px-3 py-1.5">Before</th>
                        <th className="text-left font-medium px-3 py-1.5">After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {xp.steps.map((st, i) => (
                        <tr key={i} className="border-t border-[hsl(var(--border))] align-top">
                          <td className="px-3 py-1.5">{i + 1}</td>
                          {st.kind === "cognitoPhone" ? (
                            <>
                              <td className="px-3 py-1.5 whitespace-nowrap">
                                Cognito mobile update
                              </td>
                              <td className="px-3 py-1.5">
                                account of <span className="font-mono">{st.shortCode}</span>
                                <span className="block text-[10px] font-mono text-[hsl(var(--muted-foreground))] break-all">
                                  {st.sub}
                                </span>
                              </td>
                              <td className="px-3 py-1.5 font-mono">{st.before ?? "—"}</td>
                              <td className="px-3 py-1.5 font-mono text-emerald-700 dark:text-emerald-400">
                                {st.after}
                              </td>
                            </>
                          ) : st.kind === "dbWrite" ? (
                            <>
                              <td className="px-3 py-1.5 whitespace-nowrap">
                                cognito_id write
                              </td>
                              <td className="px-3 py-1.5">
                                {stepLabel(st.source)}{" "}
                                <span className="font-mono">{st.id}</span>
                                {st.shortCode ? (
                                  <span className="block text-[10px] text-[hsl(var(--muted-foreground))]">
                                    {st.shortCode}
                                  </span>
                                ) : null}
                              </td>
                              <td className="px-3 py-1.5 font-mono break-all">
                                {st.before ?? "—"}
                              </td>
                              <td className="px-3 py-1.5 font-mono break-all text-emerald-700 dark:text-emerald-400">
                                {st.after}
                              </td>
                            </>
                          ) : (
                            <>
                              <td className="px-3 py-1.5 whitespace-nowrap">
                                clear stale link
                              </td>
                              <td className="px-3 py-1.5">
                                {stepLabel(st.source)}{" "}
                                <span className="font-mono">{st.id}</span>
                                {st.shortCode ? (
                                  <span className="block text-[10px] text-[hsl(var(--muted-foreground))]">
                                    {st.shortCode}
                                  </span>
                                ) : null}
                              </td>
                              <td className="px-3 py-1.5 font-mono break-all">{st.before}</td>
                              <td className="px-3 py-1.5 font-mono text-red-600 dark:text-red-400">
                                NULL
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {xp.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 space-y-1 text-[11px] text-amber-700 dark:text-amber-400">
                {xp.warnings.map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
              </div>
            )}

            <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
              After the run, re-check this employee and analyze the other
              user&apos;s mobile to verify both ended up consistent.
            </p>
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
            disabled={blocked}
            title={
              blocked
                ? creating
                  ? "Creating the missing auth record — the confirm unlocks once it exists"
                  : "Resolve the listed conflicts first — this would leave duplicate data behind"
                : undefined
            }
          >
            {isReplay
              ? "Confirm replay"
              : isSync
                ? "Confirm sync"
                : isMobile
                  ? "Confirm change"
                  : "Confirm repair"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One label/value line of the mobile-change preview table. */
function MobileRow({
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

/**
 * Integrity violations (red — the confirm is disabled while any exist) and
 * non-blocking cautions (amber) for the replay and sync previews. The repair
 * modal renders its own blockers block because that one also carries the
 * "Create <short code> in auth" buttons.
 */
function IntegrityNotices({
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
          <p className="font-medium">
            Blocked — this would leave duplicate data behind:
          </p>
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
