-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 016 : Realistic Demo Seed
--
--  This migration loads a realistic snapshot of data for demo / QA:
--    • 3 additional staff users (manager, cashier, sales)
--    • 25 products with 2-4 colors each and 5-8 sizes (shoes) = ~500 variants
--    • Full stock on hand + reorder points
--    • 40 customers (phones, tiers, loyalty points)
--    • ~90 invoices spread over the past 60 days with split payments,
--      realistic discounts and a handful of coupons applied
--    • Cashbox opening + running balance reflecting the invoices
--    • A few expenses (rent, salaries, supplies) so P&L looks lifelike
--
--  It is SAFE to re-run: everything uses ON CONFLICT or WHERE NOT EXISTS.
--  Re-applying will NOT duplicate invoices — existing invoice_no values
--  are preserved via the sku_prefix / customer_no keys.
--
--  NOTE: depends on 013_seed_data.sql having run (roles, warehouses,
--  cashboxes, categories, colors, sizes, brands, payment_methods).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
--  Handy reference CTEs stored as temp views
-- ----------------------------------------------------------------------------
CREATE TEMP VIEW _ref AS
SELECT
    (SELECT id FROM warehouses WHERE code = 'ZHR-01')                 AS wh_id,
    (SELECT id FROM cashboxes  ORDER BY created_at LIMIT 1)           AS cash_id,
    (SELECT id FROM users      WHERE username = 'admin')              AS admin_id,
    (SELECT id FROM brands     WHERE name_ar = 'زهران')               AS brand_zahran,
    (SELECT id FROM brands     WHERE name_ar = 'بلا علامة')           AS brand_generic,
    (SELECT id FROM categories WHERE slug = 'shoes')                  AS cat_shoes,
    (SELECT id FROM categories WHERE slug = 'bags')                   AS cat_bags,
    (SELECT id FROM categories WHERE slug = 'evening-shoes')          AS sc_evening,
    (SELECT id FROM categories WHERE slug = 'casual-shoes')           AS sc_casual,
    (SELECT id FROM categories WHERE slug = 'sport-shoes')            AS sc_sport,
    (SELECT id FROM categories WHERE slug = 'sandals')                AS sc_sandals,
    (SELECT id FROM categories WHERE slug = 'boots')                  AS sc_boots,
    (SELECT id FROM categories WHERE slug = 'hand-bags')              AS sc_hand,
    (SELECT id FROM categories WHERE slug = 'clutch')                 AS sc_clutch,
    (SELECT id FROM categories WHERE slug = 'backpacks')              AS sc_back,
    (SELECT id FROM categories WHERE slug = 'crossbody')              AS sc_cross;

-- ----------------------------------------------------------------------------
--  1. Additional staff users
-- ----------------------------------------------------------------------------
-- Password = "Demo@123" for everyone below (bcrypt, cost 10)
INSERT INTO users (full_name, username, email, password_hash, role_id, is_active, locale)
SELECT v.full_name, v.username, v.email,
       '$2a$10$8/8k0qFq0t8E7dQcpOhqL.4RZbG4YkG4qv0fY9jqh4lK2u.zY6eYG',
       r.id, TRUE, 'ar'
FROM (VALUES
    ('مها السيد',     'manager1',  'manager@zahran.eg', 'manager'),
    ('سارة محمد',      'cashier1',  'sara@zahran.eg',    'cashier'),
    ('نور خالد',       'cashier2',  'nour@zahran.eg',    'cashier'),
    ('ياسمين أحمد',    'sales1',    'yasmin@zahran.eg',  'salesperson'),
    ('ريم طارق',       'sales2',    'reem@zahran.eg',    'salesperson'),
    ('مصطفى حسن',      'stock1',    'mostafa@zahran.eg', 'inventory')
) AS v(full_name, username, email, role_code)
JOIN roles r ON r.code = v.role_code
ON CONFLICT (username) DO NOTHING;

-- ----------------------------------------------------------------------------
--  2. Products — 25 styles (15 shoes + 8 bags + 2 accessories)
-- ----------------------------------------------------------------------------
INSERT INTO products (sku_prefix, name_ar, name_en, product_type, target_audience,
                      category_id, subcategory_id, brand_id,
                      base_cost, base_price, min_margin_pct, metadata, is_active)
