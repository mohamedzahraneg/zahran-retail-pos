/**
 * purchaseReturns.api.ts — PR-P2.4A
 *
 * Strongly-typed FE wrapper for the SINGLE official purchase-returns
 * namespace: `/purchases/returns*` and the
 * `/purchases/:id/returnable-items` helper. No `/purchase-returns`
 * surface exists — the existing routes were upgraded in place.
 */
import { api, unwrap } from './client';

export type PurchaseReturnSettlementType =
  | 'supplier_credit'
  | 'cash_refund'
  | 'bank_refund'
  | 'no_settlement';

export type PurchaseReturnStatus = 'draft' | 'posted' | 'cancelled';

export interface PurchaseReturnListItem {
  id: string;
  return_no: string;
  return_date: string;
  supplier_id: string;
  supplier_name: string | null;
  warehouse_id: string;
  warehouse_name: string | null;
  total_amount: string | number;
  status: PurchaseReturnStatus;
  reason: string | null;
  settlement_type: PurchaseReturnSettlementType;
  refund_amount: string | number | null;
  cashbox_id: string | null;
  posted_at: string | null;
  cancelled_at: string | null;
  items_count: number;
}

export interface PurchaseReturnItem {
  id: string;
  purchase_return_id: string;
  purchase_item_id: string | null;
  variant_id: string;
  quantity: string | number;
  unit_cost: string | number;
  line_total: string | number;
  sku?: string | null;
  barcode?: string | null;
  product_id?: string | null;
  product_name?: string | null;
  color_name?: string | null;
  size_label?: string | null;
}

export interface PurchaseReturnDetails extends PurchaseReturnListItem {
  purchase_id: string | null;
  notes: string | null;
  posted_by: string | null;
  cancelled_by: string | null;
  created_by: string | null;
  created_at: string;
  cashbox_name?: string | null;
  cashbox_kind?: string | null;
  created_by_name?: string | null;
  posted_by_name?: string | null;
  cancelled_by_name?: string | null;
  items: PurchaseReturnItem[];
}

export interface ReturnableItem {
  purchase_item_id: string;
  variant_id: string;
  sku: string | null;
  barcode: string | null;
  product_id: string;
  product_name: string;
  color_name: string | null;
  size_label: string | null;
  received: string | number;
  unit_cost: string | number;
  base_unit_cost?: string | number;
  already_returned: string | number;
  returnable: string | number;
}

export interface ReturnableResponse {
  purchase: {
    id: string;
    purchase_no: string;
    supplier_id: string;
    warehouse_id: string;
    status: string;
  };
  items: ReturnableItem[];
}

export interface CreatePurchaseReturnPayload {
  supplier_id: string;
  warehouse_id: string;
  purchase_id?: string | null;
  return_date?: string;
  items: Array<{
    variant_id: string;
    purchase_item_id?: string | null;
    quantity: number;
    unit_cost: number;
  }>;
  reason: string;
  notes?: string;
  settlement_type: PurchaseReturnSettlementType;
  cashbox_id?: string | null;
  refund_amount?: number | null;
}

function normalizeList<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.rows)) return r.rows as T[];
    if (Array.isArray(r.data)) return r.data as T[];
    if (Array.isArray(r.items)) return r.items as T[];
  }
  return [];
}

export const purchaseReturnsApi = {
  list: async (params?: {
    q?: string;
    supplier_id?: string;
    status?: PurchaseReturnStatus;
    from?: string;
    to?: string;
  }) => {
    const raw = await unwrap<unknown>(
      api.get('/purchases/returns', { params }),
    );
    return normalizeList<PurchaseReturnListItem>(raw);
  },

  get: (id: string) =>
    unwrap<PurchaseReturnDetails>(api.get(`/purchases/returns/${id}`)),

  create: (payload: CreatePurchaseReturnPayload) =>
    unwrap<PurchaseReturnDetails>(api.post('/purchases/returns', payload)),

  cancel: (id: string) =>
    unwrap<{ cancelled: true; id: string }>(
      api.patch(`/purchases/returns/${id}/cancel`),
    ),

  returnableItems: (purchaseId: string) =>
    unwrap<ReturnableResponse>(
      api.get(`/purchases/${purchaseId}/returnable-items`),
    ),
};
