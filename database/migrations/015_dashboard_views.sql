-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 015 : Dashboard Views & Smart Suggestions
--
--  Views تُستعمل مباشرة من الـ API لتغذية شاشة الداشبورد الرئيسية:
--    • KPIs لحظة-بلحظة (المبيعات اليوم، الربح، عدد الفواتير…)
--    • Top N منتجات، عملاء، كاشيرز
--    • Time-series آخر 30 يوم
--    • Live feed للتنبيهات + الحجوزات القريبة من الانتهاء
--    • توصيات ذكية (إعادة طلب، تخفيض سعر، رفع سعر)
-- ============================================================================

-- ---------- Add reorder_quantity column if missing (used by reorder suggestion view) ----------
ALTER TABLE stock ADD COLUMN IF NOT EXISTS reorder_quantity INT NOT NULL DEFAULT 10;
COMMENT ON COLUMN stock.reorder_quantity IS 'Default order quantity when reorder_point is hit';

-- ---------------------------------------------------------------------------
--  1) KPIs اليوم — صف واحد فقط
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_today AS
SELECT
    (SELECT COUNT(*)                           FROM invoices
        WHERE DATE(completed_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
          AND status IN ('completed','paid'))                         AS invoices_today,
    (SELECT COALESCE(SUM(grand_total),0)       FROM invoices
        WHERE DATE(completed_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
          AND status IN ('completed','paid'))                         AS revenue_today,
    (SELECT COALESCE(SUM(gross_profit),0)      FROM invoices
        WHERE DATE(completed_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
          AND status IN ('completed','paid'))                         AS profit_today,
    (SELECT COALESCE(SUM(quantity),0)          FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        WHERE DATE(i.completed_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
          AND i.status IN ('completed','paid'))                       AS units_sold_today,
    (SELECT COUNT(*)                           FROM reservations
        WHERE status = 'active')                                      AS active_reservations,
    (SELECT COALESCE(SUM(remaining_amount),0)  FROM reservations
        WHERE status = 'active')                                      AS reservations_pending_amount,
    (SELECT COUNT(*)                           FROM alerts
        WHERE is_resolved = FALSE)                                    AS open_alerts,
    (SELECT COALESCE(SUM(amount),0)            FROM expenses
        WHERE expense_date = CURRENT_DATE)                            AS expenses_today,
    (SELECT COALESCE(SUM(current_balance),0)   FROM cashboxes
        WHERE is_active = TRUE)                                       AS cashboxes_balance,
    (SELECT COALESCE(SUM(current_balance),0)   FROM customers
        WHERE deleted_at IS NULL)                                     AS customers_receivable,
    (SELECT COALESCE(SUM(current_balance),0)   FROM suppliers
        WHERE deleted_at IS NULL)                                     AS suppliers_payable,
    NOW()                                                             AS as_of;

-- ---------------------------------------------------------------------------
--  2) Revenue / profit time-series — آخر 30 يوم
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_revenue_30d AS
WITH series AS (
    SELECT generate_series(CURRENT_DATE - INTERVAL '29 day',
                           CURRENT_DATE,
                           INTERVAL '1 day')::date AS day
)
SELECT
    s.day,
    COALESCE(SUM(i.grand_total),  0)::numeric(14,2) AS revenue,
    COALESCE(SUM(i.gross_profit), 0)::numeric(14,2) AS profit,
    COUNT(i.id)                                    AS invoices,
    COALESCE(SUM(e.amount),       0)::numeric(14,2) AS expenses
FROM series s
LEFT JOIN invoices i
       ON DATE(i.completed_at AT TIME ZONE 'Africa/Cairo') = s.day
      AND i.status IN ('completed','paid')
LEFT JOIN expenses e
       ON e.expense_date = s.day
GROUP BY s.day
ORDER BY s.day;

-- ---------------------------------------------------------------------------
--  3) Top 10 منتجات (بالكمية + بالربح) خلال آخر 30 يوم
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_top_products_30d AS
SELECT
    p.id                                AS product_id,
    p.name_ar                           AS product_name,
    p.product_type,
    SUM(ii.quantity)                    AS units_sold,
    SUM(ii.line_total)                  AS revenue,
    SUM((ii.unit_price - ii.unit_cost) * ii.quantity - COALESCE(ii.discount_amount,0))
                                        AS profit,
    CASE WHEN SUM(ii.unit_cost * ii.quantity) > 0
         THEN ROUND(
               ((SUM((ii.unit_price - ii.unit_cost) * ii.quantity -
                     COALESCE(ii.discount_amount,0))
                 / SUM(ii.unit_cost * ii.quantity)) * 100)::numeric, 2)
         ELSE NULL END                  AS margin_pct
FROM invoice_items ii
JOIN invoices         i  ON i.id = ii.invoice_id
JOIN product_variants v  ON v.id = ii.variant_id
JOIN products         p  ON p.id = v.product_id
WHERE i.status IN ('completed','paid')
  AND i.completed_at >= NOW() - INTERVAL '30 day'
GROUP BY p.id, p.name_ar, p.product_type
ORDER BY revenue DESC
LIMIT 10;

-- ---------------------------------------------------------------------------
--  4) Top 10 عملاء (بالإنفاق) خلال آخر 90 يوم
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_top_customers_90d AS
SELECT
    c.id                          AS customer_id,
    c.customer_no,
    c.full_name,
    c.phone,
    c.loyalty_tier,
    COUNT(i.id)                   AS invoices_count,
    SUM(i.grand_total)            AS total_spent,
    MAX(i.completed_at)           AS last_purchase_at
FROM customers c
JOIN invoices i ON i.customer_id = c.id
WHERE i.status IN ('completed','paid')
  AND i.completed_at >= NOW() - INTERVAL '90 day'
GROUP BY c.id
ORDER BY total_spent DESC
LIMIT 10;

-- ---------------------------------------------------------------------------
--  5) أداء الكاشيرز خلال اليوم / الأسبوع
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_cashier_performance AS
SELECT
    u.id                           AS user_id,
    u.full_name,
    COUNT(*) FILTER (WHERE DATE(i.completed_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE)
                                   AS invoices_today,
    COALESCE(SUM(i.grand_total) FILTER (
        WHERE DATE(i.completed_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE),0)::numeric(14,2)
                                   AS revenue_today,
    COUNT(*) FILTER (WHERE i.completed_at >= NOW() - INTERVAL '7 day')
                                   AS invoices_week,
    COALESCE(SUM(i.grand_total) FILTER (
        WHERE i.completed_at >= NOW() - INTERVAL '7 day'),0)::numeric(14,2)
                                   AS revenue_week
FROM users u
LEFT JOIN invoices i ON i.cashier_id = u.id
   AND i.status IN ('completed','paid')
WHERE u.is_active = TRUE
GROUP BY u.id, u.full_name
ORDER BY revenue_today DESC;

-- ---------------------------------------------------------------------------
--  6) المخزون المنخفض / المنتهي — مصدر مباشر للتنبيهات
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_low_stock AS
SELECT
    v.id                   AS variant_id,
    v.sku,
    v.barcode,
    p.name_ar              AS product_name,
    col.name_ar            AS color,
    sz.size_label       AS size,
    w.name_ar              AS warehouse,
    s.quantity_on_hand,
    s.quantity_reserved,
    (s.quantity_on_hand - s.quantity_reserved) AS quantity_available,
    s.reorder_point,
    CASE
        WHEN (s.quantity_on_hand - s.quantity_reserved) <= 0          THEN 'out_of_stock'
        WHEN (s.quantity_on_hand - s.quantity_reserved) <= s.reorder_point THEN 'low_stock'
        ELSE 'ok'
    END                    AS stock_status
FROM stock s
JOIN product_variants v ON v.id = s.variant_id
JOIN products         p ON p.id = v.product_id
JOIN warehouses       w ON w.id = s.warehouse_id
LEFT JOIN colors      col ON col.id = v.color_id
LEFT JOIN sizes       sz  ON sz.id  = v.size_id
WHERE (s.quantity_on_hand - s.quantity_reserved) <= s.reorder_point
ORDER BY quantity_available ASC;

-- ---------------------------------------------------------------------------
--  7) حجوزات على وشك الانتهاء (خلال 48 ساعة)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_reservations_expiring AS
SELECT
    r.id                   AS reservation_id,
    r.reservation_no,
    c.full_name            AS customer_name,
    c.phone                AS customer_phone,
    r.total_amount,
    r.paid_amount,
    r.remaining_amount,
    r.expires_at,
    (r.expires_at - NOW()) AS time_left
