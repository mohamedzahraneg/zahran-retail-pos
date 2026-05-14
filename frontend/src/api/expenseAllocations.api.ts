/**
 * Expense Allocations — Frontend API client (PR-FE-A, read-only).
 *
 * Phase 2 backend exposes 14 endpoints across allocation periods +
 * preview/save-preview + two reports.  FE-A wires the four READ
 * endpoints only; the 10 write endpoints land in FE-B / FE-C.
 *
 * Hard scope reminder (mirrors the design):
 *   * No POST/PATCH/DELETE calls in FE-A.
 *   * Permission to view = `expense_allocation.view`.
 *   * DATE columns arrive as 'YYYY-MM-DD' strings (TZ fix in effect).
 */
import { api, unwrap } from './client';

// ─── Types — periods ────────────────────────────────────────────────

export type AllocationPeriodStatus = 'draft' | 'approved' | 'reversed';

export type AllocationMethod =
  | 'manual'
  | 'by_revenue'
  | 'by_units_sold'
  | 'by_gross_profit'
  | 'by_category_pct'
  | 'by_warehouse';

export type AllocationTargetKind = 'product' | 'category' | 'warehouse';

export interface AllocationPeriodRow {
  id: string;
  period_start: string;          // 'YYYY-MM-DD'
  period_end: string;            // 'YYYY-MM-DD'
  warehouse_id: string | null;
  warehouse_name: string | null;
  status: AllocationPeriodStatus;
  total_allocated: string;       // numeric — string
  notes: string | null;
  created_by: string | null;
  created_by_name: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: string | null;    // ISO timestamp
  reversed_by: string | null;
  reversed_by_name: string | null;
  reversed_at: string | null;
  reversed_reason: string | null;
  created_at: string;            // ISO timestamp
  updated_at: string;
  lines_count: string | number;  // pg COUNT comes back as string
}

export interface AllocationLineRow {
  id: string;
  period_id: string;
  expense_id: string | null;
  expense_no: string | null;
  expense_category_id: string | null;
  expense_category_code: string | null;
  expense_category_name: string | null;
  source_amount: string;
  product_id: string | null;
  product_name: string | null;
  product_category_id: string | null;
  product_category_name: string | null;
  warehouse_id: string | null;
  target_warehouse_name: string | null;
  allocation_method: AllocationMethod;
  allocated_amount: string;
  weight_basis_value: string | null;
  weight_basis_total: string | null;
  created_at: string;
}

export interface AllocationPeriodDetail extends AllocationPeriodRow {
  lines: AllocationLineRow[];
}

// ─── Types — reports ───────────────────────────────────────────────

export interface ProfitWithOverheadRow {
  product_id: string;
  product_name: string;
  product_type: string | null;
  units_sold: string;
  revenue: string;
  cogs: string;
  gross_profit: string;
  roi_pct: string;
  overhead_allocated: string;
  net_profit_after_overhead: string;
}

export interface UnallocatedExpenseRow {
  id: string;
  expense_no: string;
  amount: string;
  expense_date: string;          // 'YYYY-MM-DD'
  category_id: string | null;
  category_code: string | null;
  category_name: string | null;
  warehouse_id: string | null;
  warehouse_name: string | null;
}

// ─── Filters ───────────────────────────────────────────────────────

export interface PeriodFilters {
  from?: string;                 // 'YYYY-MM-DD'
  to?: string;
  status?: AllocationPeriodStatus;
  warehouse_id?: string;
}

export interface ReportFilters {
  from?: string;
  to?: string;
  warehouse_id?: string;
}

// ─── Client (read-only) ────────────────────────────────────────────

/**
 * Four read endpoints.  Each one returns the unwrapped `data` field
 * from the global `{success,data,meta}` envelope (handled by
 * `unwrap` in `./client.ts`).
 *
 * Write endpoints are NOT exposed here yet — they land in FE-B
 * (manual workflow) and FE-C (preview + save-preview).
 */
export const expenseAllocationsApi = {
  /** GET /api/v1/expense-allocations/periods */
  listPeriods: (filters: PeriodFilters = {}) =>
    unwrap<AllocationPeriodRow[]>(
      api.get('/expense-allocations/periods', { params: filters }),
    ),

  /** GET /api/v1/expense-allocations/periods/:id */
  getPeriod: (id: string) =>
    unwrap<AllocationPeriodDetail>(
      api.get(`/expense-allocations/periods/${encodeURIComponent(id)}`),
    ),

  /** GET /api/v1/reports/profit-with-overhead */
  profitWithOverhead: (filters: ReportFilters = {}) =>
    unwrap<ProfitWithOverheadRow[]>(
      api.get('/reports/profit-with-overhead', { params: filters }),
    ),

  /** GET /api/v1/reports/unallocated-expenses */
  unallocatedExpenses: (filters: ReportFilters = {}) =>
    unwrap<UnallocatedExpenseRow[]>(
      api.get('/reports/unallocated-expenses', { params: filters }),
    ),
};
