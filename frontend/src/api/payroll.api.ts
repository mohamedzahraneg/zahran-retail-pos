import { api, unwrap } from './client';

// EmpTxnType is the DISPLAY union — it keeps 'advance' so historical
// rows (synthesised from expenses.is_advance=TRUE in the /payroll
// union query) still render with their label and styling.
//
// 'expense' removed (PR #69) and write-side 'advance' removed in the
// audit-#4 PR — see CreatePayrollType below. Direct creation of an
// advance via POST /payroll is refused at the backend DTO boundary;
// the canonical write path is POST /accounting/expenses with
// is_advance=TRUE.
export type EmpTxnType =
  | 'wage'
  | 'bonus'
  | 'deduction'
  | 'advance'
  | 'payout';

/**
 * Narrower union for write-side surfaces (CreateEmpTxn below, and the
 * type-picker button grid in the Payroll modal). Excludes:
 *   - 'advance' — canonical path is POST /accounting/expenses with
 *                 is_advance=TRUE (audit #4 dual-write fix).
 *   - 'wage'    — canonical path is the attendance / payable-day
 *                 workflow (PR #88 + PR-1). Direct wage rows from
 *                 this modal raced with payable_days inserts and
 *                 surfaced as the user-facing duplicate-entry error.
 *                 The backend rejects type='wage' on POST /payroll
 *                 with a 400 + redirect to /attendance/admin/*.
 */
export type CreatePayrollType = Exclude<EmpTxnType, 'advance' | 'wage'>;

export const CREATE_TXN_TYPES: readonly CreatePayrollType[] = [
  'bonus',
  'deduction',
  'payout',
] as const;

export const TXN_TYPE_LABELS: Record<EmpTxnType, string> = {
  wage: 'يومية',
  bonus: 'مكافأة',
  deduction: 'خصم',
  advance: 'سلفة',
  payout: 'صرف',
};

/** +ve direction → company owes employee. -ve → employee owes company. */
export const TXN_DIRECTION: Record<EmpTxnType, 1 | -1> = {
  wage: 1,
  bonus: 1,
  deduction: -1,
  advance: -1,
  payout: -1,
};

export interface EmployeeTxn {
  id: string;
  employee_id: string;
  employee_name?: string;
  employee_username?: string;
  txn_date: string;
  type: EmpTxnType;
  amount: string | number;
  description: string | null;
  cashbox_id: string | null;
  shift_id: string | null;
  created_by: string | null;
  created_by_name?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Shape returned by `GET /payroll/balances`.
 *
 * PR-AUDIT-EMPLOYEE-VIEW-UNIFY — sign convention contract:
 *
 *   ✅ USE `gl_balance` for ALL user-facing display.
 *      Sourced from `v_employee_gl_balance.balance` (migration 075,
 *      COA 1123 + 213). Convention:
 *        positive ⇒ EMPLOYEE OWES the company  (عليه)
 *        negative ⇒ COMPANY OWES the employee  (له)
 *
 *   ⚠ DO NOT consume `liabilities` / `receivables` / `net_balance`
 *      for display. These are SOURCE-derived aggregates from
 *      employee_transactions + employee_deductions etc. — they exist
 *      only so the BE can compute `gl_vs_source_diff` for drift
 *      detection, and they carry the OPPOSITE sign convention from
 *      `gl_balance`:
 *        positive net_balance ⇒ company owes employee
 *        negative net_balance ⇒ employee owes company
 *      Mixing them with `gl_balance` will silently invert labels.
 */
export interface EmployeeBalance {
  employee_id: string;
  /**
   * Canonical GL balance from v_employee_gl_balance (COA 1123 + 213,
   * migration 075). **THE headline field for any UI display.**
   * Positive = employee owes company (عليه); negative = company owes
   * employee (له). All Finance Dashboard / Team / EmployeeProfile / /me
   * pages already consume this field exclusively (see audit
   * PR-AUDIT-EMPLOYEE-VIEW-UNIFY).
   */
  gl_balance: number | string;
  full_name: string;
  username: string;
  /**
   * @deprecated Source-derived; INVERTED sign vs `gl_balance`. Used by
   * BE drift detection (`gl_vs_source_diff`). Do not display.
   */
  liabilities: number | string;
  /** @deprecated See `liabilities` — same warning. */
  receivables: number | string;
  /** @deprecated See `liabilities` — same warning. */
  net_balance: number | string;
  txn_count: number;
  last_txn_date: string | null;
}

export interface EmployeeSummary extends EmployeeBalance {
  by_type: { type: EmpTxnType; count: number; total: number }[];
  recent: EmployeeTxn[];
}

export interface CreateEmpTxn {
  employee_id: string;
  type: CreatePayrollType;
  amount: number;
  txn_date?: string;
  description?: string;
}

export const payrollApi = {
  list: (params?: {
    employee_id?: string;
    type?: EmpTxnType;
    from?: string;
    to?: string;
    limit?: number;
  }) => unwrap<EmployeeTxn[]>(api.get('/payroll', { params })),

  balances: () => unwrap<EmployeeBalance[]>(api.get('/payroll/balances')),

  employee: (id: string) =>
    unwrap<EmployeeSummary>(api.get(`/payroll/employee/${id}`)),

  create: (body: CreateEmpTxn) =>
    unwrap<EmployeeTxn>(api.post('/payroll', body)),

  update: (id: string, body: Partial<CreateEmpTxn>) =>
    unwrap<EmployeeTxn>(api.patch(`/payroll/${id}`, body)),

  remove: (id: string) =>
    unwrap<{ deleted: boolean }>(api.delete(`/payroll/${id}`)),
};