FROM reservations r
JOIN customers c ON c.id = r.customer_id
WHERE r.status = 'active'
  AND r.expires_at IS NOT NULL
  AND r.expires_at <= NOW() + INTERVAL '48 hour'
ORDER BY r.expires_at ASC;

-- ---------------------------------------------------------------------------
--  8) توزيع طرق الدفع — آخر 30 يوم
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_payment_mix_30d AS
SELECT
    ip.payment_method                  AS payment_method,
    COUNT(*)                           AS transactions,
    SUM(ip.amount)::numeric(14,2)      AS total_amount,
    ROUND((SUM(ip.amount) * 100.0 /
           NULLIF(SUM(SUM(ip.amount)) OVER (), 0))::numeric, 2) AS pct
FROM invoice_payments ip
JOIN invoices i ON i.id = ip.invoice_id
WHERE i.status IN ('completed','paid')
  AND i.completed_at >= NOW() - INTERVAL '30 day'
GROUP BY ip.payment_method
ORDER BY total_amount DESC;

-- ---------------------------------------------------------------------------
--  9) توصيات ذكية — إعادة الطلب من الموردين
--  المنتج سيُعاد طلبه إن كان: available <= reorder_point AND متوسط المبيعات > 0
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_smart_reorder_suggestions AS
WITH sales_30 AS (
    SELECT
        ii.variant_id,
        SUM(ii.quantity)::numeric / 30.0 AS avg_daily_sales
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.status IN ('completed','paid')
      AND i.completed_at >= NOW() - INTERVAL '30 day'
    GROUP BY ii.variant_id
)
SELECT
    v.id                           AS variant_id,
    v.sku,
    p.name_ar                      AS product_name,
    col.name_ar                    AS color,
    sz.size_label               AS size,
    s.warehouse_id,
    w.name_ar                      AS warehouse,
    s.quantity_on_hand,
    s.quantity_reserved,
    (s.quantity_on_hand - s.quantity_reserved)                  AS available,
    s.reorder_point,
    s.reorder_quantity,
    COALESCE(sd.avg_daily_sales, 0)::numeric(10,2)              AS avg_daily_sales,
    CASE
        WHEN COALESCE(sd.avg_daily_sales,0) > 0
        THEN ROUND(((s.quantity_on_hand - s.quantity_reserved) /
                    sd.avg_daily_sales)::numeric, 1)
        ELSE NULL
    END                                                         AS days_of_stock_left,
    -- كمية الطلب المقترحة: 30 يوم مبيعات تقريبية - المتاح حالياً
    GREATEST(
        CEIL(COALESCE(sd.avg_daily_sales, 0) * 30)::int
            - (s.quantity_on_hand - s.quantity_reserved),
        s.reorder_quantity
    )                                                           AS suggested_order_qty,
    CASE
        WHEN (s.quantity_on_hand - s.quantity_reserved) <= 0 THEN 'urgent'
        WHEN (s.quantity_on_hand - s.quantity_reserved) <=
             COALESCE(sd.avg_daily_sales,0) * 3             THEN 'soon'
        ELSE 'routine'
    END                                                         AS priority
