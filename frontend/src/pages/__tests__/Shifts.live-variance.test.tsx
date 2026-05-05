/**
 * Shifts.live-variance.test.tsx
 * ─────────────────────────────────────────────────────────────────────
 * PR-FIX-SHIFTS-PAGE-LIVE-VARIANCE-REVERT
 *
 * Pins that the main Shifts list page displays the **stored close-time
 * variance** from `shifts.list()` and does NOT recompute it live.
 *
 * History:
 *   - PR #292 fanned out `summary(id)` per closed shift → exhausted
 *     the Supavisor pooler with EMAXCONNSESSION on /shifts refresh.
 *   - PR #293 introduced a bulk `listLiveSummary` endpoint to replace
 *     the fan-out. The endpoint is lightweight (5 grouped queries)
 *     but its computation diverged from stored close-time variance
 *     on 4 known-good shifts (SHF-2026-00013, 00012, 00002, 00001),
 *     showing false shortages.
 *   - This PR: revert the live override entirely. Display stored
 *     variance. Keep the BE bulk endpoint deployed but unused on
 *     this page.
 *
 * Source-grep style — Shifts.tsx mounts a deep tree (multiple
 * modals, mutations, payment-account state) we'd rather not boot
 * just to assert source content.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHIFTS_SRC = readFileSync(
  resolve(__dirname, '../Shifts.tsx'),
  'utf8',
);

describe('Shifts list — stored close-time variance (PR-FIX-SHIFTS-PAGE-LIVE-VARIANCE-REVERT)', () => {
  it('does NOT fan out shiftsApi.summary(id) for closed shifts', () => {
    expect(SHIFTS_SRC).not.toMatch(
      /closedShiftIds\.map\([^)]*shiftsApi\.summary/,
    );
    expect(SHIFTS_SRC).not.toMatch(
      /Promise\.all\([^)]*shiftsApi\.summary/,
    );
  });

  it('does NOT call shiftsApi.listLiveSummary from this page', () => {
    expect(SHIFTS_SRC).not.toMatch(/shiftsApi\.listLiveSummary/);
  });

  it('does NOT declare a `liveSummariesQuery` / `liveVarianceMap` / `closedShiftIds` (live override is removed)', () => {
    expect(SHIFTS_SRC).not.toMatch(/\bliveSummariesQuery\b/);
    expect(SHIFTS_SRC).not.toMatch(/\bliveVarianceMap\b/);
    expect(SHIFTS_SRC).not.toMatch(/\bclosedShiftIds\b/);
  });

  it('does NOT register a `shifts-live-summaries` React Query cache key (no live fetch on this page)', () => {
    expect(SHIFTS_SRC).not.toContain("'shifts-live-summaries'");
  });

  it('reads the variance cell from stored fields only: `(s as any).variance ?? s.difference ?? 0`', () => {
    expect(SHIFTS_SRC).toMatch(
      /value=\{Number\([\s\S]*?\(s as any\)\.variance \?\? s\.difference \?\? 0[\s\S]*?\)\}/,
    );
  });

  it('still renders a DiffBadge for closed shifts (markup unchanged)', () => {
    expect(SHIFTS_SRC).toMatch(/<DiffBadge[\s\S]+value=\{[\s\S]+\}/);
  });

  it('preserves the existing `summary(id)` call sites for the close-out modal / refund-detail tabs (those are intentional and not the regression source)', () => {
    // Intentional summary(id) calls remain — they fire ONCE on click
    // (modal open), not per-row on list render.
    expect(SHIFTS_SRC).toMatch(/shiftsApi\.summary\(shift\.id\)/);
  });
});
