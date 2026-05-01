/**
 * format-arabic-date.ts — PR-FIN-PAYACCT-4D-UX-FIX-14
 *
 * Defensive Arabic date / date-range formatting for operator-facing
 * surfaces. Accepts whatever shape the backend happens to send today
 * (ISO 8601, Postgres `timestamptz` text like
 * `"2026-04-20 13:06:42.082408+00"`, or even a stringified JS Date
 * such as `"Wed Apr 29 2026 00:00:00 GMT+0300 (...)"`) and renders a
 * clean, locale-formatted Arabic date.
 *
 * Production driver: PR-FIN-PAYACCT-4D-UX-FIX-9 backend serialised
 * `MIN(created_at)` / `MAX(created_at)` via `String(b.earliest)`,
 * which calls `Date.prototype.toString()` on a TypeORM Date instance
 * and produced `"Wed Apr 29 2026 ..."`. The reconciliation panel
 * rendered that verbatim, which leaked raw JS-ese into the operator
 * UI. Rather than chase the BE serialisation, we make the FE robust
 * to any of these shapes.
 *
 * Returns:
 *   • The formatted Arabic date string (e.g. `"٢٠ أبريل ٢٠٢٦"`).
 *   • The original input verbatim if `Date` cannot parse it (so we
 *     never silently drop information — better to show a slightly
 *     ugly string than nothing).
 *   • Empty string for `null` / `undefined` / `''`.
 */

const ARABIC_DATE_FMT = new Intl.DateTimeFormat('ar-EG', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

/**
 * Format a single timestamp as an Arabic date.
 *
 * @param input  ISO string, PG timestamp text, JS Date stringified, or null.
 */
export function formatArabicDate(
  input: string | null | undefined,
): string {
  if (!input) return '';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return input;
  return ARABIC_DATE_FMT.format(d);
}

/**
 * PR-FIN-PAYACCT-4D-REPORTS-1B — pad a number to two digits.
 * Local helper kept private to this module so the date-time formatter
 * never has to reach for a 3rd-party `padStart` polyfill.
 */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * PR-FIN-PAYACCT-4D-REPORTS-1B — operator-friendly compact datetime.
 *
 * Returns the input rendered in the operator's local timezone as
 * `DD/MM/YYYY HH:mm:ss` with Latin numerals — the format requested by
 * the report spec for the cashbox operations table and report exports.
 * Example: `"01/05/2026 14:35:09"`.
 *
 * Defensive in the same way as `formatArabicDate`: accepts ISO 8601,
 * PG `timestamptz` text, stringified JS Dates, etc. Returns the input
 * verbatim when `Date` cannot parse, and `''` for null / undefined / ''.
 *
 * Avoids `Intl.DateTimeFormat`'s `'en-GB'` quirk that injects a
 * `,` between the date and time across Node/browser implementations
 * — a manual format keeps the output deterministic in tests.
 */
export function formatArabicDateTime(
  input: string | null | undefined,
): string {
  if (!input) return '';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return input;
  return (
    `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/**
 * Format an inclusive date range. Renders:
 *   • `""` when both ends are missing.
 *   • The single formatted date when both ends parse to the same day.
 *   • `"من <earliest> إلى <latest>"` otherwise.
 *
 * Same fallback behavior per-end as `formatArabicDate`.
 */
export function formatArabicDateRange(
  earliest: string | null | undefined,
  latest: string | null | undefined,
): string {
  const e = formatArabicDate(earliest);
  const l = formatArabicDate(latest);
  if (!e && !l) return '';
  if (!l) return e;
  if (!e) return l;
  if (e === l) return e;
  return `من ${e} إلى ${l}`;
}
