import { describe, it, expect, vi, afterEach } from 'vitest';
import { printReport } from '../exportExcel';

/**
 * PR-REPORTS-1 — Lock the title escaping in `printReport`. CodeQL
 * flagged the prior version as "DOM text reinterpreted as HTML"
 * because the `title` argument was interpolated raw into both
 * `<title>` and `<h1>`. Callers pass user-influenced values
 * (shift numbers, date ranges, employee names), so an attacker who
 * could plant `<script>` into a shift number would otherwise hit
 * stored DOM-XSS in the print preview window.
 *
 * The test stubs `window.open` and asserts that meta-characters in
 * the title are escaped in the rendered document while the body
 * remains a raw HTML pass-through (builders escape their own
 * fragments — see shiftReportBuilder / shiftsPeriodReportBuilder).
 */

describe('printReport title escaping', () => {
  let written = '';
  const fakeWin = {
    document: {
      write: (s: string) => {
        written += s;
      },
      close: () => {},
    },
  };

  afterEach(() => {
    written = '';
    vi.restoreAllMocks();
  });

  it('escapes < > & " in the title', () => {
    vi.spyOn(window, 'open').mockReturnValue(fakeWin as any);
    printReport(`<script>alert(1)</script>`, '<p>body</p>');
    expect(written).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(written).not.toContain('<script>alert(1)</script>');
    // Body must be passed through verbatim — builders own their own escaping.
    expect(written).toContain('<p>body</p>');
  });

  it('escapes both <title> and the visible <h1>', () => {
    vi.spyOn(window, 'open').mockReturnValue(fakeWin as any);
    printReport(`A & B "C"`, '');
    const matches = written.match(/A &amp; B &quot;C&quot;/g) || [];
    // Once inside <title>, once inside <h1>.
    expect(matches.length).toBe(2);
  });

  it('returns silently when window.open is blocked', () => {
    vi.spyOn(window, 'open').mockReturnValue(null as any);
    expect(() => printReport('whatever', '<p>body</p>')).not.toThrow();
    expect(written).toBe('');
  });
});
