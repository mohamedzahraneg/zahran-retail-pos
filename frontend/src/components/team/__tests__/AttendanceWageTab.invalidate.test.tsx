/**
 * AttendanceWageTab.invalidate.test.tsx — PR-EMP-WAGE-CACHE-1
 *
 * Pins the React Query cache-invalidation contract that was the
 * proximate cause of the "approved 2 days but the balance didn't
 * refresh" report.
 *
 * The audit confirmed the backend posts every wage approval correctly
 * (`v_employee_gl_balance` exactly matches the manual sum over
 * `journal_lines.employee_user_id`). The reason the on-screen
 * BalanceCard / ledger panels appeared stuck was that the helper used
 * by the approve-wage modal invalidated only six keys, while the
 * admin-profile screens read from a wider set:
 *
 *   - `employee-dashboard`        (EmployeeProfile.tsx:267)
 *   - `employee-ledger`           (EmployeeProfile.tsx:1020,
 *                                  AdjustmentsTab.tsx:134,
 *                                  ApprovalsAuditTab.tsx:140)
 *   - `employee-user-ledger`      (EmployeeReportsTab.tsx:103)
 *   - `employees-pending`         (ApprovalsAuditTab.tsx:119)
 *   - `my-dashboard`              (MyProfile.tsx:144)
 *   - `employee-history-mine`     (EmployeeProfile.tsx:1441)
 *   - `employee-requests-mine`    (EmployeeProfile.tsx:1884)
 *
 * Each test below asserts that ONE specific key is invalidated by the
 * helper. A future refactor that drops a key fails CI immediately.
 */
import { describe, it, expect, vi } from 'vitest';
import { invalidate } from '../AttendanceWageTab';

/**
 * Build a minimal QueryClient stand-in with `invalidateQueries` as a
 * vi.fn(). The helper only uses that one method, so we don't need a
 * real React Query instance for this contract test.
 */
function makeQc() {
  return { invalidateQueries: vi.fn() } as any;
}

/** Convenience: did `invalidateQueries` see a call with this exact key? */
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

describe('AttendanceWageTab.invalidate(qc) — PR-EMP-WAGE-CACHE-1', () => {
  // ── Existing keys (regression net) ────────────────────────────
  it('invalidates payable-days', () => {
    const qc = makeQc();
    invalidate(qc);
    expect(wasInvalidated(qc, 'payable-days')).toBe(true);
  });

  it('invalidates attendance-employee-log', () => {
    const qc = makeQc();
    invalidate(qc);
    expect(wasInvalidated(qc, 'attendance-employee-log')).toBe(true);
  });

  it('invalidates attendance-employee-today', () => {
    const qc = makeQc();
    invalidate(qc);
    expect(wasInvalidated(qc, 'attendance-employee-today')).toBe(true);
  });

  it('invalidates employee-user-dashboard', () => {
    const qc = makeQc();
    invalidate(qc);
    expect(wasInvalidated(qc, 'employee-user-dashboard')).toBe(true);
  });

  it('invalidates employees-team', () => {
    const qc = makeQc();
    invalidate(qc);
    expect(wasInvalidated(qc, 'employees-team')).toBe(true);
  });

  it('invalidates attendance-summary-today', () => {
    const qc = makeQc();
    invalidate(qc);
    expect(wasInvalidated(qc, 'attendance-summary-today')).toBe(true);
  });

  // ── PR-EMP-WAGE-CACHE-1 newly-required keys ───────────────────
  it('PR-EMP-WAGE-CACHE-1: invalidates employee-dashboard (EmployeeProfile.tsx:267 header card)', () => {
    const qc = makeQc();
    invalidate(qc);
    expect(wasInvalidated(qc, 'employee-dashboard')).toBe(true);
  });

  it('PR-EMP-WAGE-CACHE-1: invalidates employee-ledger (EmployeeProfile.tsx:1020 + AdjustmentsTab + ApprovalsAuditTab ledger panel)', () => {
    const qc = makeQc();
    invalidate(qc);
    expect(wasInvalidated(qc, 'employee-ledger')).toBe(true);
  });

  it('PR-EMP-WAGE-CACHE-1: invalidates employee-user-ledger (EmployeeReportsTab.tsx:103)', () => {
    const qc = makeQc();
    invalidate(qc);
    expect(wasInvalidated(qc, 'employee-user-ledger')).toBe(true);
  });

  it('PR-EMP-WAGE-CACHE-1: invalidates employees-pending (ApprovalsAuditTab.tsx:119 left-rail count)', () => {
    const qc = makeQc();
    invalidate(qc);
    expect(wasInvalidated(qc, 'employees-pending')).toBe(true);
  });

  it("PR-EMP-WAGE-CACHE-1: invalidates my-dashboard (admin-on-self / MyProfile /me dashboard)", () => {
    const qc = makeQc();
    invalidate(qc);
    expect(wasInvalidated(qc, 'my-dashboard')).toBe(true);
  });

  it('PR-EMP-WAGE-CACHE-1: invalidates employee-history-mine (EmployeeProfile.tsx:1441)', () => {
    const qc = makeQc();
    invalidate(qc);
    expect(wasInvalidated(qc, 'employee-history-mine')).toBe(true);
  });

  it('PR-EMP-WAGE-CACHE-1: invalidates employee-requests-mine (EmployeeProfile.tsx:1884)', () => {
    const qc = makeQc();
    invalidate(qc);
    expect(wasInvalidated(qc, 'employee-requests-mine')).toBe(true);
  });

  // ── Aggregate sanity ───────────────────────────────────────────
  it('calls invalidateQueries at least 13 times in total (6 existing + 7 new)', () => {
    const qc = makeQc();
    invalidate(qc);
    expect(qc.invalidateQueries.mock.calls.length).toBeGreaterThanOrEqual(13);
  });
});
