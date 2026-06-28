"use client";

import { useMemo, useState } from "react";
import { Check, Copy, Wand2, X } from "lucide-react";
import clsx from "clsx";

/**
 * Paste a multi-line list and convert it to a comma-separated string, optionally
 * stripping characters and wrapping each item. Purely client-side. Shared by the
 * Event Ops and Counter Events pages for assembling ID lists.
 */
export function FormatIdsModal({ onClose }: { onClose: () => void }) {
  const [raw, setRaw] = useState("");
  const [stripChars, setStripChars] = useState("");
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [copied, setCopied] = useState(false);

  const items = useMemo(() => {
    const stripSet = new Set(stripChars.split(""));
    return raw
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        if (!stripSet.size) return trimmed;
        return trimmed
          .split("")
          .filter((c) => !stripSet.has(c))
          .join("");
      })
      .filter((s) => s.length > 0);
  }, [raw, stripChars]);

  const output = useMemo(
    () => items.map((s) => `${prefix}${s}${suffix}`).join(", "),
    [items, prefix, suffix],
  );

  const itemCount = items.length;

  async function handleCopy() {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail (insecure context / permission). Select fallback.
      const ta = document.getElementById(
        "fmt-output",
      ) as HTMLTextAreaElement | null;
      if (ta) {
        ta.select();
        try {
          document.execCommand("copy");
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* give up silently */
        }
      }
    }
  }

  function handleReset() {
    setRaw("");
    setStripChars("");
    setPrefix("");
    setSuffix("");
    setCopied(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="card-strong max-w-2xl w-full max-h-[90vh] flex flex-col">
        <div className="flex items-start gap-3 p-6 pb-3">
          <div className="h-10 w-10 rounded-full flex items-center justify-center bg-[hsl(var(--primary))]/15 shrink-0">
            <Wand2 className="h-5 w-5 text-[hsl(var(--primary))]" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold">Format ID List</h3>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">
              Paste IDs (one per line) and convert them to a comma-separated
              string. Use the options to strip characters or wrap each item.
            </p>
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
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label
                htmlFor="fmt-input"
                className="block text-xs font-medium text-[hsl(var(--muted-foreground))]"
              >
                Paste items (one per line)
              </label>
              <span className="pill bg-[hsl(var(--muted))] text-[hsl(var(--foreground))] tabular-nums">
                {itemCount} item{itemCount === 1 ? "" : "s"}
              </span>
            </div>
            <textarea
              id="fmt-input"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={6}
              placeholder={"28156150\n28120800\n45635815"}
              className="input-base font-mono text-[13px] resize-y min-h-[140px]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label
                htmlFor="fmt-strip"
                className="block text-xs font-medium text-[hsl(var(--muted-foreground))]"
              >
                Strip characters
              </label>
              <input
                id="fmt-strip"
                value={stripChars}
                onChange={(e) => setStripChars(e.target.value)}
                placeholder={`e.g. "'`}
                className="input-base font-mono text-[13px]"
              />
              <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
                Every character entered here is removed from each item.
              </p>
            </div>
            <div className="space-y-1">
              <label
                htmlFor="fmt-prefix"
                className="block text-xs font-medium text-[hsl(var(--muted-foreground))]"
              >
                Prefix each item
              </label>
              <input
                id="fmt-prefix"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder={`e.g. '`}
                className="input-base font-mono text-[13px]"
              />
              <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
                Prepended to every item (leave empty to skip).
              </p>
            </div>
            <div className="space-y-1">
              <label
                htmlFor="fmt-suffix"
                className="block text-xs font-medium text-[hsl(var(--muted-foreground))]"
              >
                Suffix each item
              </label>
              <input
                id="fmt-suffix"
                value={suffix}
                onChange={(e) => setSuffix(e.target.value)}
                placeholder={`e.g. '`}
                className="input-base font-mono text-[13px]"
              />
              <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
                Appended to every item (leave empty to skip).
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="fmt-output"
                className="block text-xs font-medium text-[hsl(var(--muted-foreground))]"
              >
                Output (comma-separated)
              </label>
              <button
                type="button"
                onClick={handleCopy}
                disabled={!output}
                className={clsx(
                  "btn-ghost h-8 text-xs px-2.5",
                  copied &&
                    "text-emerald-600 dark:text-emerald-400 border-emerald-500/40",
                )}
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" />
                    Copy
                  </>
                )}
              </button>
            </div>
            <textarea
              id="fmt-output"
              readOnly
              value={output}
              rows={4}
              placeholder="Output will appear here…"
              className="input-base font-mono text-[13px] resize-y min-h-[100px] bg-[hsl(var(--muted))]/40"
            />
          </div>
        </div>

        <div className="flex justify-between gap-2 px-6 py-4 border-t border-[hsl(var(--border))]">
          <button
            type="button"
            className="btn-ghost"
            onClick={handleReset}
            disabled={!raw && !stripChars && !prefix && !suffix}
          >
            Reset
          </button>
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
