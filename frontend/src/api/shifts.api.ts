import { api, unwrap } from './client';

export type ShiftStatus = 'open' | 'closed';

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
  opening_balance: string;
  expected_closing: string;
  actual_closing: string | null;
  difference: string;
  total_sales: string;
  total_returns: string;
  total_expenses: string;
  total_cash_in: string;
  total_cash_out: string;
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

  open: (payload: OpenShiftPayload) =>
    unwrap<Shift>(api.post('/shifts/open', payload)),

  close: (id: string, payload: { actual_closing: number; notes?: string }) =>
    unwrap<Shift>(api.post(`/shifts/${id}/close`, payload)),
};
