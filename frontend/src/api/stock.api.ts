import { api, unwrap } from './client';

export interface StockRow {
  s_id: string;
  s_variant_id: string;
  s_warehouse_id: string;
  s_quantity: number;
  s_reserved_quantity: number;
  s_reorder_quantity: number;
  s_avg_cost: string | null;
  w_code: string;
  w_name_ar: string;
}

export interface AdjustmentPayload {
  variant_id: string;
  warehouse_id: string;
  delta: number;
  reason: string;
  unit_cost?: number;
}

export interface AdjustmentRow {
  id: string;
  variant_id: string;
  warehouse_id: string;
  direction: 'in' | 'out';
  quantity: number;
  unit_cost: string | null;
  notes: string | null;
  user_id: string | null;
  created_at: string;
  sku?: string;
  product_name?: string;
  warehouse_code?: string;
  warehouse_name?: string;
  user_name?: string;
}

export interface LowStockRow {
  variant_id: string;
  warehouse_id: string;
  sku: string;
  product_name: string;
  warehouse_name: string;
  quantity: number;
  reorder_quantity: number;
  shortage: number;
}

export interface VariantStockRow {
  variant_id: string;
  product_id: string;
  sku: string;
  barcode: string | null;
  color: string | null;
  size: string | null;
  cost_price: string;
  selling_price: string;
  is_active: boolean;
  quantity_on_hand: number;
  quantity_reserved: number;
  reorder_point: number;
}

export const stockApi = {
  adjust: (body: AdjustmentPayload) =>
    unwrap<{ new_qty: number }>(api.post('/stock/adjust', body)),

  byProduct: (productId: string, warehouseId?: string) =>
    unwrap<VariantStockRow[]>(
      api.get(`/stock/by-product/${productId}`, {
        params: warehouseId ? { warehouse_id: warehouseId } : undefined,
      }),
    ),

  listAdjustments: (params?: {
    variant_id?: string;
    warehouse_id?: string;
    from?: string;
    to?: string;
    limit?: number;
  }) => unwrap<AdjustmentRow[]>(api.get('/stock/adjustments', { params })),

  forVariant: (variantId: string) =>
    unwrap<StockRow[]>(api.get(`/stock/variant/${variantId}`)),

  lowStock: () => unwrap<LowStockRow[]>(api.get('/stock/low')),

  reorderSuggestions: () =>
    unwrap<any[]>(api.get('/stock/suggestions/reorder')),

  deadStock: () => unwrap<any[]>(api.get('/stock/suggestions/dead')),

  lossWarnings: () => unwrap<any[]>(api.get('/stock/suggestions/loss')),
};
