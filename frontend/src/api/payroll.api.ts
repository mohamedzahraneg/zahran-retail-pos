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
 * type-picker button grid in the Payroll modal). Excludes 'advance'
 * and 'expense' — the display EmpTxnType still includes them so
 * historical rows render correctly.
 */
export type CreatePayrollType = Exclude<EmpTxnType, 'advance'>;

export const CREATE_TXN_TYPES: readonly CreatePayrollType[] = [
  'wage',
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
 * Shape returned by `GET /payroll/balances`. Sourced from the authoritative
 * GL view `v_employee_balances_gl` (migration 039) — NOT from raw
 * employee_transactions sums. Positive `net_balance` = company owes the
 * employee; negative = employee owes the company.
 */
export interface EmployeeBalance {
  employee_id: string;
  full_name: string;
  username: string;
  liabilities: number | string; // account 213 (credit − debit)
  receivables: number | string; // account 1123 (debit − credit)
  net_balance: number | string; // liabilities − receivables
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
