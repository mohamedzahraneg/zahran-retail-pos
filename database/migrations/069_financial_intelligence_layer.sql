-- Migration 069: Financial Intelligence Layer (read-only views + detection)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Additive observability. No change to posting logic, no mutation of
-- financial tables. Adds:
--
--   1. v_employee_risk_score — per-employee 30-day rollup of shift
--      shortages, cashbox advances, manual deductions, settlements,
--      and a composite risk score 0–100.
--
--   2. v_shift_accuracy_score — per-shift accuracy rating based on
--      variance / expected_closing ratio. Shift with variance ≤ 1%
--      of expected = HIGH accuracy; > 5% = LOW.
--
--   3. v_cash_position — current-vs-expected rollup for the live
--      cash dashboard. Powers the "Cash balance vs expected" tile.
--
--   4. v_daily_pnl — per-day revenue (411) − expenses (5xx) rollup
--      over the last 30 days.
--
-- INVARIANTS:
--   * READ-ONLY views only. No triggers, no mutations.
--   * Idempotent (CREATE OR REPLACE).
--   * Referenced by FinancialHealthService's new endpoints, not by
--     any posting path.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. v_employee_risk_score ───────────────────────────────────────────
-- Composite risk: repeated shortages weigh heaviest; unresolved
-- outstanding balance adds to the score; recent settlements reduce it.
-- Scale 0–100 where 100 = highest risk.
CREATE OR REPLACE VIEW v_employee_risk_score AS
WITH base AS (
  SELECT
    u.id                                                  AS user_id,
    u.username, u.full_name, u.employee_no,
    -- Shift shortages charged to this employee in last 30 days
    (SELECT COUNT(*) FROM employee_deductions d
       WHERE d.user_id = u.id
         AND d.source = 'shift_shortage'
         AND d.deduction_date > NOW() - INTERVAL '30 days') AS shortage_count_30d,
    (SELECT COALESCE(SUM(amount),0) FROM employee_deductions d
       WHERE d.user_id = u.id
         AND d.source = 'shift_shortage'
         AND d.deduction_date > NOW() - INTERVAL '30 days') AS shortage_total_30d,
    -- All deductions (shortage + manual + advances) 30 days
    (SELECT COUNT(*) FROM employee_deductions d
       WHERE d.user_id = u.id
         AND d.deduction_date > NOW() - INTERVAL '30 days') AS deduction_count_30d,
    -- Cashbox advances (is_advance=true) 30 days
    (SELECT COALESCE(SUM(amount),0) FROM expenses e
       WHERE e.employee_user_id = u.id
         AND e.is_advance = TRUE
         AND e.expense_date > NOW() - INTERVAL '30 days') AS advances_total_30d,
    -- Settlements paid (reduces risk)
    (SELECT COALESCE(SUM(amount),0) FROM employee_settlements s
       WHERE s.user_id = u.id
         AND s.settlement_date > NOW() - INTERVAL '30 days') AS settlements_total_30d,
    -- Current outstanding (from v_employee_ledger)
    COALESCE((SELECT SUM(amount_owed_delta) FROM v_employee_ledger
               WHERE user_id = u.id), 0) AS outstanding_balance
  FROM users u
  WHERE u.is_active = TRUE
)
SELECT
  user_id, username, full_name, employee_no,
  shortage_count_30d,
  shortage_total_30d::numeric(14,2)    AS shortage_total_30d,
  deduction_count_30d,
  advances_total_30d::numeric(14,2)    AS advances_total_30d,
  settlements_total_30d::numeric(14,2) AS settlements_total_30d,
  outstanding_balance::numeric(14,2)   AS outstanding_balance,
  -- Composite score. Tuned so:
  --   * 3+ shortages in 30d pushes past 60 (HIGH)
  --   * 1 shortage + outstanding balance < 100 → around 20-30 (MEDIUM)
  --   * no shortages + balanced = 0-10 (LOW)
  LEAST(100, GREATEST(0,
    (shortage_count_30d * 20)
    + LEAST(30, shortage_total_30d / 100)
    + LEAST(20, outstanding_balance / 200)
    - LEAST(20, settlements_total_30d / 100)
  ))::numeric(5,2) AS risk_score,
  CASE
    WHEN shortage_count_30d >= 3              THEN 'critical'
    WHEN shortage_count_30d >= 1
      OR outstanding_balance > 500            THEN 'high'
    WHEN outstanding_balance > 100
      OR advances_total_30d > 500             THEN 'medium'
    ELSE                                           'low'
  END::text AS risk_level
FROM base;

COMMENT ON VIEW v_employee_risk_score IS
  'Per-employee risk rollup (last 30 days). Powers the intelligence panel on the financial dashboard. Composite score 0–100 weighting shortage frequency, outstanding balance, and settlement activity.';

