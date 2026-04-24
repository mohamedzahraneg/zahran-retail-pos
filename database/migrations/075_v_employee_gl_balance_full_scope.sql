-- Migration 075 — broaden v_employee_gl_balance to the full employee GL scope.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   migration 071 introduced v_employee_gl_balance as the canonical
--   per-employee GL balance. The intended scope was "employee receivables
--   + payables", but the implementation had two issues:
--
--     1. The scope filter `AND a.code = '1123'` lived on a LEFT JOIN
--        condition, not a WHERE clause. Because SUM aggregates over ALL
--        joined journal_lines regardless of whether `a` matched, the
--        filter was silently inert — the view summed every
--        employee_user_id-tagged line, whatever account it sat on.
--     2. Until PR #70, only 1123 lines carried `employee_user_id`, so
--        the inert filter produced a visually correct "receivables-only"
--        balance. After PR #70 populated 213/521 lines too, the view
--        would have started mixing 521 (salary expense P&L account)
--        into the employee balance — wrong semantic.
--
--   Live comparison for the two employees with activity:
--
--     employee         current view (1123-only)   full (1123 + 213)
--     ─────────────    ────────────────────────   ──────────────────
--     ابو يوسف          +745 DR                     −1 035 (company owes him 1 035)
--     محمد الظباطي      +200 DR                     +1 840 (he owes company 1 840)
--
-- Change
--
--   CREATE OR REPLACE the view so the scope is explicitly `1123 OR 213`
--   via SUM … FILTER (WHERE …). Active users with no tagged lines still
--   show balance=0 (preserved by the outer LEFT JOIN + GROUP BY u.id).
--   521 lines (tagged incidentally by the bonus/deduction pair since
--   PR #70) are excluded — 521 is a P&L salary-expense account, not the
--   employee's balance.
--
-- Sign convention (unchanged from migration 071):
--
--   balance = SUM(debit) − SUM(credit) across 1123 + 213
--     • > 0  →  employee owes company (net receivable)
--     • < 0  →  company owes employee (net payable)
--     • = 0  →  even
--
-- API response shape: unchanged. Same 9 columns, same names, same types.
-- Only the numeric meaning of `balance` / `debit_total` / `credit_total`
-- changes — they now represent the combined 1123+213 picture.
--
-- What this migration does NOT touch
--
--   * FinancialEngine
--   * source transaction tables (employee_bonuses / _deductions / etc.)
--   * journal_entries — no row rewritten
--   * journal_lines   — no column updated (PR #70 already consistent)
--   * cashbox, balances, trial balance, drift
--   * v_employee_ledger (separate view, different purpose)
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE VIEW v_employee_gl_balance AS
SELECT
  u.id                                                  AS employee_user_id,
  u.username,
  COALESCE(u.full_name, u.username::character varying) AS employee_name,
  u.employee_no,
  COALESCE(SUM(jl.debit)  FILTER (WHERE a.code IN ('1123', '213')), 0)::numeric(14,2) AS debit_total,
  COALESCE(SUM(jl.credit) FILTER (WHERE a.code IN ('1123', '213')), 0)::numeric(14,2) AS credit_total,
  (COALESCE(SUM(jl.debit)  FILTER (WHERE a.code IN ('1123', '213')), 0)
   - COALESCE(SUM(jl.credit) FILTER (WHERE a.code IN ('1123', '213')), 0))::numeric(14,2) AS balance,
  COUNT(DISTINCT jl.entry_id) FILTER (WHERE a.code IN ('1123', '213'))::int AS entry_count,
  MAX(je.entry_date)          FILTER (WHERE a.code IN ('1123', '213')) AS last_entry_date
FROM users u
LEFT JOIN journal_lines jl
       ON jl.employee_user_id = u.id
LEFT JOIN journal_entries je
       ON je.id = jl.entry_id
      AND je.is_posted = TRUE
      AND je.is_void   = FALSE
LEFT JOIN chart_of_accounts a
       ON a.id = jl.account_id
WHERE u.is_active = TRUE
GROUP BY u.id, u.username, u.full_name, u.employee_no;

COMMENT ON VIEW v_employee_gl_balance IS
  'Per-employee net GL balance combining COA 1123 (ذمم الموظفين receivables) and 213 (مستحقات الموظفين payables). Lines are tagged by the engine + payroll stored procs via journal_lines.employee_user_id. Positive balance = employee owes company; negative = company owes employee.';

COMMIT;
