import { types as pgTypes } from 'pg';

/**
 * PR-PHASE2-TZ-FIX
 *
 * Configure the `pg` driver to return DATE (OID 1082) values as raw
 * `YYYY-MM-DD` strings rather than constructing JS `Date` objects in
 * the server's local timezone.
 *
 * Why: the default parser builds a Date at midnight server-local time,
 * which then serialises back through `Date.prototype.toISOString()` as
 * a UTC instant shifted by the local offset (e.g. Africa/Cairo midnight
 * → "<prev day>T22:00:00.000Z").  DATE columns are date-only by
 * definition; the natural representation is the raw string.
 *
 * Scope: DATE only.  TIMESTAMP / TIMESTAMPTZ parsers are deliberately
 * untouched so columns like `created_at`, `updated_at`, `approved_at`
 * keep their JS `Date` semantics.
 *
 * Idempotent: calling `applyPgDateParserOverride()` more than once has
 * no observable effect — pg.types replaces the existing parser slot.
 */
export function applyPgDateParserOverride(): void {
  pgTypes.setTypeParser(pgTypes.builtins.DATE, (val: string | null) => val);
}
