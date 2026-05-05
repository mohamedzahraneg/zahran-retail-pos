/**
 * Shifts.live-variance.test.tsx
 * ─────────────────────────────────────────────────────────────────────
 * PR-FIX-SHIFTS-PAGE-BULK-LIVE-VARIANCE
 *
 * Pins the bulk live-variance pattern on the main Shifts list page.
 *
 * Repro: PR #292 introduced a per-row `summary(id)` fan-out that
 * exhausted the Supavisor pooler with EMAXCONNSESSION on refresh.
 *
 * Fix: Shifts.tsx now calls a single `shiftsApi.listLiveSummary(ids)`
 * with the visible closed-shift ids. The BE returns one row per
 * shift with the LIVE variance, sourced via 5 grouped SQL queries
 * (NOT N × computeSummary). The FE keeps the same DiffBadge
 * override pattern.
 *
 * Source-grep style (matches the existing Shifts test file
 * conventions) — Shifts.tsx mounts a deep tree we'd rather not boot
 * just to assert two query references.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHIFTS_SRC = readFileSync(
  resolve(__dirname, '../Shifts.tsx'),
  'utf8',
);

describe('Shifts list — bulk live-variance (PR-FIX-SHIFTS-PAGE-BULK-LIVE-VARIANCE)', () => {
  it('does NOT fan out shiftsApi.summary(id) for closed shifts in the live-summary query', () => {
    // The old (post-PR #292, pre-this-PR) pattern was
    //   const arr = await Promise.all(closedShiftIds.map((id) =>
    //     shiftsApi.summary(id).catch(() => null)
    //   ));
    // It must NOT survive in the queryFn.
    expect(SHIFTS_SRC).not.toMatch(
      /closedShiftIds\.map\([^)]*shiftsApi\.summary/,
    );
    expect(SHIFTS_SRC).not.toMatch(
      /Promise\.all\([^)]*shiftsApi\.summary/,
    );
  });

  it('calls shiftsApi.listLiveSummary(closedShiftIds) once via the React Query queryFn', () => {
    expect(SHIFTS_SRC).toContain('shiftsApi.listLiveSummary(closedShiftIds)');
  });

  it('keeps the React Query cache key `shifts-live-summaries` keyed off closed shift ids', () => {
    expect(SHIFTS_SRC).toContain("'shifts-live-summaries'");
    expect(SHIFTS_SRC).toMatch(
      /closedShiftIds[\s\S]+filter\(\(s\) => s\.status === 'closed'\)/,
    );
  });

  it('reads the variance cell from `liveVarianceMap[s.id]?.variance` first (LIVE summary), with stale `s.variance` as fallback only', () => {
    expect(SHIFTS_SRC).toMatch(
      /liveVarianceMap\[s\.id\]\?\.variance\s*!=\s*null[\s\S]+Number\(liveVarianceMap\[s\.id\]\.variance\)/,
    );
    expect(SHIFTS_SRC).toMatch(
      /\(s as any\)\.variance \?\? s\.difference \?\? 0/,
    );
  });

  it('still renders a DiffBadge for closed shifts (markup unchanged)', () => {
    expect(SHIFTS_SRC).toMatch(/<DiffBadge[\s\S]+value=\{[\s\S]+\}/);
  });
});
