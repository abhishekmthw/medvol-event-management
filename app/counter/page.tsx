"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Braces,
  CircleAlert,
  Database,
  Download,
  Info,
  Layers,
  Loader2,
  Search,
  Wand2,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Segmented } from "@/components/segmented";
import { FormatIdsModal } from "@/components/format-ids-modal";
import { CounterTable } from "@/components/counter-table";
import { rowsToCsv } from "@/lib/csv";
import type {
  CounterOption,
  CounterQueryResult,
  CounterView,
  Environment,
  InstanceOption,
  Service,
} from "@/lib/types";

const VIEW_OPTIONS: { value: CounterView; label: string }[] = [
  { value: "division", label: "Counter Division" },
  { value: "products", label: "Counter Products" },
  { value: "stockist", label: "Counter Stockist" },
];

export default function CounterEventsPage() {
  const router = useRouter();

  const [view, setView] = useState<CounterView>("division");
  const [environment, setEnvironment] = useState<Environment>("stage");

  const [streamInput, setStreamInput] = useState("");
  const [companies, setCompanies] = useState<CounterOption[]>([]);
  const [companyCode, setCompanyCode] = useState("");
  const [divisions, setDivisions] = useState<CounterOption[]>([]);
  const [divisionCode, setDivisionCode] = useState("");
  const [locationCode, setLocationCode] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [loading, setLoading] = useState(false);
  const [loadingCompanies, setLoadingCompanies] = useState(false);
  const [loadingDivisions, setLoadingDivisions] = useState(false);
  const [result, setResult] = useState<CounterQueryResult | null>(null);
  const [topError, setTopError] = useState<string | null>(null);
  const [formatOpen, setFormatOpen] = useState(false);

  // --- Raw Event Payloads card (independent target: env / service / instance) ---
  const [rawEnv, setRawEnv] = useState<Environment>("stage");
  const [rawService, setRawService] = useState<Service>("corp");
  const [rawInstance, setRawInstance] = useState<string | null>(null);
  const [instances, setInstances] = useState<InstanceOption[]>([]);
  const [rawStreamInput, setRawStreamInput] = useState("");
  const [rawLoading, setRawLoading] = useState(false);
  const [rawResult, setRawResult] = useState<CounterQueryResult | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);

  const isProd = environment === "prod";
  const showDivision = view !== "stockist";

  const handleSessionExpired = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // best-effort — middleware will redirect anyway.
    }
    const next = window.location.pathname + window.location.search;
    router.replace(`/login?next=${encodeURIComponent(next)}`);
    router.refresh();
  }, [router]);

  // Load companies whenever the environment changes (and on mount). Reset the
  // dependent company/division selections so we never carry stale codes across envs.
  useEffect(() => {
    let cancelled = false;
    setLoadingCompanies(true);
    setCompanyCode("");
    setDivisions([]);
    setDivisionCode("");
    fetch(`/api/counter/companies?environment=${environment}`)
      .then(async (r) => {
        if (r.status === 401) {
          if (!cancelled) await handleSessionExpired();
          return null;
        }
        return r.json();
      })
      .then((d) => {
        if (cancelled || d === null) return;
        setCompanies(Array.isArray(d?.companies) ? d.companies : []);
      })
      .catch(() => {
        if (!cancelled) setCompanies([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingCompanies(false);
      });
    return () => {
      cancelled = true;
    };
  }, [environment, handleSessionExpired]);

  // Cascade: load divisions for the selected company. Clear when no company.
  useEffect(() => {
    if (!companyCode) {
      setDivisions([]);
      setDivisionCode("");
      return;
    }
    let cancelled = false;
    setLoadingDivisions(true);
    setDivisionCode("");
    fetch(
      `/api/counter/divisions?environment=${environment}&company=${encodeURIComponent(companyCode)}`,
    )
      .then(async (r) => {
        if (r.status === 401) {
          if (!cancelled) await handleSessionExpired();
          return null;
        }
        return r.json();
      })
      .then((d) => {
        if (cancelled || d === null) return;
        setDivisions(Array.isArray(d?.divisions) ? d.divisions : []);
      })
      .catch(() => {
        if (!cancelled) setDivisions([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingDivisions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyCode, environment, handleSessionExpired]);

  const canExecute = useMemo(() => streamInput.trim().length > 0, [streamInput]);

  async function handleExecute() {
    if (!canExecute) {
      setTopError("At least one stream ID is required.");
      return;
    }
    setLoading(true);
    setTopError(null);
    setResult(null);
    try {
      const res = await fetch("/api/counter/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          environment,
          view,
          streamIds: streamInput,
          companyCode: companyCode || null,
          divisionCode: showDivision ? divisionCode || null : null,
          locationCode: locationCode || null,
          fromDate: fromDate || null,
          toDate: toDate || null,
        }),
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
      setResult(data as CounterQueryResult);
    } catch (e) {
      setTopError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function handleDownloadCsv() {
    if (!result || !result.rows.length) return;
    const csv = rowsToCsv(result.columns, result.rows);
    // Prepend a UTF-8 BOM (U+FEFF) so Excel detects the encoding correctly.
    const bom = String.fromCharCode(0xfeff);
    const blob = new Blob([bom + csv], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvFilename(view, environment);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Load the registered private instances once (drives the Raw card's instance
  // picker). Mirrors the Event Ops dashboard.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/instances")
      .then(async (r) => {
        if (r.status === 401) {
          if (!cancelled) await handleSessionExpired();
          return null;
        }
        return r.json();
      })
      .then((d) => {
        if (cancelled || d === null) return;
        setInstances(Array.isArray(d?.instances) ? d.instances : []);
      })
      .catch(() => {
        if (!cancelled) setInstances([]);
      });
    return () => {
      cancelled = true;
    };
  }, [handleSessionExpired]);

  const rawInstancesForService = useMemo(
    () => instances.filter((i) => i.service === rawService),
    [instances, rawService],
  );

  // Drop a selected instance that no longer belongs to the chosen service.
  useEffect(() => {
    if (rawInstance && !rawInstancesForService.find((i) => i.id === rawInstance)) {
      setRawInstance(null);
    }
  }, [rawInstance, rawInstancesForService]);

  const canExecuteRaw = useMemo(
    () => rawStreamInput.trim().length > 0,
    [rawStreamInput],
  );

  async function handleRawExecute() {
    if (!canExecuteRaw) {
      setRawError("At least one stream ID is required.");
      return;
    }
    setRawLoading(true);
    setRawError(null);
    setRawResult(null);
    try {
      const res = await fetch("/api/counter/raw-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          environment: rawEnv,
          service: rawService,
          instance: rawInstance,
          streamIds: rawStreamInput,
        }),
      });
      if (res.status === 401) {
        await handleSessionExpired();
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setRawError(data?.error ?? `Request failed (HTTP ${res.status}).`);
        return;
      }
      setRawResult(data as CounterQueryResult);
    } catch (e) {
      setRawError(e instanceof Error ? e.message : String(e));
    } finally {
      setRawLoading(false);
    }
  }

  function handleRawDownloadCsv() {
    if (!rawResult || !rawResult.rows.length) return;
    const csv = rowsToCsv(rawResult.columns, rawResult.rows);
    // Prepend a UTF-8 BOM (U+FEFF) so Excel detects the encoding correctly.
    const bom = String.fromCharCode(0xfeff);
    const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = rawCsvFilename(rawEnv, rawService, rawInstance);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <main className="min-h-screen">
      <AppHeader />

      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 space-y-6">
        <section className="card p-5 sm:p-6 space-y-5 animate-fade-in">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-[hsl(var(--primary))]" />
            <h2 className="text-sm font-semibold uppercase tracking-wider">
              Counter Events
            </h2>
            {isProd && (
              <span className="ml-auto pill bg-red-500/15 text-red-600 dark:text-red-400">
                <AlertTriangle className="h-3 w-3" />
                Production
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-medium mb-2 text-[hsl(var(--muted-foreground))]">
                View
              </p>
              <Segmented<CounterView>
                options={VIEW_OPTIONS}
                value={view}
                onChange={(v) => {
                  setView(v);
                  setResult(null);
                  setTopError(null);
                }}
              />
            </div>
            <div>
              <p className="text-xs font-medium mb-2 text-[hsl(var(--muted-foreground))]">
                Environment <span className="opacity-60">(Corp DB)</span>
              </p>
              <Segmented<Environment>
                options={[
                  { value: "stage", label: "Stage" },
                  { value: "prod", label: "Prod", danger: true },
                ]}
                value={environment}
                onChange={setEnvironment}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="stream-input"
                className="block text-xs font-medium text-[hsl(var(--muted-foreground))]"
              >
                Stream IDs <span className="text-[hsl(var(--danger))]">*</span>
              </label>
              <button
                type="button"
                onClick={() => setFormatOpen(true)}
                className="btn-ghost h-7 text-xs px-2.5"
                title="Open the ID formatter — paste a list, get a comma-separated string."
              >
                <Wand2 className="h-3.5 w-3.5" />
                Format IDs
              </button>
            </div>
            <textarea
              id="stream-input"
              value={streamInput}
              onChange={(e) => setStreamInput(e.target.value)}
              rows={2}
              placeholder="counter_104997, counter_109770"
              className="input-base font-mono text-[13px] resize-y min-h-[60px]"
              disabled={loading}
            />
            <p className="flex items-start gap-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              Required. One or many `counter_*` stream IDs (comma / space /
              newline separated).
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label
                htmlFor="company-select"
                className="block text-xs font-medium mb-2 text-[hsl(var(--muted-foreground))]"
              >
                Company {loadingCompanies && <InlineSpinner />}
              </label>
              <select
                id="company-select"
                value={companyCode}
                onChange={(e) => setCompanyCode(e.target.value)}
                className="input-base"
                disabled={loading || loadingCompanies}
              >
                <option value="">All companies</option>
                {companies.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name} ({c.code})
                  </option>
                ))}
              </select>
            </div>

            {showDivision && (
              <div>
                <label
                  htmlFor="division-select"
                  className="block text-xs font-medium mb-2 text-[hsl(var(--muted-foreground))]"
                >
                  Division {loadingDivisions && <InlineSpinner />}
                </label>
                <select
                  id="division-select"
                  value={divisionCode}
                  onChange={(e) => setDivisionCode(e.target.value)}
                  className="input-base"
                  disabled={loading || loadingDivisions || !companyCode}
                >
                  <option value="">
                    {companyCode ? "All divisions" : "Select a company first"}
                  </option>
                  {divisions.map((d) => (
                    <option key={d.code} value={d.code}>
                      {d.name} ({d.code})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label
                htmlFor="location-input"
                className="block text-xs font-medium mb-2 text-[hsl(var(--muted-foreground))]"
              >
                Location Code
              </label>
              <input
                id="location-input"
                value={locationCode}
                onChange={(e) => setLocationCode(e.target.value)}
                placeholder="e.g. 1957327797"
                className="input-base font-mono text-[13px]"
                disabled={loading}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="from-date"
                className="block text-xs font-medium mb-2 text-[hsl(var(--muted-foreground))]"
              >
                From Date
              </label>
              <input
                id="from-date"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="input-base"
                disabled={loading}
              />
            </div>
            <div>
              <label
                htmlFor="to-date"
                className="block text-xs font-medium mb-2 text-[hsl(var(--muted-foreground))]"
              >
                To Date <span className="opacity-60">(inclusive)</span>
              </label>
              <input
                id="to-date"
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="input-base"
                disabled={loading}
              />
            </div>
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
              Read-only query against the Corp event store. Stream ID is
              required; all other filters are optional.
            </p>
            <button
              type="button"
              className="btn-primary min-w-[150px]"
              onClick={handleExecute}
              disabled={loading || !canExecute}
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Running…
                </>
              ) : (
                <>
                  <Search className="h-4 w-4" />
                  Run Query
                </>
              )}
            </button>
          </div>
        </section>

        {result && (
          <section className="card p-5 sm:p-6 space-y-4 animate-fade-in">
            <div className="flex items-center gap-2 flex-wrap">
              <Database className="h-4 w-4 text-[hsl(var(--primary))]" />
              <h2 className="text-sm font-semibold uppercase tracking-wider">
                Results
              </h2>
              <span className="pill bg-[hsl(var(--muted))] text-[hsl(var(--foreground))] tabular-nums">
                {result.count} row{result.count === 1 ? "" : "s"}
              </span>
              {result.truncated && (
                <span
                  className="pill bg-amber-500/15 text-amber-600 dark:text-amber-400"
                  title="Result set hit the row cap — narrow your filters to see the rest."
                >
                  <AlertTriangle className="h-3 w-3" />
                  showing first 1000
                </span>
              )}
              <div className="ml-auto flex items-center gap-3">
                <span className="text-xs text-[hsl(var(--muted-foreground))]">
                  {result.message}
                </span>
                <button
                  type="button"
                  className="btn-ghost h-8 text-xs px-2.5"
                  onClick={handleDownloadCsv}
                  disabled={result.rows.length === 0}
                  title="Download the fetched rows as a CSV file."
                >
                  <Download className="h-3.5 w-3.5" />
                  Download CSV
                </button>
              </div>
            </div>
            <CounterTable columns={result.columns} rows={result.rows} />
          </section>
        )}

        {/* ---------------- Raw Event Payloads card ---------------- */}
        <section className="card p-5 sm:p-6 space-y-5 animate-fade-in">
          <div className="flex items-center gap-2">
            <Braces className="h-4 w-4 text-[hsl(var(--primary))]" />
            <h2 className="text-sm font-semibold uppercase tracking-wider">
              Raw Event Payloads
            </h2>
            {rawEnv === "prod" && (
              <span className="ml-auto pill bg-red-500/15 text-red-600 dark:text-red-400">
                <AlertTriangle className="h-3 w-3" />
                Production
              </span>
            )}
          </div>

          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            Dump every event on a stream — full payload, newest first — from any
            environment / service / instance. Read-only.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <p className="text-xs font-medium mb-2 text-[hsl(var(--muted-foreground))]">
                Environment
              </p>
              <Segmented<Environment>
                options={[
                  { value: "stage", label: "Stage" },
                  { value: "prod", label: "Prod", danger: true },
                ]}
                value={rawEnv}
                onChange={setRawEnv}
              />
            </div>
            <div>
              <p className="text-xs font-medium mb-2 text-[hsl(var(--muted-foreground))]">
                Service
              </p>
              <Segmented<Service>
                options={[
                  { value: "corp", label: "Corp" },
                  { value: "oms", label: "OMS" },
                ]}
                value={rawService}
                onChange={(s) => {
                  setRawService(s);
                  setRawInstance(null);
                }}
              />
            </div>
            <div>
              <p className="text-xs font-medium mb-2 text-[hsl(var(--muted-foreground))]">
                {rawService.toUpperCase()} Instance
              </p>
              <Segmented<string>
                options={
                  rawInstancesForService.length > 0
                    ? [
                        { value: "shared", label: "Shared" },
                        ...rawInstancesForService.map((i) => ({
                          value: i.id,
                          label: i.label,
                        })),
                      ]
                    : [{ value: "shared", label: "Shared (only)" }]
                }
                value={rawInstance ?? "shared"}
                onChange={(v) => setRawInstance(v === "shared" ? null : v)}
                disabled={rawInstancesForService.length === 0}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="raw-stream-input"
                className="block text-xs font-medium text-[hsl(var(--muted-foreground))]"
              >
                Stream IDs <span className="text-[hsl(var(--danger))]">*</span>
              </label>
              <button
                type="button"
                onClick={() => setFormatOpen(true)}
                className="btn-ghost h-7 text-xs px-2.5"
                title="Open the ID formatter — paste a list, get a comma-separated string."
              >
                <Wand2 className="h-3.5 w-3.5" />
                Format IDs
              </button>
            </div>
            <textarea
              id="raw-stream-input"
              value={rawStreamInput}
              onChange={(e) => setRawStreamInput(e.target.value)}
              rows={2}
              placeholder="counter_104997, order_375159, employee_88214"
              className="input-base font-mono text-[13px] resize-y min-h-[60px]"
              disabled={rawLoading}
            />
            <p className="flex items-start gap-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              Required. One or many stream IDs of any domain (comma / space /
              newline separated). Events are grouped per stream, newest first.
            </p>
          </div>

          {rawError && (
            <div
              role="alert"
              className="rounded-lg border border-[hsl(var(--danger))]/40 bg-[hsl(var(--danger))]/10
                         text-[hsl(var(--danger))] px-3 py-2 text-xs flex items-start gap-2 animate-fade-in"
            >
              <CircleAlert className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{rawError}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              Read-only query against `public.events`. Full `data` /
              `userDetails` payloads are returned as JSON.
            </p>
            <button
              type="button"
              className="btn-primary min-w-[150px]"
              onClick={handleRawExecute}
              disabled={rawLoading || !canExecuteRaw}
            >
              {rawLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Running…
                </>
              ) : (
                <>
                  <Search className="h-4 w-4" />
                  Fetch Events
                </>
              )}
            </button>
          </div>
        </section>

        {rawResult && (
          <section className="card p-5 sm:p-6 space-y-4 animate-fade-in">
            <div className="flex items-center gap-2 flex-wrap">
              <Database className="h-4 w-4 text-[hsl(var(--primary))]" />
              <h2 className="text-sm font-semibold uppercase tracking-wider">
                Event Payloads
              </h2>
              <span className="pill bg-[hsl(var(--muted))] text-[hsl(var(--foreground))] tabular-nums">
                {rawResult.count} event{rawResult.count === 1 ? "" : "s"}
              </span>
              {rawResult.truncated && (
                <span
                  className="pill bg-amber-500/15 text-amber-600 dark:text-amber-400"
                  title="Result set hit the row cap — narrow to fewer streams to see the rest."
                >
                  <AlertTriangle className="h-3 w-3" />
                  showing first 1000
                </span>
              )}
              <div className="ml-auto flex items-center gap-3">
                <span className="text-xs text-[hsl(var(--muted-foreground))]">
                  {rawResult.message}
                </span>
                <button
                  type="button"
                  className="btn-ghost h-8 text-xs px-2.5"
                  onClick={handleRawDownloadCsv}
                  disabled={rawResult.rows.length === 0}
                  title="Download the fetched events as a CSV file (payload in one column)."
                >
                  <Download className="h-3.5 w-3.5" />
                  Download CSV
                </button>
              </div>
            </div>
            <CounterTable columns={rawResult.columns} rows={rawResult.rows} />
          </section>
        )}
      </div>

      {formatOpen && <FormatIdsModal onClose={() => setFormatOpen(false)} />}
    </main>
  );
}

function InlineSpinner() {
  return (
    <Loader2 className="inline h-3 w-3 animate-spin text-[hsl(var(--muted-foreground))]" />
  );
}

/** e.g. counter-products-stage-20260628-143012.csv */
function csvFilename(view: CounterView, environment: Environment): string {
  return `counter-${view}-${environment}-${stamp()}.csv`;
}

/** e.g. raw-events-oms-lupin-prod-20260729-143012.csv */
function rawCsvFilename(
  environment: Environment,
  service: Service,
  instance: string | null,
): string {
  return `raw-events-${service}-${instance ?? "shared"}-${environment}-${stamp()}.csv`;
}

/** Compact local timestamp for filenames: YYYYMMDD-HHMMSS. */
function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