SELECT p.sku_prefix, p.name_ar, p.name_en, p.product_type::product_type, 'women'::target_audience,
       CASE p.cat_slug WHEN 'shoes' THEN r.cat_shoes
                       WHEN 'bags'  THEN r.cat_bags
                       ELSE NULL END,
       CASE p.sub_slug
           WHEN 'evening-shoes' THEN r.sc_evening
           WHEN 'casual-shoes'  THEN r.sc_casual
           WHEN 'sport-shoes'   THEN r.sc_sport
           WHEN 'sandals'       THEN r.sc_sandals
           WHEN 'boots'         THEN r.sc_boots
           WHEN 'hand-bags'     THEN r.sc_hand
           WHEN 'clutch'        THEN r.sc_clutch
           WHEN 'backpacks'     THEN r.sc_back
           WHEN 'crossbody'     THEN r.sc_cross
           ELSE NULL END,
       r.brand_zahran,
       p.base_cost, p.base_price, 20.00,
       jsonb_build_object('season', p.season, 'material', p.material),
       TRUE
FROM _ref r, (VALUES
    -- (sku_prefix, name_ar, name_en, product_type, cat_slug, sub_slug, base_cost, base_price, season, material)
    ('SH-EV01', 'حذاء سهرة كلاسيك ذهبي',  'Classic Gold Evening Heel',  'shoe', 'shoes', 'evening-shoes', 420, 890,  'summer', 'leather'),
    ('SH-EV02', 'حذاء سهرة مفتوح فضي',    'Open Silver Evening Heel',   'shoe', 'shoes', 'evening-shoes', 380, 790,  'summer', 'satin'),
    ('SH-EV03', 'حذاء سهرة أسود لامع',    'Black Glossy Heel',          'shoe', 'shoes', 'evening-shoes', 450, 990,  'all',    'patent'),
    ('SH-CA01', 'حذاء كاجوال جلد بني',    'Brown Leather Loafer',       'shoe', 'shoes', 'casual-shoes',  300, 650,  'winter', 'leather'),
    ('SH-CA02', 'حذاء كاجوال ستراب بيج',  'Beige Strap Flat',           'shoe', 'shoes', 'casual-shoes',  280, 599,  'summer', 'suede'),
    ('SH-CA03', 'حذاء كاجوال ناعم وردي',  'Pink Ballerina Flat',        'shoe', 'shoes', 'casual-shoes',  240, 499,  'spring', 'canvas'),
    ('SH-SP01', 'حذاء رياضي أبيض',        'White Sneaker',              'shoe', 'shoes', 'sport-shoes',   350, 750,  'all',    'mesh'),
    ('SH-SP02', 'حذاء رياضي وردي',        'Pink Running Shoe',          'shoe', 'shoes', 'sport-shoes',   380, 820,  'spring', 'mesh'),
    ('SH-SA01', 'صندل كعب رفيع أسود',     'Black Stiletto Sandal',      'shoe', 'shoes', 'sandals',       360, 790,  'summer', 'leather'),
    ('SH-SA02', 'صندل مسطح بني',          'Brown Flat Sandal',          'shoe', 'shoes', 'sandals',       220, 450,  'summer', 'leather'),
    ('SH-SA03', 'صندل كريستال ذهبي',      'Gold Crystal Sandal',        'shoe', 'shoes', 'sandals',       420, 920,  'summer', 'synthetic'),
    ('SH-BT01', 'بوت جلد أسود',           'Black Leather Boot',         'shoe', 'shoes', 'boots',         560, 1250, 'winter', 'leather'),
    ('SH-BT02', 'بوت سويد نسكافيه',       'Camel Suede Boot',           'shoe', 'shoes', 'boots',         520, 1150, 'winter', 'suede'),
    ('SH-BT03', 'بوت قصير بني',            'Brown Ankle Boot',           'shoe', 'shoes', 'boots',         480, 990,  'winter', 'leather'),
    ('SH-CA04', 'حذاء كاجوال أحمر',        'Red Casual Flat',            'shoe', 'shoes', 'casual-shoes',  260, 549,  'spring', 'leather'),

    ('BG-HD01', 'حقيبة يد جلد أسود',       'Black Leather Handbag',      'bag',  'bags',  'hand-bags',     550, 1290, 'all',    'leather'),
    ('BG-HD02', 'حقيبة يد نسكافيه كلاسيك', 'Camel Classic Handbag',      'bag',  'bags',  'hand-bags',     520, 1190, 'all',    'leather'),
    ('BG-HD03', 'حقيبة يد وردي ناعم',      'Soft Pink Handbag',          'bag',  'bags',  'hand-bags',     480, 1090, 'spring', 'leather'),
    ('BG-CL01', 'كلاتش سهرة ذهبي',         'Gold Evening Clutch',        'bag',  'bags',  'clutch',        220, 550,  'summer', 'satin'),
    ('BG-CL02', 'كلاتش سهرة فضي',          'Silver Evening Clutch',      'bag',  'bags',  'clutch',        220, 550,  'summer', 'satin'),
    ('BG-BP01', 'شنطة ظهر ناعمة بيج',      'Soft Beige Backpack',        'bag',  'bags',  'backpacks',     420, 990,  'all',    'canvas'),
    ('BG-BP02', 'شنطة ظهر أسود',           'Black Backpack',             'bag',  'bags',  'backpacks',     400, 890,  'all',    'nylon'),
    ('BG-CR01', 'كروس صغير أسود',          'Small Black Crossbody',      'bag',  'bags',  'crossbody',     280, 650,  'all',    'leather'),
    ('BG-CR02', 'كروس بني كلاسيك',         'Classic Brown Crossbody',    'bag',  'bags',  'crossbody',     290, 690,  'all',    'leather'),

    ('AC-BL01', 'حزام جلد بنى',            'Brown Leather Belt',         'accessory', NULL, NULL,          90,  250,  'all',    'leather')
) AS p(sku_prefix, name_ar, name_en, product_type, cat_slug, sub_slug, base_cost, base_price, season, material)
ON CONFLICT (sku_prefix) DO NOTHING;

