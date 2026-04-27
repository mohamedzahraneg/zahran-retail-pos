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
  /** COA leaf this category posts to. Required for Daily Expenses
   *  (PR-1 strict mode); legacy categories without it block submit. */
  account_id?: string | null;
  /** Joined preview fields from `chart_of_accounts` (PR-1) — let the
   *  Daily Expenses modal render "DR <code> <name>" without a second
   *  round-trip. NULL when category is unmapped. */
  account_code?: string | null;
  account_name_ar?: string | null;
  has_account?: boolean;
}

export interface Expense {
  id: string;
  expense_no: string;
  warehouse_id: string;
  warehouse_name?: string;
  cashbox_id: string | null;
  /** PR-2: name joined from cashboxes. NULL when expense has no cashbox. */
  cashbox_name?: string | null;
  category_id: string;
  category_name?: string;
  category_code?: string;
  /** PR-1: COA preview joined via expense_categories.account_id. */
  account_code?: string | null;
  account_name_ar?: string | null;
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
  /** PR-2: open shift the expense was recorded under. NULL if none. */
  shift_id?: string | null;
  shift_no?: string | null;
  /** PR-2: responsible employee (from users join via employee_user_id). */
  employee_user_id?: string | null;
  employee_name?: string | null;
  employee_username?: string | null;
  /** PR-3: posted journal entry (latest one referenced by this expense).
   *  NULL when the expense is still pending approval / no JE exists. */
  je_entry_no?: string | null;
  je_is_void?: boolean | null;
  /** PR-11 (migration 094): TRUE iff there's a pending edit request
   *  on this expense. The register renders a small badge when set. */
  has_pending_edit_request?: boolean;
  /** PR-12 — rolled-up edit-request state used by the row badges + filter. */
  last_edit_status?: 'pending' | 'approved' | 'rejected' | 'cancelled' | null;
  edit_request_count?: number;
  approved_edit_count?: number;
  rejected_edit_count?: number;
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
    /** PR-3 — register filters. */
    employee_user_id?: string;
    cashbox_id?: string;
    shift_id?: string;
    /** PR-12 — filter by edit-request state. */
    edit_status?: 'none' | 'pending' | 'approved' | 'rejected' | 'any';
    q?: string;
    limit?: number;
    offset?: number;
  }) =>
    unwrap<{ items: Expense[]; total: number; total_amount: number }>(
      api.get('/accounting/expenses', { params }),
    ),
  createExpense: (body: Partial<Expense>) =>
    unwrap<Expense>(api.post('/accounting/expenses', body)),

  /**
   * Daily Expenses endpoint (migration 060) — requires explicit
   * `employee_user_id`. Server enforces that non-admin callers can
   * only book expenses against their own user id.
   */
  createDailyExpense: (body: {
    /**
     * PR-EMP-FIX — optional. Backend DTO is
     * `@IsOptional() @IsUUID()`; an empty string fails validation.
     * When omitted the service auto-resolves the first active
     * warehouse (accounting.service.ts:439-451). Daily expenses
     * aren't branch-scoped so omitting is the canonical path on prod.
     */
    warehouse_id?: string;
    cashbox_id?: string;
    category_id: string;
    amount: number;
    payment_method?: 'cash' | 'card' | 'transfer' | 'wallet' | 'mixed';
    expense_date?: string;
    description?: string;
    receipt_url?: string;
    vendor_name?: string;
    employee_user_id: string;
    /** PR-15 — explicit shift linkage from the source selector. */
    shift_id?: string;
    /** PR-15 — explicit advance flag (was previously read via dto-as-any). */
    is_advance?: boolean;
    /**
     * PR-ESS-2B — link this advance daily-expense to the originating
     * self-service `employee_requests` row. Required to be a row
     * with `kind='advance_request'` and `status='approved'`; the
     * backend pre-validates kind / status / user / amount / and that
     * no other expense already links to it. On engine success the
     * request flips to `status='disbursed'` inside the same
     * transaction. On any failure the transaction rolls back and the
     * request stays `'approved'`. Must be sent with `is_advance=true`.
     */
    source_employee_request_id?: number;
  }) => unwrap<Expense>(api.post('/accounting/expenses/daily', body)),
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

  // ── Expense approval workflow ───────────────────────────────────
  listApprovalRules: () =>
    unwrap<ApprovalRule[]>(api.get('/accounting/approvals/rules')),
  createApprovalRule: (payload: CreateApprovalRulePayload) =>
    unwrap<ApprovalRule>(api.post('/accounting/approvals/rules', payload)),
  updateApprovalRule: (id: string, payload: Partial<CreateApprovalRulePayload> & { is_active?: boolean }) =>
    unwrap<ApprovalRule>(api.patch(`/accounting/approvals/rules/${id}`, payload)),
  removeApprovalRule: (id: string) =>
    unwrap<any>(api.delete(`/accounting/approvals/rules/${id}`)),
  approvalInbox: () =>
    unwrap<ApprovalInboxItem[]>(api.get('/accounting/approvals/inbox')),
  approveApproval: (id: string, note?: string) =>
    unwrap<any>(api.post(`/accounting/approvals/${id}/approve`, { note })),
  rejectApproval: (id: string, reason: string) =>
    unwrap<any>(api.post(`/accounting/approvals/${id}/reject`, { reason })),
  approvalsForExpense: (expenseId: string) =>
    unwrap<ApprovalRow[]>(api.get(`/accounting/approvals/expense/${expenseId}`)),

  // ── Edit-request workflow (migration 094) ─────────────────────────
  /** File a new edit request on an existing expense. The reason field
   *  must be at least 5 characters (also enforced server-side). */
  requestExpenseEdit: (
    expenseId: string,
    body: { reason: string; new_values: Partial<ExpenseEditableValues> },
  ) =>
    unwrap<ExpenseEditRequest>(
      api.post(`/accounting/expenses/${expenseId}/edit-request`, body),
    ),
  /** Full edit history for one expense — used by the audit modal. */
  listEditRequestsForExpense: (expenseId: string) =>
    unwrap<ExpenseEditRequest[]>(
      api.get(`/accounting/expenses/${expenseId}/edit-requests`),
    ),
  /** Pending edit requests across the system — used by the inbox. */
  editRequestsInbox: () =>
    unwrap<ExpenseEditRequest[]>(
      api.get('/accounting/expenses/edit-requests/inbox'),
    ),
  /** Approve a pending edit request. Triggers the void+repost flow on
   *  the backend if accounting fields changed. */
  approveEditRequest: (id: string) =>
    unwrap<{
      ok: true;
      accounting_corrected: boolean;
      voided_je_id: string | null;
      applied_je_id: string | null;
    }>(api.post(`/accounting/expenses/edit-requests/${id}/approve`)),
  rejectEditRequest: (id: string, reason: string) =>
    unwrap<{ ok: true }>(
      api.post(`/accounting/expenses/edit-requests/${id}/reject`, { reason }),
    ),
  cancelEditRequest: (id: string) =>
    unwrap<{ ok: true }>(
      api.post(`/accounting/expenses/edit-requests/${id}/cancel`),
    ),
  /** PR-12 — aggregated stats for the analytics audit KPI section. */
  editRequestsStats: (params: { from?: string; to?: string }) =>
    unwrap<ExpenseEditStats>(
      api.get('/accounting/expenses/edit-requests/stats', { params }),
    ),
};

