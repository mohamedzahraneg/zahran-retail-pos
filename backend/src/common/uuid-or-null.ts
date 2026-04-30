/**
 * uuid-or-null — PR-FIN-PAYACCT-4D-UX-FIX-6
 *
 * Backend mirror of `frontend/src/lib/uuid-or-null.ts`. Defensive
 * sanitizer for optional UUID inputs (DTO fields + actor IDs) at the
 * service boundary. Returns `null` when the value is missing OR the
 * literal sentinel strings `"undefined"` / `"null"`, which used to
 * slip past the FE's empty-string-only normalization and explode at
 * the SQL boundary as
 * `invalid input syntax for type uuid: "undefined"`.
 *
 * Format-validation lives in class-validator (`@IsUUID()`) — this
 * helper only neutralizes the known footguns so a downstream INSERT
 * sees `NULL` instead of a poisoned string.
 */

export function sanitizeUuidInput(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  if (trimmed === 'undefined' || trimmed === 'null') return null;
  return trimmed;
}
