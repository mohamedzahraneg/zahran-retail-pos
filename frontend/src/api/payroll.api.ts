import { api, unwrap } from './client';

// 'expense' removed (2026‑04). Its backend recipe posted
// DR 529 مصروفات متفرقة / CR 213, hiding a real reimbursement
// inside misc. Until a proper reimbursement flow with
// expense_account_code is designed, the type is refused at the
// backend DTO boundary — removed here so the UI doesn't render a
// broken button.
export type EmpTxnType =
  | 'wage'
  | 'bonus'
  | 'deduction'
  | 'advance'
  | 'payout';

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
  type: EmpTxnType;
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
