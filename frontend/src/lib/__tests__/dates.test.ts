/**
 * dates.test.ts — PR-A2
 *
 * Pins the Cairo-localised date helpers used wherever a Postgres
 * `DATE` / `TIMESTAMPTZ` column is rendered in the UI.  Critical
 * regression guard: the Recurring Expenses page previously rendered
 * the raw ISO timestamp `2026-05-10T21:00:00.000Z` directly into
 * the table cell.  The helpers below must convert any reasonable
 * shape of date input into a human-readable Cairo date / datetime.
 */
import { describe, expect, it } from 'vitest';
import { fmtCairoDate, fmtCairoDateTimeSeconds } from '../dates';

describe('fmtCairoDate', () => {
  it('renders YYYY-MM-DD as Arabic weekday + DD/MM/YYYY (Latin digits)', () => {
    expect(fmtCairoDate('2026-05-11')).toBe('الاثنين 11/05/2026');
  });

  it('renders an ISO datetime at Cairo midnight as the Cairo calendar day', () => {
    // 2026-05-10T21:00:00.000Z = 2026-05-11 00:00:00 Cairo (DST +03).
    // The original screenshot bug — must NOT render the raw ISO.
    const out = fmtCairoDate('2026-05-10T21:00:00.000Z');
    expect(out).toBe('الاثنين 11/05/2026');
  });

  it('renders a Date object correctly (Cairo TZ)', () => {
    // Same instant, passed as Date.
    const d = new Date('2026-05-10T21:00:00.000Z');
    expect(fmtCairoDate(d)).toBe('الاثنين 11/05/2026');
  });

  it('handles null / undefined / empty / invalid strings as the "—" placeholder', () => {
    expect(fmtCairoDate(null)).toBe('—');
    expect(fmtCairoDate(undefined)).toBe('—');
    expect(fmtCairoDate('')).toBe('—');
    expect(fmtCairoDate('not-a-date')).toBe('—');
  });

  it('never returns a raw ISO substring (regression guard)', () => {
    const out = fmtCairoDate('2026-05-10T21:00:00.000Z');
    expect(out).not.toMatch(/T\d{2}:\d{2}/);
    expect(out).not.toMatch(/Z$/);
  });

  it('survives DST flip — same calendar input in winter renders correct day name', () => {
    // 2026-01-05 is a Monday; winter Cairo offset is +02 (no DST).
    expect(fmtCairoDate('2026-01-05')).toBe('الاثنين 05/01/2026');
    // Same Monday rendered as ISO at Cairo midnight = UTC 22:00 prev day.
    expect(fmtCairoDate('2026-01-04T22:00:00.000Z')).toBe('الاثنين 05/01/2026');
  });
});

describe('fmtCairoDateTimeSeconds', () => {
  it('renders YYYY-MM-DD as Arabic weekday + DD/MM/YYYY + midnight time (12:00:00 ص)', () => {
    expect(fmtCairoDateTimeSeconds('2026-05-11')).toBe(
      'الاثنين 11/05/2026 — 12:00:00 ص',
    );
  });

  it('renders an ISO datetime at Cairo midnight with the actual seconds (12:00:00 ص)', () => {
    expect(fmtCairoDateTimeSeconds('2026-05-10T21:00:00.000Z')).toBe(
      'الاثنين 11/05/2026 — 12:00:00 ص',
    );
  });

  it('uses Latin digits + Arabic ص / م markers (no Arabic-Indic numerals)', () => {
    const out = fmtCairoDateTimeSeconds('2026-05-11T09:30:15+03:00');
    // Latin digits required.
    expect(out).toMatch(/[0-9]{1,2}:[0-9]{2}:[0-9]{2}/);
    // Arabic AM/PM marker.
    expect(out).toMatch(/[صم]/);
    // No Arabic-Indic digits (٠..٩).
    expect(out).not.toMatch(/[٠-٩]/);
  });

  it('handles null / undefined / invalid', () => {
    expect(fmtCairoDateTimeSeconds(null)).toBe('—');
    expect(fmtCairoDateTimeSeconds(undefined)).toBe('—');
    expect(fmtCairoDateTimeSeconds('not-a-date')).toBe('—');
  });

  it('never returns a raw ISO substring', () => {
    const out = fmtCairoDateTimeSeconds('2026-05-10T21:00:00.000Z');
    expect(out).not.toMatch(/Z$/);
    expect(out).not.toMatch(/T\d{2}:/);
  });
});
