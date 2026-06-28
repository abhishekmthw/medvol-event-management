"use client";

import clsx from "clsx";

/** Segmented (tab-style) single-select control. Shared across pages. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string; danger?: boolean }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={clsx(
        "inline-flex p-1 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/50 w-full",
        disabled && "opacity-50 pointer-events-none",
      )}
      role="tablist"
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(opt.value)}
            disabled={disabled}
            className={clsx(
              "flex-1 text-xs font-medium px-3 py-1.5 rounded-md transition",
              selected
                ? opt.danger
                  ? "bg-[hsl(var(--danger))] text-white shadow"
                  : "bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))] ring-1 ring-[hsl(var(--primary))] shadow-sm"
                : "text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
