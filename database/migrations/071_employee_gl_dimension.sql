-- Migration 071: add `employee_user_id` dimension to journal_lines
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Architectural move: make the Chart of Accounts the SINGLE source of truth
-- for per-employee balances. Today the payroll page aggregates across 5
-- tables (employee_deductions, employee_bonuses, employee_settlements,
-- advance expenses, employee_transactions). After this migration the
-- canonical path is:
--
--   every employee-related GL line  →  journal_lines row
--                                       ↑ tagged with employee_user_id
--   per-employee balance             →  SUM(debit)-SUM(credit) on account 1123
--                                       WHERE employee_user_id = <u>
--
-- This migration is purely ADDITIVE:
--   * journal_lines gains a nullable `employee_user_id` FK column.
--   * Existing historic rows stay untagged (NULL). No retroactive GL
--     writes — all legacy data remains in its source tables as
--     immutable record.
--   * New view `v_employee_gl_balance` aggregates per-employee on
--     account 1123 for tagged lines only.
--
-- Going-forward (code PR): the engine will populate `employee_user_id`
-- on lines whose caller supplied an `employee_id` — shift shortages
-- charged to employees, employee settlement payments, and cash
-- advances booked against an employee.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. add the dimension column + FK + index ───────────────────────────
ALTER TABLE journal_lines
  ADD COLUMN IF NOT EXISTS employee_user_id UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS ix_journal_lines_employee
  ON journal_lines(employee_user_id)
  WHERE employee_user_id IS NOT NULL;

-- ─── 2. v_employee_gl_balance ────────────────────────────────────────────
-- Sums DR/CR on the Employee Receivables account (COA 1123) per
-- employee. Positive `balance` = employee owes the company.
-- Only reads LIVE (posted, non-void) rows.
CREATE OR REPLACE VIEW v_employee_gl_balance AS
SELECT
  u.id                                                  AS employee_user_id,
  u.username,
  COALESCE(u.full_name, u.username)                    AS employee_name,
  u.employee_no,
  COALESCE(SUM(jl.debit),  0)::numeric(14,2)           AS debit_total,
  COALESCE(SUM(jl.credit), 0)::numeric(14,2)           AS credit_total,
  (COALESCE(SUM(jl.debit), 0)
   - COALESCE(SUM(jl.credit), 0))::numeric(14,2)       AS balance,
  COUNT(DISTINCT jl.entry_id)::int                     AS entry_count,
  MAX(je.entry_date)                                   AS last_entry_date
FROM users u
LEFT JOIN journal_lines jl
       ON jl.employee_user_id = u.id
LEFT JOIN journal_entries je
       ON je.id = jl.entry_id
      AND je.is_posted = TRUE
      AND je.is_void   = FALSE
LEFT JOIN chart_of_accounts a
       ON a.id = jl.account_id
      AND a.code = '1123'   -- ذمم الموظفين — the canonical home
WHERE u.is_active = TRUE
GROUP BY u.id, u.username, u.full_name, u.employee_no;

COMMENT ON VIEW v_employee_gl_balance IS
  'Per-employee balance on COA 1123 (ذمم الموظفين). Lines are tagged by the engine via journal_lines.employee_user_id. Only posted non-void lines included.';

COMMIT;
