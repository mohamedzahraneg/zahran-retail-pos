import { api, unwrap } from './client';

export type ShiftStatus = 'open' | 'closed' | 'pending_close';

export type VarianceTreatment =
  | 'charge_employee'
  | 'company_loss'
  | 'revenue'
  | 'suspense';

export interface ApproveClosePayload {
  variance_treatment?: VarianceTreatment;
  variance_employee_id?: string;
  variance_notes?: string;
}

export interface PaymentBreakdown {
  cash: { amount: number; count: number };
  card: { amount: number; count: number };
  instapay: { amount: number; count: number };
  bank_transfer: { amount: number; count: number };
}

export interface ShiftExpenseRow {
  id: string;
  expense_no: string | null;
  amount: number | string;
  description: string | null;
  category_name: string | null;
  expense_date: string;
  status: string;
  /** PR-14 — joined fields used by the cash-out section. */
  employee_name?: string | null;
  cashbox_name?: string | null;
  payment_method?: string;
  created_by_name?: string | null;
  je_entry_no?: string | null;
}

/** PR-14 — every cash row that left the drawer for an employee
 *  (settlement payout or expense flagged as advance). The shift
 *  closing renders these in their own "حركات موظفين نقدية" section
 *  so they're never confused with operating expenses. */
export interface EmployeeCashMovement {
  kind: 'settlement' | 'advance';
  id: string;
  movement_type: 'settlement' | 'advance';
  /** Arabic display label used by the table — صرف مستحقات / سلفة موظف. */
  type_label: string;
  employee_user_id: string | null;
  employee_name: string | null;
  amount: number;
  created_at: string;
  cashbox_id: string | null;
  cashbox_name: string | null;
  payment_method: string | null;
  description: string | null;
  je_entry_no: string | null;
  created_by_name: string | null;
  /** Friendly accounting impact label for the table cell.
   *  e.g. "DR 213 / CR الخزينة الرئيسية". */
  accounting_impact: string;
  /** explicit = row carries shift_id, derived = matched by
   *  cashbox_id + time window. */
  link_method: 'explicit' | 'derived';
}

/** PR-B1 — one row in the shift counted-cash adjustment audit. */
export interface ShiftCountAdjustment {
  id: string;
  shift_id: string;
  old_actual_closing: number | string | null;
  new_actual_closing: number | string;
  old_expected_closing: number | string | null;
  new_expected_closing: number | string | null;
  old_difference: number | string | null;
  new_difference: number | string | null;
  reason: string;
  adjusted_by: string;
  adjusted_by_name?: string | null;
  adjusted_at: string;
}

export interface ShiftSummary {
  shift_id: string;
  shift_no: string;
  status: ShiftStatus;
  opening_balance: number;
  opened_at: string;
  closed_at: string | null;

  // Sales
  total_sales: number;
  invoice_count: number;
  cancelled_count: number;
  total_cancelled: number;
  remaining_receivable: number;

  // Payment method split
  payment_breakdown: PaymentBreakdown;

  // Cashbox flows
  customer_receipts: number;
  supplier_payments: number;
  other_cash_in: number;
  other_cash_out: number;

  // Returns + expenses
  total_returns: number;
  return_count: number;
  /** Sum of advances + operating expenses (legacy semantic). */
  total_expenses: number;
  expense_count: number;
  /** Operating expenses only (advances filtered out — PR-14). */
  expenses: ShiftExpenseRow[];

  // PR-14 — employee cash split (no schema changes)
  total_operating_expenses: number;
  operating_expense_count: number;
  total_employee_advances: number;
  employee_advance_count: number;
  total_employee_settlements: number;
  employee_settlement_count: number;
  total_employee_cash_out: number;
  employee_cash_movements: EmployeeCashMovement[];

  // Reconciliation
  total_cash_in: number;
  total_cash_out: number;
  expected_closing: number;
  actual_closing: number | null;
  variance: number | null;
}

