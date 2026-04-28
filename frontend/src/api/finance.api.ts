/**
 * finance.api.ts — PR-FIN-2
 *
 * Typed client for the Financial Dashboard endpoint. Mirrors the
 * backend's `FinanceDashboardResponse` 1:1. Read-only.
 */

import { api, unwrap } from './client';

export type ConfidenceTier = 'High' | 'Medium' | 'Low' | 'N/A';

export interface DashboardFilters {
  from?: string;
  to?: string;
  cashbox_id?: string;
  payment_account_id?: string;
  user_id?: string;
  shift_id?: string;
}

export interface FinanceDashboard {
  range: { from: string; to: string };
  generated_at: string;
  filters_applied: DashboardFilters;

  // PR-FIN-2-HOTFIX-4 — split real cashbox-balance drift away from
  // per-reference labeling drift, plus carry the timestamp of the
  // most recent bypass alert so the UI can mark counts as historical.
  health: {
    trial_balance_imbalance: number;
    cashbox_balance_drift_count: number;
    cashbox_drift_total: number;
    cashbox_drift_count: number;
    engine_bypass_alerts_7d: number;
    engine_bypass_alerts_last_seen: string | null;
    unbalanced_entries_count: number;
    overall: 'healthy' | 'warning' | 'critical';
  };

  liquidity: {
    cashboxes_total: number;
    banks_total: number;
    wallets_total: number;
    cards_total: number;
    total_cash_equivalents: number;
  };

  // PR-FIN-2-HOTFIX-4 — both today's and the period's slices.
  daily_expenses: {
    today_total: number;
    today_count: number;
    today_largest: { category: string | null; amount: number } | null;
    period_total: number;
    period_count: number;
    period_largest: { category: string | null; amount: number } | null;
  };

  balances: {
    customers: {
      total_due: number;
      count: number;
      top: { name: string; amount: number } | null;
    };
    // PR-FIN-2-HOTFIX-4 — supplier card consults three sources
    // (suppliers.current_balance → GL 211 → unpaid purchases). The
    // UI renders a caption derived from these flags.
    suppliers: {
      total_due: number;
      count: number;
      top: { name: string; amount: number } | null;
      effective_source:
        | 'suppliers_table'
        | 'gl_211'
        | 'purchases'
        | 'mixed'
        | 'none';
      sources_checked: Array<'suppliers_table' | 'gl_211' | 'purchases'>;
    };
    employees: {
      total_owed_to: number;
      total_owed_by: number;
      net: number;
    };
  };

  profit: {
    sales_total: number;
    cogs_total: number;
    gross_profit: number;
    expenses_total: number;
    net_profit: number;
    margin_pct: number;
    delta_vs_previous: {
      sales_pct: number;
      cogs_pct: number;
      gross_pct: number;
      expenses_pct: number;
      net_pct: number;
      margin_pp: number;
    };
    best_customer: { name: string; profit: number } | null;
    best_supplier: { name: string; profit: number } | null;
    best_product: { name: string; profit: number } | null;
    confidence: ConfidenceTier;
    confidence_breakdown: {
      high_lines: number;
      medium_lines: number;
      low_lines: number;
    };
  };

  profit_trend: Array<{
    date: string;
    gross_profit: number;
    net_profit: number;
    cogs: number;
  }>;

  payment_channels: Array<{
    method_key: string;
    label_ar: string;
    sales: number;
    pct: number;
  }>;

  group_profits: Array<{
    group_id: string | null;
    label_ar: string;
    profit: number;
  }>;

  top_products: Array<{
    product_id: string;
    name_ar: string;
    sales: number;
    gross_profit: number;
    margin_pct: number;
  }>;

  profit_by_customer: Array<{
    customer_id: string;
    name_ar: string;
    sales: number;
    gross_profit: number;
    margin_pct: number;
    invoices_count: number;
  }>;

  profit_by_supplier: Array<{
    supplier_id: string;
    name_ar: string;
    sales: number;
    cost: number;
    gross_profit: number;
    margin_pct: number;
  }>;

  profit_by_department: Array<{
    department_id: string | null;
    name_ar: string;
    sales: number;
    gross_profit: number;
    margin_pct: number;
  }>;

  profit_by_shift: Array<{
    shift_id: string;
    opened_at: string;
    sales: number;
    cash_net: number;
    gross_profit: number;
    margin_pct: number;
  }>;

  profit_by_payment_method: Array<{
    method_key: string;
    label_ar: string;
    sales: number;
    fees_or_costs: number;
    net_collection: number;
    margin_pct: number;
  }>;

  cash_accounts: Array<{
    cashbox_id: string;
    name_ar: string;
    kind: 'cash' | 'bank' | 'ewallet' | 'check';
    opening_balance: number;
    inflow: number;
    outflow: number;
    current_balance: number;
    last_movement_at: string | null;
    status: 'active' | 'inactive';
  }>;

  recent_movements: Array<{
    occurred_at: string;
    user_name: string | null;
    operation_type: string;
    source_label: string;
    amount: number;
    status: 'active' | 'voided' | 'pending';
    journal_entry_no: string | null;
    drilldown_url: string | null;
  }>;

  alerts: Array<{
    type:
      | 'cashbox_drift'
      | 'payment_account'
      | 'employee_request'
      | 'expense_approval'
      | 'journal_entries'
      | 'engine_bypass';
    label_ar: string;
    severity: 'info' | 'warning' | 'critical';
    description: string;
    deeplink: string | null;
  }>;

  quick_reports: Array<{
    key: string;
    label_ar: string;
    available: boolean;
    href: string | null;
  }>;
}

export const financeApi = {
  dashboard: (filters: DashboardFilters = {}) =>
    unwrap<FinanceDashboard>(
      api.get('/finance/dashboard', { params: filters }),
    ),
};
