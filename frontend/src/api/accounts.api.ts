import { api, unwrap } from './client';

export type AccountType =
  | 'asset'
  | 'liability'
  | 'equity'
  | 'revenue'
  | 'expense';
export type NormalBalance = 'debit' | 'credit';

export interface Account {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  account_type: AccountType;
  normal_balance: NormalBalance;
  parent_id: string | null;
  is_leaf: boolean;
  is_system: boolean;
  is_active: boolean;
  description: string | null;
  level: number;
  sort_order: number;
  cashbox_id: string | null;
  cashbox_name: string | null;
  balance: string | number;
  total_debit: string | number;
  total_credit: string | number;
}

export interface TrialBalanceRow {
  id: string;
  code: string;
  name_ar: string;
  account_type: AccountType;
  normal_balance: NormalBalance;
  total_debit: string;
  total_credit: string;
  balance: string;
}

export interface JournalLine {
  id: string;
  entry_id: string;
  line_no: number;
  account_id: string;
  account_code: string | null;
  account_name: string | null;
  debit: string;
  credit: string;
  description: string | null;
  cashbox_id: string | null;
  cashbox_name: string | null;
  warehouse_id: string | null;
  warehouse_name: string | null;
  created_at: string;
}

export interface JournalEntry {
  id: string;
  entry_no: string;
  entry_date: string;
  description: string | null;
  reference_type: string | null;
  reference_id: string | null;
  is_posted: boolean;
  is_void: boolean;
  void_reason: string | null;
  reversal_of: string | null;
  posted_at: string | null;
  voided_at: string | null;
  created_at: string;
  created_by_name: string | null;
  posted_by_name?: string | null;
  voided_by_name?: string | null;
  total_debit?: string;
  total_credit?: string;
  lines?: JournalLine[];
}

export interface CreateAccountPayload {
  code: string;
  name_ar: string;
  name_en?: string;
  account_type: AccountType;
  normal_balance?: NormalBalance;
  parent_id?: string;
  description?: string;
  cashbox_id?: string;
}

export interface UpdateAccountPayload {
  name_ar?: string;
  name_en?: string;
  description?: string;
  is_active?: boolean;
  cashbox_id?: string | null;
  sort_order?: number;
}

export interface CreateJournalPayload {
  entry_date: string;
  description?: string;
  reference_type?: string;
  reference_id?: string;
  post_immediately?: boolean;
  lines: Array<{
    account_id: string;
    debit?: number;
    credit?: number;
    description?: string;
    cashbox_id?: string;
    warehouse_id?: string;
  }>;
}

