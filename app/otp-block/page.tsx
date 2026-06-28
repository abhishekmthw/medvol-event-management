"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Eye,
  Info,
  Loader2,
  ShieldAlert,
  Smartphone,
  Users,
  X,
} from "lucide-react";
import clsx from "clsx";
import { AppHeader } from "@/components/app-header";
import { Segmented } from "@/components/segmented";
import { OtpBlockTable } from "@/components/otp-block-table";
import {
  OTP_USER_TYPES,
  type Environment,
  type OtpBlockResult,
  type OtpUserType,
} from "@/lib/types";

export default function OtpBlockPage() {
  const router = useRouter();

  const [environment, setEnvironment] = useState<Environment>("stage");
  const [userType, setUserType] = useState<OtpUserType>("stockist");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<OtpBlockResult | null>(null);
  const [result, setResult] = useState<OtpBlockResult | null>(null);
  const [topError, setTopError] = useState<string | null>(null);

  const isProd = environment === "prod";
  const userTypeLabel = useMemo(
    () => OTP_USER_TYPES.find((u) => u.value === userType)?.label ?? userType,
    [userType],
  );

  const handleSessionExpired = useMemo(
    () => async () => {
      try {
        await fetch("/api/auth/logout", { method: "POST" });
      } catch {
        // Best-effort — middleware will redirect anyway.
      }
      const next = window.location.pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
      router.refresh();
    },
    [router],
  );

  async function callRun(
    previewMode: boolean,
  ): Promise<OtpBlockResult | null> {
    setTopError(null);
    try {
      const res = await fetch("/api/otp-block/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          environment,
          userType,
          input,
          preview: previewMode,
        }),
      });
      if (res.status === 401) {
        await handleSessionExpired();
        return null;
      }
      const data = await res.json();
      if (!res.ok) {
        setTopError(data?.error ?? `Request failed (HTTP ${res.status}).`);
        return null;
      }
      return data as OtpBlockResult;
    } catch (e) {
      setTopError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  async function executeNow() {
    setLoading(true);
    setResult(null);
    try {
      const data = await callRun(false);
      if (data) setResult(data);
    } finally {
      setLoading(false);
    }
  }

  async function handlePreview() {
    if (!input.trim()) {
      setTopError("Please enter at least one mobile number.");
      return;
    }
    setPreviewing(true);
    setResult(null);
    try {
      const p = await callRun(true);
      if (p) setPreview(p);
    } finally {
      setPreviewing(false);
    }
  }

  async function confirmPreview() {
    setPreview(null);
    await executeNow();
  }

  return (
    <main className="min-h-screen">
      <AppHeader />

      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 space-y-6">
        {/* Target */}
        <section className="card p-5 sm:p-6 space-y-5 animate-fade-in">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-[hsl(var(--primary))]" />
            <h2 className="text-sm font-semibold uppercase tracking-wider">
              Target
            </h2>
            {isProd && (
              <span className="ml-auto pill bg-red-500/15 text-red-600 dark:text-red-400">
                <AlertTriangle className="h-3 w-3" />
                Production
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-medium mb-2 text-[hsl(var(--muted-foreground))]">
                Environment
              </p>
              <Segmented<Environment>
                options={[
                  { value: "stage", label: "Stage" },
                  { value: "prod", label: "Prod", danger: true },
                ]}
                value={environment}
                onChange={(v) => {
                  setEnvironment(v);
                  setResult(null);
                  setTopError(null);
                }}
              />
            </div>

            <div>
              <p className="text-xs font-medium mb-2 text-[hsl(var(--muted-foreground))]">
                User Type
              </p>
              <Segmented<OtpUserType>
                options={OTP_USER_TYPES}
                value={userType}
                onChange={(v) => {
                  setUserType(v);
                  setResult(null);
                  setTopError(null);
                }}
              />
            </div>
          </div>
        </section>

        {/* Operation */}
        <section className="card p-5 sm:p-6 space-y-5 animate-fade-in">
          <div className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-[hsl(var(--primary))]" />
            <h2 className="text-sm font-semibold uppercase tracking-wider">
              Clear 24h OTP Block
            </h2>
            <span className="ml-auto pill bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <ShieldAlert className="h-3 w-3" />
              write
            </span>
          </div>

          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            Sets <code>otp_retry_count</code> and <code>lockup_date</code> to{" "}
            <b>NULL</b> for the matching <b>{userTypeLabel}</b> record(s),
            removing the 24-hour OTP lockout.
          </p>

          <div className="space-y-2">
            <label
              htmlFor="mobile-input"
              className="block text-xs font-medium text-[hsl(var(--muted-foreground))]"
            >
              Mobile Number(s)
            </label>
            <textarea
              id="mobile-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={3}
              placeholder="9876543210, 9123456789"
              className="input-base font-mono text-[13px] resize-y min-h-[80px]"
              disabled={loading}
            />
            <p className="flex items-start gap-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              Comma-, space- or newline-separated. Matched exactly against{" "}
              <code>mobile_no</code>.
            </p>
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
              Preview will show affected rows before any database change.
            </p>
            <button
              type="button"
              className={clsx(isProd ? "btn-danger" : "btn-primary", "min-w-[150px]")}
              onClick={handlePreview}
              disabled={loading || previewing || !input.trim()}
            >
              {previewing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Previewing…
                </>
              ) : loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Running…
                </>
              ) : (
                <>
                  <Eye className="h-4 w-4" />
                  Preview & Run
                </>
              )}
            </button>
          </div>
        </section>
      </div>

      {result && (
        <ResultsModal result={result} onClose={() => setResult(null)} />
      )}

      {preview && (
        <PreviewModal
          preview={preview}
          userTypeLabel={userTypeLabel}
          isProd={isProd}
          running={loading}
          onCancel={() => setPreview(null)}
          onConfirm={confirmPreview}
        />
      )}
    </main>
  );
}

