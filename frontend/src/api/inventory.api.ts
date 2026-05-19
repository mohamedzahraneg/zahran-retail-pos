/**
 * inventory.api.ts — PR-FIX-INVENTORY-UI-SHELL
 *
 * Read-only client for the new inventory APIs shipped by the backend
 * foundation PR. Wraps:
 *   GET /inventory/dashboard
 *   GET /inventory/balances
 *   GET /inventory/movements
 *   GET /products/:id/360
 *   GET /products/:id/matrix
 *
 * All endpoints are pure SELECTs server-side. The frontend never
 * mutates inventory through this module — write paths still go
 * through the existing `stockApi.adjust`, `stockTransfersApi`,
 * `inventoryCountsApi`, etc.
 *
 * Tenant-readiness: the param shapes leave room for `tenant_id` /
 * `branch_id` to land later without rewriting call-sites — every
 * filter object is open-shape (`Partial<...>` at the call layer)
 * and the response types describe what the server returns today,
 * not what the schema constrains it to forever.
 */
import { api, unwrap } from './client';

// ─── Group fields shared across multiple shapes ─────────────────────
/**
 * Each protected row that has groups carries FOUR parallel arrays:
 * `group_ids`, `group_names_ar`, `group_names_en`, `group_colors`.
 * The arrays are aligned by index — `group_ids[i]` corresponds to
 * `group_names_ar[i]` etc. The arrays are NEVER null; an empty
 * array `[]` means the variant isn't a member of any active group.
 *
 * `group_names_en` and `group_colors` MAY contain `null` slots when
 * the underlying `product_groups.name_en` / `.color` columns are
 * NULL. Frontend renderers should fall back to `name_ar`/no-color
 * in those slots.
 */
export interface VariantGroupArrays {
  group_ids: string[];
  group_names_ar: string[];
  group_names_en: Array<string | null>;
  group_colors: Array<string | null>;
}

// ============================================================================
// GET /inventory/dashboard
// ============================================================================
export interface InventoryDashboardTotals {
  total_products: number;
  total_variants: number;
  total_stock_qty: number;
  total_available_qty: number;
  total_stock_cost_value: number;
  total_stock_sale_value: number;
  low_stock_count: number;
  out_of_stock_count: number;
  warehouses_count: number;
  movements_today_count: number;
  low_stock_groups_count: number;
}

export interface InventoryDashboardLowStockItem {
  variant_id: string;
  product_id: string;
  product_name: string;
  sku: string;
  color_name: string | null;
  size_label: string | null;
  warehouse_id: string;
  warehouse_name: string;
  quantity_on_hand: number;
  reorder_point: number;
}

export interface InventoryDashboardMovement {
  id: string;
  created_at: string;
  movement_type: string;
  direction: 'in' | 'out';
  quantity: number;
  variant_id: string;
  product_name: string;
  sku: string;
  warehouse_name: string;
  source_module: string | null;
  source_action: string | null;
}

export interface InventoryDashboardGroupValue {
  group_id: string;
  name_ar: string;
  name_en: string | null;
  color: string | null;
  stock_qty: number;
  stock_value: number;
}

export interface InventoryDashboardGroupSales {
  group_id: string;
  name_ar: string;
  color: string | null;
  revenue_30d: number;
  qty_30d: number;
}

export interface InventoryDashboardResponse {
  totals: InventoryDashboardTotals;
  top_low_stock: InventoryDashboardLowStockItem[];
  recent_movements: InventoryDashboardMovement[];
  top_groups_by_stock_value: InventoryDashboardGroupValue[];
  top_groups_by_sales_30d: InventoryDashboardGroupSales[];
}

// ============================================================================
// GET /inventory/balances
// ============================================================================
export interface InventoryBalancesFilters {
  page?: number;
  limit?: number;
  search?: string;
  warehouse_id?: string;
  category_id?: string;
  brand_id?: string;
  color_id?: string;
  size_id?: string;
  /** Filter to variants in this product_group. Server uses an EXISTS
   *  sub-query so a variant in multiple groups still produces ONE row. */
  group_id?: string;
  /**
   * PR-BRANCHES-INVENTORY-FILTERS — restrict to warehouses linked to
   * this branch via `warehouse_branches`. Combinable with
   * `warehouse_id` (both apply — intersection).
   */
  branch_id?: string;
  low_stock?: boolean;
  out_of_stock?: boolean;
}

