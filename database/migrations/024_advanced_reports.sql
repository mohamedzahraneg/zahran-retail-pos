-- 024_advanced_reports.sql
-- Advanced analytics views:
--   v_profit_margin_per_product : profit per product, % margin
--   v_dead_stock                : stock with no movement in the last N days
--   v_period_compare            : helper view for UI (day/month aggregates)

-- --------------------------------------------------------------------
-- 1. Profit margin per product
-- --------------------------------------------------------------------
CREATE OR REPLACE VIEW v_profit_margin_per_product AS
SELECT
  p.id                          AS product_id,
  p.sku_root,
  p.name_ar,
  p.product_type,
  COALESCE(SUM(ii.quantity), 0)          AS qty_sold,
  COALESCE(SUM(ii.line_total), 0)        AS revenue,
  COALESCE(SUM(ii.quantity * ii.unit_cost), 0) AS cogs,
  COALESCE(SUM(ii.line_total - ii.quantity * ii.unit_cost), 0) AS gross_profit,
  CASE
    WHEN COALESCE(SUM(ii.line_total), 0) = 0 THEN 0
    ELSE ROUND(
      (SUM(ii.line_total - ii.quantity * ii.unit_cost) /
       NULLIF(SUM(ii.line_total), 0)) * 100, 2
    )
  END AS margin_pct
FROM products p
LEFT JOIN product_variants pv ON pv.product_id = p.id
LEFT JOIN invoice_items    ii ON ii.variant_id = pv.id
LEFT JOIN invoices         inv ON inv.id = ii.invoice_id AND inv.status = 'paid'
GROUP BY p.id, p.sku_root, p.name_ar, p.product_type;

COMMENT ON VIEW v_profit_margin_per_product IS
  'Revenue, COGS, gross profit & margin % per product (all-time, paid invoices)';

-- --------------------------------------------------------------------
-- 2. Dead stock (no sales in last 90 days, still on hand)
-- --------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dead_stock AS
WITH last_sale AS (
  SELECT
    ii.variant_id,
    MAX(inv.completed_at) AS last_sold_at
  FROM invoice_items ii
  JOIN invoices      inv ON inv.id = ii.invoice_id AND inv.status = 'paid'
  GROUP BY ii.variant_id
)
SELECT
  pv.id              AS variant_id,
  pv.sku,
  p.id               AS product_id,
  p.name_ar          AS product_name,
  c.name_ar          AS color_name,
  s.size_label       AS size_label,
  pv.cost_price,
  SUM(st.quantity_on_hand) AS on_hand,
  ls.last_sold_at,
  COALESCE(
    EXTRACT(DAY FROM (NOW() - ls.last_sold_at))::int,
    9999
  )                  AS days_since_last_sale,
  SUM(st.quantity_on_hand) * pv.cost_price AS tied_up_capital
FROM product_variants pv
JOIN products      p  ON p.id = pv.product_id
LEFT JOIN colors   c  ON c.id = pv.color_id
LEFT JOIN sizes    s  ON s.id = pv.size_id
LEFT JOIN stock    st ON st.variant_id = pv.id
LEFT JOIN last_sale ls ON ls.variant_id = pv.id
WHERE p.is_active = TRUE
GROUP BY pv.id, pv.sku, p.id, p.name_ar, c.name_ar, s.size_label,
         pv.cost_price, ls.last_sold_at
HAVING SUM(st.quantity_on_hand) > 0
   AND (ls.last_sold_at IS NULL OR ls.last_sold_at < NOW() - INTERVAL '90 days');

COMMENT ON VIEW v_dead_stock IS
  'Variants with on-hand stock but no sales in the last 90 days';

-- --------------------------------------------------------------------
-- 3. Daily sales (for period-comparison charts)
-- --------------------------------------------------------------------
CREATE OR REPLACE VIEW v_sales_daily AS
SELECT
  date_trunc('day', completed_at)::date AS day,
  COUNT(*)                              AS invoice_count,
  COALESCE(SUM(grand_total), 0)         AS gross_sales,
  COALESCE(SUM(tax_amount), 0)          AS vat,
  COALESCE(SUM(invoice_discount), 0)    AS discounts,
  COALESCE(SUM(grand_total - tax_amount), 0) AS net_sales
FROM invoices
WHERE status = 'paid'
GROUP BY 1
ORDER BY 1 DESC;

COMMENT ON VIEW v_sales_daily IS
  'One row per day of gross sales — feed for period comparison charts';
