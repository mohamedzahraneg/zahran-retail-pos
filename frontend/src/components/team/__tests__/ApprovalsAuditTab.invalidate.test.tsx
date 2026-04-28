/**
 * ApprovalsAuditTab.invalidate.test.tsx — PR-EMP-WAGE-CACHE-1
 *
 * Pins the React Query cache-invalidation contract for the
 * ApprovalsAuditTab decide-mutation success path. Mirrors the
 * AttendanceWageTab helper exactly — both must invalidate the same
 * set of keys, otherwise an admin who approves from one tab vs the
 * other gets different on-screen freshness.
 *
 * The drift detector here is per-key: every key the audit identified
 * as "read by an employee-profile screen" gets its own assertion. If
 * a future edit drops a key from one helper but not the other, this
 * test (or its sibling AttendanceWageTab.invalidate.test) fails.
 */
import { describe, it, expect, vi } from 'vitest';
import { invalidateWageApprovalSurfaces } from '../ApprovalsAuditTab';

function makeQc() {
  return { invalidateQueries: vi.fn() } as any;
}

function wasInvalidated(qc: any, key: string): boolean {
  return qc.invalidateQueries.mock.calls.some(
    (call: unknown[]) => {
      const arg = call[0] as { queryKey?: unknown[] };
      return (
        Array.isArray(arg?.queryKey) &&
        arg.queryKey.length === 1 &&
        arg.queryKey[0] === key
      );
    },
  );
}

describe('ApprovalsAuditTab.invalidateWageApprovalSurfaces — PR-EMP-WAGE-CACHE-1', () => {
  // ── Pre-existing keys on the decide mutation ──────────────────
  it('invalidates employees-pending (left-rail badge / pending list)', () => {
    const qc = makeQc();
    invalidateWageApprovalSurfaces(qc);
    expect(wasInvalidated(qc, 'employees-pending')).toBe(true);
  });

  it('invalidates employees-team', () => {
    const qc = makeQc();
    invalidateWageApprovalSurfaces(qc);
    expect(wasInvalidated(qc, 'employees-team')).toBe(true);
  });

  it('invalidates employee-user-dashboard', () => {
    const qc = makeQc();
    invalidateWageApprovalSurfaces(qc);
    expect(wasInvalidated(qc, 'employee-user-dashboard')).toBe(true);
  });

  // ── PR-EMP-WAGE-CACHE-1 newly-mirrored keys ───────────────────
  it('PR-EMP-WAGE-CACHE-1: invalidates payable-days', () => {
    const qc = makeQc();
    invalidateWageApprovalSurfaces(qc);
    expect(wasInvalidated(qc, 'payable-days')).toBe(true);
  });

  it('PR-EMP-WAGE-CACHE-1: invalidates attendance-employee-log', () => {
    const qc = makeQc();
    invalidateWageApprovalSurfaces(qc);
    expect(wasInvalidated(qc, 'attendance-employee-log')).toBe(true);
  });

  it('PR-EMP-WAGE-CACHE-1: invalidates attendance-employee-today', () => {
    const qc = makeQc();
    invalidateWageApprovalSurfaces(qc);
    expect(wasInvalidated(qc, 'attendance-employee-today')).toBe(true);
  });

  it('PR-EMP-WAGE-CACHE-1: invalidates attendance-summary-today', () => {
    const qc = makeQc();
    invalidateWageApprovalSurfaces(qc);
    expect(wasInvalidated(qc, 'attendance-summary-today')).toBe(true);
  });

  it('PR-EMP-WAGE-CACHE-1: invalidates employee-dashboard (EmployeeProfile.tsx:267 header card)', () => {
    const qc = makeQc();
    invalidateWageApprovalSurfaces(qc);
    expect(wasInvalidated(qc, 'employee-dashboard')).toBe(true);
  });

  it('PR-EMP-WAGE-CACHE-1: invalidates employee-ledger', () => {
    const qc = makeQc();
    invalidateWageApprovalSurfaces(qc);
    expect(wasInvalidated(qc, 'employee-ledger')).toBe(true);
  });

  it('PR-EMP-WAGE-CACHE-1: invalidates employee-user-ledger', () => {
    const qc = makeQc();
    invalidateWageApprovalSurfaces(qc);
    expect(wasInvalidated(qc, 'employee-user-ledger')).toBe(true);
  });

  it("PR-EMP-WAGE-CACHE-1: invalidates my-dashboard (admin-on-self / /me)", () => {
    const qc = makeQc();
    invalidateWageApprovalSurfaces(qc);
    expect(wasInvalidated(qc, 'my-dashboard')).toBe(true);
  });

  it('PR-EMP-WAGE-CACHE-1: invalidates employee-history-mine', () => {
    const qc = makeQc();
    invalidateWageApprovalSurfaces(qc);
    expect(wasInvalidated(qc, 'employee-history-mine')).toBe(true);
  });

  it('PR-EMP-WAGE-CACHE-1: invalidates employee-requests-mine', () => {
    const qc = makeQc();
    invalidateWageApprovalSurfaces(qc);
    expect(wasInvalidated(qc, 'employee-requests-mine')).toBe(true);
  });

  // ── Drift detector: parity with AttendanceWageTab ──────────────
  it('parity check — invalidates the same 13 top-level keys as AttendanceWageTab.invalidate', async () => {
    const { invalidate: wageInvalidate } = await import('../AttendanceWageTab');

    const qcA = makeQc();
    const qcB = makeQc();
    wageInvalidate(qcA);
    invalidateWageApprovalSurfaces(qcB);

    const setOf = (qc: any) =>
      new Set(
        qc.invalidateQueries.mock.calls
          .map((call: unknown[]) => (call[0] as any).queryKey?.[0])
          .filter((k: unknown): k is string => typeof k === 'string'),
      );

    const aKeys = setOf(qcA);
    const bKeys = setOf(qcB);
    // Every key invalidated by the WageTab helper must also be
    // invalidated by the AuditTab helper. Use Array.from for older
    // TS targets that don't ship Set spread.
    const missingInAudit = Array.from(aKeys).filter((k) => !bKeys.has(k));
    expect(missingInAudit).toEqual([]);
    // And vice-versa — keep the two helpers strictly in sync.
    const missingInWage = Array.from(bKeys).filter((k) => !aKeys.has(k));
    expect(missingInWage).toEqual([]);
    // Both must hit the 13-key floor.
    expect(aKeys.size).toBeGreaterThanOrEqual(13);
    expect(bKeys.size).toBeGreaterThanOrEqual(13);
  });
});
