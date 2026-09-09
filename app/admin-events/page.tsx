"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  Eye,
  Info,
  KeyRound,
  Loader2,
  Send,
  ShieldAlert,
  Square,
  Users,
  Wand2,
  X,
} from "lucide-react";
import clsx from "clsx";
import { AppHeader } from "@/components/app-header";
import { Segmented } from "@/components/segmented";
import { FormatIdsModal } from "@/components/format-ids-modal";
import {
  AdminEventUsersTable,
  AdminEventsTable,
} from "@/components/admin-events-table";
import { rowsToCsv } from "@/lib/csv";
import {
  ADMIN_EVENT_CHUNK,
  ALL_COMPANY_ROLE_IDS,
  SPECIFIC_COMPANY_ROLE_IDS,
  type AdminEventPreview,
  type AdminEventRow,
  type AdminEventRunResult,
  type AdminTokenResult,
  type Environment,
} from "@/lib/types";

type SkippedNote = AdminEventRunResult["skipped"][number];

export default function AdminEventsPage() {
  const router = useRouter();
  const [environment, setEnvironment] = useState<Environment>("stage");
  // A run holds the environment it started with, so the selector is locked
  // while one is in flight — otherwise the results on screen would be labelled
  // with an environment they did not come from.
  const [bulkBusy, setBulkBusy] = useState(false);
  const isProd = environment === "prod";

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

  return (
    <main className="min-h-screen">
      <AppHeader />

      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 space-y-6">
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
          <div className="max-w-xs">
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
              disabled={bulkBusy}
            />
          </div>
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            Applies to both cards below. The auth DB, the Cognito app client and
            the auth-backend endpoint are all resolved from this selection.
            {bulkBusy && " Locked while a push is running."}
          </p>
        </section>

        <BulkEditCard
          environment={environment}
          isProd={isProd}
          onBusyChange={setBulkBusy}
          onSessionExpired={handleSessionExpired}
        />

        <TokenCard
          environment={environment}
          onSessionExpired={handleSessionExpired}
        />
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ *
 * Card 1 — Bulk admin edit
 * ------------------------------------------------------------------ */

function BulkEditCard({
  environment,
  isProd,
  onBusyChange,
  onSessionExpired,
}: {
  environment: Environment;
  isProd: boolean;
  onBusyChange: (busy: boolean) => void;
  onSessionExpired: () => Promise<void>;
}) {
  const [input, setInput] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<AdminEventPreview | null>(null);
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<AdminEventRow[]>([]);
  const [skipped, setSkipped] = useState<SkippedNote[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  const [stoppedEarly, setStoppedEarly] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const [showFormat, setShowFormat] = useState(false);

  // Invalidates an in-flight chunk loop when the target changes underneath it,
  // so a stale response can never write into the new run's results.
  const genRef = useRef(0);
  const stopRef = useRef(false);

  function resetResults() {
    setRows([]);
    setSkipped([]);
    setProgress({ done: 0, total: 0 });
    setStoppedEarly(false);
    setTopError(null);
  }

  async function callRun(
    body: Record<string, unknown>,
  ): Promise<unknown | null> {
    try {
      const res = await fetch("/api/admin-events/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environment, ...body }),
      });
      if (res.status === 401) {
        await onSessionExpired();
        return null;
      }
      const data = await res.json();
      if (!res.ok) {
        setTopError(data?.error ?? `Request failed (HTTP ${res.status}).`);
        return null;
      }
      return data;
    } catch (e) {
      setTopError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  async function handlePreview() {
    setTopError(null);
    resetResults();
    setPreviewing(true);
    try {
      const data = (await callRun({
        input,
        preview: true,
      })) as AdminEventPreview | null;
      if (data) setPreview(data);
    } finally {
      setPreviewing(false);
    }
  }

  async function confirmPreview() {
    const users = preview?.users ?? [];
    setPreview(null);
    if (!users.length) return;

    const gen = ++genRef.current;
    stopRef.current = false;
    resetResults();
    setRunning(true);
    onBusyChange(true);

    const ids = users.map((u) => u.id);
    setProgress({ done: 0, total: ids.length });

    const acc: AdminEventRow[] = [];
    const accSkipped: SkippedNote[] = [];
    let halted = false;

    try {
      for (let i = 0; i < ids.length; i += ADMIN_EVENT_CHUNK) {
        if (stopRef.current) {
          halted = true;
          break;
        }
        const chunk = ids.slice(i, i + ADMIN_EVENT_CHUNK);
        const data = (await callRun({
          ids: chunk,
        })) as AdminEventRunResult | null;

        // The target changed mid-run — this response belongs to a run the user
        // has already abandoned.
        if (genRef.current !== gen) return;

        if (!data) {
          halted = true;
          break;
        }
        acc.push(...data.rows);
        accSkipped.push(...data.skipped);
        setRows([...acc]);
        setSkipped([...accSkipped]);
        setProgress({ done: Math.min(i + chunk.length, ids.length), total: ids.length });
      }
    } finally {
      if (genRef.current === gen) {
        setRunning(false);
        setStoppedEarly(halted);
        onBusyChange(false);
      }
    }
  }

  function handleDownloadCsv() {
    if (!rows.length) return;
    const columns = [
      { key: "id", label: "Admin User ID" },
      { key: "name", label: "Name" },
      { key: "mobile_no", label: "Mobile" },
      { key: "user_role_id", label: "Role ID" },
      { key: "group", label: "Body" },
      { key: "ok", label: "Sent" },
      { key: "status", label: "HTTP Status" },
      { key: "detail", label: "Response" },
    ];
    const csv = rowsToCsv(columns, rows as unknown as Record<string, unknown>[]);
    // Prepend a UTF-8 BOM (U+FEFF) so Excel detects the encoding correctly.
    const bom = String.fromCharCode(0xfeff);
    const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.download = `admin-events-${environment}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const succeeded = rows.filter((r) => r.ok).length;
  const failed = rows.length - succeeded;

  return (
    <>
      <section className="card p-5 sm:p-6 space-y-5 animate-fade-in">
        <div className="flex items-center gap-2">
          <Send className="h-4 w-4 text-[hsl(var(--primary))]" />
          <h2 className="text-sm font-semibold uppercase tracking-wider">
            Bulk Admin Edit
          </h2>
          <span className="ml-auto pill bg-amber-500/15 text-amber-600 dark:text-amber-400">
            <ShieldAlert className="h-3 w-3" />
            creates events
          </span>
        </div>

        <p className="text-xs text-[hsl(var(--muted-foreground))]">
          PUTs <code>/event/admin/edit</code> once per matching admin user,
          producing one <b>ADMIN_EDIT</b> V2 event per user on stream{" "}
          <code>admin_&lt;id&gt;</code>. Eligible users are{" "}
          <code>active_status = &apos;Y&apos;</code> with a non-empty mobile and
          email in one of these role groups:
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <RoleGroupBox
            title="All companies"
            roles={ALL_COMPANY_ROLE_IDS}
            note="companies omitted — auth-backend resolves every company for these roles."
          />
          <RoleGroupBox
            title="Specific companies"
            roles={SPECIFIC_COMPANY_ROLE_IDS}
            note="companies sent — every active company that has an active division."
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="admin-mobile-input"
              className="block text-xs font-medium text-[hsl(var(--muted-foreground))]"
            >
              Mobile Number(s) — optional filter
            </label>
            <button
              type="button"
              className="btn-ghost h-7 text-[11px]"
              onClick={() => setShowFormat(true)}
            >
              <Wand2 className="h-3 w-3" />
              Format
            </button>
          </div>
          <textarea
            id="admin-mobile-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={3}
            placeholder="Leave blank to target every eligible admin user"
            className="input-base font-mono text-[13px] resize-y min-h-[80px]"
            disabled={running || previewing}
          />
          <p className="flex items-start gap-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">
            <Info className="h-3 w-3 mt-0.5 shrink-0" />
            Comma-, space- or newline-separated, matched exactly against{" "}
            <code>mobile_no</code>. Each matched user is pushed with the body its
            own role group requires. <b>Blank means every eligible user</b> —
            the preview shows the count first.
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
            Preview lists every user and the exact body shape before anything is
            sent.
          </p>
          <div className="flex items-center gap-2">
            {running && (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  stopRef.current = true;
                }}
              >
                <Square className="h-4 w-4" />
                Stop
              </button>
            )}
            <button
              type="button"
              className={clsx(
                isProd ? "btn-danger" : "btn-primary",
                "min-w-[150px]",
              )}
              onClick={handlePreview}
              disabled={running || previewing}
            >
              {previewing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Previewing…
                </>
              ) : running ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Pushing…
                </>
              ) : (
                <>
                  <Eye className="h-4 w-4" />
                  Preview &amp; Run
                </>
              )}
            </button>
          </div>
        </div>

        {(running || rows.length > 0) && (
          <div className="space-y-3 pt-2 border-t border-[hsl(var(--border))]">
            <div className="flex flex-wrap items-center gap-4 text-xs pt-3">
              <span className="text-[hsl(var(--muted-foreground))]">
                Pushed{" "}
                <b className="text-[hsl(var(--foreground))] tabular-nums">
                  {progress.done}
                </b>{" "}
                of{" "}
                <b className="text-[hsl(var(--foreground))] tabular-nums">
                  {progress.total}
                </b>
              </span>
              <span className="text-emerald-600 dark:text-emerald-400">
                {succeeded} succeeded
              </span>
              {failed > 0 && (
                <span className="text-red-600 dark:text-red-400">
                  {failed} failed
                </span>
              )}
              {skipped.length > 0 && (
                <span className="text-amber-600 dark:text-amber-400">
                  {skipped.length} skipped
                </span>
              )}
              {stoppedEarly && !running && (
                <span className="pill bg-amber-500/15 text-amber-600 dark:text-amber-400">
                  Stopped early
                </span>
              )}
              {rows.length > 0 && !running && (
                <button
                  type="button"
                  className="btn-ghost h-7 text-[11px] ml-auto"
                  onClick={handleDownloadCsv}
                >
                  Download CSV
                </button>
              )}
            </div>

            {skipped.length > 0 && (
              <details className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
                <summary className="cursor-pointer font-medium text-amber-600 dark:text-amber-400">
                  {skipped.length} user{skipped.length === 1 ? "" : "s"} skipped
                </summary>
                <ul className="mt-2 space-y-1 max-h-48 overflow-auto">
                  {skipped.map((s, i) => (
                    <li key={i}>
                      <b className="font-mono">{s.id}</b>: {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <AdminEventsTable rows={rows} />
          </div>
        )}
      </section>

      {showFormat && <FormatIdsModal onClose={() => setShowFormat(false)} />}

      {preview && (
        <PreviewModal
          preview={preview}
          isProd={isProd}
          onCancel={() => setPreview(null)}
          onConfirm={confirmPreview}
        />
      )}
    </>
  );
}

function RoleGroupBox({
  title,
  roles,
  note,
}: {
  title: string;
  roles: readonly string[];
  note: string;
}) {
  return (
    <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30 p-3 space-y-1">
      <p className="text-xs font-medium">{title}</p>
      <p className="font-mono text-[11px] text-[hsl(var(--foreground))]">
        {roles.join(", ")}
      </p>
      <p className="text-[11px] text-[hsl(var(--muted-foreground))]">{note}</p>
    </div>
  );
}

function PreviewModal({
  preview,
  isProd,
  onCancel,
  onConfirm,
}: {
  preview: AdminEventPreview;
  isProd: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const count = preview.users.length;
  const blocked = preview.blockers.length > 0;
  const nothingToDo = count === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="card-strong max-w-4xl w-full max-h-[90vh] flex flex-col">
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
              <span>Preview — Bulk Admin Edit</span>
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
            {preview.endpoint && (
              <p className="text-[11px] font-mono text-[hsl(var(--muted-foreground))] mt-1 break-all">
                PUT {preview.endpoint}
              </p>
            )}
          </div>
          <button
            type="button"
            className="btn-ghost h-8 w-8 px-0"
            onClick={onCancel}
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 pb-3 space-y-3">
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
              ADMIN_EDIT event{count === 1 ? "" : "s"} will be created —{" "}
              {preview.allCompaniesCount} all-company,{" "}
              {preview.specificCompaniesCount} company-scoped (
              {preview.companies.length} companies).
              {isProd && !nothingToDo
                ? " This is the production event pipeline."
                : ""}
            </span>
          </div>

          {preview.blockers.map((b, i) => (
            <div
              key={i}
              className="rounded-lg border border-[hsl(var(--danger))]/40 bg-[hsl(var(--danger))]/10
                         text-[hsl(var(--danger))] px-3 py-2 text-xs flex items-start gap-2"
            >
              <CircleAlert className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{b}</span>
            </div>
          ))}

          {preview.notes.length > 0 && (
            <details className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
              <summary className="cursor-pointer font-medium text-amber-600 dark:text-amber-400">
                {preview.notes.length} mobile number
                {preview.notes.length === 1 ? "" : "s"} with no match
              </summary>
              <ul className="mt-2 space-y-1 max-h-48 overflow-auto">
                {preview.notes.map((n, i) => (
                  <li key={i}>
                    <b className="font-mono">{n.mobile}</b>: {n.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {preview.specificCompaniesCount > 0 &&
            preview.companies.length > 0 && (
              <details className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30 p-3 text-xs">
                <summary className="cursor-pointer font-medium">
                  {preview.companies.length} companies sent to the{" "}
                  {preview.specificCompaniesCount} company-scoped user
                  {preview.specificCompaniesCount === 1 ? "" : "s"}
                </summary>
                <p className="mt-2 font-mono text-[11px] break-words max-h-32 overflow-auto">
                  {preview.companies.map((c) => c.id).join(", ")}
                </p>
              </details>
            )}
        </div>

        <div className="px-6 pb-3 overflow-auto flex-1">
          <AdminEventUsersTable users={preview.users} />
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[hsl(var(--border))]">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={isProd ? "btn-danger" : "btn-primary"}
            onClick={onConfirm}
            disabled={nothingToDo || blocked}
          >
            <ChevronRight className="h-4 w-4" />
            {nothingToDo
              ? "Nothing to do"
              : blocked
                ? "Blocked"
                : isProd
                  ? `Confirm — push ${count} on production`
                  : `Confirm & push ${count}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Card 2 — Generate token
 * ------------------------------------------------------------------ */

function TokenCard({
  environment,
  onSessionExpired,
}: {
  environment: Environment;
  onSessionExpired: () => Promise<void>;
}) {
  const [mobile, setMobile] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AdminTokenResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate() {
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const res = await fetch("/api/admin-events/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environment, mobile }),
      });
      if (res.status === 401) {
        await onSessionExpired();
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `Request failed (HTTP ${res.status}).`);
        return;
      }
      setResult(data as AdminTokenResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card p-5 sm:p-6 space-y-5 animate-fade-in">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-[hsl(var(--primary))]" />
        <h2 className="text-sm font-semibold uppercase tracking-wider">
          Generate Token
        </h2>
        <span className="ml-auto pill bg-sky-500/15 text-sky-600 dark:text-sky-400">
          read
        </span>
      </div>

      <p className="text-xs text-[hsl(var(--muted-foreground))]">
        Runs Cognito <code>InitiateAuth</code> with{" "}
        <code>AuthFlow: CUSTOM_AUTH</code> for one mobile number and returns the
        tokens. Independent of the card above, which mints and caches its own
        token server-side.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[220px]">
          <label
            htmlFor="token-mobile"
            className="block text-xs font-medium text-[hsl(var(--muted-foreground))] mb-2"
          >
            Mobile Number
          </label>
          <input
            id="token-mobile"
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            placeholder="9008695776"
            className="input-base font-mono text-[13px]"
            disabled={loading}
            onKeyDown={(e) => {
              if (e.key === "Enter" && mobile.trim() && !loading) {
                void handleGenerate();
              }
            }}
          />
        </div>
        <button
          type="button"
          className="btn-primary min-w-[150px]"
          onClick={handleGenerate}
          disabled={loading || !mobile.trim()}
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Minting…
            </>
          ) : (
            <>
              <KeyRound className="h-4 w-4" />
              Generate
            </>
          )}
        </button>
      </div>

      <p className="flex items-start gap-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">
        <Info className="h-3 w-3 mt-0.5 shrink-0" />
        The <code>+91</code> prefix is added automatically. Minting clears this
        user&apos;s pending OTP, because the{" "}
        <code>define-auth-challenge</code> trigger calls{" "}
        <code>/auth/removeOTP</code> for any number outside its bypass list.
      </p>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-[hsl(var(--danger))]/40 bg-[hsl(var(--danger))]/10
                     text-[hsl(var(--danger))] px-3 py-2 text-xs flex items-start gap-2 animate-fade-in"
        >
          <CircleAlert className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="space-y-3 animate-fade-in">
          <TokenField
            label="Authorization header"
            value={result.bearer}
            primary
          />
          <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
            For <span className="font-mono">+91{result.mobile}</span>
            {result.expiresAt && (
              <>
                {" "}
                · expires{" "}
                <b>{new Date(result.expiresAt).toLocaleTimeString()}</b>
              </>
            )}
          </p>
          <details className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30 p-3 space-y-3">
            <summary className="cursor-pointer text-xs font-medium">
              ID token &amp; refresh token
            </summary>
            <div className="pt-3 space-y-3">
              <TokenField label="ID token" value={result.idToken ?? ""} />
              <TokenField
                label="Refresh token"
                value={result.refreshToken ?? ""}
              />
            </div>
          </details>
        </div>
      )}
    </section>
  );
}

function TokenField({
  label,
  value,
  primary,
}: {
  label: string;
  value: string;
  primary?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable over plain http — the value is selectable.
    }
  }

  if (!value) {
    return (
      <div>
        <p className="text-xs font-medium mb-1">{label}</p>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">
          Not returned.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <p className="text-xs font-medium">{label}</p>
        <button type="button" className="btn-ghost h-7 text-[11px]" onClick={copy}>
          {copied ? (
            <>
              <Check className="h-3 w-3" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              Copy
            </>
          )}
        </button>
      </div>
      <textarea
        readOnly
        value={value}
        rows={primary ? 3 : 2}
        onFocus={(e) => e.currentTarget.select()}
        className="input-base font-mono text-[11px] resize-y break-all"
      />
    </div>
  );
}
