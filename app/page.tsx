"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CirclePlay,
  Database,
  Eraser,
  Eye,
  Info,
  Layers,
  Loader2,
  RefreshCcw,
  Search,
  ShieldAlert,
  Wand2,
  X,
} from "lucide-react";
import clsx from "clsx";
import { AppHeader } from "@/components/app-header";
import { Segmented } from "@/components/segmented";
import { FormatIdsModal } from "@/components/format-ids-modal";
import {
  ACTIONS,
  type ActionKey,
  type BatchStatusRow,
  type Environment,
  type EventStatusRow,
  type InstanceOption,
  type OperationResult,
  type Service,
} from "@/lib/types";

const ACTION_ICONS: Record<ActionKey, JSX.Element> = {
  "clear-by-event-ids": <Eraser className="h-4 w-4" />,
  "refire-by-event-ids": <RefreshCcw className="h-4 w-4" />,
  "clear-by-stream-ids": <Layers className="h-4 w-4" />,
  "clear-batch": <Database className="h-4 w-4" />,
  status: <Search className="h-4 w-4" />,
};

function statusPillClass(status: string): string {
  const s = status.toLowerCase();
  if (s === "success" || s === "forcesuccess") {
    return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
  }
  if (s === "failed") {
    return "bg-red-500/15 text-red-600 dark:text-red-400";
  }
  if (s === "queue") {
    return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
  }
  return "bg-slate-500/15 text-slate-600 dark:text-slate-300";
}

