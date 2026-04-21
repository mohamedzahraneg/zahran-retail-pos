-- 037_fix_revenue_30d_view.sql
-- -----------------------------------------------------------------------------
-- Rebuild v_dashboard_revenue_30d so invoices × expenses can't multiply.
--
-- The previous version joined `invoices` and `expenses` directly against the
-- day series — a cartesian product. A day with N invoices and M expenses
-- reported N*M rows, so SUM(grand_total) was multiplied by M and SUM(amount)
-- by N. Users saw revenue that was exactly 2× the real figure whenever two
-- expenses were logged on the same day.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_dashboard_revenue_30d AS
WITH series AS (
    SELECT generate_series(CURRENT_DATE - INTERVAL '29 day',
                           CURRENT_DATE,
                           INTERVAL '1 day')::date AS day
),
inv AS (
    SELECT DATE(completed_at AT TIME ZONE 'Africa/Cairo') AS day,
           COALESCE(SUM(grand_total), 0)::numeric(14,2)   AS revenue,
           COALESCE(SUM(gross_profit), 0)::numeric(14,2)  AS profit,
           COUNT(*)                                        AS invoices
      FROM invoices
     WHERE status IN ('completed','paid','partially_paid')
       AND DATE(completed_at AT TIME ZONE 'Africa/Cairo')
           >= CURRENT_DATE - INTERVAL '29 day'
     GROUP BY 1
),
exp AS (
    SELECT expense_date                            AS day,
           COALESCE(SUM(amount), 0)::numeric(14,2) AS expenses
      FROM expenses
     WHERE expense_date >= CURRENT_DATE - INTERVAL '29 day'
     GROUP BY 1
)
SELECT s.day,
       COALESCE(inv.revenue,  0)::numeric(14,2) AS revenue,
       COALESCE(inv.profit,   0)::numeric(14,2) AS profit,
       COALESCE(inv.invoices, 0)                AS invoices,
       COALESCE(exp.expenses, 0)::numeric(14,2) AS expenses
  FROM series s
  LEFT JOIN inv ON inv.day = s.day
  LEFT JOIN exp ON exp.day = s.day
 ORDER BY s.day;