-- ─── 2. v_shift_accuracy_score ───────────────────────────────────────────
CREATE OR REPLACE VIEW v_shift_accuracy_score AS
SELECT
  s.id                                                    AS shift_id,
  s.shift_no,
  s.opened_at,
  s.closed_at,
  s.opened_by,
  ou.full_name                                            AS opened_by_name,
  s.cashbox_id,
  s.expected_closing::numeric(14,2)                      AS expected_closing,
  s.actual_closing::numeric(14,2)                        AS actual_closing,
  s.variance_amount::numeric(14,2)                       AS variance_amount,
  s.variance_type,
  s.variance_treatment,
  -- Accuracy % = 100 - |variance| / expected × 100
  CASE
    WHEN s.expected_closing IS NULL OR s.expected_closing = 0 THEN NULL
    ELSE GREATEST(0, 100 - ABS(s.variance_amount) / s.expected_closing * 100)::numeric(5,2)
  END AS accuracy_pct,
  CASE
    WHEN s.expected_closing IS NULL OR s.expected_closing = 0       THEN 'n/a'
    WHEN ABS(s.variance_amount) / s.expected_closing <= 0.01        THEN 'high'
    WHEN ABS(s.variance_amount) / s.expected_closing <= 0.05        THEN 'medium'
    ELSE                                                                 'low'
  END AS accuracy_level,
  s.status
FROM shifts s
LEFT JOIN users ou ON ou.id = s.opened_by
WHERE s.status = 'closed';

COMMENT ON VIEW v_shift_accuracy_score IS
  'Per-shift accuracy (post-close). HIGH = variance ≤ 1% of expected, MEDIUM ≤ 5%, LOW > 5%.';

-- ─── 3. v_cash_position (current vs expected live) ───────────────────────
CREATE OR REPLACE VIEW v_cash_position AS
SELECT
  cb.id                                                  AS cashbox_id,
  cb.name_ar,
  cb.kind,
  cb.current_balance::numeric(14,2)                      AS stored_balance,
  (COALESCE(cb.opening_balance, 0)
   + COALESCE((
       SELECT SUM(CASE WHEN direction='in' THEN amount ELSE -amount END)
         FROM cashbox_transactions ct
        WHERE ct.cashbox_id = cb.id AND NOT ct.is_void
     ), 0))::numeric(14,2)                               AS computed_balance,
  (cb.current_balance
   - (COALESCE(cb.opening_balance, 0)
      + COALESCE((
          SELECT SUM(CASE WHEN direction='in' THEN amount ELSE -amount END)
            FROM cashbox_transactions ct
           WHERE ct.cashbox_id = cb.id AND NOT ct.is_void
        ), 0))
  )::numeric(14,2)                                       AS drift,
  -- Open shift for this cashbox, if any
  (SELECT s.shift_no FROM shifts s
    WHERE s.cashbox_id = cb.id AND s.status = 'open'
    ORDER BY s.opened_at DESC LIMIT 1)                   AS open_shift_no,
  (SELECT s.expected_closing FROM shifts s
    WHERE s.cashbox_id = cb.id AND s.status = 'open'
    ORDER BY s.opened_at DESC LIMIT 1)::numeric(14,2)    AS open_shift_expected,
  cb.is_active
FROM cashboxes cb
WHERE cb.is_active = TRUE;

COMMENT ON VIEW v_cash_position IS
  'Live cash position per cashbox: stored balance, computed balance from ledger, drift, and any open-shift expected closing.';

-- ─── 4. v_daily_pnl — per-day revenue vs expense ────────────────────────
CREATE OR REPLACE VIEW v_daily_pnl AS
WITH day_series AS (
  SELECT generate_series(
    (CURRENT_DATE - INTERVAL '30 days')::date,
    CURRENT_DATE::date,
    INTERVAL '1 day'
  )::date AS day
),
revenue_by_day AS (
  SELECT je.entry_date::date AS day,
         COALESCE(SUM(jl.credit), 0)::numeric(14,2) AS revenue
    FROM journal_entries je
    JOIN journal_lines  jl ON jl.entry_id = je.id
    JOIN chart_of_accounts a ON a.id = jl.account_id
   WHERE je.is_posted AND NOT je.is_void
     AND a.account_type = 'revenue'
     AND jl.credit > 0
     AND je.entry_date >= CURRENT_DATE - INTERVAL '30 days'
   GROUP BY 1
),
expense_by_day AS (
  SELECT je.entry_date::date AS day,
         COALESCE(SUM(jl.debit), 0)::numeric(14,2) AS expense
    FROM journal_entries je
    JOIN journal_lines  jl ON jl.entry_id = je.id
    JOIN chart_of_accounts a ON a.id = jl.account_id
   WHERE je.is_posted AND NOT je.is_void
     AND a.account_type = 'expense'
     AND jl.debit > 0
     AND je.entry_date >= CURRENT_DATE - INTERVAL '30 days'
   GROUP BY 1
)
SELECT
  d.day,
  COALESCE(r.revenue, 0)::numeric(14,2) AS revenue,
  COALESCE(e.expense, 0)::numeric(14,2) AS expense,
  (COALESCE(r.revenue, 0) - COALESCE(e.expense, 0))::numeric(14,2) AS net_pnl
FROM day_series d
LEFT JOIN revenue_by_day r ON r.day = d.day
LEFT JOIN expense_by_day e ON e.day = d.day
ORDER BY d.day DESC;

COMMENT ON VIEW v_daily_pnl IS
  'Last 30 days revenue vs expense rollup — powers the daily P&L sparkline.';

COMMIT;
