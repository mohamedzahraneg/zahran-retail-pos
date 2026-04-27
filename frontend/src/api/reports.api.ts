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