export const accountsApi = {
  // Chart of Accounts
  list: (includeInactive = false) =>
    unwrap<Account[]>(
      api.get('/accounts/chart', {
        params: includeInactive ? { include_inactive: 'true' } : undefined,
      }),
    ),
  trialBalance: () =>
    unwrap<TrialBalanceRow[]>(api.get('/accounts/chart/trial-balance')),
  get: (id: string) => unwrap<Account>(api.get(`/accounts/chart/${id}`)),
  create: (payload: CreateAccountPayload) =>
    unwrap<Account>(api.post('/accounts/chart', payload)),
  update: (id: string, payload: UpdateAccountPayload) =>
    unwrap<Account>(api.patch(`/accounts/chart/${id}`, payload)),
  remove: (id: string) =>
    unwrap<{ deleted: boolean }>(api.delete(`/accounts/chart/${id}`)),

  // Journal Entries
  listJournal: (params?: {
    from?: string;
    to?: string;
    is_posted?: boolean;
    is_void?: boolean;
    reference_type?: string;
    account_id?: string;
    limit?: number;
    offset?: number;
  }) =>
    unwrap<JournalEntry[]>(api.get('/accounts/journal', { params })),
  getJournal: (id: string) =>
    unwrap<JournalEntry>(api.get(`/accounts/journal/${id}`)),
  createJournal: (payload: CreateJournalPayload) =>
    unwrap<JournalEntry>(api.post('/accounts/journal', payload)),
  voidJournal: (id: string, reason: string) =>
    unwrap<JournalEntry | { deleted: boolean }>(
      api.post(`/accounts/journal/${id}/void`, { reason }),
    ),

  /** One-click backfill: post GL entries for every historical event that
   *  doesn't have one yet. Idempotent — safe to re-run. */
  backfill: (params?: { since?: string }) =>
    unwrap<
      Record<string, { found: number; posted: number }>
    >(api.post('/accounts/journal/backfill', params || {})),

  // ── Reports ─────────────────────────────────────────────────────────

  accountLedger: (accountId: string, params?: { from?: string; to?: string }) =>
    unwrap<AccountLedger>(
      api.get(`/accounts/chart/${accountId}/ledger`, { params }),
    ),

  incomeStatement: (params: { from: string; to: string }) =>
    unwrap<IncomeStatement>(
      api.get('/accounts/reports/income-statement', { params }),
    ),

  balanceSheet: (params: { as_of: string }) =>
    unwrap<BalanceSheet>(
      api.get('/accounts/reports/balance-sheet', { params }),
    ),

  aging: (params: { type: 'receivable' | 'payable'; as_of?: string }) =>
    unwrap<AgingReport>(
      api.get('/accounts/reports/aging', { params }),
    ),

  customerLedger: (customerId: string, params?: { from?: string; to?: string }) =>
    unwrap<PartyLedger>(
      api.get(`/accounts/reports/customer-ledger/${customerId}`, { params }),
    ),

  supplierLedger: (supplierId: string, params?: { from?: string; to?: string }) =>
    unwrap<PartyLedger>(
      api.get(`/accounts/reports/supplier-ledger/${supplierId}`, { params }),
    ),

  closeYear: (fiscal_year_end: string) =>
    unwrap<any>(api.post('/accounts/close-year', { fiscal_year_end })),

  runDepreciation: () =>
    unwrap<{ posted_count: number; schedule_ids: string[] }>(
      api.post('/accounts/depreciation/run', {}),
    ),

  listFixedAssets: () =>
    unwrap<FixedAsset[]>(api.get('/accounts/fixed-assets')),

  createFixedAsset: (payload: CreateFixedAssetPayload) =>
    unwrap<FixedAsset>(api.post('/accounts/fixed-assets', payload)),

  updateFixedAsset: (id: string, payload: Partial<CreateFixedAssetPayload> & { is_active?: boolean }) =>
    unwrap<FixedAsset>(api.patch(`/accounts/fixed-assets/${id}`, payload)),

  removeFixedAsset: (id: string) =>
    unwrap<any>(api.delete(`/accounts/fixed-assets/${id}`)),

  // ── Analytics ────────────────────────────────────────────────────
  dailyPerformance: (params: { from: string; to: string }) =>
    unwrap<DailyPerfRow[]>(
      api.get('/accounts/analytics/daily-performance', { params }),
    ),
  hourlyHeatmap: (params: { from: string; to: string }) =>
    unwrap<HeatmapCell[]>(
      api.get('/accounts/analytics/hourly-heatmap', { params }),
    ),
  topProducts: (params: { from: string; to: string; limit?: number }) =>
    unwrap<TopProduct[]>(
      api.get('/accounts/analytics/top-products', { params }),
    ),
  topCustomers: (params: { from: string; to: string; limit?: number }) =>
    unwrap<TopCustomer[]>(
      api.get('/accounts/analytics/top-customers', { params }),
    ),
  topSalespeople: (params: { from: string; to: string; limit?: number }) =>
    unwrap<TopSalesperson[]>(
      api.get('/accounts/analytics/top-salespeople', { params }),
    ),
  expenseBreakdown: (params: { from: string; to: string }) =>
    unwrap<ExpenseBreakdownRow[]>(
      api.get('/accounts/analytics/expense-breakdown', { params }),
    ),
  indicators: (params: { from: string; to: string }) =>
    unwrap<SmartIndicators>(
      api.get('/accounts/analytics/indicators', { params }),
    ),
  recommendations: (params: { from: string; to: string }) =>
    unwrap<Recommendation[]>(
      api.get('/accounts/analytics/recommendations', { params }),
    ),
  cashflowWaterfall: (params: { from: string; to: string }) =>
    unwrap<{
      opening: number;
      buckets: Array<{
        direction: 'in' | 'out';
        category: string;
        amount: string;
      }>;
    }>(api.get('/accounts/analytics/cashflow-waterfall', { params })),

  // ── VAT ──────────────────────────────────────────────────────────
  vatReturn: (params: { from: string; to: string }) =>
    unwrap<VatReturn>(api.get('/accounts/reports/vat-return', { params })),

  // ── Budgets ──────────────────────────────────────────────────────
  listBudgets: () => unwrap<Budget[]>(api.get('/accounts/budgets')),
  getBudget: (id: string) =>
    unwrap<BudgetDetail>(api.get(`/accounts/budgets/${id}`)),
  createBudget: (payload: CreateBudgetPayload) =>
    unwrap<BudgetDetail>(api.post('/accounts/budgets', payload)),
  updateBudget: (id: string, payload: UpdateBudgetPayload) =>
    unwrap<BudgetDetail>(api.patch(`/accounts/budgets/${id}`, payload)),
  removeBudget: (id: string) =>
    unwrap<any>(api.delete(`/accounts/budgets/${id}`)),
  budgetVariance: (id: string, params?: { cost_center_id?: string }) =>
    unwrap<BudgetVariance>(
      api.get(`/accounts/budgets/${id}/variance`, { params }),
    ),

  // ── Cost centers ─────────────────────────────────────────────────
  listCostCenters: (includeInactive = false) =>
    unwrap<CostCenter[]>(
      api.get('/accounts/cost-centers', {
        params: includeInactive ? { include_inactive: 'true' } : undefined,
      }),
    ),
  createCostCenter: (payload: CreateCostCenterPayload) =>
    unwrap<CostCenter>(api.post('/accounts/cost-centers', payload)),
  updateCostCenter: (id: string, payload: Partial<CreateCostCenterPayload> & { is_active?: boolean }) =>
    unwrap<CostCenter>(api.patch(`/accounts/cost-centers/${id}`, payload)),
  removeCostCenter: (id: string) =>
    unwrap<any>(api.delete(`/accounts/cost-centers/${id}`)),

  // ── FX ─────────────────────────────────────────────────────────────
  listRates: (params?: { currency?: string; limit?: number }) =>
    unwrap<CurrencyRate[]>(api.get('/accounts/fx/rates', { params })),
  upsertRate: (payload: UpsertRatePayload) =>
    unwrap<CurrencyRate>(api.post('/accounts/fx/rates', payload)),
  removeRate: (id: string) =>
    unwrap<any>(api.delete(`/accounts/fx/rates/${id}`)),
  revalue: (as_of: string) =>
    unwrap<{
      as_of: string;
      results: Array<{
        cashbox_id: string;
        name?: string;
        currency?: string;
        rate?: number;
        balance_fc?: number;
        target_egp?: number;
        book_egp?: number;
        diff?: number;
        posted?: boolean;
        skipped?: boolean;
        reason?: string;
      }>;
    }>(api.post('/accounts/fx/revalue', { as_of })),

  // ── Audit ────────────────────────────────────────────────────────
  auditSummary: () =>
    unwrap<AuditSummary>(api.get('/accounts/audit/summary')),
  auditCashboxes: () =>
    unwrap<CashboxAuditRow[]>(api.get('/accounts/audit/cashboxes')),
  auditInvoices: (limit = 50) =>
    unwrap<InvoiceAuditRow[]>(
      api.get('/accounts/audit/invoices', { params: { limit } }),
    ),
  auditExpenses: (limit = 50) =>
    unwrap<any[]>(
      api.get('/accounts/audit/expenses', { params: { limit } }),
    ),
  auditPayments: (limit = 50) =>
    unwrap<{ customer: any[]; supplier: any[] }>(
      api.get('/accounts/audit/payments', { params: { limit } }),
    ),
  recomputeCashbox: (id: string) =>
    unwrap<{ cashbox_id: string; new_balance: number }>(
      api.post(`/accounts/audit/recompute-cashbox/${id}`, {}),
    ),
  recomputeAllCashboxes: () =>
    unwrap<{ updated: number; results: any[] }>(
      api.post('/accounts/audit/recompute-cashboxes', {}),
    ),
  resetAutoEntries: () =>
    unwrap<{ voided: number }>(
      api.post('/accounts/audit/reset-auto-entries', {}),
    ),

  purgeCancelled: () =>
    unwrap<{
      invoices_deleted: number;
      journal_entries_deleted: number;
      cashbox_txns_deleted: number;
    }>(api.post('/accounts/audit/purge-cancelled', {})),

  forcePostExpenses: () =>
    unwrap<{
      found: number;
      posted: number;
      skipped: number;
      failed: number;
      results: Array<{
        expense_id: string;
        expense_no: string | null;
        amount: string;
        status: 'posted' | 'skipped' | 'failed';
        reason?: string;
      }>;
    }>(api.post('/accounts/audit/force-post-expenses', {})),

  forcePostInvoices: () =>
    unwrap<{
      found: number;
      posted: number;
      skipped: number;
      failed: number;
      results: Array<{
        invoice_id: string;
        invoice_no: string | null;
        grand_total: string;
        status: 'posted' | 'skipped' | 'failed';
        reason?: string;
      }>;
    }>(api.post('/accounts/audit/force-post-invoices', {})),

  dedupeCashbox: () =>
    unwrap<{ duplicates_removed: number; groups: number }>(
      api.post('/accounts/audit/dedupe-cashbox', {}),
    ),

  migrationsStatus: () =>
    unwrap<{
      dir: string;
      total_files: number;
      applied: Array<{ filename: string; applied_at: string }>;
      pending: string[];
    }>(api.get('/accounts/audit/migrations')),

  runMigrations: () =>
    unwrap<{
      dir: string;
      applied: string[];
      failed: Array<{ file: string; error: string }>;
      already: string[];
    }>(api.post('/accounts/audit/run-migrations', {})),
};

