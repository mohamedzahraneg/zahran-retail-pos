import { api, unwrap } from './client';

export interface ReturnsSummary {
  total_count: number;
  total_net_refund: string | number;
  count_30d: number;
  net_refund_30d: string | number;
  count_90d: number;
  net_refund_90d: string | number;
  pending_count: number;
  pending_amount: string | number;
  return_rate_30d: string | number;
}

export interface ReturnsByReason {
  reason: string;
  return_count: number;
  qty: number;
  net_refund: string | number;
  avg_refund: string | number;
}

export interface ReturnsTopProduct {
  variant_id: string;
  product_id: string;
  name_ar: string;
  sku: string;
  returned_qty: number;
  sold_qty: number;
  refund_total: string | number;
  return_count: number;
  return_rate_pct: string | number;
}

export interface ReturnsTrend {
  month?: string;
  day?: string;
  return_count: number;
  qty: number;
  net_refund: string | number;
}

export interface ReturnsByCondition {
  condition: 'resellable' | 'damaged' | 'defective';
  line_count: number;
  qty: number;
  refund_total: string | number;
  pct_of_total: string | number;
}

export interface ReturnsWidget {
  count_30d: number;
  refund_30d: string | number;
  pending_count: number;
  top_reasons: Array<{ reason: string; cnt: number }>;
  top_products: Array<{ name_ar: string; sku: string; returned_qty: number }>;
}

export interface ReturnsAnalyticsAll {
  summary: ReturnsSummary;
  byReason: ReturnsByReason[];
  topProducts: ReturnsTopProduct[];
  trendMonthly: ReturnsTrend[];
  trendDaily: ReturnsTrend[];
  byCondition: ReturnsByCondition[];
}

export const returnsAnalyticsApi = {
  all: () => unwrap(api.get<ReturnsAnalyticsAll>('/returns/analytics')),
  summary: () => unwrap(api.get<ReturnsSummary>('/returns/analytics/summary')),
  byReason: () =>
    unwrap(api.get<ReturnsByReason[]>('/returns/analytics/by-reason')),
  topProducts: (limit = 20) =>
    unwrap(
      api.get<ReturnsTopProduct[]>('/returns/analytics/top-products', {
        params: { limit },
      }),
    ),
  trend: (granularity: 'daily' | 'monthly' = 'monthly') =>
    unwrap(
      api.get<ReturnsTrend[]>('/returns/analytics/trend', {
        params: { granularity },
      }),
    ),
  byCondition: () =>
    unwrap(api.get<ReturnsByCondition[]>('/returns/analytics/by-condition')),
  widget: () => unwrap(api.get<ReturnsWidget>('/returns/analytics/widget')),
};

export const REASON_LABELS_AR: Record<string, string> = {
  defective: 'عيب مصنعي',
  wrong_size: 'مقاس خاطئ',
  wrong_color: 'لون خاطئ',
  customer_changed_mind: 'العميل غيّر رأيه',
  not_as_described: 'غير مطابق للوصف',
  other: 'أخرى',
};

export const CONDITION_LABELS_AR: Record<string, string> = {
  resellable: 'قابل لإعادة البيع',
  damaged: 'تالف',
  defective: 'معيوب',
};
