import { api, unwrap } from './client';

export interface Salesperson {
  id: string;
  username: string;
  full_name: string;
  commission_rate: string;
  is_active: boolean;
  role_code: string;
  role_name: string;
}

export interface CommissionSummaryRow {
  user_id: string;
  full_name: string;
  username: string;
  commission_rate: string;
  invoices_count: string;
  eligible_sales: string;
  commission_amount: string;
}

export interface CommissionDetailRow {
  invoice_id: string;
  invoice_no: string;
  completed_at: string;
  customer_name: string | null;
  eligible_total: string;
  commission_rate: string;
  commission: string;
}

export const commissionsApi = {
  listSalespeople: () =>
    unwrap<Salesperson[]>(api.get('/commissions/salespeople')),

  summary: (from: string, to: string) =>
    unwrap<CommissionSummaryRow[]>(
      api.get('/commissions/summary', { params: { from, to } }),
    ),

  detail: (userId: string, from: string, to: string) =>
    unwrap<CommissionDetailRow[]>(
      api.get(`/commissions/${userId}/detail`, { params: { from, to } }),
    ),

  updateRate: (userId: string, commission_rate: number) =>
    unwrap<{ user_id: string; commission_rate: number }>(
      api.patch(`/commissions/${userId}/rate`, { commission_rate }),
    ),
};
