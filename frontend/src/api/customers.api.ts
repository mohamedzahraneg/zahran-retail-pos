import { api, unwrap } from './client';

export interface Customer {
  id: string;
  code: string;
  full_name: string;
  phone?: string;
  email?: string;
  loyalty_tier: 'bronze' | 'silver' | 'gold' | 'platinum';
  loyalty_points: number;
  current_balance: number;
  credit_limit: number;
}

export const customersApi = {
  list: (params?: { q?: string; page?: number; limit?: number }) =>
    unwrap<{ data: Customer[]; meta: any }>(api.get('/customers', { params })),
  get: (id: string) => unwrap<Customer>(api.get(`/customers/${id}`)),
  create: (body: Partial<Customer>) => unwrap<Customer>(api.post('/customers', body)),
  update: (id: string, body: Partial<Customer>) =>
    unwrap<Customer>(api.patch(`/customers/${id}`, body)),
  ledger: (id: string) => unwrap<any[]>(api.get(`/customers/${id}/ledger`)),
  outstanding: () => unwrap<any[]>(api.get('/customers/outstanding')),
  unpaidInvoices: (id: string) =>
    unwrap<
      Array<{
        id: string;
        invoice_no: string;
        completed_at: string;
        grand_total: string;
        paid_amount: string;
        remaining: string;
        status: string;
      }>
    >(api.get(`/customers/${id}/unpaid-invoices`)),
};
