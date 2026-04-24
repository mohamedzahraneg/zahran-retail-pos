-- Migration 080 — Exclude voided source rows from v_employee_ledger.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   v_employee_ledger (migration 060) UNIONs the four employee source
--   tables — employee_deductions, expenses(is_advance=TRUE),
--   employee_settlements, employee_bonuses — to power the secondary
--   "سجل العمليات الأصلي" section on the Employee Financial Profile.
--
--   None of the four legs filtered on `is_void`. After admin voids
--   (PR #82/#84/#85), the voided source rows kept appearing in
--   the breakdown section — confusing because the canonical
--   headline (gl_balance) correctly excludes them via the migration
--   079 view fix, but the secondary totals still included them.
--
-- Fix
--
--   Redefine v_employee_ledger with `WHERE NOT is_void` on every
--   source-table leg that has the column (deductions, settlements,
--   bonuses). Expenses doesn't have an is_void flag — we check that
--   the linked JE isn't voided instead (advance rows have no direct
--   JE on expenses table, but the reclass-to-1123 chain produces a
--   JE per expense; we filter on that JE's is_void status via a
--   JOIN).
--
--   Actually — simpler: since admin-void for expenses isn't exposed
--   via the UI yet, live expenses(is_advance=TRUE) rows are never
--   voided today. Leaving the expenses leg untouched preserves
--   behaviour. If/when a direct expense-void endpoint lands, this
--   view will need a matching refresh.
--
-- What this migration does NOT touch
--   * Underlying tables (no row edited)
--   * journal_entries / journal_lines
--   * Aggregates computed outside the view (those are fixed in the
--     companion backend change)
--   * Accounting logic
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE VIEW v_employee_ledger AS
SELECT d.user_id,
       d.deduction_date AS event_date,
       d.created_at,
       CASE d.source
         WHEN 'shift_shortage' THEN 'shift_shortage'
         WHEN 'advance'        THEN 'advance'
         WHEN 'penalty'        THEN 'penalty'
         ELSE 'deduction'
       END AS entry_type,
       d.reason AS description,
       CASE WHEN d.is_recoverable THEN d.amount ELSE 0::numeric END
         ::numeric(14,2) AS amount_owed_delta,
       d.amount AS gross_amount,
       'deduction'::text AS reference_type,
       d.id::text AS reference_id,
       d.shift_id,
       d.journal_entry_id,
       d.notes,
       d.created_by
  FROM employee_deductions d
 WHERE NOT d.is_void
UNION ALL
SELECT e.employee_user_id AS user_id,
       e.expense_date AS event_date,
       e.created_at,
       'advance'::text AS entry_type,
       COALESCE(e.description, 'سلفة نقدية'::text) AS description,
       e.amount AS amount_owed_delta,
       e.amount AS gross_amount,
       'expense'::text AS reference_type,
       e.id::text AS reference_id,
       NULL::uuid AS shift_id,
       NULL::uuid AS journal_entry_id,
       e.description AS notes,
       e.created_by
  FROM expenses e
 WHERE e.is_advance = TRUE
   AND e.employee_user_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM employee_deductions ed
      WHERE ed.source = 'advance' AND ed.shift_id IS NULL
        AND ed.user_id = e.employee_user_id
        AND ed.deduction_date = e.expense_date
        AND ed.amount = e.amount
   )
UNION ALL
SELECT s.user_id,
       s.settlement_date AS event_date,
       s.created_at,
       'settlement'::text AS entry_type,
       COALESCE(s.notes, 'سداد من الموظف'::text) AS description,
       (- s.amount)::numeric(14,2) AS amount_owed_delta,
       s.amount AS gross_amount,
       'settlement'::text AS reference_type,
       s.id::text AS reference_id,
       NULL::uuid AS shift_id,
       s.journal_entry_id,
       s.notes,
       s.created_by
  FROM employee_settlements s
 WHERE NOT s.is_void
UNION ALL
SELECT b.user_id,
       b.bonus_date AS event_date,
       b.created_at,
       'bonus'::text AS entry_type,
       COALESCE(b.note, 'حافز'::text) AS description,
       0::numeric(14,2) AS amount_owed_delta,
       b.amount AS gross_amount,
       'bonus'::text AS reference_type,
       b.id::text AS reference_id,
       NULL::uuid AS shift_id,
       NULL::uuid AS journal_entry_id,
       b.note AS notes,
       b.created_by
  FROM employee_bonuses b
 WHERE NOT b.is_void;

COMMENT ON VIEW v_employee_ledger IS
  'Source-table ledger for Employee Financial Profile secondary breakdown. Excludes voided rows on deductions / settlements / bonuses. Expenses leg (advances) has no is_void column today — those never get voided via the current UI. This view is NOT the canonical balance source — use v_employee_gl_balance for that.';

COMMIT;
