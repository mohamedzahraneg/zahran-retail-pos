/**
 * smart-date-range.ts — PR-FIN-PAYACCT-4D-UX-FIX-4
 *
 * Helpers for the 4 smart-filter chips used by both the cashbox
 * details modal and the per-account details panel:
 *
 *   - اليوم          → start of today           ⟶ today
 *   - هذا الأسبوع    → start of current week    ⟶ today (Saturday-start, EG convention)
 *   - هذا الشهر      → start of current month   ⟶ today
 *   - مخصص           → operator-supplied from / to
 *
 * Each preset returns ISO YYYY-MM-DD strings sized for the backend's
 * `from` / `to` query params.
 */

export type SmartRangeKey = 'today' | 'week' | 'month' | 'custom';

export interface SmartRange {
  from: string;
  to: string;
}

/** Format a Date as `YYYY-MM-DD` in local time. */
function isoDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Saturday-start week: returns the Saturday of the current calendar
 * week. JS getDay() returns 0=Sunday … 6=Saturday. To find the most
 * recent Saturday (or today if today IS Saturday), we offset backward
 * by `(getDay() + 1) % 7` days.
 */
export function startOfWeekSaturday(now: Date = new Date()): Date {
  const back = (now.getDay() + 1) % 7;
  const sat = new Date(now);
  sat.setHours(0, 0, 0, 0);
  sat.setDate(now.getDate() - back);
  return sat;
}

export function startOfMonth(now: Date = new Date()): Date {
  const m = new Date(now.getFullYear(), now.getMonth(), 1);
  m.setHours(0, 0, 0, 0);
  return m;
}

export function startOfDay(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Resolve a smart-range preset to a `{from, to}` ISO-date pair.
 * For 'custom', the caller should supply its own from/to and skip
 * this helper. We return the current month as a sensible fallback if
 * 'custom' is passed without explicit dates.
 */
export function resolveSmartRange(
  key: SmartRangeKey,
  now: Date = new Date(),
): SmartRange {
  const today = isoDate(now);
  switch (key) {
    case 'today':
      return { from: isoDate(startOfDay(now)), to: today };
    case 'week':
      return { from: isoDate(startOfWeekSaturday(now)), to: today };
    case 'month':
      return { from: isoDate(startOfMonth(now)), to: today };
    case 'custom':
    default:
      return { from: isoDate(startOfMonth(now)), to: today };
  }
}

export const SMART_RANGE_LABELS_AR: Record<SmartRangeKey, string> = {
  today: 'اليوم',
  week: 'هذا الأسبوع',
  month: 'هذا الشهر',
  custom: 'مخصص',
};
