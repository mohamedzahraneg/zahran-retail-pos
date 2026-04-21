import { api, unwrap } from './client';

export interface ExpenseCategory {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  is_fixed: boolean;
  allocate_to_cogs: boolean;
  is_active: boolean;
  created_at: string;
}

export interface Expense {
  id: string;
  expense_no: string;
  warehouse_id: string;
  warehouse_name?: string;
  cashbox_id: string | null;
  category_id: string;
  category_name?: string;
  category_code?: string;
  amount: number;
  payment_method: 'cash' | 'card' | 'transfer' | 'wallet' | 'mixed';
  expense_date: string;
  description: string | null;
  receipt_url: string | null;
  vendor_name: string | null;
  is_approved: boolean;
  approved_by: string | null;
  approved_by_name?: string;
  created_by: string | null;
  created_by_name?: string;
  created_at: string;
}

export interface ProfitAndLoss {
  range: { from: string; to: string };
  warehouse_id: string | null;
  revenue: number;
  discounts: number;
  invoice_count: number;
  returns: number;
  net_revenue: number;
  cogs: number;
  allocated_expenses: number;
  gross_profit: number;
  operating_expenses: number;
  total_expenses: number;
  net_profit: number;
  gross_margin_pct: number;
  net_margin_pct: number;
  expenses_by_category: Array<{
    code: string;
    name_ar: string;
    is_fixed: boolean;
    allocate_to_cogs: boolean;
    total: number;
  }>;
}

export interface Cashflow {
  range: { from: string; to: string };
  inflow: number;
  outflow: number;
  net: number;
  breakdown: Array<{
    category: string;
    direction: 'in' | 'out';
    total: number;
    count: number;
  }>;
}

export interface TrialBalanceRow {
  cashbox_id: string;
  cashbox_name: string;
  warehouse_id: string;
  warehouse_name: string;
  current_balance: number;
  period_in: number;
  period_out: number;
  opening_in: number;
  opening_out: number;
}

export interface GLRow {
  id: number;
  cashbox_id: string;
  cashbox_name: string;
  direction: 'in' | 'out';
  amount: number;
  category: string;
  reference_type: string | null;
  reference_id: string | null;
  balance_after: number;
  notes: string | null;
  user_id: string | null;
  user_name: string | null;
  created_at: string;
}

export interface AccountingKPIs {
  today: ProfitAndLoss;
  month: ProfitAndLoss;
  pending_expenses: number;
  pending_amount: number;
}

export const accountingApi = {
  // Categories
  categories: () => unwrap<ExpenseCategory[]>(api.get('/accounting/categories')),
  createCategory: (body: Partial<ExpenseCategory>) =>
    unwrap<ExpenseCategory>(api.post('/accounting/categories', body)),
  updateCategory: (id: string, body: Partial<ExpenseCategory>) =>
    unwrap<ExpenseCategory>(api.patch(`/accounting/categories/${id}`, body)),

  // Expenses
  listExpenses: (params?: {
    from?: string;
    to?: string;
    category_id?: string;
    warehouse_id?: string;
    status?: 'approved' | 'pending' | 'all';
    q?: string;
    limit?: number;
    offset?: number;
  }) =>
    unwrap<{ items: Expense[]; total: number; total_amount: number }>(
      api.get('/accounting/expenses', { params }),
    ),
  createExpense: (body: Partial<Expense>) =>
    unwrap<Expense>(api.post('/accounting/expenses', body)),
  updateExpense: (id: string, body: Partial<Expense>) =>
    unwrap<Expense>(api.patch(`/accounting/expenses/${id}`, body)),
  approveExpense: (id: string) =>
    unwrap<Expense>(api.post(`/accounting/expenses/${id}/approve`)),
  deleteExpense: (id: string) =>
    unwrap<{ deleted: boolean }>(api.delete(`/accounting/expenses/${id}`)),

  deleteCategory: (id: string) =>
    unwrap<{ archived: boolean }>(
      api.delete(`/accounting/categories/${id}`),
    ),

  // Reports
  profitAndLoss: (params: { from: string; to: string; warehouse_id?: string }) =>
    unwrap<ProfitAndLoss>(
      api.get('/accounting/reports/profit-and-loss', { params }),
    ),
  profitAndLossAnalysis: (params: {
    from: string;
    to: string;
    warehouse_id?: string;
  }) =>
    unwrap<
      ProfitAndLoss & {
        analysis: {
          headline: 'profit' | 'loss' | 'breakeven';
          headline_label: string;
          headline_tone: 'green' | 'red' | 'amber';
          reasons: Array<{
            code: string;
            message: string;
            severity: 'info' | 'warning' | 'critical';
          }>;
          suggestions: string[];
        };
      }
    >(api.get('/accounting/reports/profit-and-loss/analysis', { params })),
  cashflow: (params: { from: string; to: string; warehouse_id?: string }) =>
    unwrap<Cashflow>(api.get('/accounting/reports/cashflow', { params })),
  trialBalance: (params: { from: string; to: string; warehouse_id?: string }) =>
    unwrap<TrialBalanceRow[]>(
      api.get('/accounting/reports/trial-balance', { params }),
    ),
  generalLedger: (params: {
    from?: string;
    to?: string;
    cashbox_id?: string;
    category?: string;
    limit?: number;
    offset?: number;
  }) => unwrap<GLRow[]>(api.get('/accounting/reports/general-ledger', { params })),

  kpis: (params?: { date?: string; from?: string; to?: string }) =>
    unwrap<AccountingKPIs>(api.get('/accounting/kpis', { params })),
};
