/**
 * Shifts.live-variance.test.tsx
 * ─────────────────────────────────────────────────────────────────────
 * PR-FIX-SHIFT-REPORTS-LIVE-VARIANCE-EXPENSES-RETURNS-NET
 *
 * Pins the live-variance override on the main Shifts list page.
 *
 * Repro: SHF-2026-00016 had a 500 EGP InstaPay payment. The stored
 * `shifts.expected_closing` briefly captured the 500 (= 1660), so
 * `shifts.list()` returned `variance = -500` even though the LIVE
 * single-shift card correctly shows variance = 0.
 *
 * Fix: Shifts.tsx now fans out `summary(id)` for every closed shift
 * and overrides the displayed variance with the LIVE summary value.
 *
 * The Shifts page mounts a deep tree (multiple modals, payment
 * accounts, mutations, …); rather than booting the whole page, this
 * test source-greps the relevant branches.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHIFTS_SRC = readFileSync(
  resolve(__dirname, '../Shifts.tsx'),
  'utf8',
);

describe('Shifts list — live variance override (PR-FIX-SHIFT-REPORTS-LIVE-VARIANCE-EXPENSES-RETURNS-NET)', () => {
  it('declares a `liveSummariesQuery` keyed off closed shift ids', () => {
    expect(SHIFTS_SRC).toContain('liveSummariesQuery');
    expect(SHIFTS_SRC).toContain("'shifts-live-summaries'");
  });

  it('only fires for closed shifts (avoids unnecessary fan-out on open ones)', () => {
    expect(SHIFTS_SRC).toMatch(
      /closedShiftIds[\s\S]+filter\(\(s\) => s\.status === 'closed'\)/,
    );
  });

  it('reads the variance cell from `liveVarianceMap[s.id]?.variance` first (LIVE summary), with stale `s.variance` as fallback only', () => {
    expect(SHIFTS_SRC).toMatch(
      /liveVarianceMap\[s\.id\]\?\.variance\s*!=\s*null[\s\S]+Number\(liveVarianceMap\[s\.id\]\.variance\)/,
    );
    // Fallback path is preserved (so initial render before fan-out
    // resolves still shows something instead of empty).
    expect(SHIFTS_SRC).toMatch(
      /\(s as any\)\.variance \?\? s\.difference \?\? 0/,
    );
  });

  it('still renders a DiffBadge for closed shifts (markup unchanged)', () => {
    expect(SHIFTS_SRC).toMatch(/<DiffBadge[\s\S]+value=\{[\s\S]+\}/);
  });
});
