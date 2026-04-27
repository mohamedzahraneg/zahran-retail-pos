import { api, unwrap } from './client';

export interface Salesperson {
  id: string;
  username: string;
  full_name: string;
  commission_rate: string;
  is_active: boolean;
  role_code: string;
  role_name: string;
}

export interface CommissionSummaryRow {
  user_id: string;
  full_name: string;
  username: string;
  commission_rate: string;
  invoices_count: string;
  eligible_sales: string;
  commission_amount: string;
}

export interface CommissionDetailRow {
  invoice_id: string;
  invoice_no: string;
  completed_at: string;
  customer_name: string | null;
  eligible_total: string;
  /** invoices.grand_total — for collection-ratio KPI on Overview */
  grand_total: string;
  /** invoices.paid_total — for collection-ratio KPI on Overview */
  paid_total: string;
  commission_rate: string;
  commission: string;
}

/**
 * One row per category contributing to a salesperson's eligible sales
 * in the window. `category_id = null` means the products lack
 * category_id (returned with the label "غير مصنّف"). Empty array =
 * no items in the window.
 */
export interface CommissionCategoryBreakdownRow {
  category_id: string | null;
  category_name: string;
  invoices_count: string;
  total: string;
}

export const commissionsApi = {
  listSalespeople: () =>
    unwrap<Salesperson[]>(api.get('/commissions/salespeople')),

  summary: (from: string, to: string) =>
    unwrap<CommissionSummaryRow[]>(
      api.get('/commissions/summary', { params: { from, to } }),
    ),

  detail: (userId: string, from: string, to: string) =>
    unwrap<CommissionDetailRow[]>(
      api.get(`/commissions/${userId}/detail`, { params: { from, to } }),
    ),

  /**
   * PR-ESS-2A — self-service commission detail. Same shape as `detail`
   * above but resolves user from JWT, so the employee can see their
   * own sales/commission rows on /me without the `accounting.view`
   * gate that scopes the rest of this controller. No IDOR.
   */
  myDetail: (from: string, to: string) =>
    unwrap<CommissionDetailRow[]>(
      api.get('/commissions/me/detail', { params: { from, to } }),
    ),

  categoryBreakdown: (userId: string, from: string, to: string) =>
    unwrap<CommissionCategoryBreakdownRow[]>(
      api.get(`/commissions/${userId}/category-breakdown`, {
        params: { from, to },
      }),
    ),

  updateRate: (userId: string, commission_rate: number) =>
    unwrap<{ user_id: string; commission_rate: number }>(
      api.patch(`/commissions/${userId}/rate`, { commission_rate }),
    ),

  getSellerSettings: (userId: string) =>
    unwrap<SellerSettings>(api.get(`/commissions/${userId}/seller-settings`)),

  updateSellerSettings: (
    userId: string,
    patch: SellerSettingsPatch,
  ) =>
    unwrap<SellerSettings>(
      api.patch(`/commissions/${userId}/seller-settings`, patch),
    ),
};

/**
 * PR-T4.6 — full seller settings row used by the EditProfile modal
 * + the Overview's target widgets.
 *   sales_target_period = 'none' (or null on legacy users) means the
 *   operator hasn't enabled the target system yet.
 *   commission_mode = 'general' is the default for legacy users (NULL
 *   in DB is coerced to 'general' by the backend's COALESCE).
 */
export type CommissionMode =
  | 'general'
  | 'after_target'
  | 'over_target'
  | 'general_plus_over_target';

export type SalesTargetPeriod = 'none' | 'daily' | 'weekly' | 'monthly';

export interface SellerSettings {
  user_id: string;
  is_salesperson: boolean | null;
  commission_rate: string;
  commission_mode: CommissionMode;
  sales_target_period: SalesTargetPeriod;
  sales_target_amount: string | null;
  commission_after_target_rate: string | null;
  over_target_commission_rate: string | null;
  effective_from: string | null;
}

export interface SellerSettingsPatch {
  is_salesperson?: boolean | null;
  commission_rate?: number;
  commission_mode?: CommissionMode;
  sales_target_period?: SalesTargetPeriod;
  sales_target_amount?: number | null;
  commission_after_target_rate?: number | null;
  over_target_commission_rate?: number | null;
  effective_from?: string | null;
}
