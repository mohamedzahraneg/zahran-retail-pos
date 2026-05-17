import { api, unwrap } from './client';

export interface Product {
  id: string;
  /** Server auto-generates when blank. */
  sku_root?: string;
  name_ar: string;
  name_en?: string;
  type: 'shoe' | 'bag' | 'accessory';
  base_price: number;
  cost_price: number;
  is_active: boolean;
  created_at: string;
  category_id?: string | null;
  brand_id?: string | null;
  supplier_id?: string | null;
  uom?: string;
  primary_image_url?: string | null;
  description?: string | null;
  /** Aggregated across variants (current warehouse or all warehouses). */
  total_stock?: number;
  stock_value?: number;
  variants_count?: number;
}

export interface ColorOption {
  id: string;
  name_ar: string;
  name_en: string | null;
  hex_code: string | null;
}

export interface SizeOption {
  id: string;
  size_label: string;
  size_system: string;
  sort_order: number;
}

export interface Variant {
  id: string;
  product_id: string;
  /** Server auto-generates when blank. */
  sku?: string;
  barcode?: string | null;
  color?: string | null;
  color_id?: string | null;
  size?: string | null;
  size_id?: string | null;
  cost_price?: number | string;
  selling_price?: number | string;
  price_override?: number | null;
  image_url?: string | null;
}

export const productsApi = {
  list: (params?: {
    type?: string;
    q?: string;
    page?: number;
    limit?: number;
    warehouse_id?: string;
    category_id?: string;
    active?: boolean;
  }) => unwrap<{ data: Product[]; meta: any }>(api.get('/products', { params })),

  get: (id: string) => unwrap<Product & { variants: Variant[] }>(api.get(`/products/${id}`)),

  /**
   * PR-POS-STOCK-1 — When `warehouse_id` is supplied the backend
   * LEFT JOINs the `stock` table for that warehouse and returns
   * `available_stock` (= `quantity_on_hand` for this variant in the
   * caller's warehouse, or `0` if no stock row exists). Without the
   * param the response shape stays exactly as it was before — no
   * downstream caller has to change.
   */
  byBarcode: (code: string, opts?: { warehouse_id?: string }) =>
    unwrap<{
      product: Product;
      variant: Variant;
      available_stock?: number;
    }>(
      api.get(`/products/barcode/${code}`, {
        params: opts?.warehouse_id ? { warehouse_id: opts.warehouse_id } : undefined,
      }),
    ),

  create: (body: Partial<Product>) =>
    unwrap<Product>(api.post('/products', body)),

  update: (id: string, body: Partial<Product>) =>
    unwrap<Product>(api.patch(`/products/${id}`, body)),

  remove: (id: string) => unwrap<void>(api.delete(`/products/${id}`)),

  // Variants CRUD
  addVariant: (body: Partial<Variant> & { product_id: string; sku: string }) =>
    unwrap<Variant>(api.post('/products/variants', body)),

  updateVariant: (id: string, body: Partial<Variant>) =>
    unwrap<Variant>(api.patch(`/products/variants/${id}`, body)),

  removeVariant: (id: string) =>
    unwrap<{ archived: boolean }>(api.delete(`/products/variants/${id}`)),

  // Master lists
  colors: () => unwrap<ColorOption[]>(api.get('/products/catalog/colors')),
  sizes: () => unwrap<SizeOption[]>(api.get('/products/catalog/sizes')),

  /** Preview the next product SKU the DB trigger would assign. */
  nextProductSku: (type: string) =>
    unwrap<{ sku: string }>(
      api.get('/products/catalog/next-sku', { params: { type } }),
    ),

  /** Preview the variant SKU for a given product + color + size combo. */
  nextVariantSku: (product_id: string, color_id: string, size_id?: string) =>
    unwrap<{ sku: string }>(
      api.get('/products/catalog/next-variant-sku', {
        params: { product_id, color_id, size_id: size_id || undefined },
      }),
    ),

  // ─── PR-PURCHASES-P3.2 — manual apply suggested sale price ───────────
  // Pricing-only endpoint. Updates product_variants.selling_price and
  // inserts a variant_price_history audit row per change. Never touches
  // accounting / cashbox / stock / POS lines.
  applyVariantPrices: (body: ApplyVariantPricesPayload) =>
    unwrap<ApplyVariantPricesResponse>(
      api.post('/products/variants/apply-prices', body),
    ),

  // ─── PR-PURCHASES-P3.5A — Smart Bulk Pricing Assistant ───────────────
  // Preview is read-only. Apply mutates ONLY product_variants.selling_price
  // + inserts variant_price_history audit rows. Cost adjustment is
  // explicitly deferred to P3.5B.
  // HOTFIX P3.5A.1 timeout — smart-pricing preview can take longer than
  // the 30s global axios default when the operator widens the scope.
  // The server hard-caps at 1000 rows and surfaces truncation metadata,
  // so 60s is a comfortable client deadline. Apply uses the same window
  // because it re-runs the preview server-side.
  smartPricingPreview: (body: SmartPricingPreviewPayload) =>
    unwrap<SmartPricingPreviewResponse>(
      api.post('/products/variants/smart-pricing/preview', body, {
        timeout: 60_000,
      }),
    ),
  smartPricingApply: (body: SmartPricingApplyPayload) =>
    unwrap<SmartPricingApplyResponse>(
      api.post('/products/variants/smart-pricing/apply', body, {
        timeout: 60_000,
      }),
    ),
};

