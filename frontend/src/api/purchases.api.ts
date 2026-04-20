import { api, unwrap } from './client';

export type PurchaseStatus = 'draft' | 'received' | 'partial' | 'paid' | 'cancelled';

export interface Purchase {
  id: string;
  purchase_no: string;
  supplier_id: string;
  warehouse_id: string;
  supplier_name?: string;
  supplier_no?: string;
  warehouse_code?: string;
  invoice_date: string;
  due_date?: string | null;
  supplier_ref?: string | null;
  subtotal: string;
  discount_amount: string;
  tax_amount: string;
  shipping_cost: string;
  grand_total: string;
  paid_amount: string;
  remaining_amount?: string;
  status: PurchaseStatus;
  notes?: string | null;
  items_count?: number;
  created_at: string;
  received_at?: string | null;
}

export interface PurchaseItem {
  id: string;
  purchase_id: string;
  variant_id: string;
  sku?: string;
  product_name?: string;
  quantity: number;
  unit_cost: string;
  discount: string;
  tax: string;
  line_total: string;
}

export interface PurchasePayment {
  id: string;
  purchase_id: string;
  payment_method: string;
  amount: string;
  reference_number?: string | null;
  notes?: string | null;
  paid_at: string;
}

export interface PurchaseDetail extends Purchase {
  items: PurchaseItem[];
  payments: PurchasePayment[];
}

export interface CreatePurchaseItemPayload {
  variant_id: string;
  quantity: number;
  unit_cost: number;
  discount?: number;
  tax?: number;
}

export interface CreatePurchasePayload {
  supplier_id: string;
  warehouse_id: string;
  invoice_date?: string;
  due_date?: string;
  supplier_ref?: string;
  shipping_cost?: number;
  discount_amount?: number;
  tax_amount?: number;
  notes?: string;
  items: CreatePurchaseItemPayload[];
}

export interface AddPurchasePaymentPayload {
  payment_method: string;
  amount: number;
  reference_number?: string;
  notes?: string;
}

export interface ListPurchasesParams {
  status?: PurchaseStatus;
  supplier_id?: string;
  from?: string;
  to?: string;
}

export const purchasesApi = {
  list: (params?: ListPurchasesParams) =>
    unwrap<Purchase[]>(api.get('/purchases', { params })),

  get: (id: string) => unwrap<PurchaseDetail>(api.get(`/purchases/${id}`)),

  create: (body: CreatePurchasePayload) =>
    unwrap<Purchase>(api.post('/purchases', body)),

  receive: (id: string) =>
    unwrap<PurchaseDetail>(api.post(`/purchases/${id}/receive`)),

  pay: (id: string, body: AddPurchasePaymentPayload) =>
    unwrap<{ paid_amount: number; status: PurchaseStatus }>(
      api.post(`/purchases/${id}/pay`, body),
    ),

  cancel: (id: string) =>
    unwrap<{ cancelled: boolean }>(api.patch(`/purchases/${id}/cancel`)),

  // ───── Purchase Returns (إرجاع للمورد) ─────
  listReturns: (supplier_id?: string) =>
    unwrap<any[]>(
      api.get('/purchases/returns', {
        params: supplier_id ? { supplier_id } : undefined,
      }),
    ),

  getReturn: (id: string) => unwrap<any>(api.get(`/purchases/returns/${id}`)),

  createReturn: (body: {
    supplier_id: string;
    warehouse_id: string;
    purchase_id?: string;
    return_date?: string;
    reason?: string;
    notes?: string;
    items: Array<{ variant_id: string; quantity: number; unit_cost: number }>;
  }) => unwrap<any>(api.post('/purchases/returns', body)),

  cancelReturn: (id: string) =>
    unwrap<{ cancelled: boolean }>(
      api.patch(`/purchases/returns/${id}/cancel`),
    ),
};