// ── Audit types ──────────────────────────────────────────────────

export interface AuditSummary {
  cashboxes: {
    total: number;
    txn_mismatch: number;
    gl_mismatch: number;
    max_txn_drift: number;
    max_gl_drift: number;
  };
  invoices: { missing_count: number; missing_value: number };
  expenses: { missing_count: number; missing_value: number };
  payments: { missing_count: number };
}

export interface CashboxAuditRow {
  id: string;
  name_ar: string;
  kind: string;
  currency: string;
  is_active: boolean;
  stored_balance: string;
  computed_balance: string;
  gl_balance: string;
  gl_account_id: string | null;
  gl_account_code: string | null;
}

export interface InvoiceAuditRow {
  id: string;
  invoice_no: string;
  status: string;
  grand_total: string;
  posted_debit: string;
  drift: string;
  completed_at: string | null;
  created_at: string;
}

export interface CurrencyRate {
  id: string;
  currency: string;
  rate_date: string;
  rate_to_egp: string;
  source: string | null;
  notes: string | null;
  created_by_name: string | null;
  created_at: string;
}

export interface UpsertRatePayload {
  currency: string;
  rate_date: string;
  rate_to_egp: number;
  source?: string;
  notes?: string;
}

// ── Budget + Cost Center types ──────────────────────────────────────

