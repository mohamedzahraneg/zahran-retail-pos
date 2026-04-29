/**
 * smart-date-range.test.ts — PR-FIN-PAYACCT-4D-UX-FIX-4
 *
 * Pins the smart-range helpers used by the cashbox + per-account
 * details modals.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveSmartRange,
  startOfDay,
  startOfMonth,
  startOfWeekSaturday,
  SMART_RANGE_LABELS_AR,
} from '../smart-date-range';

describe('smart-date-range', () => {
  it('startOfDay returns the same day at 00:00:00', () => {
    const d = new Date('2026-04-29T15:32:11Z');
    const out = startOfDay(d);
    expect(out.getHours()).toBe(0);
    expect(out.getMinutes()).toBe(0);
    expect(out.getSeconds()).toBe(0);
  });

  it('startOfMonth returns the 1st of the same month', () => {
    const d = new Date(2026, 3, 29); // 2026-04-29 local
    const out = startOfMonth(d);
    expect(out.getFullYear()).toBe(2026);
    expect(out.getMonth()).toBe(3);
    expect(out.getDate()).toBe(1);
  });

  it('startOfWeekSaturday returns the Saturday of the current week', () => {
    // Wednesday 2026-04-29 → Saturday 2026-04-25
    const wed = new Date(2026, 3, 29);
    const sat = startOfWeekSaturday(wed);
    expect(sat.getDay()).toBe(6); // Saturday
    expect(sat.getDate()).toBe(25);
  });

  it('startOfWeekSaturday on Saturday returns the same day', () => {
    const sat = new Date(2026, 3, 25); // 2026-04-25 (Saturday)
    const out = startOfWeekSaturday(sat);
    expect(out.getDate()).toBe(25);
    expect(out.getDay()).toBe(6);
  });

  it('resolveSmartRange("today") returns from=to=today', () => {
    const d = new Date(2026, 3, 29);
    const r = resolveSmartRange('today', d);
    expect(r.from).toBe(r.to);
    expect(r.from).toBe('2026-04-29');
  });

  it('resolveSmartRange("week") returns Saturday → today', () => {
    const wed = new Date(2026, 3, 29);
    const r = resolveSmartRange('week', wed);
    expect(r.from).toBe('2026-04-25');
    expect(r.to).toBe('2026-04-29');
  });

  it('resolveSmartRange("month") returns first of month → today', () => {
    const d = new Date(2026, 3, 29);
    const r = resolveSmartRange('month', d);
    expect(r.from).toBe('2026-04-01');
    expect(r.to).toBe('2026-04-29');
  });

  it('exposes Arabic labels for all 4 keys', () => {
    expect(SMART_RANGE_LABELS_AR.today).toBe('اليوم');
    expect(SMART_RANGE_LABELS_AR.week).toBe('هذا الأسبوع');
    expect(SMART_RANGE_LABELS_AR.month).toBe('هذا الشهر');
    expect(SMART_RANGE_LABELS_AR.custom).toBe('مخصص');
  });
});
