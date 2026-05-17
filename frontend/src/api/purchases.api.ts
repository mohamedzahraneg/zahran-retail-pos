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
  // PR-PURCHASES-P2.1 — landed-cost aggregates (NUMERIC NOT NULL DEFAULT 0).
  extra_costs_capitalized?: string | number;
  extra_costs_non_capitalized?: string | number;
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
  // PR-PURCHASES-P2.1 — landed-cost breakdown (numeric in DB, comes
  // back as string under TypeORM's pg-decimal serialization).
  base_unit_cost?: string | number;
  allocated_cost_total?: string | number;
  allocated_cost_per_unit?: string | number;
  manual_allocation?: boolean;
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
  // PR-PURCHASES-P2.2 — landed-cost aggregates + child rows. Empty
  // array on legacy purchases; backend supplies the relation.
  extra_costs?: PurchaseExtraCostRow[];
  extra_costs_capitalized?: string | number;
  extra_costs_non_capitalized?: string | number;
}

export interface CreatePurchaseItemPayload {
  variant_id: string;
  quantity: number;
  /** Operator-entered base/raw price per piece. Backend converts this
   *  into the LANDED unit_cost after running its allocation engine. */
  unit_cost: number;
  discount?: number;
  tax?: number;
}

// PR-PURCHASES-P2.2 — landed-cost extras DTOs.
export type ExtraCostType =
  | 'transport'
  | 'labor'
  | 'shipping'
  | 'customs'
  | 'packaging'
  | 'other';

export type AllocationMethod = 'by_value' | 'by_quantity' | 'manual';

export interface ManualAllocationPayload {
  variant_id: string;
  amount: number;
}

export interface CreatePurchaseExtraCostPayload {
  cost_type: ExtraCostType;
  label?: string;
  amount: number;
  capitalize_to_inventory?: boolean;
  allocation_method?: AllocationMethod;
  notes?: string;
  sort_order?: number;
  manual_allocations?: ManualAllocationPayload[];
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
  // PR-PURCHASES-P2.2 — optional; undefined keeps the legacy shape.
  extra_costs?: CreatePurchaseExtraCostPayload[];
}

// Detail-response shape (extras + per-line landed breakdown).
export interface PurchaseExtraCostRow {
  id: string;
  cost_type: ExtraCostType;
  label: string | null;
  amount: string | number;
  capitalize_to_inventory: boolean;
  allocation_method: AllocationMethod;
  notes: string | null;
  sort_order: number;
  created_at?: string;
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
  /** Purchases UX fixes — opt-in to include cancelled invoices in the
   *  default list view. When omitted the server hides cancelled rows
   *  (operator complaint: cancelled invoices were noise). Setting an
   *  explicit `status='cancelled'` filter still returns the cancelled
   *  rows regardless of this flag. */
  include_cancelled?: boolean;
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
