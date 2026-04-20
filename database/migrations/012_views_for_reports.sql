-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 012 : Reporting Views
--  All views are prefixed with `v_` and are read-only.
-- ============================================================================

-- ---------- Available stock per variant per warehouse ----------
CREATE OR REPLACE VIEW v_stock_available AS
SELECT
    s.id,
    s.variant_id,
    s.warehouse_id,
    s.quantity_on_hand,
    s.quantity_reserved,
    (s.quantity_on_hand - s.quantity_reserved) AS quantity_available,
    s.reorder_point,
    (s.quantity_on_hand <= s.reorder_point)    AS is_low_stock,
    (s.quantity_on_hand = 0)                   AS is_out_of_stock
FROM stock s;

-- ---------- Full variant catalog with stock rollup ----------
CREATE OR REPLACE VIEW v_variant_catalog AS
SELECT
    pv.id                           AS variant_id,
    pv.sku,
    pv.barcode,
    p.id                            AS product_id,
    p.name_ar                       AS product_name_ar,
    p.name_en                       AS product_name_en,
    p.product_type,
    c.name_ar                       AS color_ar,
    c.hex_code                      AS color_hex,
    z.size_label                    AS size_label,
    pv.cost_price,
    pv.selling_price,
    (pv.selling_price - pv.cost_price) AS unit_margin,
    CASE WHEN pv.cost_price > 0
         THEN ROUND(((pv.selling_price - pv.cost_price) / pv.cost_price) * 100, 2)
         ELSE 0 END                 AS margin_pct,
    COALESCE((SELECT SUM(quantity_on_hand)  FROM stock WHERE variant_id = pv.id), 0) AS total_on_hand,
    COALESCE((SELECT SUM(quantity_reserved) FROM stock WHERE variant_id = pv.id), 0) AS total_reserved,
    pv.is_active
FROM product_variants pv
JOIN products  p ON p.id = pv.product_id
JOIN colors    c ON c.id = pv.color_id
LEFT JOIN sizes z ON z.id = pv.size_id
WHERE pv.deleted_at IS NULL
  AND p.deleted_at IS NULL;

-- ---------- Daily sales summary (per warehouse) ----------
CREATE OR REPLACE VIEW v_daily_sales AS
SELECT
    DATE(i.completed_at)            AS sale_date,
    i.warehouse_id,
    w.name_ar                       AS warehouse_name,
    COUNT(*) FILTER (WHERE NOT i.is_return)   AS invoice_count,
    COUNT(*) FILTER (WHERE i.is_return)       AS return_count,
    SUM(i.grand_total)              AS gross_sales,
    SUM(i.items_discount_total + i.invoice_discount + i.coupon_discount) AS total_discounts,
    SUM(i.cogs_total)               AS total_cogs,
    SUM(i.gross_profit)             AS gross_profit,
    SUM(i.tax_amount)               AS total_tax,
    SUM(i.paid_amount)              AS collected_cash
FROM invoices i
JOIN warehouses w ON w.id = i.warehouse_id
WHERE i.status IN ('completed','paid','partially_paid')
GROUP BY DATE(i.completed_at), i.warehouse_id, w.name_ar;

-- ---------- Sales per user / cashier / salesperson ----------
CREATE OR REPLACE VIEW v_sales_per_user AS
SELECT
    u.id              AS user_id,
    u.full_name,
    r.code            AS role_code,
    DATE_TRUNC('day', i.completed_at)::date AS sale_date,
    COUNT(i.id)       AS invoice_count,
    SUM(i.grand_total) AS total_sales,
    SUM(i.gross_profit) AS total_profit,
    SUM(i.items_discount_total + i.invoice_discount) AS total_discounts
FROM invoices i
JOIN users u ON u.id = COALESCE(i.salesperson_id, i.cashier_id)
JOIN roles r ON r.id = u.role_id
WHERE i.status IN ('completed','paid','partially_paid')
GROUP BY u.id, u.full_name, r.code, DATE_TRUNC('day', i.completed_at);

-- ---------- Product profitability ----------
CREATE OR REPLACE VIEW v_product_profit AS
SELECT
    p.id                            AS product_id,
    p.name_ar                       AS product_name,
    p.product_type,
    SUM(ii.quantity)                AS units_sold,
    SUM(ii.quantity * ii.unit_price - ii.discount_amount) AS revenue,
    SUM(ii.quantity * ii.unit_cost) AS cogs,
    SUM(ii.quantity * ii.unit_price - ii.discount_amount - ii.quantity * ii.unit_cost) AS gross_profit,
    CASE WHEN SUM(ii.quantity * ii.unit_cost) > 0
         THEN ROUND((SUM(ii.quantity * ii.unit_price - ii.discount_amount - ii.quantity * ii.unit_cost)
                     / SUM(ii.quantity * ii.unit_cost)) * 100, 2)
         ELSE 0 END                 AS roi_pct
FROM invoice_items ii
JOIN product_variants pv ON pv.id = ii.variant_id
JOIN products p ON p.id = pv.product_id
JOIN invoices i ON i.id = ii.invoice_id
WHERE i.status IN ('completed','paid','partially_paid')
  AND NOT i.is_return
GROUP BY p.id, p.name_ar, p.product_type;

-- ---------- Discount reports (per cashier, per product) ----------
CREATE OR REPLACE VIEW v_discounts_per_cashier AS
SELECT
    u.id                            AS user_id,
    u.full_name,
    DATE_TRUNC('day', du.created_at)::date AS disc_date,
    COUNT(*)                        AS discount_count,
    SUM(du.amount)                  AS total_discount_amount