-- ----------------------------------------------------------------------------
--  3. Product colors — 2-4 colors per product
-- ----------------------------------------------------------------------------
INSERT INTO product_colors (product_id, color_id, is_active)
SELECT p.id, c.id, TRUE
FROM products p
CROSS JOIN LATERAL (
    -- Pick 2-4 colors deterministically based on sku_prefix
    SELECT id FROM colors
    WHERE name_ar IN (
      CASE WHEN p.sku_prefix LIKE 'SH-EV%' THEN 'ذهبي' WHEN p.sku_prefix LIKE 'BG-CL%' THEN 'ذهبي' ELSE 'أسود' END,
      CASE WHEN p.sku_prefix LIKE 'SH-SP%' THEN 'أبيض' WHEN p.sku_prefix LIKE '%EV02' THEN 'فضي'   ELSE 'بني' END,
      CASE WHEN p.sku_prefix LIKE '%01'    THEN 'وردي' ELSE 'بيج' END
    )
) c
WHERE p.sku_prefix LIKE 'SH-%' OR p.sku_prefix LIKE 'BG-%' OR p.sku_prefix LIKE 'AC-%'
ON CONFLICT (product_id, color_id) DO NOTHING;

-- ----------------------------------------------------------------------------
--  4. Variants
--     Shoes: product × color × size (sizes 37..42 to keep numbers sane)
--     Bags / accessories: product × color (size NULL)
-- ----------------------------------------------------------------------------
-- Shoes variants
INSERT INTO product_variants (product_id, color_id, size_id, sku, cost_price, selling_price, is_active)
SELECT p.id, pc.color_id, s.id,
       p.sku_prefix || '-' || substring(replace(co.name_en, ' ', ''), 1, 3) || '-' || s.size_label,
       p.base_cost,
       p.base_price,
       TRUE
FROM products p
JOIN product_colors pc ON pc.product_id = p.id
JOIN colors co ON co.id = pc.color_id
JOIN sizes  s  ON s.size_label IN ('37','38','39','40','41','42')
WHERE p.product_type = 'shoe'
ON CONFLICT (product_id, color_id, size_id) DO NOTHING;

-- Bags / accessories variants (no size)
INSERT INTO product_variants (product_id, color_id, size_id, sku, cost_price, selling_price, is_active)
SELECT p.id, pc.color_id, NULL,
       p.sku_prefix || '-' || substring(replace(co.name_en, ' ', ''), 1, 3),
       p.base_cost,
       p.base_price,
       TRUE
