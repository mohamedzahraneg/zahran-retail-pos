import { api, unwrap } from './client';

export type Frequency =
  | 'daily'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual'
  | 'custom_days';

export interface RecurringExpense {
  id: string;
  code: string;
  name_ar: string;
  name_en?: string;
  category_id: string;
  category_name?: string;
  warehouse_id: string;
  warehouse_name?: string;
  cashbox_id?: string;
  amount: number;
  payment_method: string;
  vendor_name?: string;
  description?: string;
  frequency: Frequency;
  custom_interval_days?: number;
  day_of_month?: number;
  start_date: string;
  end_date?: string;
  next_run_date: string;
  last_run_date?: string;
  auto_post: boolean;
  auto_paid: boolean;
  notify_days_before: number;
  require_approval: boolean;
  status: 'active' | 'paused' | 'ended';
  runs_count: number;
  last_error?: string;
  due_status?: 'due' | 'upcoming' | 'scheduled';
  days_overdue?: number;
}

export interface RecurringExpenseRun {
  id: string;
  recurring_id: string;
  expense_id?: string;
  expense_no?: string;
  scheduled_for: string;
  generated_at: string;
  amount: number;
  status: 'generated' | 'skipped' | 'failed' | 'manual';
  notes?: string;
  error_message?: string;
}

export interface RecurringExpenseStats {
  active_templates: number;
  paused_templates: number;
  due_now: number;
  due_next_7_days: number;
  monthly_commitment_estimate: number;
  due_amount: number;
}

export interface CreateRecurringExpenseInput {
  code: string;
  name_ar: string;
  name_en?: string;
  category_id: string;
  warehouse_id: string;
  cashbox_id?: string;
  amount: number;
  payment_method?: string;
  vendor_name?: string;
  description?: string;
  frequency: Frequency;
  custom_interval_days?: number;
  day_of_month?: number;
  start_date: string;
  end_date?: string;
  auto_post?: boolean;
  auto_paid?: boolean;
  notify_days_before?: number;
  require_approval?: boolean;
}

export const recurringExpensesApi = {
  list: (params: { status?: string; warehouse_id?: string; due_only?: boolean } = {}) =>
    unwrap<RecurringExpense[]>(api.get('/recurring-expenses', { params })),
  stats: () => unwrap<RecurringExpenseStats>(api.get('/recurring-expenses/stats')),
  get: (id: string) =>
    unwrap<RecurringExpense & { runs: RecurringExpenseRun[] }>(
      api.get(`/recurring-expenses/${id}`),
    ),
  create: (dto: CreateRecurringExpenseInput) =>
    unwrap<RecurringExpense>(api.post('/recurring-expenses', dto)),
  update: (id: string, dto: Partial<CreateRecurringExpenseInput> & { status?: string }) =>
    unwrap<RecurringExpense>(api.patch(`/recurring-expenses/${id}`, dto)),
  remove: (id: string) =>
    unwrap<{ success: boolean }>(api.delete(`/recurring-expenses/${id}`)),
  pause: (id: string) =>
    unwrap<RecurringExpense>(api.post(`/recurring-expenses/${id}/pause`)),
  resume: (id: string) =>
    unwrap<RecurringExpense>(api.post(`/recurring-expenses/${id}/resume`)),
  run: (id: string, dry_run = false) =>
    unwrap<any>(api.post(`/recurring-expenses/${id}/run`, { dry_run })),
  processDue: (limit = 100) =>
    unwrap<{ total: number; ok: number; failed: number; results: any[] }>(
      api.post(`/recurring-expenses/process-due`, { limit }),
    ),
};