export interface Budget {
  id: string;
  name_ar: string;
  fiscal_year: number;
  is_active: boolean;
  created_by: string | null;
  created_by_name: string | null;
  line_count: number;
  total_annual: string;
  created_at: string;
}

export interface BudgetLine {
  id: string;
  budget_id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: AccountType;
  month: number;
  amount: string;
}

export interface BudgetDetail extends Budget {
  lines: BudgetLine[];
}

export interface CreateBudgetPayload {
  name_ar: string;
  fiscal_year: number;
  lines?: Array<{ account_id: string; month: number; amount: number }>;
}

export interface UpdateBudgetPayload {
  name_ar?: string;
  is_active?: boolean;
  lines?: Array<{ account_id: string; month: number; amount: number }>;
}

export interface BudgetVarianceRow {
  account_id: string;
  code: string;
  name_ar: string;
  account_type: AccountType;
  months: Record<string, { budget: number; actual: number }>;
  budget_total: number;
  actual_total: number;
  variance: number;
  variance_pct: number | null;
}

export interface BudgetVariance {
  budget: Budget;
  cost_center_id: string | null;
  rows: BudgetVarianceRow[];
  totals: { budget: number; actual: number; variance: number };
}

export interface CostCenter {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  parent_id: string | null;
  parent_code: string | null;
  parent_name: string | null;
  warehouse_id: string | null;
  warehouse_name: string | null;
  is_active: boolean;
}

export interface CreateCostCenterPayload {
  code: string;
  name_ar: string;
  name_en?: string;
  parent_id?: string;
  warehouse_id?: string;
}

// ── Analytics types ──────────────────────────────────────────────────

export interface DailyPerfRow {
  date: string;
  invoice_count: number;
  revenue: string;
  cogs: string;
  tax: string;
  returns: string;
  expenses: string;
  gross_profit: string;
  net_profit: string;
  cash_low: string;
  cash_high: string;
}

export interface HeatmapCell {
  dow: number;
  hour: number;
  invoice_count: number;
  revenue: string;
}