export interface Shift {
  id: string;
  shift_no: string;
  cashbox_id: string;
  cashbox_name?: string;
  warehouse_id: string;
  warehouse_name?: string;
  opened_by: string;
  opened_by_name?: string;
  closed_by?: string | null;
  closed_by_name?: string | null;
  status: ShiftStatus;
  opening_balance: string | number;
  expected_closing: string | number;
  actual_closing: string | number | null;
  difference?: string | number;
  variance?: string | number;
  total_sales: string | number;
  total_returns: string | number;
  total_expenses: string | number;
  total_cash_in: string | number;
  total_cash_out: string | number;
  invoice_count: number;
  opened_at: string;
  closed_at: string | null;
  notes: string | null;
  // Pending-close request metadata (set while status='pending_close')
  close_requested_at?: string | null;
  close_requested_by?: string | null;
  close_requested_amount?: string | number | null;
  close_requested_notes?: string | null;
  close_approved_at?: string | null;
  close_approved_by?: string | null;
  close_rejection_reason?: string | null;
  // Variance treatment metadata (migration 060)
  variance_treatment?: VarianceTreatment | null;
  variance_employee_id?: string | null;
  variance_notes?: string | null;
  variance_journal_entry_id?: string | null;
  variance_amount?: number | string | null;
  variance_type?: 'shortage' | 'overage' | 'zero' | null;
  variance_approved_by?: string | null;
  variance_approved_at?: string | null;
  // Live values injected by /shifts/pending-close (not DB columns) —
  // present only on that endpoint's rows. See shifts.service.listPendingCloses.
  expected_closing_live?: number | null;
  variance_live?: number | null;
  invoices?: Array<{
    id: string;
    invoice_no: string;
    grand_total: string;
    paid_amount: string;
    status: string;
    completed_at: string;
  }>;
  /** Present on /current, /:id, and /:id/summary. */
  summary?: ShiftSummary;
}

export interface OpenShiftPayload {
  cashbox_id: string;
  warehouse_id: string;
  opening_balance: number;
  notes?: string;
}

export const shiftsApi = {
  list: (params?: { status?: string; user_id?: string }) =>
    unwrap<Shift[]>(api.get('/shifts', { params })),

  current: () => unwrap<Shift | null>(api.get('/shifts/current')),

  get: (id: string) => unwrap<Shift>(api.get(`/shifts/${id}`)),

  summary: (id: string) => unwrap<ShiftSummary>(api.get(`/shifts/${id}/summary`)),

  // PR-B1 — counted-cash adjustment workflow
  adjustCount: (id: string, body: { new_actual_closing: number; reason: string }) =>
    unwrap<{ shift: Shift; adjustment: ShiftCountAdjustment }>(
      api.post(`/shifts/${id}/adjust-count`, body),
    ),
  listAdjustments: (id: string) =>
    unwrap<ShiftCountAdjustment[]>(api.get(`/shifts/${id}/adjustments`)),

  open: (payload: OpenShiftPayload) =>
    unwrap<Shift>(api.post('/shifts/open', payload)),

  close: (
    id: string,
    payload: {
      actual_closing: number;
      notes?: string;
      denominations?: Record<string, number>;
    },
  ) =>
    unwrap<Shift & { summary?: ShiftSummary }>(
      api.post(`/shifts/${id}/close`, payload),
    ),

  requestClose: (
    id: string,
    payload: { actual_closing: number; notes?: string },
  ) =>
    unwrap<
      | { pending: true; shift: Shift; variance: number; expected_closing: number }
      | { pending: false; auto_closed: true; shift: Shift & { summary?: ShiftSummary } }
    >(api.post(`/shifts/${id}/request-close`, payload)),

  pendingCloses: () =>
    unwrap<Array<Shift & { requested_by_name?: string }>>(
      api.get('/shifts/pending-close'),
    ),

  approveClose: (id: string, payload: ApproveClosePayload = {}) =>
    unwrap<{ approved: true; shift: Shift }>(
      api.post(`/shifts/${id}/approve-close`, payload),
    ),

  rejectClose: (id: string, reason: string) =>
    unwrap<{ rejected: true; shift: Shift }>(
      api.post(`/shifts/${id}/reject-close`, { reason }),
    ),
};