FROM products p
JOIN product_colors pc ON pc.product_id = p.id
JOIN colors co ON co.id = pc.color_id
WHERE p.product_type IN ('bag','accessory')
ON CONFLICT (product_id, color_id, size_id) DO NOTHING;

-- ----------------------------------------------------------------------------
--  5. Initial stock — 4..14 units per variant, reorder_point = 3
-- ----------------------------------------------------------------------------
INSERT INTO stock (variant_id, warehouse_id, quantity_on_hand, quantity_reserved, reorder_point)
SELECT pv.id, r.wh_id,
       4 + (abs(hashtext(pv.id::text)) % 11),   -- 4..14
       0,
       3
FROM product_variants pv, _ref r
ON CONFLICT (variant_id, warehouse_id) DO NOTHING;

-- ----------------------------------------------------------------------------
--  6. Customers — 40 rows with phones (Egyptian format) and tiers
-- ----------------------------------------------------------------------------
INSERT INTO customers (customer_no, full_name, phone, gender, city, governorate,
                       loyalty_tier, loyalty_points, is_vip)
SELECT
    'CUS-' || lpad((1000 + row_number() OVER (ORDER BY v.full_name))::text, 6, '0'),
    v.full_name,
    '010' || lpad(((hashtext(v.full_name) & 2147483647) % 100000000)::text, 8, '0'),
    'female',
    v.city, v.gov,
    v.tier, v.points, v.vip
FROM (VALUES
    ('ندى مصطفى',     'القاهرة',   'القاهرة',     'gold',     2400, TRUE),
    ('هبة محمود',      'الإسكندرية','الإسكندرية',  'silver',   1100, FALSE),
    ('دينا شريف',      'الجيزة',    'الجيزة',      'platinum', 6200, TRUE),
    ('منى عبدالله',    'المنصورة',  'الدقهلية',    'silver',   800,  FALSE),
    ('رانيا صلاح',     'طنطا',      'الغربية',     'bronze',   150,  FALSE),
    ('أميرة فاروق',    'القاهرة',   'القاهرة',     'gold',     3100, TRUE),
    ('سمر جمال',       'الإسكندرية','الإسكندرية',  'silver',   900,  FALSE),
    ('هدى إبراهيم',    'أسيوط',     'أسيوط',      'bronze',    50,  FALSE),
    ('عبير أحمد',      'المنيا',    'المنيا',     'bronze',   320,  FALSE),
    ('رحمة يوسف',      'القاهرة',   'القاهرة',    'silver',   1250, FALSE),
    ('إيمان خالد',     'الزقازيق',  'الشرقية',    'bronze',    90,  FALSE),
    ('مروة سامي',      'القاهرة',   'القاهرة',    'gold',     2800, FALSE),
    ('نسرين فؤاد',     'الجيزة',    'الجيزة',      'silver',   1050, FALSE),
    ('شيماء عادل',     'الفيوم',    'الفيوم',     'bronze',    210, FALSE),
    ('لمياء أكرم',     'الإسماعيلية','الإسماعيلية','bronze',    170, FALSE),
    ('آية حسام',       'القاهرة',   'القاهرة',    'platinum', 5600, TRUE),
    ('فاطمة السيد',    'الجيزة',    'الجيزة',      'silver',   1800, FALSE),
    ('نجلاء عبدالرحمن','المنصورة',  'الدقهلية',    'bronze',    260, FALSE),
    ('ميرنا رامي',     'القاهرة',   'القاهرة',    'gold',     2550, FALSE),
    ('حبيبة وائل',     'الإسكندرية','الإسكندرية',  'silver',   1450, FALSE),
    ('جنى وليد',       'طنطا',     'الغربية',    'bronze',    110, FALSE),
    ('مريم شوقي',      'القاهرة',   'القاهرة',    'bronze',    200, FALSE),
    ('يارا أشرف',      'الجيزة',    'الجيزة',      'silver',   950,  FALSE),
    ('ملك رضا',        'دمياط',     'دمياط',      'bronze',    60,  FALSE),
    ('سلمى كريم',      'القاهرة',   'القاهرة',    'gold',     3400, TRUE),
    ('روان هيثم',      'الإسكندرية','الإسكندرية',  'silver',   1600, FALSE),
    ('أسماء نبيل',     'سوهاج',     'سوهاج',      'bronze',    130, FALSE),
    ('مرام طاهر',      'القاهرة',   'القاهرة',    'silver',   780,  FALSE),
    ('تسنيم عمرو',     'بورسعيد',   'بورسعيد',    'bronze',    90,  FALSE),
    ('جيهان حمدي',     'القاهرة',   'القاهرة',    'gold',     2950, FALSE),
    ('رفيدة أنور',     'الجيزة',    'الجيزة',      'silver',   1300, FALSE),
    ('منال زكي',       'الأقصر',    'الأقصر',     'bronze',    180, FALSE),
    ('عزة حلمي',       'القاهرة',   'القاهرة',    'silver',   1150, FALSE),
    ('هند عبدالحميد',  'الإسكندرية','الإسكندرية',  'bronze',    230, FALSE),
    ('ريهام عثمان',    'القاهرة',   'القاهرة',    'platinum', 7800, TRUE),
    ('سندس رفعت',      'المنصورة',  'الدقهلية',    'bronze',    75,  FALSE),
    ('نهى سعد',        'القاهرة',   'القاهرة',    'gold',     2200, FALSE),
    ('إسراء صبحي',     'الجيزة',    'الجيزة',      'silver',   890,  FALSE),
    ('بسنت مؤمن',      'القاهرة',   'القاهرة',    'silver',   1020, FALSE),
    ('نيرة علاء',      'القاهرة',   'القاهرة',    'bronze',    190, FALSE)
) AS v(full_name, city, gov, tier, points, vip)
ON CONFLICT (phone) DO NOTHING;