export interface InventoryBalanceRow extends VariantGroupArrays {
  product_id: string;
  product_name: string;
  sku_prefix: string;
  variant_id: string;
  sku: string;
  barcode: string | null;
  cost_price: string | number;
  selling_price: string | number;
  color_id: string | null;
  color_name: string | null;
  size_id: string | null;
  size_label: string | null;
  warehouse_id: string;
  warehouse_name: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  available_quantity: number;
  reorder_point: number;
  avg_cost: string | number | null;
  stock_cost_value: string | number;
  stock_sale_value: string | number;
  last_movement_at: string | null;
}

export interface PaginatedInventoryBalances {
  items: InventoryBalanceRow[];
  total: number;
  page: number;
  limit: number;
}

// ============================================================================
// GET /inventory/movements
// ============================================================================
export interface InventoryMovementsFilters {
  page?: number;
  limit?: number;
  variant_id?: string;
  product_id?: string;
  warehouse_id?: string;
  movement_type?: string;
  direction?: 'in' | 'out';
  reference_type?: string;
  date_from?: string;
  date_to?: string;
  search?: string;
  /** Filter to movements on variants in this group. EXISTS sub-query
   *  server-side — no row multiplication. */
  group_id?: string;
  /**
   * PR-BRANCHES-INVENTORY-FILTERS — restrict to movements on
   * warehouses linked to this branch.
   */
  branch_id?: string;
}

/**
 * PR-BRANCHES-INVENTORY-FILTERS — dashboard scope filters. Today
 * just `branch_id`.
 */
export interface InventoryDashboardFilters {
  branch_id?: string;
}

export interface InventoryMovementRow {
  id: string;
  created_at: string;
  movement_type: string;
  direction: 'in' | 'out';
  quantity: number;
  unit_cost: string | number | null;
  reference_type: string | null;
  reference_id: string | null;
  source_module: string | null;
  source_action: string | null;
  balance_after_qty: number | null;
  notes: string | null;
  variant_id: string;
  sku: string;
  barcode: string | null;
  product_id: string;
  product_name: string;
  sku_prefix: string;
  warehouse_id: string;
  warehouse_name: string;
  user_id: string | null;
  user_name: string | null;
  user_username: string | null;
}

export interface PaginatedInventoryMovements {
  items: InventoryMovementRow[];
  total: number;
  page: number;
  limit: number;
}

