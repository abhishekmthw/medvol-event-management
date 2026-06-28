"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CircleAlert,
  Download,
  GitCompareArrows,
  Info,
  Loader2,
  Search,
  Users,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Segmented } from "@/components/segmented";
import { AuthComparisonTable } from "@/components/auth-comparison-table";
import { toComparisonCsv } from "@/lib/comparison-csv";
import {
  EMPLOYEE_SCOPES,
  type AuthComparisonResult,
  type EmployeeScope,
  type Environment,
} from "@/lib/types";

export default function AuthComparisonPage() {
  const router = useRouter();

  const [environment, setEnvironment] = useState<Environment>("stage");
  const [scope, setScope] = useState<EmployeeScope>("active");
  const [mobile, setMobile] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AuthComparisonResult | null>(null);
  const [topError, setTopError] = useState<string | null>(null);

  const isProd = environment === "prod";
  const bulkMode = mobile.trim().length === 0;

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
      </div>
    </main>
  );
}