FROM stock s
JOIN product_variants v ON v.id = s.variant_id
JOIN products         p ON p.id = v.product_id
JOIN warehouses       w ON w.id = s.warehouse_id
LEFT JOIN colors  col ON col.id = v.color_id
LEFT JOIN sizes   sz  ON sz.id  = v.size_id
LEFT JOIN sales_30 sd ON sd.variant_id = v.id
WHERE (s.quantity_on_hand - s.quantity_reserved) <= s.reorder_point
  AND p.is_active = TRUE
ORDER BY
    CASE priority WHEN 'urgent' THEN 1 WHEN 'soon' THEN 2 ELSE 3 END,
    days_of_stock_left ASC NULLS LAST;

-- ---------------------------------------------------------------------------
--  10) توصيات ذكية — منتجات راكدة (لم تُبَع منذ 60+ يوم)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_smart_dead_stock AS
SELECT
    v.id                      AS variant_id,
    v.sku,
    p.name_ar                 AS product_name,
    col.name_ar               AS color,
    sz.size_label          AS size,
    w.name_ar                 AS warehouse,
    s.quantity_on_hand        AS qty,
    v.cost_price              AS unit_cost,
    (s.quantity_on_hand * v.cost_price)::numeric(14,2) AS tied_capital,
    (SELECT MAX(i.completed_at)
        FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        WHERE ii.variant_id = v.id
          AND i.status IN ('completed','paid'))        AS last_sold_at,
    CASE
        WHEN (SELECT MAX(i.completed_at)
                FROM invoice_items ii
                JOIN invoices i ON i.id = ii.invoice_id
                WHERE ii.variant_id = v.id) IS NULL
             THEN 'never_sold'
        ELSE 'dormant'
    END                       AS status,
    'discount_or_bundle'      AS suggested_action
FROM stock s
JOIN product_variants v ON v.id = s.variant_id
JOIN products         p ON p.id = v.product_id
JOIN warehouses       w ON w.id = s.warehouse_id
LEFT JOIN colors  col ON col.id = v.color_id
LEFT JOIN sizes   sz  ON sz.id  = v.size_id
WHERE s.quantity_on_hand > 0
  AND (
    NOT EXISTS (
        SELECT 1 FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        WHERE ii.variant_id = v.id
          AND i.status IN ('completed','paid')
          AND i.completed_at >= NOW() - INTERVAL '60 day'
    )
  )
