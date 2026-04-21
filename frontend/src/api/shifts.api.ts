import { api, unwrap } from './client';

export type ShiftStatus = 'open' | 'closed';

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
  total_expenses: number;
  expense_count: number;
  expenses: ShiftExpenseRow[];

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
    unwrap<{ pending: true; shift: Shift }>(
      api.post(`/shifts/${id}/request-close`, payload),
    ),

  pendingCloses: () =>
    unwrap<Array<Shift & { requested_by_name?: string }>>(
      api.get('/shifts/pending-close'),
    ),

  approveClose: (id: string) =>
    unwrap<{ approved: true; shift: Shift }>(
      api.post(`/shifts/${id}/approve-close`, {}),
    ),

  rejectClose: (id: string, reason: string) =>
    unwrap<{ rejected: true; shift: Shift }>(
      api.post(`/shifts/${id}/reject-close`, { reason }),
    ),
};
