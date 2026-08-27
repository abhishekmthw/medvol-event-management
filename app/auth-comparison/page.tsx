"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Users } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Segmented } from "@/components/segmented";
import { DataCorrectionCard } from "@/components/data-correction-card";
import { ReservedNumberCard } from "@/components/reserved-number-card";
import { type Environment } from "@/lib/types";

/**
 * Auth Details Comparison tab.
 *
 * Two cards, both keyed on the selected environment:
 *   1. "Compare Auth / Corp / Cognito" — corp-driven, mobile-keyed comparison
 *      of one employee across corp / auth / Cognito. Display-only: the write
 *      actions live in the code but are gated off (see `lib/write-guard.ts`).
 *   2. "Reserved mobile number" — the reserved sign-in-identifier tool, the
 *      only path here that still writes (releasing a number back).
 *
 * The former bulk "Compare" and "Employee ↔ Cognito Check" cards were removed;
 * their read-only API routes (`/api/auth-comparison/fetch`,
 * `/api/auth-comparison/employee-cognito`) and `lib/comparison-csv.ts` are
 * intentionally left in place.
 */
export default function AuthComparisonPage() {
  const router = useRouter();

  const [environment, setEnvironment] = useState<Environment>("stage");

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
              onChange={(v) => setEnvironment(v)}
            />
            <p className="mt-2 text-[11px] text-[hsl(var(--muted-foreground))]">
              Stage and prod are separate AWS accounts and separate Cognito user
              pools — a number that looks free in stage says nothing about prod.
            </p>
          </div>
        </section>

        {/* Compare Auth / Corp / Cognito (display-only) */}
        <DataCorrectionCard
          key={environment}
          environment={environment}
          onSessionExpired={handleSessionExpired}
        />

        {/* Reserved mobile number (Cognito sign-in index) */}
        <ReservedNumberCard
          key={`reserved-${environment}`}
          environment={environment}
          onSessionExpired={handleSessionExpired}
        />
      </div>
    </main>
  );
}
