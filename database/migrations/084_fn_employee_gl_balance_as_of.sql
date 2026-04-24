-- Migration 084 — fn_employee_gl_balance_as_of(as_of_date) for monthly cards.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   v_employee_gl_balance (migration 079) returns the *current* GL
--   snapshot. The new monthly Employee Profile needs both an opening
--   and a closing balance per selected month — i.e. the GL balance
--   truncated at a specific entry_date.
--
--   Rather than adding a view with a date parameter (views can't take
--   arguments in Postgres), ship a function. Same scope, same filters
--   as the view (accounts 1123 + 213, posted + non-void), plus an
--   `entry_date <= as_of_date` cutoff.
--
-- Callers
--
--   * EmployeesService.dashboard(month) — opening = as_of(monthStart −
--     1 day); closing = as_of(monthEnd).
--   * EmployeesService.financialLedger() — same.
--
--   Read-only; does not touch schema or any row.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_employee_gl_balance_as_of(
    p_user_id     uuid,
    p_as_of_date  date
) RETURNS numeric
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(SUM(jl.debit), 0)::numeric(14,2)
         - COALESCE(SUM(jl.credit), 0)::numeric(14,2)
      FROM journal_lines   jl
      JOIN journal_entries je  ON je.id = jl.entry_id
      JOIN chart_of_accounts a ON a.id = jl.account_id
     WHERE COALESCE(jl.employee_user_id, jl.employee_id) = p_user_id
       AND a.code IN ('1123', '213')
       AND je.is_posted = TRUE
       AND je.is_void   = FALSE
       AND je.entry_date <= p_as_of_date;
$$;

COMMENT ON FUNCTION public.fn_employee_gl_balance_as_of(uuid, date) IS
  'Per-employee GL balance truncated at p_as_of_date. Same scope as v_employee_gl_balance (COA 1123 + 213, posted + non-void JEs) but lets callers ask for opening/closing balances around a monthly window. Positive = employee owes company.';

COMMIT;
