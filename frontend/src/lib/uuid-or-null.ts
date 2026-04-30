/**
 * uuid-or-null — PR-FIN-PAYACCT-4D-UX-FIX-6
 *
 * Tiny sanitizer for optional UUID fields in API payloads. Catches the
 * three "stringified-empty" footguns that used to slip into requests
 * and explode at the SQL boundary as
 * `invalid input syntax for type uuid: "undefined"`:
 *
 *   1. `undefined` / `null` JS values
 *   2. empty / whitespace-only strings
 *   3. literal strings `"undefined"` / `"null"` (e.g. from
 *      template-literal coercion `${someUndefinedVar}` or a
 *      payload-builder that ran `String(value)` on an undefined)
 *
 * Anything else passes through untouched (we don't try to validate the
 * UUID shape — the backend's class-validator does that). The explicit
 * goal is "never send a known-bad sentinel that the DB will reject",
 * not "format-validate the UUID".
 *
 * Usage:
 *   payload.warehouse_id = uuidOrNull(form.warehouse_id);
 *   for (const k of UUID_FIELDS) payload[k] = uuidOrNull(payload[k]);
 */

export function isMissingUuid(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v !== 'string') return false;
  const trimmed = v.trim();
  return trimmed === '' || trimmed === 'undefined' || trimmed === 'null';
}

export function uuidOrNull(v: unknown): string | null {
  return isMissingUuid(v) ? null : String(v);
}