ORDER BY tied_capital DESC
LIMIT 50;

-- ---------------------------------------------------------------------------
--  11) توصيات ذكية — منتج تم بيعه بخسارة أكثر من مرة
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_smart_loss_warnings AS
SELECT
    p.id                                   AS product_id,
    p.name_ar                              AS product_name,
    COUNT(*)                               AS times_sold_at_loss,
    SUM((ii.unit_cost - ii.unit_price) * ii.quantity)::numeric(14,2)
                                           AS total_loss,
    MIN(ii.unit_price)                     AS min_selling_price,
    AVG(ii.unit_cost)::numeric(10,2)       AS avg_cost_price,
    'raise_price_or_block_discount'        AS suggested_action
FROM invoice_items ii
JOIN invoices         i ON i.id = ii.invoice_id
JOIN product_variants v ON v.id = ii.variant_id
JOIN products         p ON p.id = v.product_id
WHERE i.status IN ('completed','paid')
  AND ii.unit_price < ii.unit_cost
  AND i.completed_at >= NOW() - INTERVAL '60 day'
GROUP BY p.id, p.name_ar
HAVING COUNT(*) >= 2
ORDER BY total_loss DESC;

-- ---------------------------------------------------------------------------
--  12) حركة الصندوق اليوم — للعرض على شاشة الكاشير
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_cashflow_today AS
SELECT
    cb.id                                 AS cashbox_id,
    cb.name_ar                            AS cashbox_name,
    cb.current_balance,
    COALESCE(SUM(ct.amount) FILTER (WHERE ct.direction = 'in'
           AND DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE), 0)::numeric(14,2)
                                          AS cash_in_today,
    COALESCE(SUM(ct.amount) FILTER (WHERE ct.direction = 'out'
           AND DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE), 0)::numeric(14,2)
                                          AS cash_out_today,
    COUNT(*) FILTER (WHERE DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE)
                                          AS transactions_today
FROM cashboxes cb
LEFT JOIN cashbox_transactions ct ON ct.cashbox_id = cb.id
WHERE cb.is_active = TRUE
GROUP BY cb.id, cb.name_ar, cb.current_balance
ORDER BY cb.name_ar;

-- ---------------------------------------------------------------------------
--  13) Feed موحد للتنبيهات (أحدث 20)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_alerts_feed AS
SELECT
    a.id,
    a.alert_type,
    a.severity,
    a.title,
    a.message,
    a.entity,
    a.entity_id,
    a.is_read,
    a.is_resolved,
    a.created_at
FROM alerts a
WHERE a.is_resolved = FALSE
ORDER BY
    CASE a.severity
        WHEN 'critical' THEN 1
        WHEN 'warning'  THEN 2
        WHEN 'info'     THEN 3
        ELSE 4
    END,
    a.created_at DESC
LIMIT 20;

COMMENT ON VIEW v_dashboard_today              IS 'KPIs مباشرة لليوم الحالي — صف واحد';
COMMENT ON VIEW v_dashboard_revenue_30d        IS 'سلسلة زمنية يومية: إيراد/ربح/مصروفات آخر 30 يوم';
COMMENT ON VIEW v_dashboard_top_products_30d   IS 'أكثر 10 منتجات مبيعاً وربحاً آخر 30 يوم';
COMMENT ON VIEW v_dashboard_top_customers_90d  IS 'أكثر 10 عملاء إنفاقاً آخر 90 يوم';
COMMENT ON VIEW v_dashboard_cashier_performance IS 'أداء الكاشيرز — اليوم والأسبوع';
COMMENT ON VIEW v_dashboard_low_stock          IS 'المخزون المنخفض + نفاد المخزون لكل فرع';
COMMENT ON VIEW v_dashboard_reservations_expiring IS 'حجوزات ستنتهي خلال 48 ساعة';
COMMENT ON VIEW v_dashboard_payment_mix_30d    IS 'توزيع طرق الدفع آخر 30 يوم';
COMMENT ON VIEW v_smart_reorder_suggestions    IS 'توصية إعادة الطلب بناءً على متوسط البيع';
COMMENT ON VIEW v_smart_dead_stock             IS 'منتجات راكدة لم تُبَع منذ 60 يوم';
COMMENT ON VIEW v_smart_loss_warnings          IS 'منتجات تُباع بخسارة متكررة — رفع السعر';
COMMENT ON VIEW v_dashboard_cashflow_today     IS 'حركة نقدية لكل خزنة اليوم';
COMMENT ON VIEW v_dashboard_alerts_feed        IS 'أحدث 20 تنبيه غير مُغلق';