// PR-PURCHASES-P3.2 — wire types for the apply-prices payload + response.
export interface ApplyVariantPriceItem {
  variant_id: string;
  new_selling_price: number;
}

export interface ApplyVariantPricesPayload {
  source_purchase_id?: string;
  reason?: string;
  items: ApplyVariantPriceItem[];
}

export interface ApplyVariantPricesResultItem {
  variant_id: string;
  old_selling_price: number;
  new_selling_price: number;
  history_id: string | null;
  skipped: boolean;
}

export interface ApplyVariantPricesResponse {
  updated: number;
  skipped: number;
  items: ApplyVariantPricesResultItem[];
}

// ─── PR-PURCHASES-P3.5A — Smart Bulk Pricing Assistant types ─────────
export type SmartPricingStrategy =
  | 'conservative'
  | 'balanced'
  | 'aggressive'
  | 'clearance';

export type SmartPricingScopeType =
  | 'selected'
  | 'filtered'
  | 'all'
  | 'single';

export type SmartPricingStatusFilter =
  | 'below_cost'
  | 'below_min_margin'
  | 'ok'
  | 'unknown_cost';

export type SmartPricingRecommendation =
  | 'increase'
  | 'decrease'
  | 'keep'
  | 'review';

export type SmartPricingWarning =
  | 'below_cost_at_current'
  | 'below_cost_after_change'
  | 'below_min_margin_after_change'
  | 'large_increase'
  | 'large_decrease'
  | 'missing_cost'
  | 'no_stock'
  | 'no_stock_alt'
  | 'slow_moving'
  | 'high_stock';

// ─── PR-PURCHASES-P3.5A.1 — Manual Bulk Sale Price Adjustment ────────
export type SmartPricingMode = 'smart' | 'manual';
export type ManualAdjustmentOperation =
  | 'increase_percent'
  | 'decrease_percent'
  | 'increase_amount'
  | 'decrease_amount'
  | 'set_price';

export interface ManualAdjustment {
  operation: ManualAdjustmentOperation;
  value: number;
}

export interface SmartPricingScope {
  type: SmartPricingScopeType;
  variant_ids?: string[];
  filters?: {
    q?: string;
    status?: SmartPricingStatusFilter;
    only_in_stock?: boolean;
    supplier_id?: string;
    needs_review_only?: boolean;
  };
}

export interface SmartPricingPreviewPayload {
  scope: SmartPricingScope;
  strategy: SmartPricingStrategy;
  /** P3.5A.1 — defaults to 'smart' on the server. */
  mode?: SmartPricingMode;
  /** Required when mode === 'manual'. */
  manual_adjustment?: ManualAdjustment;
  limit?: number;
}

export interface SmartPricingApplyPayload {
  scope: SmartPricingScope;
  strategy: SmartPricingStrategy;
  /** P3.5A.1 — defaults to 'smart' on the server. */
  mode?: SmartPricingMode;
  /** Required when mode === 'manual'. */
  manual_adjustment?: ManualAdjustment;
  variant_ids_to_apply?: string[];
  reason: string;
  confirm_all?: string;
}

export interface SmartPricingItem {
  variant_id: string;
  product_id: string;
  product_name: string;
  sku: string;
  barcode: string | null;
  color: string | null;
  size: string | null;
  current_cost: number;
  current_price: number;
  stock_qty: number;
  qty_sold: number;
  invoice_count: number;
  last_sold_at: string | null;
  current_margin_pct: number | null;
  current_markup_pct: number | null;
  min_margin_pct: number;
  recommendation: SmartPricingRecommendation;
  suggested_selling_price: number | null;
  expected_profit_delta_per_unit: number | null;
  final_margin_pct?: number | null;
  final_markup_pct?: number | null;
  reason_ar: string;
  warnings: SmartPricingWarning[];
  skipped_reason: string | null;
}

export interface SmartPricingPreviewResponse {
  strategy: SmartPricingStrategy;
  scope_type: SmartPricingScopeType;
  mode?: SmartPricingMode;
  manual_adjustment?: ManualAdjustment | null;
  /** HOTFIX P3.5A.1 timeout — truncation metadata. When `truncated`
   *  is true the preview only included the first `returned_count` of
   *  `total_candidates`; `message_ar` is a ready-to-render Arabic
   *  notice the operator should see. */
  truncated?: boolean;
  total_candidates?: number;
  returned_count?: number;
  limit?: number;
  message_ar?: string | null;
  settings: {
    competitive_markup_pct: number;
    recommended_margin_pct: number;
    high_margin_pct: number;
    wholesale_markup_pct: number;
    min_margin_pct_default: number;
    rounding_step: 1 | 5 | 10 | 25 | 50;
    rounding_mode: 'nearest' | 'floor' | 'ceil';
  };
  summary: {
    total: number;
    increase: number;
    decrease: number;
    keep: number;
    review: number;
  };
  items: SmartPricingItem[];
}

export interface SmartPricingApplyResultItem {
  variant_id: string;
  old_selling_price: number;
  new_selling_price: number;
  recommendation: SmartPricingRecommendation;
  history_id: string | null;
}

export interface SmartPricingApplyResponse {
  strategy: SmartPricingStrategy;
  scope_type: SmartPricingScopeType;
  mode?: SmartPricingMode;
  updated: number;
  skipped: number;
  items: SmartPricingApplyResultItem[];
}
