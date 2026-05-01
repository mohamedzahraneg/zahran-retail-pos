/**
 * format-arabic-date.test.ts — PR-FIN-PAYACCT-4D-UX-FIX-14
 *
 * Pins the defensive Arabic date / range formatter that the
 * UnattachedReconciliationPanel uses so raw JS-ese (e.g.
 * "Wed Apr 29 2026 00:00:00 GMT+0300 (...)") never leaks into the
 * operator-facing UI.
 */
import { describe, it, expect } from 'vitest';
import {
  formatArabicDate,
  formatArabicDateRange,
} from '../format-arabic-date';

describe('formatArabicDate — PR-FIN-PAYACCT-4D-UX-FIX-14', () => {
  it('returns empty string for null / undefined / ""', () => {
    expect(formatArabicDate(null)).toBe('');
    expect(formatArabicDate(undefined)).toBe('');
    expect(formatArabicDate('')).toBe('');
  });

  it('formats an ISO 8601 timestamp into Arabic', () => {
    const out = formatArabicDate('2026-04-20T13:06:42.082Z');
    // Arabic locale renders the month name in Arabic. Don't assert
    // the exact glyph (locale data can drift across Node versions);
    // assert the *absence* of the raw input markers and that the
    // year is present.
    expect(out).not.toBe('2026-04-20T13:06:42.082Z');
    expect(out).not.toMatch(/T13:06:42/);
    expect(out).toMatch(/\d{4}|٢٠٢٦/); // year in Latin or Arabic-Indic digits
  });

  it('formats a Postgres `timestamptz` string into Arabic', () => {
    const out = formatArabicDate('2026-04-20 13:06:42.082408+00');
    expect(out).not.toBe('2026-04-20 13:06:42.082408+00');
    expect(out).not.toMatch(/13:06:42/);
    expect(out).not.toMatch(/\+00/);
  });

  it('formats a stringified JS Date (the production root cause) into Arabic', () => {
    // BE's `String(b.earliest)` on a TypeORM Date instance produces
    // exactly this shape. The FE must not display it raw.
    const input =
      'Wed Apr 29 2026 00:00:00 GMT+0300 (Eastern European Summer Time)';
    const out = formatArabicDate(input);
    expect(out).not.toBe(input);
    expect(out).not.toMatch(/GMT\+0300/);
    expect(out).not.toMatch(/Wed Apr/);
    expect(out).not.toMatch(/Eastern European/);
  });

  it('falls back to the input verbatim when Date cannot parse it', () => {
    // Garbage in → at least show the operator something instead of
    // silently dropping it.
    expect(formatArabicDate('not-a-date')).toBe('not-a-date');
  });
});

describe('formatArabicDateRange — PR-FIN-PAYACCT-4D-UX-FIX-14', () => {
  it('returns empty string when both ends are missing', () => {
    expect(formatArabicDateRange(null, null)).toBe('');
    expect(formatArabicDateRange(undefined, undefined)).toBe('');
  });

  it('renders a single date when only one end is present', () => {
    const onlyEarliest = formatArabicDateRange('2026-04-20T00:00Z', null);
    expect(onlyEarliest).not.toMatch(/^من /);
    expect(onlyEarliest).not.toMatch(/ إلى /);

    const onlyLatest = formatArabicDateRange(null, '2026-04-20T00:00Z');
    expect(onlyLatest).not.toMatch(/^من /);
    expect(onlyLatest).not.toMatch(/ إلى /);
  });

  it('collapses to a single date when earliest and latest format to the same day', () => {
    // Use a UTC offset that's safely inside any timezone the CI host
    // could be running in. 12:00Z and 14:00Z both fall on the same
    // calendar day from -12 through +12.
    const out = formatArabicDateRange(
      '2026-04-20T12:00Z',
      '2026-04-20T14:00Z',
    );
    expect(out).not.toMatch(/^من /);
    expect(out).not.toMatch(/ إلى /);
  });

  it('renders the range "من <earliest> إلى <latest>" for distinct days', () => {
    const out = formatArabicDateRange(
      '2026-04-20T01:00Z',
      '2026-05-01T23:00Z',
    );
    expect(out).toMatch(/^من /);
    expect(out).toMatch(/ إلى /);
    // Raw inputs must NOT appear.
    expect(out).not.toMatch(/2026-04-20T/);
    expect(out).not.toMatch(/2026-05-01T/);
  });

  it('survives the "Wed Apr 29 2026 ... GMT+0300 ..." input shape on both ends', () => {
    const out = formatArabicDateRange(
      'Wed Apr 29 2026 00:00:00 GMT+0300 (Eastern European Summer Time)',
      'Fri May 01 2026 00:00:00 GMT+0300 (Eastern European Summer Time)',
    );
    expect(out).toMatch(/^من /);
    expect(out).toMatch(/ إلى /);
    expect(out).not.toMatch(/GMT\+0300/);
    expect(out).not.toMatch(/Wed Apr/);
    expect(out).not.toMatch(/Eastern European/);
  });
});
