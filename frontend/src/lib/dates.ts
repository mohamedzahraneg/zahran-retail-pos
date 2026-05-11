/**
 * dates.ts — shared Cairo-localised date helpers
 *
 * PR-A2 — Recurring Expenses surfaced raw ISO timestamps like
 * `2026-05-10T21:00:00.000Z` instead of "الإثنين 11/05/2026".  The fix
 * needs a place where TZ-aware formatting is defined ONCE so the same
 * rules apply wherever a Postgres `DATE` / `TIMESTAMPTZ` value is
 * rendered.
 *
 * Two inputs to handle:
 *   - YYYY-MM-DD string (Postgres `DATE` columns when the server is
 *     not in Cairo TZ, or hand-built FE strings).  Treated as a pure
 *     calendar date with no TZ conversion.
 *   - ISO datetime string / Date instant (Postgres `TIMESTAMPTZ`
 *     columns, or `DATE` columns when the server's session TZ is set
 *     to Cairo so node-postgres builds Cairo-midnight Date objects
 *     that JSON-serialise to UTC-21:00 the previous day).  Formatted
 *     in Africa/Cairo so the displayed date is whatever the user
 *     would see on a wall clock in Cairo.
 *
 * Two outputs:
 *   - `fmtCairoDate("…")`               → "الإثنين 11/05/2026"
 *   - `fmtCairoDateTimeSeconds("…")`    → "الإثنين 11/05/2026 — 12:00:00 ص"
 *
 * Both are stable across Egypt's DST flip; both use the Latin
 * numbering system for digits and Arabic locale for weekday names
 * and the AM/PM marker.
 */

/** Render `—` for unknown values (matches the existing UI convention). */
const PLACEHOLDER = '—';

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

type ParseResult =
  | { kind: 'invalid' }
  | { kind: 'date-only'; y: string; m: string; d: string }
  | { kind: 'instant'; date: Date };

function parseInput(input: string | Date | null | undefined): ParseResult {
  if (input == null) return { kind: 'invalid' };
  if (input instanceof Date) {
    return Number.isFinite(input.getTime())
      ? { kind: 'instant', date: input }
      : { kind: 'invalid' };
  }
  if (typeof input !== 'string') return { kind: 'invalid' };
  const trimmed = input.trim();
  if (!trimmed) return { kind: 'invalid' };
  const m = YMD_RE.exec(trimmed);
  if (m) {
    // Pure calendar date — no TZ conversion needed.
    return { kind: 'date-only', y: m[1]!, m: m[2]!, d: m[3]! };
  }
  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime())
    ? { kind: 'instant', date: parsed }
    : { kind: 'invalid' };
}

function ddMmYyyyFromInstant(d: Date): { dd: string; mm: string; yyyy: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const yyyy = parts.find((p) => p.type === 'year')!.value;
  const mm = parts.find((p) => p.type === 'month')!.value;
  const dd = parts.find((p) => p.type === 'day')!.value;
  return { dd, mm, yyyy };
}

function arabicWeekday(d: Date, timeZone: 'Africa/Cairo' | 'UTC'): string {
  return new Intl.DateTimeFormat('ar-EG', {
    timeZone,
    weekday: 'long',
  }).format(d);
}

/**
 * "الإثنين 11/05/2026"
 *
 * - YMD strings ("2026-05-11") are formatted verbatim — no TZ drift.
 * - ISO / Date inputs are formatted in Africa/Cairo so the displayed
 *   calendar date matches what a user in Cairo sees on a wall clock.
 */
export function fmtCairoDate(input: string | Date | null | undefined): string {
  const r = parseInput(input);
  if (r.kind === 'invalid') return PLACEHOLDER;

  if (r.kind === 'date-only') {
    // Use UTC noon as a probe instant — any UTC TZ formatter will
    // agree on the calendar date and the weekday for noon UTC.
    const probe = new Date(Date.UTC(+r.y, +r.m - 1, +r.d, 12, 0, 0));
    const wd = arabicWeekday(probe, 'UTC');
    return `${wd} ${r.d}/${r.m}/${r.y}`;
  }

  const { dd, mm, yyyy } = ddMmYyyyFromInstant(r.date);
  const wd = arabicWeekday(r.date, 'Africa/Cairo');
  return `${wd} ${dd}/${mm}/${yyyy}`;
}

/**
 * "الإثنين 11/05/2026 — 12:00:00 ص"
 *
 * - YMD-only inputs render midnight (12:00:00 ص) by convention.
 * - ISO / Date inputs render the actual time-of-day in Cairo.
 * - AM/PM marker is Arabic (ص / م); digits are Latin (via
 *   `numberingSystem: 'latn'`).
 */
export function fmtCairoDateTimeSeconds(
  input: string | Date | null | undefined,
): string {
  const r = parseInput(input);
  if (r.kind === 'invalid') return PLACEHOLDER;

  const datePart = fmtCairoDate(input);
  if (datePart === PLACEHOLDER) return PLACEHOLDER;

  if (r.kind === 'date-only') {
    return `${datePart} — 12:00:00 ص`;
  }

  const timeStr = new Intl.DateTimeFormat('ar-EG', {
    timeZone: 'Africa/Cairo',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    // `numberingSystem` is a Intl option that's not in the
    // `DateTimeFormatOptions` lib type on every TS lib version, so
    // cast for compatibility.
    numberingSystem: 'latn',
  } as Intl.DateTimeFormatOptions).format(r.date);

  return `${datePart} — ${timeStr}`;
}