// ============================================================================
// GET /products/:id/360
// ============================================================================
export interface Product360Base {
  id: string;
  sku_prefix: string;
  name_ar: string;
  name_en: string | null;
  description_ar: string | null;
  description_en: string | null;
  product_type: string;
  target_audience: string;
  category_id: string | null;
  category_name: string | null;
  brand_id: string | null;
  brand_name: string | null;
  base_cost: string | number;
  base_price: string | number | null;
  suggested_price: string | number | null;
  min_margin_pct: string | number | null;
  track_inventory: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Product360GroupSummary {
  group_id: string;
  name_ar: string;
  name_en: string | null;
  color: string | null;
}

export interface Product360Variant extends VariantGroupArrays {
  variant_id: string;
  sku: string;
  barcode: string | null;
  color_id: string | null;
  color_name: string | null;
  hex_code: string | null;
  size_id: string | null;
  size_label: string | null;
  size_sort: number | null;
  cost_price: string | number;
  selling_price: string | number;
  weight_grams: number | null;
  is_active: boolean;
  total_qty: number;
  total_reserved: number;
  total_available: number;
}

export interface Product360StockByWarehouse {
  variant_id: string;
  sku: string;
  warehouse_id: string;
  warehouse_name: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  available_quantity: number;
  reorder_point: number;
  avg_cost: string | number | null;
  updated_at: string;
}

export interface Product360Totals {
  total_qty: number;
  total_available: number;
  total_cost_value: number;
  total_sale_value: number;
  sold_qty_30d: number;
  sold_revenue_30d: number;
  sold_cost_30d: number;
  returned_qty_30d: number;
  gross_profit_30d: number;
}

export interface Product360Response {
  product: Product360Base;
  product_groups: Product360GroupSummary[];
  variants: Product360Variant[];
  stock_by_warehouse: Product360StockByWarehouse[];
  totals: Product360Totals;
  recent_movements: InventoryMovementRow[];
  recent_invoice_items: Array<{
    id: string;
    invoice_id: string;
    invoice_no: string;
    status: string;
    is_return: boolean;
    is_exchange: boolean;
    invoice_created_at: string;
    voided_at: string | null;
    variant_id: string;
    sku: string;
    quantity: number;
    unit_price: string | number;
    unit_cost: string | number;
    line_total: string | number;
  }>;
  recent_purchase_items: Array<{
    id: string;
    purchase_id: string;
    purchase_no: string;
    status: string;
    purchase_created_at: string;
    variant_id: string;
    sku: string;
    quantity: number;
    unit_cost: string | number;
    line_total: string | number;
    supplier_id: string | null;
    supplier_name: string | null;
  }>;
  price_history: Array<{
    id: number;
    variant_id: string;
    sku: string;
    old_selling_price: string | number;
    new_selling_price: string | number;
    source_purchase_id: string | null;
    source_purchase_no: string | null;
    reason: string | null;
    changed_at: string;
    changed_by: string | null;
    changed_by_username: string | null;
    changed_by_name: string | null;
  }>;
  cost_history: Array<{
    id: number;
    variant_id: string;
    sku: string;
    old_cost_price: string | number;
    new_cost_price: string | number;
    adjustment_type: string | null;
    adjustment_value: string | number | null;
    reason: string | null;
    source: string | null;
    batch_id: string | null;
    changed_at: string;
    changed_by: string | null;
    changed_by_username: string | null;
    changed_by_name: string | null;
  }>;
}

// ============================================================================
// GET /products/:id/matrix
// ============================================================================
export interface ProductMatrixColor {
  id: string;
  name_ar: string;
  name_en: string | null;
  hex_code: string | null;
}

export interface ProductMatrixSize {
  id: string;
  size_label: string;
  size_system: string;
  sort_order: number | null;
}

export interface ProductMatrixCellWarehouse {
  warehouse_id: string;
  warehouse_name: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  available_quantity: number;
}

export interface ProductMatrixCell extends VariantGroupArrays {
  variant_id: string;
  color_id: string | null;
  size_id: string | null;
  sku: string;
  barcode: string | null;
  cost_price: string | number;
  selling_price: string | number;
  is_active: boolean;
  total_qty: number;
  available_qty: number;
  per_warehouse: ProductMatrixCellWarehouse[];
}

export interface ProductMatrixResponse {
  product: {
    id: string;
    sku_prefix: string;
    name_ar: string;
    name_en: string | null;
  };
  colors: ProductMatrixColor[];
  sizes: ProductMatrixSize[];
  cells: ProductMatrixCell[];
}

// ============================================================================
// PR-INVENTORY-REPORTS — /inventory/reports/*
// ============================================================================
export interface ValuationFilters {
  branch_id?: string;
  warehouse_id?: string;
  group_id?: string;
  category_id?: string;
  brand_id?: string;
  search?: string;
}

export interface ValuationTotals {
  total_qty: number;
  total_available: number;
  total_cost_value: number;
  total_sale_value: number;
  potential_margin: number;
}

export interface ValuationRow {
  product_id: string;
  product_name: string;
  sku_prefix: string;
  variant_id: string;
  sku: string;
  color: string | null;
  size: string | null;
  warehouse_id: string;
  warehouse_name: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  available_quantity: number;
  cost_price: string | number;
  selling_price: string | number;
  avg_cost: string | number | null;
  stock_cost_value: string | number;
  stock_sale_value: string | number;
  potential_margin: string | number;
  group_ids: string[];
  group_names_ar: string[];
  group_colors: Array<string | null>;
}

export interface ValuationResponse {
  totals: ValuationTotals;
  items: ValuationRow[];
}

export interface LowStockFilters {
  branch_id?: string;
  warehouse_id?: string;
  group_id?: string;
  category_id?: string;
  brand_id?: string;
}

export interface LowStockRow {
  product_id: string;
  product_name: string;
  sku_prefix: string;
  variant_id: string;
  sku: string;
  color: string | null;
  size: string | null;
  warehouse_id: string;
  warehouse_name: string;
  quantity_on_hand: number;
  reorder_point: number;
  available_quantity: number;
  shortage_kind: 'low' | 'out';
  units_short: number;
}

export interface LowStockResponse {
  totals: { low_count: number; out_count: number; total_units_short: number };
  items: LowStockRow[];
}

export interface DeadStockFilters {
  branch_id?: string;
  warehouse_id?: string;
  group_id?: string;
  days?: number;
}

export interface DeadStockRow {
  product_id: string;
  product_name: string;
  sku_prefix: string;
  variant_id: string;
  sku: string;
  color: string | null;
  size: string | null;
  warehouse_id: string;
  warehouse_name: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  cost_price: string | number;
  stuck_cost_value: string | number;
  last_sale_at: string | null;
}

export interface DeadStockResponse {
  totals: {
    items_count: number;
    total_units: number;
    total_cost_value: number;
    days_window: number;
  };
  items: DeadStockRow[];
}

export interface ProfitabilityFilters {
  branch_id?: string;
  warehouse_id?: string;
  group_id?: string;
  date_from?: string;
  date_to?: string;
}

export interface ProfitabilityRow {
  product_id: string;
  product_name: string;
  sku_prefix: string;
  sold_qty: number;
  returned_qty: number;
  net_qty: number;
  sales_total: number;
  cogs_total: number;
  gross_profit: number;
  margin_pct: number;
}

export interface ProfitabilityResponse {
  totals: {
    sold_qty: number;
    returned_qty: number;
    net_qty: number;
    sales_total: number;
    cogs_total: number;
    gross_profit: number;
    margin_pct: number;
  };
  items: ProfitabilityRow[];
}

// ─── The client surface ─────────────────────────────────────────────
export const inventoryApi = {
  getDashboard: (params: InventoryDashboardFilters = {}) =>
    unwrap<InventoryDashboardResponse>(
      api.get('/inventory/dashboard', { params: cleanParams(params) }),
    ),

  getBalances: (params: InventoryBalancesFilters = {}) =>
    unwrap<PaginatedInventoryBalances>(
      api.get('/inventory/balances', { params: cleanParams(params) }),
    ),

  getMovements: (params: InventoryMovementsFilters = {}) =>
    unwrap<PaginatedInventoryMovements>(
      api.get('/inventory/movements', { params: cleanParams(params) }),
    ),

  getProduct360: (productId: string) =>
    unwrap<Product360Response>(api.get(`/products/${productId}/360`)),

  getProductMatrix: (productId: string) =>
    unwrap<ProductMatrixResponse>(api.get(`/products/${productId}/matrix`)),

  // PR-INVENTORY-REPORTS — read-only analytics endpoints.
  reportValuation: (params: ValuationFilters = {}) =>
    unwrap<ValuationResponse>(
      api.get('/inventory/reports/valuation', { params: cleanParams(params) }),
    ),
  reportLowStock: (params: LowStockFilters = {}) =>
    unwrap<LowStockResponse>(
      api.get('/inventory/reports/low-stock', { params: cleanParams(params) }),
    ),
  reportDeadStock: (params: DeadStockFilters = {}) =>
    unwrap<DeadStockResponse>(
      api.get('/inventory/reports/dead-stock', { params: cleanParams(params) }),
    ),
  reportProfitability: (params: ProfitabilityFilters = {}) =>
    unwrap<ProfitabilityResponse>(
      api.get('/inventory/reports/profitability', {
        params: cleanParams(params),
      }),
    ),
};

/**
 * Strip undefined / empty-string filter values so the server gets a
 * clean query string. Boolean `false` and numeric `0` are PRESERVED
 * (they're meaningful filter values). Exported for unit tests.
 *
 * Typed as `object` (rather than `Record<string, unknown>`) so the
 * specific filter interfaces above — which don't carry an index
 * signature — can be passed in without a cast at the call site.
 */
export function cleanParams<T extends object>(raw: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  return out as Partial<T>;
}