-- ----------------------------------------------------------------------------
--  7. Invoices — spread over the past 60 days
--     We do this procedurally so triggers (invoice_no, stock movements,
--     loyalty) fire naturally.
-- ----------------------------------------------------------------------------
DO $seed$
DECLARE
    v_wh_id         UUID;
    v_admin_id      UUID;
    v_cashier_ids   UUID[];
    v_sales_ids     UUID[];
    v_customer_ids  UUID[];
    v_variants      RECORD;
    v_invoice_id    UUID;
    v_variant_id    UUID;
    v_unit_price    NUMERIC;
    v_unit_cost     NUMERIC;
    v_qty           INT;
    v_line_total    NUMERIC;
    v_subtotal      NUMERIC;
    v_invoice_disc  NUMERIC;
    v_grand_total   NUMERIC;
    v_paid_cash     NUMERIC;
    v_paid_card     NUMERIC;
    v_tax_rate      NUMERIC := 14.00;
    v_date          TIMESTAMPTZ;
    i INT;
    j INT;
    n_items INT;
    n_invoices INT := 90;
BEGIN
    SELECT wh_id INTO v_wh_id FROM _ref;
    SELECT admin_id INTO v_admin_id FROM _ref;

    SELECT array_agg(u.id) INTO v_cashier_ids
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.code = 'cashier';
    IF v_cashier_ids IS NULL THEN v_cashier_ids := ARRAY[v_admin_id]; END IF;

    SELECT array_agg(u.id) INTO v_sales_ids
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.code = 'salesperson';

    SELECT array_agg(id) INTO v_customer_ids FROM customers WHERE deleted_at IS NULL;

    -- Skip if we've already seeded — detect by invoice_no prefix counter
    IF (SELECT count(*) FROM invoices WHERE source = 'pos' AND metadata @> '{"demo":true}'::jsonb) > 0 THEN
        RAISE NOTICE 'Demo invoices already seeded, skipping.';
        RETURN;
    END IF;

    FOR i IN 1..n_invoices LOOP
        v_date := NOW() - ((i * 16) || ' hours')::interval
                        - ((abs(hashtext('t' || i)) % 8) || ' hours')::interval;

        INSERT INTO invoices (warehouse_id, customer_id, cashier_id, salesperson_id,
                              status, source, tax_rate, metadata,
                              created_at, completed_at)
        VALUES (
            v_wh_id,
            v_customer_ids[1 + (abs(hashtext('c' || i)) % array_length(v_customer_ids, 1))],
            v_cashier_ids[1 + (abs(hashtext('u' || i)) % array_length(v_cashier_ids, 1))],
            CASE WHEN v_sales_ids IS NOT NULL
                 THEN v_sales_ids[1 + (abs(hashtext('s' || i)) % array_length(v_sales_ids, 1))]
                 ELSE NULL END,
            'completed'::invoice_status, 'pos', v_tax_rate,
            jsonb_build_object('demo', true, 'device', 'POS-1'),
            v_date, v_date
        )
        RETURNING id INTO v_invoice_id;

        v_subtotal := 0;
        n_items := 1 + (abs(hashtext('n' || i)) % 4);  -- 1..4 lines

        FOR j IN 1..n_items LOOP
            -- pick a random variant with stock
            SELECT pv.id, pv.selling_price, pv.cost_price,
                   p.name_ar, pv.sku,
                   co.name_ar, sz.size_label
            INTO v_variants
            FROM product_variants pv
            JOIN products p  ON p.id = pv.product_id
            JOIN colors co   ON co.id = pv.color_id
            LEFT JOIN sizes sz ON sz.id = pv.size_id
            JOIN stock st    ON st.variant_id = pv.id AND st.warehouse_id = v_wh_id
            WHERE pv.is_active AND st.quantity_on_hand > 0
            ORDER BY md5(i::text || j::text || pv.id::text)
            LIMIT 1;

            EXIT WHEN v_variants IS NULL;

            v_variant_id := v_variants.id;
            v_unit_price := v_variants.selling_price;
            v_unit_cost  := v_variants.cost_price;
            v_qty        := 1 + (abs(hashtext('q' || i || j)) % 2);   -- 1 or 2

            v_line_total := v_qty * v_unit_price;

            INSERT INTO invoice_items
                (invoice_id, variant_id, product_name_snapshot, sku_snapshot,
                 color_name_snapshot, size_label_snapshot,
                 quantity, unit_cost, unit_price,
                 line_subtotal, line_total)
            VALUES
                (v_invoice_id, v_variant_id,
                 v_variants.name_ar, v_variants.sku,
                 v_variants.name_ar, v_variants.size_label,
                 v_qty, v_unit_cost, v_unit_price,
                 v_line_total, v_line_total);

            -- Ledger only — the `trg_apply_stock_movement` trigger
            -- (migration 011) already decrements stock.quantity_on_hand
            -- from each stock_movements row. The old seed had a manual
            -- UPDATE stock right before the INSERT, which made stock
            -- decrement TWICE per sale — eventually pushing rows past
            -- 0 and tripping the `quantity_on_hand >= 0` CHECK.
            INSERT INTO stock_movements
                (variant_id, warehouse_id, movement_type, direction,
                 quantity, unit_cost, reference_type, reference_id, user_id)
            VALUES
                (v_variant_id, v_wh_id, 'sale', 'out',
                 v_qty, v_unit_cost, 'invoice'::entity_type, v_invoice_id, v_admin_id);

            v_subtotal := v_subtotal + v_line_total;
        END LOOP;

        -- Invoice-level discount: 10% of the time, a small flat discount
        v_invoice_disc := CASE WHEN (abs(hashtext('d' || i)) % 10) = 0
                               THEN round(v_subtotal * 0.05, 2)
                               ELSE 0 END;

        v_grand_total := v_subtotal - v_invoice_disc;

        -- Split payments 50/50 on half the invoices, else pure cash
        IF (i % 2) = 0 AND v_grand_total > 200 THEN
            v_paid_cash := round(v_grand_total / 2, 2);
            v_paid_card := v_grand_total - v_paid_cash;
        ELSE
            v_paid_cash := v_grand_total;
            v_paid_card := 0;
        END IF;

        UPDATE invoices
           SET subtotal         = v_subtotal,
               invoice_discount = v_invoice_disc,
               grand_total      = v_grand_total,
               paid_amount      = v_grand_total,
               tax_amount       = 0,                  -- inclusive VAT for now
               cogs_total       = (SELECT COALESCE(sum(quantity * unit_cost),0)
                                   FROM invoice_items WHERE invoice_id = v_invoice_id),
               gross_profit     = v_grand_total -
                                  (SELECT COALESCE(sum(quantity * unit_cost),0)
                                   FROM invoice_items WHERE invoice_id = v_invoice_id)
         WHERE id = v_invoice_id;

        INSERT INTO invoice_payments (invoice_id, payment_method, amount, received_by, paid_at)
        VALUES (v_invoice_id, 'cash'::payment_method_code, v_paid_cash, v_admin_id, v_date);

        IF v_paid_card > 0 THEN
            INSERT INTO invoice_payments (invoice_id, payment_method, amount, reference_number,
                                          received_by, paid_at)
            VALUES (v_invoice_id, 'card_visa'::payment_method_code, v_paid_card,
                    'AUTH' || lpad(i::text, 6, '0'), v_admin_id, v_date);
        END IF;
    END LOOP;

    RAISE NOTICE 'Seeded % demo invoices', n_invoices;
