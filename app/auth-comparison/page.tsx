"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CircleAlert,
  CircleStop,
  Download,
  GitCompareArrows,
  Info,
  Loader2,
  Search,
  UserCheck,
  Users,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Segmented } from "@/components/segmented";
import { AuthComparisonTable } from "@/components/auth-comparison-table";
import { DataCorrectionCard } from "@/components/data-correction-card";
import { EmployeeCognitoTable } from "@/components/employee-cognito-table";
import { toComparisonCsv, toEmployeeCognitoCsv } from "@/lib/comparison-csv";
import {
  EMPLOYEE_SCOPES,
  type AuthComparisonResult,
  type EmployeeCognitoChunk,
  type EmployeeCognitoRow,
  type EmployeeScope,
  type Environment,
} from "@/lib/types";

/** Progress/summary of the (possibly still running) employee ↔ Cognito scan. */
type ScanMeta = {
  checked: number;
  totalWithCognitoId: number;
  totalEmployees: number;
  done: boolean;
  stopped: boolean;
};

export default function AuthComparisonPage() {
  const router = useRouter();

  const [environment, setEnvironment] = useState<Environment>("stage");
  const [scope, setScope] = useState<EmployeeScope>("active");
  const [mobile, setMobile] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AuthComparisonResult | null>(null);
  const [topError, setTopError] = useState<string | null>(null);

  // Employee ↔ Cognito scan (chunked; the client loops until done or stopped).
  const [scanLoading, setScanLoading] = useState(false);
  const [scanMeta, setScanMeta] = useState<ScanMeta | null>(null);
  const [scanRows, setScanRows] = useState<EmployeeCognitoRow[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const scanStopRef = useRef(false);
  /** Bumped on reset/start so a stale in-flight scan loop stops writing state. */
  const scanGenRef = useRef(0);

  const isProd = environment === "prod";
  const bulkMode = mobile.trim().length === 0;

  function resetScan() {
    scanGenRef.current += 1;
    scanStopRef.current = true;
    setScanLoading(false);
    setScanMeta(null);
    setScanRows([]);
    setScanError(null);
  }

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

  async function runCompare() {
    setTopError(null);
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/auth-comparison/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environment, scope, mobile: mobile.trim() }),
      });
      if (res.status === 401) {
        await handleSessionExpired();
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setTopError(data?.error ?? `Request failed (HTTP ${res.status}).`);
        return;
      }
      setResult(data as AuthComparisonResult);
    } catch (e) {
      setTopError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runEmployeeScan() {
    scanGenRef.current += 1;
    const gen = scanGenRef.current;
    scanStopRef.current = false;
    setScanError(null);
    setScanRows([]);
    setScanMeta(null);
    setScanLoading(true);
    const acc: EmployeeCognitoRow[] = [];
    let offset = 0;
    try {
      // Walk the whole employee table one chunk per request; each response
      // reports how far we are and where to resume.
      for (;;) {
        const res = await fetch("/api/auth-comparison/employee-cognito", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ environment, scope, offset }),
        });
        if (gen !== scanGenRef.current) return; // superseded by reset/restart
        if (res.status === 401) {
          await handleSessionExpired();
          return;
        }
        const data = await res.json();
        if (!res.ok) {
          setScanError(data?.error ?? `Request failed (HTTP ${res.status}).`);
          return;
        }
        const chunk = data as EmployeeCognitoChunk;
        acc.push(...chunk.rows);
        setScanRows([...acc]);

        const done = chunk.nextOffset === null;
        const stopped = !done && scanStopRef.current;
        setScanMeta({
          checked: chunk.offset + chunk.checked,
          totalWithCognitoId: chunk.totalWithCognitoId,
          totalEmployees: chunk.totalEmployees,
          done,
          stopped,
        });
        if (done || stopped) return;
        offset = chunk.nextOffset!;
      }
    } catch (e) {
      if (gen === scanGenRef.current) {
        setScanError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (gen === scanGenRef.current) setScanLoading(false);
    }
  }

  function downloadScanCsv() {
    if (scanRows.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const filename = `employee-cognito-check_${environment}_${scope}_${stamp}.csv`;
    const blob = new Blob([toEmployeeCognitoCsv(scanRows)], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function downloadCsv() {
    if (!result || result.rows.length === 0) return;
    const stamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-");
    const mob = mobile.trim() ? `_${mobile.trim().replace(/\D/g, "")}` : "";
    const filename = `auth-comparison_${environment}_${scope}_${result.mode}${mob}_${stamp}.csv`;

    const blob = new Blob([toComparisonCsv(result)], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
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
                  resetScan();
                }}
              />
            </div>

            <div>
              <p className="text-xs font-medium mb-2 text-[hsl(var(--muted-foreground))]">
                Scope
              </p>
              <Segmented<EmployeeScope>
                options={EMPLOYEE_SCOPES}
                value={scope}
                onChange={(v) => {
                  setScope(v);
                  setResult(null);
                  setTopError(null);
                  resetScan();
                }}
              />
            </div>
          </div>
        </section>

        {/* Operation */}
        <section className="card p-5 sm:p-6 space-y-5 animate-fade-in">
          <div className="flex items-center gap-2">
            <GitCompareArrows className="h-4 w-4 text-[hsl(var(--primary))]" />
            <h2 className="text-sm font-semibold uppercase tracking-wider">
              Compare Auth / Corp / Cognito
            </h2>
            <span className="ml-auto pill bg-sky-500/15 text-sky-600 dark:text-sky-400">
              read-only
            </span>
          </div>

          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            Takes corp (<code>empmaster_hdr</code>) as the source of truth and
            checks each employee against the auth DB
            (<code>Field_Force_Users</code>, matched by short code + company code)
            and AWS Cognito — comparing <b>name</b>, <b>mobile number</b> and{" "}
            <b>cognito id</b> (Cognito is the source of truth for cognito id).
          </p>

          <div className="space-y-2">
            <label
              htmlFor="mobile-input"
              className="block text-xs font-medium text-[hsl(var(--muted-foreground))]"
            >
              Mobile Number (optional)
            </label>
            <input
              id="mobile-input"
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              placeholder="9876543210"
              inputMode="numeric"
              className="input-base font-mono text-[13px]"
              disabled={loading}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !loading) runCompare();
              }}
            />
            <p className="flex items-start gap-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              {bulkMode ? (
                <>
                  Empty → bulk scan: the first <b>100</b> corp employees that
                  don&apos;t match auth (missing, or name / mobile / cognito_id
                  differs), each validated against Cognito.
                </>
              ) : (
                <>
                  The corp employee(s) with this mobile are fetched, then checked
                  against auth and Cognito.
                </>
              )}
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
              Read-only — no database, SQS or Cognito writes are performed.
            </p>
            <button
              type="button"
              className="btn-primary min-w-[150px]"
              onClick={runCompare}
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Comparing…
                </>
              ) : (
                <>
                  <Search className="h-4 w-4" />
                  {bulkMode ? "Scan inconsistencies" : "Compare"}
                </>
              )}
            </button>
          </div>
        </section>

        {/* Results */}
        {result && (
          <section className="card p-5 sm:p-6 space-y-4 animate-fade-in">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wider">
                Results
              </h2>
              <span className="ml-auto pill bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
                {result.mode === "bulk" ? "Bulk scan" : "Single lookup"}
              </span>
              <button
                type="button"
                className="btn-ghost h-8"
                onClick={downloadCsv}
                disabled={result.rows.length === 0}
                title="Download these results as a CSV"
              >
                <Download className="h-4 w-4" />
                <span className="hidden sm:inline">Download CSV</span>
              </button>
            </div>

            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              {result.message}
            </p>

            {result.mode === "bulk" && result.truncated && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2">
                <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                {result.totalInconsistent} inconsistent records found — showing the
                first {result.rows.length}. Narrow with a mobile number, or use the
                Active-only scope to reduce noise.
              </div>
            )}

            <AuthComparisonTable rows={result.rows} />
          </section>
        )}

        {/* Employee ↔ Cognito full scan */}
        <section className="card p-5 sm:p-6 space-y-5 animate-fade-in">
          <div className="flex items-center gap-2">
            <UserCheck className="h-4 w-4 text-[hsl(var(--primary))]" />
            <h2 className="text-sm font-semibold uppercase tracking-wider">
              Employee ↔ Cognito Check
            </h2>
            <span className="ml-auto pill bg-sky-500/15 text-sky-600 dark:text-sky-400">
              read-only
            </span>
          </div>

          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            Scans <b>every</b> employee in the auth DB
            (<code>Field_Force_Users</code>, honoring the scope above) that has a{" "}
            <code>cognito_id</code>, looks that id up in AWS Cognito, and compares
            the <b>mobile number</b> and <b>short code</b> between the auth record
            and the Cognito user (<code>phone_number</code> /{" "}
            <code>custom:emp_short_code</code>). Each employee is then also matched
            to corp (<code>empmaster_hdr</code>, by short code + company code) and
            its <b>name</b>, <b>mobile</b> and <b>cognito id</b> are compared
            against corp too. Runs in chunks of 200 — only mismatches are listed.
          </p>

          {scanError && (
            <div
              role="alert"
              className="rounded-lg border border-[hsl(var(--danger))]/40 bg-[hsl(var(--danger))]/10
                         text-[hsl(var(--danger))] px-3 py-2 text-xs flex items-start gap-2 animate-fade-in"
            >
              <CircleAlert className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{scanError}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              {scanLoading && scanMeta ? (
                <>
                  Checked <b>{scanMeta.checked}</b> of{" "}
                  <b>{scanMeta.totalWithCognitoId}</b> employees with a
                  cognito_id — {scanRows.length} mismatch
                  {scanRows.length === 1 ? "" : "es"} so far…
                </>
              ) : (
                <>Read-only — no database or Cognito writes are performed.</>
              )}
            </p>
            <div className="flex items-center gap-2">
              {scanLoading && (
                <button
                  type="button"
                  className="btn-ghost h-9"
                  onClick={() => {
                    scanStopRef.current = true;
                  }}
                >
                  <CircleStop className="h-4 w-4" />
                  Stop
                </button>
              )}
              <button
                type="button"
                className="btn-primary min-w-[170px]"
                onClick={runEmployeeScan}
                disabled={scanLoading}
              >
                {scanLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Scanning…
                  </>
                ) : (
                  <>
                    <Search className="h-4 w-4" />
                    Check all employees
                  </>
                )}
              </button>
            </div>
          </div>
        </section>

        {/* Employee ↔ Cognito results */}
        {scanMeta && !scanLoading && (
          <section className="card p-5 sm:p-6 space-y-4 animate-fade-in">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wider">
                Employee ↔ Cognito Results
              </h2>
              <span className="ml-auto pill bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
                {scanMeta.done
                  ? "Full scan"
                  : scanMeta.stopped
                    ? "Stopped early"
                    : "Partial scan"}
              </span>
              <button
                type="button"
                className="btn-ghost h-8"
                onClick={downloadScanCsv}
                disabled={scanRows.length === 0}
                title="Download these mismatches as a CSV"
              >
                <Download className="h-4 w-4" />
                <span className="hidden sm:inline">Download CSV</span>
              </button>
            </div>

            <p className="text-sm text-[hsl(var(--muted-foreground))]">
              Checked {scanMeta.checked} of {scanMeta.totalWithCognitoId}{" "}
              {scope === "active" ? "active " : ""}employees with a cognito_id
              ({scanMeta.totalEmployees} in scope overall) against Cognito and
              corp — {scanRows.length} with a mismatch (mobile / short code vs
              Cognito, name / mobile / cognito_id vs corp, a stale cognito_id,
              missing in corp, or a lookup error).
            </p>

            {!scanMeta.done && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2">
                <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                The scan {scanMeta.stopped ? "was stopped" : "ended"} before
                completing — {scanMeta.totalWithCognitoId - scanMeta.checked}{" "}
                employees were not checked. Run it again to cover the full table.
              </div>
            )}

            <EmployeeCognitoTable rows={scanRows} />
          </section>
        )}

        {/* Employee data correction (corp-driven, mobile-keyed) */}
        <DataCorrectionCard
          key={environment}
          environment={environment}
          onSessionExpired={handleSessionExpired}
        />
      </div>
    </main>
  );
}
