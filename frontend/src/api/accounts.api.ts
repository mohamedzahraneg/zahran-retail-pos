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
};

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