FROM discount_usages du
JOIN users u ON u.id = du.user_id
GROUP BY u.id, u.full_name, DATE_TRUNC('day', du.created_at);

CREATE OR REPLACE VIEW v_discounts_per_product AS
SELECT
    p.id           AS product_id,
    p.name_ar      AS product_name,
    COUNT(*)       AS discount_count,
    SUM(du.amount) AS total_discount_amount
FROM discount_usages du
JOIN invoice_items ii ON ii.id = du.invoice_item_id
JOIN product_variants pv ON pv.id = ii.variant_id
JOIN products p ON p.id = pv.product_id
GROUP BY p.id, p.name_ar;

-- ---------- Reservation reports 🔥 ----------
CREATE OR REPLACE VIEW v_active_reservations AS
SELECT
    r.id,
    r.reservation_no,
    r.status,
    c.full_name          AS customer_name,
    c.phone              AS customer_phone,
    w.name_ar            AS warehouse_name,
    r.total_amount,
    r.paid_amount,
    r.remaining_amount,
    r.reserved_at,
    r.expires_at,
    (r.expires_at IS NOT NULL AND r.expires_at < NOW()) AS is_expired,
    (SELECT COUNT(*) FROM reservation_items WHERE reservation_id = r.id)  AS item_count
FROM reservations r
JOIN customers c  ON c.id = r.customer_id
JOIN warehouses w ON w.id = r.warehouse_id
WHERE r.status = 'active';

CREATE OR REPLACE VIEW v_reservation_summary AS
SELECT
    DATE_TRUNC('day', r.created_at)::date AS day,
    r.status,
    COUNT(*)                    AS reservation_count,
    SUM(r.total_amount)         AS total_value,
    SUM(r.paid_amount)          AS total_collected,
    SUM(r.remaining_amount)     AS outstanding_balance
FROM reservations r
GROUP BY DATE_TRUNC('day', r.created_at), r.status;

-- ---------- Smart pricing suggestion view ----------
--   Simple rule: suggest price that keeps margin_pct >= min_margin_pct
--   Real implementation can be extended by ML layer in app.
CREATE OR REPLACE VIEW v_pricing_suggestions AS
SELECT
    pv.id                          AS variant_id,
    pv.sku,
    p.name_ar                      AS product_name,
    pv.cost_price,
    pv.selling_price,
    p.min_margin_pct,
    ROUND(pv.cost_price * (1 + p.min_margin_pct/100), 2) AS suggested_min_price,
    CASE
       WHEN pv.cost_price = 0 THEN 'unknown'
       WHEN pv.selling_price < pv.cost_price THEN 'loss'
       WHEN ((pv.selling_price - pv.cost_price) / pv.cost_price) * 100 < p.min_margin_pct THEN 'below_min_margin'
       ELSE 'ok'
    END                            AS pricing_status,
    ROUND(((pv.selling_price - pv.cost_price) / NULLIF(pv.cost_price,0)) * 100, 2) AS current_margin_pct
FROM product_variants pv
JOIN products p ON p.id = pv.product_id
WHERE pv.is_active AND pv.deleted_at IS NULL;

-- ---------- Loss-alert view (selling below cost) ----------
CREATE OR REPLACE VIEW v_loss_products AS
SELECT *
FROM v_pricing_suggestions
WHERE pricing_status IN ('loss','below_min_margin');

-- ---------- Shift summary ----------
CREATE OR REPLACE VIEW v_shift_summary AS
SELECT
    s.id,
    s.shift_no,
    s.warehouse_id,
    w.name_ar           AS warehouse_name,
    s.cashbox_id,
    u.full_name         AS opened_by_name,
    s.status,
    s.opening_balance,
    s.total_sales,
    s.total_returns,
    s.total_expenses,
    s.expected_closing,
    s.actual_closing,
    s.difference,
    s.opened_at,
    s.closed_at,
    EXTRACT(EPOCH FROM (COALESCE(s.closed_at, NOW()) - s.opened_at))/3600 AS duration_hours
FROM shifts s
JOIN users u ON u.id = s.opened_by
JOIN warehouses w ON w.id = s.warehouse_id;

-- ---------- Daily profit engine ----------
--  Net Profit = Gross Profit - Allocated Expenses (for the day)
--  Expenses where allocate_to_cogs = true
CREATE OR REPLACE VIEW v_daily_profit AS
WITH sales AS (
    SELECT DATE(completed_at) AS d, warehouse_id,
           SUM(grand_total)   AS revenue,
           SUM(cogs_total)    AS cogs,
           SUM(gross_profit)  AS gross_profit
    FROM invoices
    WHERE status IN ('completed','paid','partially_paid') AND NOT is_return
    GROUP BY DATE(completed_at), warehouse_id
), exp AS (
    SELECT e.expense_date AS d, e.warehouse_id,
           SUM(e.amount) AS allocated_expenses
    FROM expenses e
    JOIN expense_categories c ON c.id = e.category_id
    WHERE c.allocate_to_cogs = TRUE AND e.is_approved = TRUE
    GROUP BY e.expense_date, e.warehouse_id
)
SELECT
    s.d                               AS day,
    s.warehouse_id,
    s.revenue,
    s.cogs,
    s.gross_profit,
    COALESCE(e.allocated_expenses, 0) AS allocated_expenses,
    s.gross_profit - COALESCE(e.allocated_expenses, 0) AS net_profit
FROM sales s
LEFT JOIN exp e ON e.d = s.d AND e.warehouse_id = s.warehouse_id;
