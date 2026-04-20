import { api, unwrap } from './client';

export interface Supplier {
  id: string;
  code: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  current_balance?: string;
  credit_limit?: string;
  created_at?: string;
}

export interface SupplierOutstanding {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  current_balance: string;
  overdue_amount: string;
  invoices_count: number;
}

export const suppliersApi = {
  list: (q?: string) =>
    unwrap<Supplier[]>(api.get('/suppliers', { params: q ? { q } : undefined })),

  get: (id: string) => unwrap<Supplier>(api.get(`/suppliers/${id}`)),

  create: (body: Partial<Supplier>) =>
    unwrap<Supplier>(api.post('/suppliers', body)),

  update: (id: string, body: Partial<Supplier>) =>
    unwrap<Supplier>(api.patch(`/suppliers/${id}`, body)),

  remove: (id: string) =>
    unwrap<{ archived: boolean }>(api.delete(`/suppliers/${id}`)),

  ledger: (id: string) => unwrap<any[]>(api.get(`/suppliers/${id}/ledger`)),

  outstanding: () =>
    unwrap<SupplierOutstanding[]>(api.get('/suppliers/outstanding')),

  payments: (id: string) =>
    unwrap<any[]>(api.get(`/suppliers/${id}/payments`)),

  pay: (
    id: string,
    body: {
      amount: number;
      payment_method: 'cash' | 'card' | 'instapay' | 'bank_transfer';
      reference_number?: string;
      notes?: string;
    },
  ) =>
    unwrap<{
      paid: boolean;
      amount: number;
      allocations: Array<{ purchase_id: string; applied: number }>;
      new_balance: number;
    }>(api.post(`/suppliers/${id}/pay`, body)),
};
