import type { QueryClient } from '@tanstack/react-query';

/**
 * The complete set of React Query keys whose cached data depends on
 * the currently-selected employee month, an attendance row, a wage
 * accrual, or a settlement / bonus / deduction. Any mutation that
 * touches those domains should call `invalidateMonthly(qc)` so the
 * Employee Profile, Team list, Payroll tab, and Attendance page all
 * stay in sync without each caller knowing about the others.
 *
 * Originally a private helper in EmployeeProfile.tsx; promoted to a
 * shared module in PR-1 so the standalone Attendance page can fix its
 * narrow invalidation (it used to refresh only attendance-* keys,
 * leaving stale balances on Team/Payroll until a manual reload).
 */
export const MONTH_SCOPED_QUERY_KEYS = [
  ['employee-dashboard'],
  ['employee-ledger'],
  ['employee-payable-days'],
  ['employee-history-mine'],
  ['payroll-balances'],
  ['payroll-list'],
  ['employees-team'],
  ['attendance'],
  ['attendance-my-today'],
  ['attendance-list'],
  ['attendance-summary'],
] as const;

export function invalidateMonthly(qc: QueryClient): void {
  for (const key of MONTH_SCOPED_QUERY_KEYS) {
    qc.invalidateQueries({ queryKey: key });
  }
}
