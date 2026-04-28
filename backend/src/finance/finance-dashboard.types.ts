/**
 * finance-dashboard.types.ts — PR-FIN-2
 * ────────────────────────────────────────────────────────────────────
 *
 * Shape of the unified `GET /finance/dashboard` response. Every field
 * is read-only — the dashboard never writes anywhere, never triggers
 * the FinancialEngine, never touches `expenses` / `journal_entries` /
 * `cashbox_transactions`. The contract is duplicated 1:1 on the
 * frontend so the typed client stays in sync without a code-gen
 * pipeline.
 */

export type ConfidenceTier = 'High' | 'Medium' | 'Low' | 'N/A';

export interface DashboardFilters {
  from?: string; // YYYY-MM-DD (inclusive)
  to?: string;   // YYYY-MM-DD (inclusive)
  cashbox_id?: string;
  payment_account_id?: string;
  user_id?: string;
  shift_id?: string;
}

export interface FinanceDashboardResponse {
  range: { from: string; to: string };
  generated_at: string;
  filters_applied: DashboardFilters;

  /**
   * PR-FIN-2-HOTFIX-4 — health card was conflating two distinct
   * invariants under "Cashbox Drift". Split into:
   *   · `cashbox_balance_drift_count` — REAL money drift
   *     (current_balance ≠ Σ cashbox_transactions per cashbox)
   *   · `cashbox_drift_count` / `cashbox_drift_total` — per-reference
   *     LABELING drift only (rows in v_cashbox_drift_per_ref where
   *     reference_type differs between CT and JE for the same event).
   *     This NEVER reflects missing money — the per-cashbox totals
   *     still match.
   * Plus `engine_bypass_alerts_last_seen` so the UI can mark the
   * 7-day count as historical when it's older than ~24h.
   */
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

  /**
   * PR-FIN-2-HOTFIX-4 — split daily expenses into "today" vs "period"
   * so the card reads معنى ("اليوم 0 / الفترة 3,821") instead of just
   * showing zeros when there are no expenses today.
   *   · `today_*` always uses Cairo today's date.
   *   · `period_*` uses the dashboard's `range` filter.
   */
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
    /**
     * PR-FIN-2-HOTFIX-4 — supplier balances now consult three
     * independent sources (in order of priority):
     *   1. `suppliers.current_balance` — the legacy sub-ledger field
     *   2. `journal_lines` summed on GL account 211 per supplier
     *   3. `purchases.grand_total - paid_amount` per supplier
     *
     * `effective_source` reports which source produced a non-zero
     * answer (or `'none'` when all three agree on zero).
     * `sources_checked` lists every source consulted so the UI
     * caption can be precise: "محسوب من سجل الموردين + GL 211 +
     * المشتريات غير المسدّدة".
     */
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