END
$seed$;

-- ----------------------------------------------------------------------------
--  8. Cashbox opening balance + running total from invoices
-- ----------------------------------------------------------------------------
UPDATE cashboxes
   SET current_balance = (
       SELECT COALESCE(sum(ip.amount), 0)
       FROM invoice_payments ip
       WHERE ip.payment_method = 'cash'
   ) + 5000   -- 5000 EGP opening float
 WHERE id = (SELECT cash_id FROM _ref);

-- ----------------------------------------------------------------------------
--  9. A handful of expenses over the last month
-- ----------------------------------------------------------------------------
INSERT INTO expenses (warehouse_id, category_id, amount, payment_method,
                      cashbox_id, description, vendor_name, is_approved, approved_by,
                      expense_date, created_by)
SELECT
    r.wh_id,
    ec.id,
    v.amount,
    v.pm::payment_method_code,
    CASE WHEN v.pm = 'cash' THEN r.cash_id ELSE NULL END,
    v.description,
    v.vendor,
    TRUE,
    r.admin_id,
    (NOW() - (v.days_ago || ' days')::interval)::date,
    r.admin_id
FROM _ref r,
expense_categories ec,
(VALUES
    ('rent',       12000, 'bank_transfer', 'إيجار المحل شهر إبريل',    'عقار زهران',     30),
    ('salaries',   18000, 'cash',          'رواتب الموظفين',            'الموظفين',       28),
    ('utilities',   1250, 'cash',          'فاتورة كهرباء',              'شركة الكهرباء',  25),
    ('utilities',    380, 'cash',          'فاتورة مياه',                'شركة المياه',    25),
    ('marketing',   2500, 'card_visa',     'إعلانات فيسبوك',             'Meta Ads',       20),
    ('supplies',     550, 'cash',          'أكياس تغليف + فواتير',       'ستايل بلاستك',   18),
    ('transport',    900, 'cash',          'نقل بضاعة من المصنع',        'شركة الشحن',     14),
    ('maintenance',  650, 'cash',          'صيانة تكييف',                'فني صيانة',      10)
) AS v(cat_code, amount, pm, description, vendor, days_ago)
WHERE ec.code = v.cat_code
ON CONFLICT DO NOTHING;

