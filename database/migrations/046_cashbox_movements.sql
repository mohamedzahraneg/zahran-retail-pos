-- Migration 046: unified cashbox movement feed + extended cashflow_today view
-- ---------------------------------------------------------------------------
-- 1) Extend v_dashboard_cashflow_today so the frontend can read either
--    `cash_in_today`/`cash_out_today` OR `inflows_total`/`outflows_total`.
--    (The old frontend used the second pair; the view never shipped them.
--    Silently returning zero KPIs made the cashbox screen useless.)
-- 2) Add v_cashbox_movements: a chronological, enriched list of every cash
--    transaction with a human-readable "what was this for?" column so the
--    cashbox movement tab can render it without extra joins.
-- 3) Shift-variance tile: expose a tiny view so the cashbox header can
--    show the net surplus/deficit accumulated across closed shifts.

BEGIN;

-- ── (1) Cashflow today view ──────────────────────────────────────────────
DROP VIEW IF EXISTS v_dashboard_cashflow_today CASCADE;
CREATE VIEW v_dashboard_cashflow_today AS
SELECT
  cb.id                                  AS cashbox_id,
  cb.name_ar                             AS cashbox_name,
  cb.current_balance,
  COALESCE(SUM(ct.amount) FILTER (
    WHERE ct.direction = 'in'
      AND DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
  ), 0)::numeric(14,2)                   AS cash_in_today,
  COALESCE(SUM(ct.amount) FILTER (
    WHERE ct.direction = 'out'
      AND DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
  ), 0)::numeric(14,2)                   AS cash_out_today,
  -- Legacy aliases used by the frontend before migration 046.
  COALESCE(SUM(ct.amount) FILTER (
    WHERE ct.direction = 'in'
      AND DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
  ), 0)::numeric(14,2)                   AS inflows_total,
  COALESCE(SUM(ct.amount) FILTER (
    WHERE ct.direction = 'out'
      AND DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
  ), 0)::numeric(14,2)                   AS outflows_total,
  COUNT(*) FILTER (
    WHERE DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
  )                                      AS transactions_today
FROM cashboxes cb
LEFT JOIN cashbox_transactions ct ON ct.cashbox_id = cb.id
WHERE cb.is_active = TRUE
GROUP BY cb.id, cb.name_ar, cb.current_balance
ORDER BY cb.name_ar;

COMMENT ON VIEW v_dashboard_cashflow_today IS
  'Today''s in/out per cashbox. Exposes both cash_in_today/cash_out_today and inflows_total/outflows_total for frontend compatibility.';

-- ── (2) Unified movement feed ───────────────────────────────────────────
-- One row per cashbox transaction, enriched with a concrete "who/what"
-- label based on the reference_type. The frontend can render this
-- table as-is without needing to look up each referenced entity.
DROP VIEW IF EXISTS v_cashbox_movements CASCADE;
CREATE VIEW v_cashbox_movements AS
SELECT
  t.id,
  t.cashbox_id,
  cb.name_ar                             AS cashbox_name,
  t.direction::text                      AS direction,
  t.amount::numeric(14,2)                AS amount,
  t.category::text                       AS category,
  t.reference_type::text                 AS reference_type,
  t.reference_id,
  t.balance_after::numeric(14,2)         AS balance_after,
  t.notes,
  t.user_id,
  u.full_name                            AS user_name,
  t.created_at,
  -- Arabic short label for the "kind" column in the UI.
  CASE t.category
    WHEN 'customer_receipt'   THEN 'قبض من عميل'
    WHEN 'supplier_payment'   THEN 'صرف لمورد'
    WHEN 'expense'            THEN 'مصروف'
    WHEN 'invoice_cash'       THEN 'مبيعات كاش'
    WHEN 'invoice_refund'     THEN 'مرتجع'
    WHEN 'opening_balance'    THEN 'رصيد افتتاحي'
    WHEN 'owner_topup'        THEN 'تمويل من المالك'
    WHEN 'bank_deposit'       THEN 'إيداع بنكي'
    WHEN 'manual_deposit'     THEN 'إيداع يدوي'
    WHEN 'manual_withdraw'    THEN 'سحب يدوي'
    WHEN 'adjustment'         THEN 'تسوية'
    WHEN 'payment'            THEN 'دفعة'
    WHEN 'receipt'            THEN 'سند قبض'
    WHEN 'purchase'           THEN 'شراء'
    ELSE COALESCE(t.category, 'أخرى')
  END                                    AS kind_ar,
  -- Human reference — invoice_no, expense_no, supplier/customer name.
  COALESCE(
    (SELECT i.invoice_no FROM invoices i WHERE i.id = t.reference_id),
    (SELECT e.expense_no FROM expenses e WHERE e.id = t.reference_id),
    (SELECT cp.payment_no FROM customer_payments cp WHERE cp.id = t.reference_id),
    (SELECT sp.payment_no FROM supplier_payments sp WHERE sp.id = t.reference_id),
    (SELECT p.purchase_no FROM purchases p WHERE p.id = t.reference_id)
  )                                      AS reference_no,
  COALESCE(
    (SELECT c.full_name FROM customers c
       JOIN customer_payments cp ON cp.customer_id = c.id
      WHERE cp.id = t.reference_id),
    (SELECT s.name FROM suppliers s
       JOIN supplier_payments sp ON sp.supplier_id = s.id
      WHERE sp.id = t.reference_id),
    (SELECT s.name FROM suppliers s
       JOIN purchases p ON p.supplier_id = s.id
      WHERE p.id = t.reference_id)
  )                                      AS counterparty_name
FROM cashbox_transactions t
LEFT JOIN cashboxes cb ON cb.id = t.cashbox_id
LEFT JOIN users     u  ON u.id  = t.user_id;

COMMENT ON VIEW v_cashbox_movements IS
  'Chronological cashbox movement feed with human labels and reference numbers for the cashbox movement tab.';

-- ── (3) Shift variances tile ───────────────────────────────────────────
-- Totals only CLOSED shifts — pending_close are not yet committed.
DROP VIEW IF EXISTS v_shift_variances CASCADE;
CREATE VIEW v_shift_variances AS
SELECT
  COALESCE(SUM(actual_closing - expected_closing), 0)::numeric(14,2) AS net_variance,
  COALESCE(SUM(GREATEST(actual_closing - expected_closing, 0)), 0)::numeric(14,2) AS total_surplus,
  COALESCE(SUM(GREATEST(expected_closing - actual_closing, 0)), 0)::numeric(14,2) AS total_deficit,
  COUNT(*) FILTER (WHERE actual_closing - expected_closing > 0.01)::int AS surplus_count,
  COUNT(*) FILTER (WHERE expected_closing - actual_closing > 0.01)::int AS deficit_count,
  COUNT(*) FILTER (WHERE ABS(actual_closing - expected_closing) <= 0.01)::int AS matched_count
FROM shifts
WHERE status = 'closed'
  AND actual_closing IS NOT NULL;

COMMENT ON VIEW v_shift_variances IS
  'Aggregate surplus/deficit across every closed shift — powers the cashbox header tile.';

COMMIT;
