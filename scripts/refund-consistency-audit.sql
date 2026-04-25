-- =============================================================================
--  refund-consistency-audit.sql — read-only check for refund/exchange
--                                  rows where the GL credited a cash-mirror
--                                  account but the cashbox_transactions
--                                  table was never updated. Such a row
--                                  desyncs GL cash (account 111x) from
--                                  cashboxes.current_balance — invisible
--                                  to the existing trial-balance + cashbox-
--                                  drift checks because each side is
--                                  internally balanced.
--
--  Wired into weekly-drift-check.sh as check #13. Standalone callable too:
--    psql "$DATABASE_URL" -X -f scripts/refund-consistency-audit.sql
--
--  PR-R0 — read-only, surfaces the affected rows so admin can decide on
--  reconciliation in PR-R2. Does NOT mutate any data.
-- =============================================================================

-- ─── Affected rows ────────────────────────────────────────────────────────
-- For each refund/exchange JE that credits a cash-mirror account
-- (chart_of_accounts.code LIKE '111_'), confirm a matching `out` row
-- exists in cashbox_transactions tied to the same reference. When the
-- cashbox-side amount is short of the GL-side credit, the row is
-- flagged.
--
-- Output columns:
--   reference_type, reference_no, reference_id
--   refunded_at, refunded_by, customer
--   journal_entry_no, gl_cash_credit
--   cashbox_txn_count, cashbox_txn_amount
--   missing_amount  = gl_cash_credit − cashbox_txn_amount
--   suggested_action

WITH gl_cash_credits AS (
  SELECT
    je.reference_type::text                          AS reference_type,
    je.reference_id                                  AS reference_id,
    je.entry_no                                      AS journal_entry_no,
    je.created_at                                    AS je_created_at,
    SUM(jl.credit) FILTER (WHERE jl.credit > 0)::numeric AS gl_cash_credit
  FROM journal_entries je
  JOIN journal_lines    jl  ON jl.entry_id  = je.id
  JOIN chart_of_accounts coa ON coa.id      = jl.account_id
  WHERE je.is_posted = TRUE
    AND je.is_void   = FALSE
    AND coa.code LIKE '111_'              -- 1111-1115 = cash-mirror accounts
    AND je.reference_type::text IN ('return', 'exchange')
    AND je.reference_id IS NOT NULL
    AND jl.credit > 0
  GROUP BY je.reference_type, je.reference_id, je.entry_no, je.created_at
),
cashbox_outs AS (
  SELECT
    ct.reference_type::text  AS reference_type,
    ct.reference_id          AS reference_id,
    COUNT(*)::int            AS cashbox_txn_count,
    SUM(ct.amount)::numeric  AS cashbox_txn_amount
  FROM cashbox_transactions ct
  WHERE ct.direction = 'out'
    AND ct.reference_type::text IN ('return', 'exchange')
  GROUP BY ct.reference_type, ct.reference_id
)
SELECT
  g.reference_type,
  COALESCE(r.return_no, e.exchange_no)              AS reference_no,
  g.reference_id,
  COALESCE(r.refunded_at, e.completed_at)           AS refunded_at,
  COALESCE(r.refunded_by, e.handled_by)             AS refunded_by_id,
  ru.full_name                                       AS refunded_by_name,
  COALESCE(c1.full_name, c2.full_name, '—')          AS customer_name,
  g.journal_entry_no,
  g.gl_cash_credit,
  COALESCE(co.cashbox_txn_count, 0)                  AS cashbox_txn_count,
  COALESCE(co.cashbox_txn_amount, 0)::numeric        AS cashbox_txn_amount,
  (g.gl_cash_credit - COALESCE(co.cashbox_txn_amount, 0))::numeric AS missing_amount,
  CASE
    WHEN co.cashbox_txn_count IS NULL                                              THEN 'needs_cashbox_mirror'
    WHEN co.cashbox_txn_amount + 0.01 < g.gl_cash_credit                           THEN 'partial_cashbox_mirror'
    ELSE                                                                                'needs_review'
  END                                                AS suggested_action
FROM gl_cash_credits g
LEFT JOIN cashbox_outs co
       ON co.reference_type = g.reference_type
      AND co.reference_id   = g.reference_id
LEFT JOIN returns       r  ON g.reference_type = 'return'   AND r.id = g.reference_id
LEFT JOIN exchanges     e  ON g.reference_type = 'exchange' AND e.id = g.reference_id
LEFT JOIN users         ru ON ru.id = COALESCE(r.refunded_by, e.handled_by)
LEFT JOIN customers     c1 ON c1.id = r.customer_id
LEFT JOIN customers     c2 ON c2.id = e.customer_id
-- Threshold: > 0.01 EGP gap is meaningful; smaller is float noise.
WHERE COALESCE(co.cashbox_txn_amount, 0) + 0.01 < g.gl_cash_credit
ORDER BY refunded_at DESC NULLS LAST, g.journal_entry_no;
