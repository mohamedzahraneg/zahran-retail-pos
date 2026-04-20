import { api, unwrap } from './client';

export interface InvoiceLine {
  variant_id: string;
  qty: number;
  unit_price: number;
  discount?: number;
  /** Optional per-line salesperson override */
  salesperson_id?: string;
}

export interface InvoicePayment {
  payment_method: 'cash' | 'card' | 'instapay' | 'bank_transfer';
  amount: number;
  reference?: string;
}

export interface CreateInvoicePayload {
  customer_id?: string;
  warehouse_id: string;
  /** Invoice-level salesperson (applies to all items by default) */
  salesperson_id?: string;
  lines: InvoiceLine[];
  payments: InvoicePayment[];
  discount_total?: number;
  coupon_code?: string;
  redeem_points?: number;
  notes?: string;
}

export const posApi = {
  create: (body: CreateInvoicePayload) =>
    unwrap<{
      invoice_id: string;
      doc_no: string;
      grand_total: number;
      change_given: number;
      tax_rate?: number;
      tax_amount?: number;
      loyalty_discount?: number;
      applied_points?: number;
    }>(api.post('/pos/invoices', body)),

  list: (params?: {
    limit?: number;
    from?: string;
    to?: string;
    status?: string;
    q?: string;
    cashier_id?: string;
  }) => unwrap<any[]>(api.get('/pos/invoices', { params })),

  get: (id: string) => unwrap<any>(api.get(`/pos/invoices/${id}`)),

  receipt: (id: string) =>
    unwrap<{
      invoice: any;
      lines: any[];
      payments: any[];
      shop: {
        name?: string;
        address?: string;
        phone?: string;
        tax_id?: string;
        vat_number?: string;
        logo_url?: string;
        footer_note?: string;
      };
      loyalty: { direction: 'in' | 'out'; points: number; reason: string }[];
    }>(api.get(`/pos/invoices/${id}/receipt`)),

  void: (id: string, reason: string) =>
    unwrap<{ voided: boolean }>(api.post(`/pos/invoices/${id}/void`, { reason })),
};
