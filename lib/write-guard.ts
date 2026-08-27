/**
 * Employee-correction write switch.
 *
 * The Compare Auth / Corp / Cognito card (formerly "Employee Data Correction")
 * is **display-only**: it analyzes corp / auth / Cognito and shows every
 * deviation, but it must not let an operator write anything. The corrective
 * logic itself is deliberately KEPT — `replayEmployeeStream`,
 * `syncAuthFromCorp`, `repairCognitoLinks` and `changeMobileAndRelease` in
 * `lib/correction.ts` are intact, tested against the same integrity gates, and
 * one flag away from being usable again.
 *
 * Two enforcement points, because hiding a button is not a guard:
 *   - the card renders no action buttons and no confirm modal while this is
 *     false (`components/data-correction-card.tsx`);
 *   - the mutating routes refuse a non-preview request with 403
 *     (`assertCorrectionWritesEnabled`), so a hand-crafted POST is rejected
 *     too. Previews stay allowed — they are read-only and write nothing.
 *
 * To re-enable, flip this to `true` and redeploy; nothing else needs to change.
 * It is a code constant rather than an env var on purpose: it must hold
 * identically on the client and the server, and `NEXT_PUBLIC_*` values are
 * build-time inlined anyway, so an env var would only add a way for the two
 * halves to disagree.
 *
 * NOT covered by this switch: the **Reserved mobile number** card
 * (`releaseReservedNumber`, `correction/release-number`). That one stays live —
 * it is the tool for freeing a mobile stuck in Cognito's sign-in index, which
 * is the whole reason it exists, and it writes only a Cognito phone attribute.
 */
export const CORRECTION_WRITES_ENABLED: boolean = false;

/** Message shown/returned when a write is attempted while disabled. */
export const CORRECTION_WRITES_DISABLED_MESSAGE =
  "Employee data corrections are disabled — this view is read-only. " +
  "Re-enable CORRECTION_WRITES_ENABLED in lib/write-guard.ts to allow writes.";

/**
 * Route guard. Returns a 403 `Response` when a write must be refused, or
 * `null` when the request may proceed. `preview` requests are always allowed
 * (they only read and report what a write WOULD do).
 */
export function assertCorrectionWritesEnabled(preview: boolean): Response | null {
  if (preview || CORRECTION_WRITES_ENABLED) return null;
  return new Response(
    JSON.stringify({ error: CORRECTION_WRITES_DISABLED_MESSAGE }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
}
