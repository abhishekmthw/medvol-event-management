"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Loader2, LogOut } from "lucide-react";
import clsx from "clsx";
import { ThemeToggle } from "@/components/theme-toggle";

const TABS = [
  { href: "/", label: "Event Ops" },
  { href: "/counter", label: "Counter Events" },
  { href: "/otp-block", label: "24h OTP Block" },
  { href: "/auth-comparison", label: "Auth Details Comparison" },
] as const;

/** Sticky app header with section nav tabs, theme toggle and logout. */
export function AppHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const [loggingOut, setLoggingOut] = useState(false);

  function isActive(href: string): boolean {
    return href === "/" ? pathname === "/" : pathname.startsWith(href);
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.replace("/login");
      router.refresh();
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <header className="sticky top-0 z-30 backdrop-blur-md bg-[hsl(var(--background))]/70 border-b border-[hsl(var(--border))]">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
        <div className="flex items-center gap-5 min-w-0">
          <div className="leading-tight shrink-0">
            <div className="text-sm font-semibold">MedVol</div>
            <div className="text-[11px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              Event Management
            </div>
          </div>
          <nav className="flex items-center gap-1" role="tablist">
            {TABS.map((t) => {
              const active = isActive(t.href);
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  role="tab"
                  aria-selected={active}
                  className={clsx(
                    "text-xs font-medium px-3 py-1.5 rounded-md transition",
                    active
                      ? "bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))] ring-1 ring-[hsl(var(--primary))]"
                      : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]",
                  )}
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ThemeToggle />
          <button
            type="button"
            className="btn-ghost h-9"
            onClick={handleLogout}
            disabled={loggingOut}
          >
            {loggingOut ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <LogOut className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </div>
    </header>
  );
}