function ResultsModal({
  result,
  onClose,
}: {
  result: OtpBlockResult;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="card-strong max-w-4xl w-full max-h-[90vh] flex flex-col">
        <div className="flex items-start gap-3 p-6 pb-3">
          {result.ok ? (
            <div className="h-10 w-10 rounded-full flex items-center justify-center shrink-0 bg-emerald-500/15">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            </div>
          ) : (
            <div className="h-10 w-10 rounded-full flex items-center justify-center shrink-0 bg-[hsl(var(--danger))]/15">
              <CircleAlert className="h-5 w-5 text-[hsl(var(--danger))]" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold">
              {result.ok ? "Success" : "Completed with notes"}
            </h3>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">
              {result.message}
            </p>
            <div className="flex flex-wrap gap-4 mt-2 text-xs text-[hsl(var(--muted-foreground))]">
              <span>
                Matched:{" "}
                <b className="text-[hsl(var(--foreground))]">
                  {result.attempted}
                </b>
              </span>
              <span>
                Cleared:{" "}
                <b className="text-[hsl(var(--foreground))]">{result.cleared}</b>
              </span>
              <span>
                Not found:{" "}
                <b className="text-[hsl(var(--foreground))]">
                  {result.errors.length}
                </b>
              </span>
            </div>
          </div>
          <button
            type="button"
            className="btn-ghost h-8 w-8 px-0"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 pb-3 space-y-4 overflow-auto flex-1">
          {result.errors.length > 0 && (
            <details className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
              <summary className="cursor-pointer font-medium text-amber-600 dark:text-amber-400">
                {result.errors.length} mobile number
                {result.errors.length === 1 ? "" : "s"} with no match
              </summary>
              <ul className="mt-2 space-y-1 max-h-48 overflow-auto">
                {result.errors.map((err, i) => (
                  <li key={i} className="font-mono">
                    <b>{err.mobile}</b>: {err.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <OtpBlockTable rows={result.rows} />
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[hsl(var(--border))]">
          <button type="button" className="btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewModal({
  preview,
  userTypeLabel,
  isProd,
  running,
  onCancel,
  onConfirm,
}: {
  preview: OtpBlockResult;
  userTypeLabel: string;
  isProd: boolean;
  running: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const count = preview.candidates ?? 0;
  const nothingToDo = count === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="card-strong max-w-3xl w-full max-h-[90vh] flex flex-col">
        <div className="flex items-start gap-3 p-6 pb-3">
          <div
            className={clsx(
              "h-10 w-10 rounded-full flex items-center justify-center shrink-0",
              isProd
                ? "bg-[hsl(var(--danger))]/15"
                : "bg-[hsl(var(--primary))]/15",
            )}
          >
            {isProd ? (
              <AlertTriangle className="h-5 w-5 text-[hsl(var(--danger))]" />
            ) : (
              <Eye className="h-5 w-5 text-[hsl(var(--primary))]" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold flex items-center gap-2 flex-wrap">
              <span>Preview — Clear 24h OTP Block ({userTypeLabel})</span>
              {isProd && (
                <span className="pill bg-red-500/15 text-red-600 dark:text-red-400">
                  <AlertTriangle className="h-3 w-3" />
                  Production
                </span>
              )}
            </h3>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">
              {preview.message}
            </p>
          </div>
          <button
            type="button"
            className="btn-ghost h-8 w-8 px-0"
            onClick={onCancel}
            aria-label="Cancel"
            disabled={running}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 pb-3">
          <div
            className={clsx(
              "rounded-lg border p-3 text-sm flex items-center gap-3",
              nothingToDo
                ? "border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40"
                : isProd
                  ? "border-[hsl(var(--danger))]/40 bg-[hsl(var(--danger))]/5"
                  : "border-[hsl(var(--primary))]/30 bg-[hsl(var(--primary))]/5",
            )}
          >
            <span
              className={clsx(
                "text-2xl font-semibold tabular-nums leading-none",
                nothingToDo
                  ? "text-[hsl(var(--muted-foreground))]"
                  : isProd
                    ? "text-[hsl(var(--danger))]"
                    : "text-[hsl(var(--primary))]",
              )}
            >
              {count}
            </span>
            <span className="text-xs text-[hsl(var(--muted-foreground))]">
              row{count === 1 ? "" : "s"} will be modified if you confirm.
              {isProd && !nothingToDo ? " This is the production database." : ""}
            </span>
          </div>
        </div>

        <div className="px-6 pb-3 overflow-auto flex-1">
          <OtpBlockTable rows={preview.rows} />
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[hsl(var(--border))]">
          <button
            type="button"
            className="btn-ghost"
            onClick={onCancel}
            disabled={running}
          >
            Cancel
          </button>
          <button
            type="button"
            className={isProd ? "btn-danger" : "btn-primary"}
            onClick={onConfirm}
            disabled={running || nothingToDo}
          >
            {running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Running…
              </>
            ) : (
              <>
                <ChevronRight className="h-4 w-4" />
                {nothingToDo
                  ? "Nothing to do"
                  : isProd
                    ? "Confirm — run on production"
                    : "Confirm & run"}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
