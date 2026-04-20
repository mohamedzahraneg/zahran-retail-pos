-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 020 : Returns Analytics Views
-- ----------------------------------------------------------------------------
--  Dashboard views for understanding returns patterns:
--    * Summary KPIs (counts, amounts, rates)
--    * Breakdown by reason
--    * Top returned variants/products
--    * Monthly / weekly trend
--    * Condition distribution
-- ============================================================================

-- ---------- Summary (rolling 30d, 90d, YTD) ---------------------------------
CREATE OR REPLACE VIEW v_returns_summary AS
SELECT
    (SELECT COUNT(*) FROM returns
       WHERE status IN ('approved','refunded'))                            AS total_count,
    (SELECT COALESCE(SUM(net_refund),0) FROM returns
       WHERE status IN ('approved','refunded'))                            AS total_net_refund,
    (SELECT COUNT(*) FROM returns
       WHERE status IN ('approved','refunded')
         AND requested_at >= NOW() - INTERVAL '30 days')                   AS count_30d,
    (SELECT COALESCE(SUM(net_refund),0) FROM returns
       WHERE status IN ('approved','refunded')
         AND requested_at >= NOW() - INTERVAL '30 days')                   AS net_refund_30d,
    (SELECT COUNT(*) FROM returns
       WHERE status IN ('approved','refunded')
         AND requested_at >= NOW() - INTERVAL '90 days')                   AS count_90d,
    (SELECT COALESCE(SUM(net_refund),0) FROM returns
       WHERE status IN ('approved','refunded')
         AND requested_at >= NOW() - INTERVAL '90 days')                   AS net_refund_90d,
    (SELECT COUNT(*) FROM returns WHERE status = 'pending')                AS pending_count,
    (SELECT COALESCE(SUM(total_refund),0) FROM returns
       WHERE status = 'pending')                                           AS pending_amount,
    -- returns rate = returned_items / sold_items over the last 30d
    (
      SELECT ROUND(
        CASE WHEN sold.qty > 0
             THEN (COALESCE(ret.qty, 0)::numeric / sold.qty) * 100
             ELSE 0
        END, 2)
      FROM (SELECT COALESCE(SUM(ii.quantity),0) AS qty
              FROM invoice_items ii
              JOIN invoices i ON i.id = ii.invoice_id
             WHERE i.status = 'paid'
               AND i.issued_at >= NOW() - INTERVAL '30 days') sold,
           (SELECT COALESCE(SUM(ri.quantity),0) AS qty
              FROM return_items ri
              JOIN returns r ON r.id = ri.return_id
             WHERE r.status IN ('approved','refunded')
               AND r.requested_at >= NOW() - INTERVAL '30 days') ret
    ) AS return_rate_30d;

-- ---------- Breakdown by reason ---------------------------------------------
CREATE OR REPLACE VIEW v_returns_by_reason AS
SELECT
    r.reason::text                                  AS reason,
    COUNT(DISTINCT r.id)                            AS return_count,
    COALESCE(SUM(ri.quantity), 0)                   AS qty,
    COALESCE(SUM(r.net_refund), 0)                  AS net_refund,
    ROUND(AVG(r.net_refund)::numeric, 2)            AS avg_refund
FROM returns r
LEFT JOIN return_items ri ON ri.return_id = r.id
WHERE r.status IN ('approved','refunded')
GROUP BY r.reason
ORDER BY return_count DESC;

-- ---------- Top returned products / variants --------------------------------
CREATE OR REPLACE VIEW v_returns_top_products AS
WITH returned AS (
  SELECT ri.variant_id,
         SUM(ri.quantity)      AS returned_qty,
         SUM(ri.refund_amount) AS refund_total,
         COUNT(DISTINCT r.id)  AS return_count
    FROM return_items ri
    JOIN returns r ON r.id = ri.return_id
   WHERE r.status IN ('approved','refunded')
   GROUP BY ri.variant_id
),
sold AS (
  SELECT ii.variant_id,
         SUM(ii.quantity) AS sold_qty
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii.invoice_id
   WHERE i.status = 'paid'
   GROUP BY ii.variant_id
)
SELECT
    v.id                                             AS variant_id,
    p.id                                             AS product_id,
    p.name_ar,
    v.sku,
    COALESCE(ret.returned_qty, 0)                    AS returned_qty,
    COALESCE(sold.sold_qty, 0)                       AS sold_qty,
    COALESCE(ret.refund_total, 0)                    AS refund_total,
    COALESCE(ret.return_count, 0)                    AS return_count,
    CASE WHEN COALESCE(sold.sold_qty, 0) > 0
         THEN ROUND((COALESCE(ret.returned_qty,0)::numeric / sold.sold_qty) * 100, 2)
         ELSE 0
    END                                              AS return_rate_pct
