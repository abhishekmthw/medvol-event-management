/**
 * Pure, client-safe normalization/display helpers shared by the server-side
 * comparison libs and the UI components (no pg / AWS imports here).
 */

/**
 * Canonical form of a person's name for matching: lowercase, everything except
 * ASCII letters/digits removed. Handles trailing garbage from encoding damage
 * (e.g. corp "Thiyagarajan S�" vs auth "Thiyagarajan S") as well as
 * spacing/punctuation differences — two names match when their canonical
 * forms are equal.
 */
export function normalizeName(v: string | null | undefined): string {
  return (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Display form of a mobile number: last 10 digits (drops the +91 country code
 * Cognito stores on phone_number). Falls back to the trimmed original when
 * the value has no digits at all.
 */
export function displayMobile10(v: string | null | undefined): string | null {
  if (v == null) return null;
  const digits = String(v).replace(/\D/g, "");
  if (!digits) return String(v).trim() || null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}
