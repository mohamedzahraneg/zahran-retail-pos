/**
 * Expense Allocations — Frontend API client.
 *
 *   * PR-FE-A   — the four READ wrappers.
 *   * PR-FE-B.1 — eight manual-workflow WRITE wrappers (create /
 *     update / delete period, add / update / clear lines, approve,
 *     reverse).
 *   * PR-FE-C   — preview + save-preview wrappers (engine-driven
 *     batch line creation by computed method).
 *
 * Hard scope reminders (mirrors the design):
 *   * `expense_allocation.view`   gates the four GETs **and** the
 *     read-only preview endpoint (the server enforces this).
 *   * `expense_allocation.manage` gates every write endpoint below
 *     including save-preview; callers should also defense-in-depth
 *     with hasPermission(...) before rendering write controls.
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

// ─── Preview / Save-Preview DTOs (PR-FE-C) ─────────────────────────
//
// Engine-driven batch allocation.  Preview is a pure read; save-
// preview materializes the proposal into `expense_allocation_lines`
// rows for a draft period.  The backend service is at
// `backend/src/expense-allocations/expense-allocations.service.ts`
// (`previewAllocation` / `saveAllocationPreview`); response field
// names + decimal precisions verified there before this file was
// written.

export type PreviewMethod =
  | 'by_revenue'
  | 'by_units_sold'
  | 'by_gross_profit';

export type PreviewTargetKind = 'product' | 'category' | 'warehouse';

export interface PreviewBody {
  /** Exactly one of expense_id / expense_category_id; backend XORs. */
  source: {
    expense_id?: string;
    expense_category_id?: string;
  };
  target_kind: PreviewTargetKind;
  method: PreviewMethod;
}

export interface SavePreviewBody extends PreviewBody {
  /** Default false.  When true, clears all existing lines on the
   *  draft inside the same transaction before inserting the new
   *  ones.  When false, the backend rejects with 400 if any lines
   *  already exist (see ../components/expense-allocations/modals/
   *  PreviewWizardModal — the replace-confirmation step retries
   *  with this flag set to true). */
  replace_existing?: boolean;
}

export interface PreviewProposedLine {
  target_kind: PreviewTargetKind;
  target_id: string;
  target_name: string;
  /** Numeric 6dp — the per-target basis (revenue / units / profit). */
  basis_value: string;
  /** Numeric 6dp — the grand total of all candidates' basis values. */
  weight_basis_total: string;
  /** Numeric 4dp percentage, e.g. "25.5000". */
  weight_pct: string;
  /** Numeric 2dp — what would be saved as allocated_amount. */
  proposed_amount: string;
}

export interface PreviewResult {
  period_id: string;
  method: PreviewMethod;
  target_kind: PreviewTargetKind;
  source: {
    expense_id: string | null;
    expense_category_id: string | null;
    /** Numeric 2dp — total source amount being distributed. */
    amount: string;
  };
  period_scope: {
    from: string | null;
    to: string | null;
    warehouse_id: string | null;
  };
  candidates_total: number;
  candidates_excluded: number;
  /** Numeric 6dp. */
  total_basis: string;
  /** Numeric 2dp.  Sum of distributed proposed_amount typically
   *  matches source.amount; the rounding_residual goes onto one
   *  target (see rounding_residual_absorbed_into_target_id). */
  rounding_residual: string;
  /** UUID of the target row that absorbed the rounding residual,
   *  or null when there's no residual. */
  rounding_residual_absorbed_into_target_id: string | null;
  /** Arabic warning message when no candidate has a positive basis;
   *  null on the happy path.  When present, proposed_lines is empty
   *  and the FE must hide the Save button. */
  zero_basis_warning: string | null;
  proposed_lines: PreviewProposedLine[];
}

export interface SavePreviewResult extends PreviewResult {
  saved_count: number;
  /** Numeric 2dp — equals source.amount after save. */
  total_allocated: string;
  /** Echoes the flag the caller sent. */
  replace_existing: boolean;
  /** 0 when replace_existing=false; otherwise the number of lines
   *  that were cleared before the new ones were inserted. */
  existing_lines_deleted: number;
  /** ID of the actual saved line that absorbed the residual (if
   *  any).  Distinct from the *_target_id above, which is the
   *  product/category/warehouse id. */
  rounding_residual_absorbed_into_line_id: string | null;
  /** The newly saved lines, with their DB-issued ids and the
   *  full computed values. */
  lines: Array<{
    id: string;
    target_kind: PreviewTargetKind;
    target_id: string;
    target_name: string;
    basis_value: string;
    weight_basis_total: string;
    weight_pct: string;
    source_amount: string;
    allocated_amount: string;
  }>;
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

  // ─── Preview / Save-Preview — PR-FE-C ───────────────────────────
  //
  // Preview is server-side `.view` (read-only compute, no DB writes).
  // Save-preview is `.manage` and draft-only (writes a batch of
  // allocation_lines computed by the engine).

  /** POST /api/v1/expense-allocations/periods/:id/preview */
  previewAllocation: (id: string, body: PreviewBody) =>
    unwrap<PreviewResult>(
      api.post(
        `/expense-allocations/periods/${encodeURIComponent(id)}/preview`,
        body,
      ),
    ),

  /** POST /api/v1/expense-allocations/periods/:id/save-preview */
  savePreview: (id: string, body: SavePreviewBody) =>
    unwrap<SavePreviewResult>(
      api.post(
        `/expense-allocations/periods/${encodeURIComponent(id)}/save-preview`,
        body,
      ),
    ),
};
