-- =============================================================================
--  employee-wage-vs-advance-audit.sql — read-only daily reconciliation of
--  per-employee wage approvals vs cash advances vs settlements.
--
--  Surfaces (employee, work_date) pairs where the system created a cash
--  advance (DR 1123 / CR cashbox) but the operator may have intended a
--  wage settlement (DR 213 / CR cashbox). Same audit that flagged
--  Mohamed El-Zebaty 2026-04-25 + 04-22 + Abu Youssef 04-22 in the
--  PR-T6.1 audit (2026-04-26).
--
--  Usage:
--    psql "$DATABASE_URL" -X -f scripts/employee-wage-vs-advance-audit.sql
--
--  Output columns
--    employee, employee_id, work_date
--    wage_active_count, wage_active_amount    ← active employee_payable_days
--    wage_voided_count                        ← cleanup / re-approval rollback
--    advance_count, advance_amount            ← expense.is_advance=TRUE for him
--    advance_is_auto_zeyada                   ← description includes
--                                                "زيادة عن اليومية" (auto path)
--    settlement_count, settlement_amount      ← active employee_settlements
--    wage_je_nos / advance_expense_nos /
--    advance_je_nos / settlement_je_nos       ← reference numbers for triage
--    classification:
--      OK_wage_settled                — wage approved AND settled cleanly
--      OK_wage_only_unpaid            — wage approved, no payout yet
--      OK_advance_only                — advance only, no wage approval
--                                       (genuine "borrow from till")
--      OK_other                       — only voided rows (test cleanup)
--      REVIEW_wage_paid_as_advance    — wage exists AND advance same day,
--                                       no settlement → likely should
--                                       have been a settlement
--      REVIEW_advance_no_wage         — advance exists, no wage that day
--                                       → operator may have skipped
--                                       approving the wage first
--
--  PR-T6.1 — read-only. Does NOT mutate any data.
-- =============================================================================

WITH wage_active AS (
  SELECT pd.user_id, pd.work_date::date AS d,
         COUNT(*) AS n, SUM(pd.amount_accrued)::numeric(18, 2) AS amt,
         string_agg(je.entry_no, '; ') AS je_nos
    FROM employee_payable_days pd
    LEFT JOIN journal_entries je ON je.id = pd.journal_entry_id
   WHERE pd.is_void = FALSE
   GROUP BY pd.user_id, pd.work_date::date
),
wage_voided AS (
  SELECT pd.user_id, pd.work_date::date AS d,
         COUNT(*) AS n, SUM(pd.amount_accrued)::numeric(18, 2) AS amt
    FROM employee_payable_days pd
   WHERE pd.is_void = TRUE
   GROUP BY pd.user_id, pd.work_date::date
),
adv_active AS (
  SELECT e.employee_user_id AS user_id, e.expense_date::date AS d,
         COUNT(*) AS n, SUM(e.amount)::numeric(18, 2) AS amt,
         string_agg(
           e.expense_no || ' (' ||
           COALESCE(e.shift_id::text, 'no-shift') || ')',
           '; '
         ) AS exp_nos,
         string_agg(je.entry_no, '; ') AS je_nos,
         bool_or(e.description ILIKE '%زيادة عن اليومية%') AS has_auto_label
    FROM expenses e
    LEFT JOIN journal_entries je
           ON je.reference_type::text = 'expense'
          AND je.reference_id = e.id
          AND je.is_void = FALSE
   WHERE e.employee_user_id IS NOT NULL
     AND e.is_advance = TRUE
     AND EXISTS (
       SELECT 1 FROM journal_entries jx
        WHERE jx.reference_type::text = 'expense'
          AND jx.reference_id = e.id
          AND jx.is_void = FALSE
     )
   GROUP BY e.employee_user_id, e.expense_date::date
),
sett_active AS (
  SELECT s.user_id, s.settlement_date::date AS d,
         COUNT(*) AS n, SUM(s.amount)::numeric(18, 2) AS amt,
         string_agg(je.entry_no, '; ') AS je_nos
    FROM employee_settlements s
    LEFT JOIN journal_entries je
           ON je.reference_type::text = 'employee_settlement'
          AND je.reference_id::text   = s.id::text
          AND je.is_void = FALSE
   WHERE COALESCE(s.is_void, FALSE) = FALSE
   GROUP BY s.user_id, s.settlement_date::date
),
keys AS (
  SELECT DISTINCT user_id, d FROM wage_active
  UNION SELECT user_id, d FROM wage_voided
  UNION SELECT user_id, d FROM adv_active
  UNION SELECT user_id, d FROM sett_active
)
SELECT
  u.full_name                                       AS employee,
  k.user_id                                         AS employee_id,
  k.d                                               AS work_date,
  COALESCE(wa.n, 0)                                 AS wage_active_count,
  COALESCE(wa.amt, 0)::numeric(18, 2)               AS wage_active_amount,
  COALESCE(wv.n, 0)                                 AS wage_voided_count,
  COALESCE(aa.n, 0)                                 AS advance_count,
  COALESCE(aa.amt, 0)::numeric(18, 2)               AS advance_amount,
  COALESCE(aa.has_auto_label, FALSE)                AS advance_is_auto_zeyada,
  COALESCE(sa.n, 0)                                 AS settlement_count,
  COALESCE(sa.amt, 0)::numeric(18, 2)               AS settlement_amount,
  COALESCE(wa.je_nos, '')                           AS wage_je_nos,
  COALESCE(aa.exp_nos, '')                          AS advance_expense_nos,
  COALESCE(aa.je_nos, '')                           AS advance_je_nos,
  COALESCE(sa.je_nos, '')                           AS settlement_je_nos,
  CASE
    WHEN COALESCE(wa.n, 0) > 0
      AND COALESCE(sa.n, 0) = 0
      AND COALESCE(aa.n, 0) > 0
        THEN 'REVIEW_wage_paid_as_advance'
    WHEN COALESCE(aa.n, 0) > 0 AND COALESCE(wa.n, 0) = 0
        THEN 'REVIEW_advance_no_wage'
    WHEN COALESCE(wa.n, 0) > 0 AND COALESCE(sa.n, 0) > 0
        THEN 'OK_wage_settled'
    WHEN COALESCE(wa.n, 0) > 0
      AND COALESCE(sa.n, 0) = 0
      AND COALESCE(aa.n, 0) = 0
        THEN 'OK_wage_only_unpaid'
    WHEN COALESCE(aa.n, 0) > 0 AND COALESCE(wa.n, 0) = 0
        THEN 'OK_advance_only'
    ELSE 'OK_other'
  END                                               AS classification
FROM keys k
JOIN users u             ON u.id = k.user_id
LEFT JOIN wage_active wa ON wa.user_id = k.user_id AND wa.d = k.d
LEFT JOIN wage_voided wv ON wv.user_id = k.user_id AND wv.d = k.d
LEFT JOIN adv_active  aa ON aa.user_id = k.user_id AND aa.d = k.d
LEFT JOIN sett_active sa ON sa.user_id = k.user_id AND sa.d = k.d
ORDER BY classification DESC, k.d DESC, u.full_name;