FROM returned ret
JOIN product_variants v ON v.id = ret.variant_id
JOIN products p         ON p.id = v.product_id
LEFT JOIN sold          ON sold.variant_id = v.id
WHERE ret.returned_qty > 0
ORDER BY ret.returned_qty DESC, ret.refund_total DESC;

-- ---------- Monthly trend (last 12 months) ----------------------------------
CREATE OR REPLACE VIEW v_returns_trend_monthly AS
SELECT
    to_char(date_trunc('month', r.requested_at), 'YYYY-MM')  AS month,
    COUNT(*)                                                 AS return_count,
    COALESCE(SUM(ri.quantity), 0)                            AS qty,
    COALESCE(SUM(r.net_refund), 0)                           AS net_refund
FROM returns r
LEFT JOIN return_items ri ON ri.return_id = r.id
WHERE r.status IN ('approved','refunded')
  AND r.requested_at >= NOW() - INTERVAL '12 months'
GROUP BY 1
ORDER BY 1 ASC;

-- ---------- Daily trend (last 30 days) --------------------------------------
CREATE OR REPLACE VIEW v_returns_trend_daily AS
SELECT
    to_char(date_trunc('day', r.requested_at), 'YYYY-MM-DD') AS day,
    COUNT(*)                                                 AS return_count,
    COALESCE(SUM(ri.quantity), 0)                            AS qty,
    COALESCE(SUM(r.net_refund), 0)                           AS net_refund
FROM returns r
LEFT JOIN return_items ri ON ri.return_id = r.id
WHERE r.status IN ('approved','refunded')
  AND r.requested_at >= NOW() - INTERVAL '30 days'
GROUP BY 1
ORDER BY 1 ASC;

-- ---------- Condition breakdown (resellable vs damaged vs defective) --------
CREATE OR REPLACE VIEW v_returns_by_condition AS
SELECT
    ri.condition,
    COUNT(*)                                         AS line_count,
    COALESCE(SUM(ri.quantity), 0)                    AS qty,
    COALESCE(SUM(ri.refund_amount), 0)               AS refund_total,
    ROUND(
      COUNT(*)::numeric * 100 / NULLIF(SUM(COUNT(*)) OVER (), 0),
      2
    )                                                AS pct_of_total
FROM return_items ri
JOIN returns r ON r.id = ri.return_id
WHERE r.status IN ('approved','refunded')
GROUP BY ri.condition
ORDER BY qty DESC;

-- ---------- Dashboard compact widget ----------------------------------------
-- A lightweight subset used by the dashboard widget (top 5 returned SKUs and
-- top 3 reasons in the last 30 days).
CREATE OR REPLACE VIEW v_returns_widget AS
WITH reasons AS (
  SELECT r.reason::text AS reason,
         COUNT(*)       AS cnt
    FROM returns r
   WHERE r.status IN ('approved','refunded')
     AND r.requested_at >= NOW() - INTERVAL '30 days'
   GROUP BY r.reason
   ORDER BY cnt DESC
   LIMIT 3
),
top_products AS (
  SELECT p.name_ar,
         v.sku,
         SUM(ri.quantity) AS returned_qty
    FROM return_items ri
    JOIN returns r  ON r.id = ri.return_id
    JOIN product_variants v ON v.id = ri.variant_id
    JOIN products p ON p.id = v.product_id
   WHERE r.status IN ('approved','refunded')
     AND r.requested_at >= NOW() - INTERVAL '30 days'
   GROUP BY p.name_ar, v.sku
   ORDER BY returned_qty DESC
   LIMIT 5
)
SELECT
  (SELECT COUNT(*) FROM returns
     WHERE status IN ('approved','refunded')
       AND requested_at >= NOW() - INTERVAL '30 days')       AS count_30d,
  (SELECT COALESCE(SUM(net_refund),0) FROM returns
     WHERE status IN ('approved','refunded')
       AND requested_at >= NOW() - INTERVAL '30 days')       AS refund_30d,
  (SELECT COUNT(*) FROM returns WHERE status = 'pending')    AS pending_count,
  (SELECT COALESCE(json_agg(row_to_json(reasons)), '[]'::json)
     FROM reasons)                                           AS top_reasons,
  (SELECT COALESCE(json_agg(row_to_json(top_products)), '[]'::json)
     FROM top_products)                                      AS top_products;