-- Matching cashbox outflow for each cash expense — compute running balance_after
DO $cbx$
DECLARE
    v_cash_id UUID;
    v_bal     NUMERIC;
    rec       RECORD;
BEGIN
    SELECT cash_id INTO v_cash_id FROM _ref;
    SELECT current_balance INTO v_bal FROM cashboxes WHERE id = v_cash_id;

    FOR rec IN
        SELECT e.id, e.amount, e.description, e.created_by, e.expense_date
          FROM expenses e
         WHERE e.payment_method = 'cash'
           AND e.cashbox_id = v_cash_id
           AND NOT EXISTS (
               SELECT 1 FROM cashbox_transactions ct
                WHERE ct.reference_type = 'expense' AND ct.reference_id = e.id
           )
      ORDER BY e.expense_date
    LOOP
        v_bal := v_bal - rec.amount;
        INSERT INTO cashbox_transactions
            (cashbox_id, direction, amount, category, reference_type, reference_id,
             balance_after, notes, user_id, created_at)
        VALUES
            (v_cash_id, 'out'::txn_direction, rec.amount, 'expense',
             'expense'::entity_type, rec.id,
             v_bal, rec.description, rec.created_by, rec.expense_date::timestamptz);
    END LOOP;

    UPDATE cashboxes SET current_balance = v_bal, updated_at = NOW() WHERE id = v_cash_id;
END
$cbx$;

COMMIT;
