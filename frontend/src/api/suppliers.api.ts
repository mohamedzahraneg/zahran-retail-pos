import { api, unwrap } from './client';

export type SupplierType = 'cash' | 'credit' | 'installments';

export interface Supplier {
  id: string;
  code: string;
  name: string;
  phone?: string | null;
  alt_phone?: string | null;
  email?: string | null;
  address?: string | null;
  contact_person?: string | null;
  tax_number?: string | null;
  notes?: string | null;
  supplier_type?: SupplierType;
  opening_balance?: string | number;
  current_balance?: string;
  credit_limit?: string | number;
  payment_terms_days?: number;
  is_active?: boolean;
  created_at?: string;
}

export interface SupplierSummary {
  supplier: Supplier & {
    purchase_count: number;
    purchases_total: string;
    paid_total: string;
    unpaid_total: string;
  };
  purchases: Array<{
    id: string;
    purchase_no: string;
    invoice_date: string;
    grand_total: string;
    paid_amount: string;
    remaining: string;
    status: string;
  }>;
  payments: Array<{
    id: string;
    paid_at: string;
    amount: string;
    payment_method: string;
    reference_number?: string;
    notes?: string;
    purchase_no: string;
    paid_by_name?: string;
  }>;
  ledger: any[];
  discounts: Array<{
    id: string;
    name: string;
    sku: string;
    quantity: number;
    unit_cost: string;
    discount: string;
    purchase_no: string;
    invoice_date: string;
  }>;
  credit_usage_pct: number | null;
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

  summary: (id: string) =>
    unwrap<SupplierSummary>(api.get(`/suppliers/${id}/summary`)),

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