export interface TopProduct {
  variant_id: string;
  product_name: string;
  sku: string | null;
  qty: number;
  revenue: string;
  cogs: string;
  gross: string;
}

export interface TopCustomer {
  id: string;
  full_name: string;
  phone: string | null;
  code: string;
  invoice_count: number;
  revenue: string;
  avg_ticket: string;
}

export interface TopSalesperson {
  id: string;
  full_name: string;
  invoice_count: number;
  revenue: string;
  gross: string;
}

export interface ExpenseBreakdownRow {
  code: string;
  name_ar: string;
  amount: string;
}

export interface SmartIndicators {
  revenue: number;
  cogs: number;
  gross_profit: number;
  gross_margin_pct: number;
  expenses: number;
  returns_value: number;
  net_profit: number;
  net_margin_pct: number;
  invoice_count: number;
  avg_ticket: number;
  return_count: number;
  return_rate_pct: number;
  inventory_value: number;
  inventory_turns: number;
  receivables: number;
  payables: number;
  cash_on_hand: number;
  daily_burn: number;
  cash_runway_days: number;
}

export interface Recommendation {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  action?: string;
}

export interface VatReturn {
  from: string;
  to: string;
  taxable_sales: number;
  output_vat: number;
  output_vat_refunded: number;
  net_output_vat: number;
  invoice_count: number;
  taxable_purchases: number;
  input_vat: number;
  purchase_count: number;
  net_vat_due: number;
  status: string;
}

// ── More report types ────────────────────────────────────────────────

export interface AgingParty {
  id: string;
  code: string;
  name: string;
  total: number;
  buckets: Record<string, number>;
}

export interface AgingReport {
  buckets: string[];
  parties: AgingParty[];
  totals: Record<string, number>;
  invoice_count: number;
}

export interface PartyLedgerLine {
  id: string;
  debit: number;
  credit: number;
  description: string | null;
  entry_no: string;
  entry_date: string;
  entry_description: string | null;
  reference_type: string | null;
  reference_id: string | null;
  account_code: string;
  account_name: string;
  running_balance: number;
}

export interface PartyLedger {
  customer?: { id: string; code: string; full_name: string; current_balance: string };
  supplier?: { id: string; code: string; name: string; current_balance: string };
  from: string | null;
  to: string | null;
  opening_balance: number;
  closing_balance: number;
  total_debit: number;
  total_credit: number;
  lines: PartyLedgerLine[];
  note?: string;
}

export interface FixedAsset {
  id: string;
  name_ar: string;
  account_id: string;
  account_code: string | null;
  account_name: string | null;
  accum_dep_account_id: string | null;
  accum_code: string | null;
  accum_name: string | null;
  cost: string;
  salvage_value: string;
  useful_life_months: number;
  start_date: string;
  last_posted_month: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
}

export interface CreateFixedAssetPayload {
  name_ar: string;
  account_id: string;
  accum_dep_account_id?: string;
  cost: number;
  salvage_value?: number;
  useful_life_months: number;
  start_date: string;
  notes?: string;
}

// ── Report types ──────────────────────────────────────────────────────

export interface AccountLedgerLine {
  id: string;
  line_no: number;
  debit: number;
  credit: number;
  description: string | null;
  entry_no: string;
  entry_date: string;
  entry_description: string | null;
  reference_type: string | null;
  reference_id: string | null;
  running_balance: number;
}

export interface AccountLedger {
  account: {
    id: string;
    code: string;
    name_ar: string;
    account_type: AccountType;
    normal_balance: NormalBalance;
  };
  opening_balance: number;
  closing_balance: number;
  total_debit: number;
  total_credit: number;
  from: string | null;
  to: string | null;
  lines: AccountLedgerLine[];
}

export interface ReportAccountNode {
  id: string;
  code: string;
  name_ar: string;
  account_type: AccountType;
  normal_balance: NormalBalance;
  parent_id: string | null;
  is_leaf: boolean;
  amount: number;
}

export interface IncomeStatement {
  from: string;
  to: string;
  accounts: ReportAccountNode[];
  total_revenue: number;
  total_expenses: number;
  net_profit: number;
}

export interface BalanceSheet {
  as_of: string;
  accounts: ReportAccountNode[];
  total_assets: number;
  total_liabilities: number;
  book_equity: number;
  period_net_profit: number;
  total_equity: number;
  balanced: boolean;
}
