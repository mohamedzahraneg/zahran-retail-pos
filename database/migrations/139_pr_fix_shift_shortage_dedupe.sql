-- Migration 139 — PR-FIX-SHIFT-SHORTAGE-DEDUPE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Closing a shift with `variance_treatment = 'charge_employee'` was
--   producing TWO records for the same physical shortage:
--
--     1. employee_deductions  — source='shift_shortage', shift_id=…
--        Written by shifts.service.ts:close() so the employee profile's
--        Financial Ledger tab shows the row.
--
--     2. cashbox_transactions — category='shift_variance', direction='out',
--        notes='تسوية فروقات وردية …', plus a paired journal_entry
--        DR 1123 (Employee Receivable, tagged with employee_user_id) /
--        CR Cash. Written by FinancialEngine.recordShiftVariance().
--
--   Both surfaced on the employee profile — the deduction row via
--   v_employee_ledger (source-table breakdown), and the JE's 1123 line via
--   v_employee_gl_balance (canonical GL balance). Same shortage charged
--   twice in the operator's eyes.
--
--   The companion backend change (shifts.service.ts) routes the
--   `charge_employee` path through employee_deductions ONLY — no
--   recordShiftVariance call, no shift_variance CT, no employee-tagged
--   1123 JE. The existing trg_employee_deduction_post trigger
--   (migration 039 / 074) still posts the wage-side mirror
--   (DR 213 / CR 521) so v_employee_gl_balance picks the shortage up
--   through the payable account — single source of truth.
--
-- Change
--
--   Add a partial UNIQUE index on employee_deductions so retries,
--   double-clicks, or a stale request replaying after the user already
--   approved cannot create a second shortage row for the same shift.
--   The shift_id is the natural idempotency key — at most one live
--   shift_shortage deduction per shift.
--
--   Voided rows are excluded so an admin can void + re-create when
--   correcting an erroneous shortage. NULL shift_id is excluded so
--   manual deductions (source='manual'/'penalty'/'advance') stay
--   unconstrained.
--
-- Idempotency
--
--   IF NOT EXISTS guard — safe on re-run.
--
--   Pre-flight check on live (run before applying):
--     SELECT shift_id, COUNT(*)
--       FROM employee_deductions
--      WHERE source='shift_shortage' AND is_void = FALSE
--        AND shift_id IS NOT NULL
--      GROUP BY shift_id HAVING COUNT(*) > 1;
--     → must return 0 rows or the CREATE will fail.
--
--   If duplicates exist they were produced by the legacy double-write
--   path (a manual retry without idempotency). Pick one to keep, void
--   the rest with a reason explaining the dedupe, then re-run.
--
-- What this migration does NOT touch
--   * Any existing row — no UPDATE, no DELETE, no backfill.
--   * journal_entries / journal_lines — historical 1123 JE lines from
--     past `charge_employee` closes remain (the backend stops producing
--     new ones going forward; cleaning historical state is a separate
--     reconciliation task).
--   * cashbox_transactions — same; historical shift_variance CTs stay.
--   * FinancialEngine.recordShiftVariance behaviour — unchanged for
--     'company_loss' / 'revenue' / 'suspense' treatments.
--   * employee_settlements, employee_bonuses, expenses — untouched.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- One live shift_shortage deduction per shift. Voided rows are skipped
-- so re-creating after a correction works.
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_deductions_shift_shortage_live
  ON public.employee_deductions (shift_id)
  WHERE source = 'shift_shortage'
    AND is_void = FALSE
    AND shift_id IS NOT NULL;

COMMENT ON INDEX public.uq_employee_deductions_shift_shortage_live IS
  'PR-FIX-SHIFT-SHORTAGE-DEDUPE: idempotency guard for the
   charge_employee shift-close path. At most one live shift_shortage
   deduction per shift. Voided rows excluded so admin can void +
   re-create. Predicate matches the ON CONFLICT clause used by
   shifts.service.ts close().';

COMMIT;
