import { api, unwrap } from './client';

export interface DateRange {
  from?: string;
  to?: string;
}

export interface SalesRow {
  period: string;
  invoices_count: number;
  revenue: string;
  collected: string;
  discounts: string;
  avg_ticket: string;
}

export interface SalesPerUserRow {
  id: string;
  full_name: string;
  username: string;
  invoices_count: number;
  revenue: string;
  avg_ticket: string;
  discounts: string;
}

export interface ProfitRow {
  day: string;
  revenue: string;
  cogs: string;
  gross_profit: string;
  allocated_expenses: string;
  net_profit: string;
  margin_pct: string;
}

export interface TopProductRow {
  product_id: string;
  product_name: string;
  sku_root: string;
  units_sold: number;
  revenue: string;
  cogs: string;
  profit: string;
}

export interface ReturnRow {
  id: string;
  return_no: string;
  status: string;
  reason: string;
  total_refund: string;
  net_refund: string;
  requested_at: string;
  refunded_at: string | null;
  invoice_no: string | null;
  customer_name: string | null;
}

async function download(endpoint: string, params: Record<string, any>, filename: string) {
  const res = await api.get(endpoint, {
    params,
    responseType: 'blob',
  });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* PR-REPORTS-2 — same response shape as `dashboardApi.paymentChannels`,
 * extended with the active filter set so the channels report can
 * mirror the all-shifts report. The dashboard widget keeps using the
 * date-only `/dashboard/payment-channels` endpoint untouched. */
export interface PaymentChannelAccountRow {
  payment_account_id: string | null;
  display_name: string | null;
  identifier: string | null;
  provider_key: string | null;
  total_amount: number;
  invoice_count: number;
  payment_count: number;
  share_pct: number;
}
export interface PaymentChannelMethodRow {
  method: string;
  method_label_ar: string;
  total_amount: number;
  invoice_count: number;
  payment_count: number;
  share_pct: number;
  accounts: PaymentChannelAccountRow[];
}
export interface PaymentChannelsReport {
  range: { from: string; to: string };
  filters: {
    cashbox_id: string | null;
    user_id: string | null;
    status: string | null;
  };
  cash_total: number;
  non_cash_total: number;
  grand_total: number;
  channels: PaymentChannelMethodRow[];
}

export const reportsApi = {
  /** PR-REPORTS-2 — payment-method/account roll-up with full filter set. */
  paymentChannels: (params: {
    from?: string;
    to?: string;
    cashbox_id?: string;
    user_id?: string;
    status?: string;
  }) =>
    unwrap<PaymentChannelsReport>(
      api.get('/reports/payment-channels', {
        params: {
          from: params.from || undefined,
          to: params.to || undefined,
          cashbox_id: params.cashbox_id || undefined,
          user_id: params.user_id || undefined,
          status:
            params.status && params.status !== 'all' ? params.status : undefined,
        },
      }),
    ),

  sales: (params: DateRange & { group_by?: 'day' | 'week' | 'month' }) =>
    unwrap<SalesRow[]>(api.get('/reports/sales', { params })),

  salesPerUser: (params: DateRange) =>
    unwrap<SalesPerUserRow[]>(api.get('/reports/sales-per-user', { params })),

  profit: (params: DateRange) =>
    unwrap<ProfitRow[]>(api.get('/reports/profit', { params })),

  topProducts: (params: DateRange) =>
    unwrap<TopProductRow[]>(api.get('/reports/top-products', { params })),

  stockValuation: () =>
    unwrap<any[]>(api.get('/reports/stock-valuation')),

  lowStock: () => unwrap<any[]>(api.get('/reports/low-stock')),

  deadStock: () => unwrap<any[]>(api.get('/reports/dead-stock')),

  profitMargin: () => unwrap<any[]>(api.get('/reports/profit-margin')),

  comparePeriods: (params: {
    from_a: string;
    to_a: string;
    from_b: string;
    to_b: string;
  }) =>
    unwrap<{
      period_a: { from: string; to: string; gross: string; net: string; invoices: number };
      period_b: { from: string; to: string; gross: string; net: string; invoices: number };
      change: {
        gross_pct: number | null;
        net_pct: number | null;
        invoices_pct: number | null;
      };
    }>(api.get('/reports/compare-periods', { params })),

  salesDaily: (params: { from: string; to: string }) =>
    unwrap<
      Array<{
        day: string;
        invoice_count: number;
        gross_sales: string;
        vat: string;
        discounts: string;
        net_sales: string;
      }>
    >(api.get('/reports/sales-daily', { params })),

  returns: (params: DateRange) =>
    unwrap<ReturnRow[]>(api.get('/reports/returns', { params })),

  customersOutstanding: () =>
    unwrap<any[]>(api.get('/reports/customers-outstanding')),

  suppliersOutstanding: () =>
    unwrap<any[]>(api.get('/reports/suppliers-outstanding')),

  // PR-PURCHASES-P3.4A — pricing reports (read-only).
  pricingHealth: (params: {
    q?: string;
    status?: PricingStatus;
    only_in_stock?: boolean;
    limit?: number;
  } = {}) =>
    unwrap<PricingHealthResponse>(
      api.get('/reports/pricing/health', { params }),
    ),
  pricingLosses: (
    params: { only_in_stock?: boolean; limit?: number } = {},
  ) =>
    unwrap<PricingLossesResponse>(
      api.get('/reports/pricing/losses', { params }),
    ),
  pricingHistory: (
    params: {
      variant_id?: string;
      from?: string;
      to?: string;
      limit?: number;
    } = {},
  ) =>
    unwrap<PricingHistoryResponse>(
      api.get('/reports/pricing/history', { params }),
    ),
  pricingLandedImpact: (
    params: {
      supplier_id?: string;
      needs_review_only?: boolean;
      limit?: number;
    } = {},
  ) =>
    unwrap<PricingLandedImpactResponse>(
      api.get('/reports/pricing/landed-impact', { params }),
    ),

  // PR-PURCHASES-P3.4B — sold-profit reports (read-only, gross sales).
  soldProfitSummary: (params: { from?: string; to?: string } = {}) =>
    unwrap<SoldProfitSummary>(
      api.get('/reports/pricing/sold-profit/summary', { params }),
    ),
  soldProfitProducts: (
    params: {
      q?: string;
      from?: string;
      to?: string;
      status?: SoldProfitStatus;
      limit?: number;
      sort?: SoldProfitSort;
    } = {},
  ) =>
    unwrap<SoldProfitProductsResponse>(
      api.get('/reports/pricing/sold-profit/products', { params }),
    ),
  soldProfitInvoices: (
    params: {
      q?: string;
      from?: string;
      to?: string;
      status?: SoldProfitStatus;
      limit?: number;
    } = {},
  ) =>
    unwrap<SoldProfitInvoicesResponse>(
      api.get('/reports/pricing/sold-profit/invoices', { params }),
    ),

  // P3.4D — net-of-returns sold-profit reports (read-only).
  // Returns are attributed to `refunded_at`, not the original sale date.
  // Gross helpers above remain unchanged.
  soldProfitNetSummary: (params: { from?: string; to?: string } = {}) =>
    unwrap<SoldProfitNetSummary>(
      api.get('/reports/pricing/sold-profit/net-summary', { params }),
    ),
  soldProfitNetProducts: (
    params: {
      q?: string;
      from?: string;
      to?: string;
      status?: SoldProfitNetStatus;
      limit?: number;
    } = {},
  ) =>
    unwrap<SoldProfitNetProductsResponse>(
      api.get('/reports/pricing/sold-profit/net-products', { params }),
    ),

  export: (
    slug: string,
    format: 'xlsx' | 'pdf',
    params: Record<string, any> = {},
  ) =>
    download(
      `/reports/${slug}`,
      { ...params, format },
      `${slug}-${new Date().toISOString().slice(0, 10)}.${format}`,
    ),
};

// ─── PR-PURCHASES-P3.4A — pricing report response types ────────────
export type PricingStatus =
  | 'ok'
  | 'below_min_margin'
  | 'below_cost'
  | 'no_price'
  | 'unknown_cost';

export interface PricingHealthRow {
  variant_id: string;
  product_id: string;
  product_name: string;
  product_type: string;
  sku: string;
  barcode: string | null;
  color: string | null;
  size: string | null;
  cost_price: number;
  selling_price: number;
  profit: number;
  markup_pct: number | null;
  margin_pct: number | null;
  min_margin_pct: number;
  status: PricingStatus;
  stock_qty: number;
  stock_value_at_cost: number;
  potential_revenue: number;
  potential_profit: number;
}

export interface PricingHealthResponse {
  summary: {
    total_variants: number;
    below_cost: number;
    below_min_margin: number;
    no_price: number;
    unknown_cost: number;
    ok: number;
    stock_value_at_cost: number;
    potential_revenue: number;
    potential_profit: number;
  };
  items: PricingHealthRow[];
}

export interface PricingLossRow extends PricingHealthRow {
  loss_exposure: number;
  margin_gap_pct: number | null;
}

export interface PricingLossesResponse {
  summary: {
    below_cost: number;
    below_min_margin: number;
    total_loss_exposure: number;
  };
  items: PricingLossRow[];
}

export interface PricingHistoryRow {
  id: string;
  variant_id: string;
  product_id: string;
  product_name: string;
  sku: string;
  barcode: string | null;
  old_selling_price: string;
  new_selling_price: string;
  delta_amount: string;
  delta_pct: string | null;
  source_purchase_id: string | null;
  source_purchase_no: string | null;
  reason: string | null;
  changed_by: string | null;
  changed_by_name: string | null;
  changed_at: string;
}

export interface PricingHistoryResponse {
  summary: { total: number; last_change: string | null };
  items: PricingHistoryRow[];
}

export interface PricingLandedImpactRow {
  variant_id: string;
  product_id: string;
  product_name: string;
  sku: string;
  barcode: string | null;
  last_purchase: {
    purchase_id: string;
    purchase_no: string;
    supplier_id: string | null;
    supplier_name: string | null;
    received_at: string | null;
    invoice_date: string | null;
    manual_allocation: boolean;
  };
  base_unit_cost: number;
  allocated_cost_per_unit: number;
  landed_unit_cost: number;
  current_selling_price: number;
  profit: number;
  markup_pct: number | null;
  margin_pct: number | null;
  min_margin_pct: number;
  needs_review: boolean;
  needs_review_reason:
    | 'no_price'
    | 'below_cost'
    | 'below_min_margin'
    | null;
}

export interface PricingLandedImpactResponse {
  summary: { total: number; needs_review: number };
  items: PricingLandedImpactRow[];
}

// ─── PR-PURCHASES-P3.4B — sold-profit response types ──────────────
export type SoldProfitStatus = 'ok' | 'loss' | 'low_margin' | 'unknown_cost';
export type SoldProfitSort =
  | 'gross_profit_desc'
  | 'gross_profit_asc'
  | 'margin_desc'
  | 'margin_asc'
  | 'qty_desc';

export interface SoldProfitSummary {
  from: string | null;
  to: string | null;
  total_revenue: number;
  total_cogs: number;
  gross_profit: number;
  gross_margin_pct: number | null;
  markup_pct: number | null;
  total_qty_sold: number;
  invoice_count: number;
  product_count: number;
  variant_count: number;
  avg_profit_per_unit: number | null;
  top_profit_product: {
    product_id: string;
    product_name: string;
    gross_profit: number;
  } | null;
  worst_margin_product: {
    product_id: string;
    product_name: string;
    gross_profit: number;
    gross_margin_pct: number | null;
  } | null;
}

export interface SoldProfitProductRow {
  variant_id: string;
  product_id: string;
  product_name: string;
  sku: string;
  barcode: string | null;
  color: string | null;
  size: string | null;
  qty_sold: number;
  revenue: number;
  cogs: number;
  gross_profit: number;
  gross_margin_pct: number | null;
  markup_pct: number | null;
  avg_selling_price: number | null;
  avg_unit_cost: number | null;
  invoice_count: number;
  last_sold_at: string | null;
  status: SoldProfitStatus;
  min_margin_pct: number;
}

export interface SoldProfitProductsResponse {
  summary: {
    total: number;
    loss: number;
    low_margin: number;
    unknown_cost: number;
    ok: number;
  };
  items: SoldProfitProductRow[];
}

export interface SoldProfitInvoiceRow {
  invoice_id: string;
  invoice_no: string;
  sold_at: string;
  customer_id: string | null;
  customer_name: string | null;
  invoice_status: string;
  item_count: number;
  qty_sold: number;
  revenue: number;
  cogs: number;
  gross_profit: number;
  gross_margin_pct: number | null;
  markup_pct: number | null;
  status: SoldProfitStatus;
  min_margin_pct: number;
}

export interface SoldProfitInvoicesResponse {
  summary: {
    total: number;
    revenue: number;
    cogs: number;
    gross_profit: number;
    loss: number;
    low_margin: number;
  };
  items: SoldProfitInvoiceRow[];
}

// ─── P3.4D — Net-of-returns response types ────────────────────────
export type SoldProfitNetStatus = 'ok' | 'loss' | 'low_margin' | 'unknown';

export interface SoldProfitNetSummary {
  from: string | null;
  to: string | null;
  gross_revenue: number;
  gross_cogs: number;
  gross_profit: number;
  qty_sold: number;
  invoice_count: number;
  returns_revenue: number;
  returns_cogs: number;
  returns_profit_reversal: number;
  qty_returned: number;
  return_count: number;
  net_revenue: number;
  net_cogs: number;
  net_profit: number;
  net_margin_pct: number | null;
  net_markup_pct: number | null;
}

export interface SoldProfitNetProductRow {
  variant_id: string;
  product_id: string;
  product_name: string;
  sku: string;
  barcode: string | null;
  color: string | null;
  size: string | null;
  qty_sold: number;
  qty_returned: number;
  qty_net: number;
  sales_revenue: number;
  returns_revenue: number;
  net_revenue: number;
  sales_cogs: number;
  returns_cogs: number;
  net_cogs: number;
  invoice_count: number;
  return_count: number;
  last_sold_at: string | null;
  last_returned_at: string | null;
  net_profit: number;
  net_margin_pct: number | null;
  net_markup_pct: number | null;
  min_margin_pct: number;
  status: SoldProfitNetStatus;
}

export interface SoldProfitNetProductsResponse {
  from: string | null;
  to: string | null;
  summary: {
    total: number;
    net_revenue: number;
    net_cogs: number;
    net_profit: number;
    loss: number;
    low_margin: number;
    unknown: number;
    ok: number;
  };
  items: SoldProfitNetProductRow[];
}
