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

// ─── Purchases P1 (PR-PURCHASES-P1) ────────────────────────────────
// Supplier context for the purchase-invoice header card.
export interface SupplierContext {
  supplier: {
    id: string;
    code: string;
    name: string;
    supplier_type: 'cash' | 'credit' | 'installments';
    current_balance: number;
    balance_direction: 'owed_to_supplier' | 'credit_to_us' | 'zero';
    credit_limit: number;
    payment_terms_days: number;
  };
  stats: {
    purchase_count: number;
    purchases_total: number;
    paid_total: number;
    unpaid_total: number;
  };
  last_purchase: {
    id: string;
    purchase_no: string;
    invoice_date: string;
    grand_total: number;
    paid_amount: number;
    remaining: number;
    status: PurchaseStatus;
    interaction: 'cash' | 'partial' | 'credit' | null;
  } | null;
}

// Product-search row tuned for the purchase invoice line entry.
// Each row is a variant. `exact_match` is true when rank_score ≤ 3
// (variant.barcode / variant.sku / product.sku_root exact hit).
export interface PurchaseProductSearchRow {
  product_id: string;
  sku_root: string;
  name_ar: string;
  name_en: string | null;
  primary_image_url: string | null;
  base_price: number;
  variant_id: string;
  variant_sku: string;
  variant_barcode: string | null;
  variant_image_url: string | null;
  color: string | null;
  size: string | null;
  cost_price: number;
  selling_price: number;
  available_stock: number;
  last_purchase_price: number | null;
  last_purchase_at: string | null;
  last_supplier_name: string | null;
  last_supplier_id: string | null;
  exact_match: boolean;
  rank_score: number;
}

export interface PurchaseProductSearchResponse {
  query: string;
  results: PurchaseProductSearchRow[];
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

  edit: (
    id: string,
    body: CreatePurchasePayload & { edit_reason?: string },
  ) =>
    unwrap<{ edited?: boolean; replaced?: string; purchase: any }>(
      api.post(`/purchases/${id}/edit`, body),
    ),

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

  // ───── Purchases P1 (PR-PURCHASES-P1) ─────
  supplierContext: (supplierId: string) =>
    unwrap<SupplierContext>(
      api.get(`/purchases/suppliers/${supplierId}/context`),
    ),

  productSearch: (params: {
    q: string;
    warehouse_id?: string;
    limit?: number;
  }) =>
    unwrap<PurchaseProductSearchResponse>(
      api.get('/purchases/products/search', { params }),
    ),
};