export interface ExpenseEditStats {
  pending_count: number;
  approved_count: number;
  rejected_count: number;
  cancelled_count: number;
  total_count: number;
  distinct_edited_expenses: number;
  distinct_pending_expenses: number;
  total_expenses_in_range: number;
}

/** Editable fields the workflow accepts — must match the backend's
 *  EDITABLE_FIELDS whitelist in accounting.service.ts. */
export interface ExpenseEditableValues {
  category_id: string;
  amount: number;
  cashbox_id: string | null;
  expense_date: string;
  employee_user_id: string | null;
  payment_method: 'cash' | 'card' | 'transfer' | 'wallet' | 'mixed';
  description: string | null;
}

export interface ExpenseEditRequest {
  id: string;
  expense_id: string;
  requested_by: string;
  requested_by_name?: string;
  requested_at: string;
  reason: string;
  /** Snapshot of editable fields at request time. */
  old_values: Partial<ExpenseEditableValues>;
  /** What the requester wants to change. Subset of editable fields. */
  new_values: Partial<ExpenseEditableValues>;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  decided_by: string | null;
  decided_by_name?: string;
  decided_at: string | null;
  rejection_reason: string | null;
  /** JE that was voided on approval (if accounting changed). */
  voided_je_id: string | null;
  voided_je_no?: string | null;
  /** Fresh corrected JE posted on approval (if accounting changed). */
  applied_je_id: string | null;
  applied_je_no?: string | null;
  created_at: string;
  /** Inbox-only joined fields (only present in editRequestsInbox response). */
  expense_no?: string;
  current_amount?: number;
  current_category_name?: string | null;
  current_cashbox_name?: string | null;
}

export interface ApprovalRule {
  id: string;
  name_ar: string;
  min_amount: string;
  max_amount: string | null;
  required_role: string;
  level: number;
  is_active: boolean;
  notes: string | null;
}

export interface CreateApprovalRulePayload {
  name_ar: string;
  min_amount: number;
  max_amount?: number | null;
  required_role: string;
  level: number;
  notes?: string;
}

export interface ApprovalInboxItem {
  id: string;
  expense_id: string;
  level: number;
  required_role: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  expense_no: string;
  amount: string;
  expense_date: string;
  description: string | null;
  vendor_name: string | null;
  payment_method: string;
  category_name: string | null;
  category_code: string | null;
  warehouse_name: string | null;
  created_by_name: string | null;
  rule_name: string;
}

export interface ApprovalRow {
  id: string;
  expense_id: string;
  rule_id: string;
  level: number;
  required_role: string;
  status: 'pending' | 'approved' | 'rejected';
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  reason: string | null;
  created_at: string;
  rule_name: string | null;
}