export default function DashboardPage() {
  const router = useRouter();

  const [environment, setEnvironment] = useState<Environment>("stage");
  const [service, setService] = useState<Service>("corp");
  const [instance, setInstance] = useState<string | null>(null);
  const [instances, setInstances] = useState<InstanceOption[]>([]);
  const [action, setAction] = useState<ActionKey>("status");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<OperationResult | null>(null);
  const [result, setResult] = useState<OperationResult | null>(null);
  const [topError, setTopError] = useState<string | null>(null);
  const [formatOpen, setFormatOpen] = useState(false);

  const handleSessionExpired = useMemo(
    () => async () => {
      try {
        await fetch("/api/auth/logout", { method: "POST" });
      } catch {
        // Logout endpoint is best-effort — middleware will redirect anyway.
      }
      const next = window.location.pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
      router.refresh();
    },
    [router],
  );

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

  const instancesForService = useMemo(
    () => instances.filter((i) => i.service === service),
    [instances, service],
  );

  // Reset `instance` whenever it becomes invalid for the current service.
  useEffect(() => {
    if (instance && !instancesForService.find((i) => i.id === instance)) {
      setInstance(null);
    }
  }, [instance, instancesForService]);

  const meta = useMemo(
    () => ACTIONS.find((a) => a.key === action)!,
    [action],
  );

  const isProd = environment === "prod";
  const isDestructive = Boolean(meta.danger);

  async function callRun(preview: boolean): Promise<OperationResult | null> {
    setTopError(null);
    try {
      const res = await fetch("/api/events/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          environment,
          service,
          instance,
          input,
          preview,
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
      return data as OperationResult;
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

  async function handleExecute() {
    if (!input.trim()) {
      setTopError("Please enter at least one identifier.");
      return;
    }
    if (isDestructive) {
      setPreviewing(true);
      setResult(null);
      try {
        const p = await callRun(true);
        if (p) setPreview(p);
      } finally {
        setPreviewing(false);
      }
      return;
    }
    await executeNow();
  }

  async function confirmPreview() {
    setPreview(null);
    await executeNow();
  }

  return (
    <main className="min-h-screen">
      <AppHeader />

      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 space-y-6">
        <TargetCard
          environment={environment}
          service={service}
          instance={instance}
          instancesForService={instancesForService}
          setEnvironment={setEnvironment}
          setService={(s) => {
            setService(s);
            setInstance(null);
          }}
          setInstance={setInstance}
        />

        <section className="card p-5 sm:p-6 space-y-5 animate-fade-in">
          <div className="flex items-center gap-2">
            <CirclePlay className="h-4 w-4 text-[hsl(var(--primary))]" />
            <h2 className="text-sm font-semibold uppercase tracking-wider">
              Operation
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {ACTIONS.map((a) => {
              const selected = a.key === action;
              return (
                <button
                  key={a.key}
                  type="button"
                  onClick={() => {
                    setAction(a.key);
                    setResult(null);
                    setTopError(null);
                  }}
                  className={clsx(
                    "text-left rounded-xl border p-3 transition group",
                    selected
                      ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 shadow-sm"
                      : "border-[hsl(var(--border))] hover:border-[hsl(var(--primary))]/40 hover:bg-[hsl(var(--muted))]",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={clsx(
                        "h-7 w-7 inline-flex items-center justify-center rounded-md",
                        selected
                          ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                          : "bg-[hsl(var(--muted))] text-[hsl(var(--foreground))]",
                      )}
                    >
                      {ACTION_ICONS[a.key]}
                    </span>
                    <span className="text-sm font-medium">{a.label}</span>
                    {a.danger && (
                      <span className="ml-auto pill bg-amber-500/15 text-amber-600 dark:text-amber-400">
                        <ShieldAlert className="h-3 w-3" />
                        write
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[hsl(var(--muted-foreground))] mt-2 line-clamp-3">
                    {a.description}
                  </p>
                </button>
              );
            })}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="action-input"
                className="block text-xs font-medium text-[hsl(var(--muted-foreground))]"
              >
                {meta.inputLabel}
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
              id="action-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={3}
              placeholder={meta.inputPlaceholder}
              className="input-base font-mono text-[13px] resize-y min-h-[80px]"
              disabled={loading}
            />
            <p className="flex items-start gap-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              {meta.inputHint}
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
              {isDestructive
                ? "Preview will show affected rows before any database change."
                : "This is a read-only operation."}
            </p>
            <button
              type="button"
              className={clsx(
                isDestructive && isProd ? "btn-danger" : "btn-primary",
                "min-w-[150px]",
              )}
              onClick={handleExecute}
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
              ) : isDestructive ? (
                <>
                  <Eye className="h-4 w-4" />
                  Preview & Run
                </>
              ) : (
                <>
                  Execute
                  <ChevronRight className="h-4 w-4" />
                </>
              )}
            </button>
          </div>
        </section>

      </div>

      {result && (
        <ResultsModal
          result={result}
          action={action}
          onClose={() => setResult(null)}
        />
      )}

      {preview && (
        <PreviewModal
          preview={preview}
          action={action}
          actionLabel={meta.label}
          isProd={isProd}
          running={loading}
          onCancel={() => setPreview(null)}
          onConfirm={confirmPreview}
        />
      )}

      {formatOpen && <FormatIdsModal onClose={() => setFormatOpen(false)} />}
    </main>
  );
}

function TargetCard({
  environment,
  service,
  instance,
  instancesForService,
  setEnvironment,
  setService,
  setInstance,
}: {
  environment: Environment;
  service: Service;
  instance: string | null;
  instancesForService: InstanceOption[];
  setEnvironment: (e: Environment) => void;
  setService: (s: Service) => void;
  setInstance: (v: string | null) => void;
}) {
  const hasPrivate = instancesForService.length > 0;
  const instanceOptions = hasPrivate
    ? [
        { value: "shared", label: "Shared" },
        ...instancesForService.map((i) => ({ value: i.id, label: i.label })),
      ]
    : [{ value: "shared", label: "Shared (only)" }];

  return (
    <section className="card p-5 sm:p-6 space-y-5 animate-fade-in">
      <div className="flex items-center gap-2">
        <Database className="h-4 w-4 text-[hsl(var(--primary))]" />
        <h2 className="text-sm font-semibold uppercase tracking-wider">
          Target
        </h2>
        {environment === "prod" && (
          <span className="ml-auto pill bg-red-500/15 text-red-600 dark:text-red-400">
            <AlertTriangle className="h-3 w-3" />
            Production
          </span>
        )}
      </div>

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
            value={environment}
            onChange={setEnvironment}
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
            value={service}
            onChange={setService}
          />
        </div>

        <div>
          <p className="text-xs font-medium mb-2 text-[hsl(var(--muted-foreground))]">
            {service.toUpperCase()} Instance
          </p>
          <Segmented<string>
            options={instanceOptions}
            value={instance ?? "shared"}
            onChange={(v) => setInstance(v === "shared" ? null : v)}
            disabled={!hasPrivate}
          />
        </div>
      </div>
    </section>
  );
}

function ResultsModal({
  result,
  action,
  onClose,
}: {
  result: OperationResult;
  action: ActionKey;
  onClose: () => void;
}) {
  const isBatch = action === "clear-batch";
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
              {result.ok ? "Success" : "Completed with errors"}
            </h3>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">
              {result.message}
            </p>
            {action !== "status" && (
              <div className="flex flex-wrap gap-4 mt-2 text-xs text-[hsl(var(--muted-foreground))]">
                <span>
                  Attempted: <b className="text-[hsl(var(--foreground))]">{result.attempted}</b>
                </span>
                <span>
                  Processed: <b className="text-[hsl(var(--foreground))]">{result.cleared}</b>
                </span>
                {typeof result.gone === "number" && result.gone > 0 && (
                  <span title="SQS message was already gone (>15 days) — DB was still force-succeeded.">
                    SQS expired:{" "}
                    <b className="text-amber-600 dark:text-amber-400">{result.gone}</b>
                  </span>
                )}
                <span>
                  Errors: <b className="text-[hsl(var(--foreground))]">{result.errors.length}</b>
                </span>
              </div>
            )}
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
            <details className="rounded-lg border border-[hsl(var(--danger))]/30 bg-[hsl(var(--danger))]/5 p-3 text-xs">
              <summary className="cursor-pointer font-medium text-[hsl(var(--danger))]">
                {result.errors.length} error{result.errors.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-2 space-y-1 max-h-48 overflow-auto">
                {result.errors.map((err, i) => (
                  <li key={i} className="font-mono">
                    <b>{String(err.id)}</b>: {err.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {isBatch
            ? <BatchTable rows={result.batch ?? []} />
            : <EventTable rows={result.events ?? []} />}
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

function EventTable({ rows }: { rows: EventStatusRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-[hsl(var(--muted-foreground))] py-4 text-center">
        No event_consumer_status rows to display.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-[hsl(var(--border))]">
      <table className="w-full text-xs">
        <thead className="bg-[hsl(var(--muted))]/60 text-[hsl(var(--muted-foreground))]">
          <tr>
            <Th>Event ID</Th>
            <Th>Stream ID</Th>
            <Th>Event Type</Th>
            <Th>Status</Th>
            <Th>Force</Th>
            <Th>Recv</Th>
            <Th>Modified</Th>
            <Th>Error</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-t border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))]/40"
            >
              <Td className="font-mono">{r.eventid}</Td>
              <Td className="font-mono">{r.streamid}</Td>
              <Td>{r.event_type ?? "—"}</Td>
              <Td>
                <span className={clsx("pill", statusPillClass(r.event_status))}>
                  {r.event_status}
                </span>
              </Td>
              <Td>{r.forceStatus ? "✓" : "—"}</Td>
              <Td>{r.approximatereceivecount ?? "—"}</Td>
              <Td className="whitespace-nowrap">
                {r.modified_date
                  ? new Date(r.modified_date).toLocaleString()
                  : "—"}
              </Td>
              <Td
                className="max-w-[260px] truncate"
                title={r.error_message ?? undefined}
              >
                {r.error_message ?? "—"}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BatchTable({ rows }: { rows: BatchStatusRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-[hsl(var(--muted-foreground))] py-4 text-center">
        No batch_event_status rows to display.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-[hsl(var(--border))]">
      <table className="w-full text-xs">
        <thead className="bg-[hsl(var(--muted))]/60 text-[hsl(var(--muted-foreground))]">
          <tr>
            <Th>Row ID</Th>
            <Th>Batch ID</Th>
            <Th>Seq</Th>
            <Th>Event Type</Th>
            <Th>Status</Th>
            <Th>Force</Th>
            <Th>Modified</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-t border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))]/40"
            >
              <Td className="font-mono">{r.id}</Td>
              <Td className="font-mono">{r.batch_id}</Td>
              <Td className="font-mono">{String(r.batch_sequence)}</Td>
              <Td>{r.event_type}</Td>
              <Td>
                <span className={clsx("pill", statusPillClass(r.event_status))}>
                  {r.event_status}
                </span>
              </Td>
              <Td>{r.force_status ? "✓" : "—"}</Td>
              <Td className="whitespace-nowrap">
                {r.modified_date
                  ? new Date(r.modified_date).toLocaleString()
                  : "—"}
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
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={clsx("px-3 py-2 align-middle", className)} title={title}>
      {children}
    </td>
  );
}

function PreviewModal({
  preview,
  action,
  actionLabel,
  isProd,
  running,
  onCancel,
  onConfirm,
}: {
  preview: OperationResult;
  action: ActionKey;
  actionLabel: string;
  isProd: boolean;
  running: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isBatch = action === "clear-batch";
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
              <span>Preview — {actionLabel}</span>
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
              {isProd && !nothingToDo
                ? " This is the production database."
                : ""}
            </span>
          </div>
        </div>

        <div className="px-6 pb-3 overflow-auto flex-1">
          {isBatch ? (
            <BatchTable rows={preview.batch ?? []} />
          ) : (
            <EventTable rows={preview.events ?? []} />
          )}
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

