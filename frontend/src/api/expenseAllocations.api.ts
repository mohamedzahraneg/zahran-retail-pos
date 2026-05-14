/**
 * Expense Allocations — Frontend API client.
 *
 *   * PR-FE-A   (shipped) — the four READ wrappers.
 *   * PR-FE-B.1 (this PR) — eight manual-workflow WRITE wrappers
 *     (create / update / delete period, add / update / clear lines,
 *     approve, reverse).  These are plumbing: defined here so FE-B.2+
 *     can call them, but NO mounted page invokes them yet.  Save-
 *     preview stays out — it ships in FE-C with the preview wizard.
 *
 * Hard scope reminders (mirrors the design):
 *   * `expense_allocation.view`   gates the four GETs.
 *   * `expense_allocation.manage` gates every write endpoint below;
 *     callers should also defense-in-depth with hasPermission(...)
 *     before rendering write controls (FE-B.2+).
 *   * DATE columns arrive as 'YYYY-MM-DD' strings (TZ fix in effect).
 *   * Numeric columns arrive as strings from pg; callers Number(...) at
 *     egress.
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

// ─── Write DTOs (PR-FE-B.1) ────────────────────────────────────────
//
// Field names + shapes mirror the controller DTOs at
// `backend/src/expense-allocations/expense-allocations.controller.ts`
// (CreatePeriodDtoIn, UpdatePeriodDtoIn, AddLineDtoIn, UpdateLineDtoIn,
// ReverseDtoIn).  Numeric fields are sent as `number` — the backend
// rounds and persists; pg returns them as strings on the next read.
//
// `null` semantics on PATCH bodies: pass `null` to explicitly clear a
// nullable column (warehouse, notes, target_*, source_*).  Omit the
// key to leave it untouched.

export interface CreatePeriodBody {
  period_start: string;                 // 'YYYY-MM-DD'
  period_end: string;                   // 'YYYY-MM-DD'
  warehouse_id?: string;
  notes?: string;
}

export interface UpdatePeriodBody {
  period_start?: string;
  period_end?: string;
  warehouse_id?: string | null;
  notes?: string | null;
}

export interface AddLineBody {
  /** Exactly one of expense_id / expense_category_id is required. */
  expense_id?: string;
  expense_category_id?: string;
  source_amount: number;
  /** Exactly one of product_id / product_category_id / warehouse_id. */
  product_id?: string;
  product_category_id?: string;
  warehouse_id?: string;
  /** Backend only accepts 'manual' in B2; omit to default server-side. */
  allocation_method?: 'manual';
  allocated_amount: number;
  notes?: string;
}

export interface UpdateLineBody {
  source_amount?: number;
  allocated_amount?: number;
  /** Pass `null` to clear; omit to leave untouched. */
  product_id?: string | null;
  product_category_id?: string | null;
  warehouse_id?: string | null;
  expense_id?: string | null;
  expense_category_id?: string | null;
}

export interface ReverseBody {
  /** Min 1 char (server-validated); UI form should enforce ≥ 3 for UX. */
  reason: string;
}

// ─── Client ────────────────────────────────────────────────────────

/**
 * All endpoints unwrap `{ success, data }` via `unwrap` in `./client.ts`.
 *
 * Reads (FE-A, shipped):
 *   * listPeriods, getPeriod, profitWithOverhead, unallocatedExpenses
 *
 * Writes (FE-B.1, plumbing only — NOT called by any mounted page yet):
 *   * createPeriod, updatePeriod, deletePeriod
 *   * addLine, updateLine, clearLines
 *   * approvePeriod, reversePeriod
 *
 * Save-preview is deliberately absent here — it lands in FE-C with
 * the preview wizard surface, not the manual workflow.
 */
export const expenseAllocationsApi = {
  // ─── Reads ───────────────────────────────────────────────────────

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

  // ─── Writes — PR-FE-B.1 plumbing ────────────────────────────────
  //
  // Server permission: `expense_allocation.manage` on every route
  // below (controller annotation overrides the class-level `.view`).
  // FE callers MUST gate the surfacing UI with hasPermission(...) on
  // the same code before exposing buttons (FE-B.2+).

  /** POST /api/v1/expense-allocations/periods */
  createPeriod: (body: CreatePeriodBody) =>
    unwrap<AllocationPeriodDetail>(
      api.post('/expense-allocations/periods', body),
    ),

  /** PATCH /api/v1/expense-allocations/periods/:id */
  updatePeriod: (id: string, body: UpdatePeriodBody) =>
    unwrap<AllocationPeriodDetail>(
      api.patch(
        `/expense-allocations/periods/${encodeURIComponent(id)}`,
        body,
      ),
    ),

  /** DELETE /api/v1/expense-allocations/periods/:id */
  deletePeriod: (id: string) =>
    unwrap<{ id: string; deleted: true }>(
      api.delete(`/expense-allocations/periods/${encodeURIComponent(id)}`),
    ),

  /** POST /api/v1/expense-allocations/periods/:id/lines */
  addLine: (id: string, body: AddLineBody) =>
    unwrap<AllocationLineRow>(
      api.post(
        `/expense-allocations/periods/${encodeURIComponent(id)}/lines`,
        body,
      ),
    ),

  /** PATCH /api/v1/expense-allocations/periods/:id/lines/:line_id */
  updateLine: (id: string, lineId: string, body: UpdateLineBody) =>
    unwrap<AllocationLineRow>(
      api.patch(
        `/expense-allocations/periods/${encodeURIComponent(
          id,
        )}/lines/${encodeURIComponent(lineId)}`,
        body,
      ),
    ),

  /** DELETE /api/v1/expense-allocations/periods/:id/lines */
  clearLines: (id: string) =>
    unwrap<{ cleared: number }>(
      api.delete(
        `/expense-allocations/periods/${encodeURIComponent(id)}/lines`,
      ),
    ),

  /** POST /api/v1/expense-allocations/periods/:id/approve */
  approvePeriod: (id: string) =>
    unwrap<AllocationPeriodDetail>(
      api.post(
        `/expense-allocations/periods/${encodeURIComponent(id)}/approve`,
      ),
    ),

  /** POST /api/v1/expense-allocations/periods/:id/reverse */
  reversePeriod: (id: string, body: ReverseBody) =>
    unwrap<AllocationPeriodDetail>(
      api.post(
        `/expense-allocations/periods/${encodeURIComponent(id)}/reverse`,
        body,
      ),
    ),
};
