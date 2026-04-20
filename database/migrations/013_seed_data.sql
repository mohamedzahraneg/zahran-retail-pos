-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 013 : Seed Data
--  Run LAST, after all schema + triggers are in place.
-- ============================================================================

-- ---------- Company profile ----------
INSERT INTO company_profile (id, name_ar, name_en, default_tax_rate, default_currency,
                             receipt_footer_ar, return_policy_text_ar)
VALUES (1, 'زهران لأحذية وحقائب السيدات', 'Zahran Women Shoes & Bags',
        14.00, 'EGP',
        'شكراً لتسوقك من زهران ❤️ — الاستبدال خلال 7 أيام مع فاتورة.',
        'يحق للعميل استبدال المنتج خلال 7 أيام من تاريخ الشراء بشرط احتفاظه بالفاتورة والتغليف الأصلي.')
ON CONFLICT (id) DO NOTHING;

-- ---------- Roles ----------
INSERT INTO roles (code, name_ar, name_en, is_system, description) VALUES
 ('admin',        'مدير النظام',   'System Administrator', TRUE,  'صلاحيات كاملة'),
 ('manager',      'مدير',          'Manager',              TRUE,  'إدارة الفرع والتقارير'),
 ('cashier',      'كاشير',         'Cashier',              TRUE,  'مبيعات نقطة البيع'),
 ('salesperson',  'مندوب مبيعات',   'Salesperson',          TRUE,  'مساعدة العملاء والعمولات'),
 ('inventory',    'موظف مخزون',     'Inventory Staff',      TRUE,  'استقبال وجرد وتحويل مخزون')
ON CONFLICT (code) DO NOTHING;

-- ---------- Permissions (module.action) ----------
INSERT INTO permissions (code, module, name_ar, name_en) VALUES
 ('dashboard.view',         'dashboard',  'عرض لوحة التحكم',       'View dashboard'),
 ('products.view',          'products',   'عرض المنتجات',          'View products'),
 ('products.create',        'products',   'إضافة منتج',             'Create product'),
 ('products.update',        'products',   'تعديل المنتج',           'Update product'),
 ('products.delete',        'products',   'حذف منتج',               'Delete product'),
 ('products.import',        'products',   'استيراد Excel',          'Import products from Excel'),
 ('inventory.view',         'inventory',  'عرض المخزون',            'View inventory'),
 ('inventory.adjust',       'inventory',  'تسويات المخزون',         'Adjust stock'),
 ('inventory.transfer',     'inventory',  'تحويل مخزون',            'Transfer stock'),
 ('inventory.count',        'inventory',  'جرد فعلي',              'Inventory count'),
 ('pos.sell',               'pos',        'البيع',                 'POS sell'),
 ('pos.discount',           'pos',        'إعطاء خصم',             'Apply discount'),
 ('pos.void',               'pos',        'إلغاء فاتورة',           'Void invoice'),
 ('reservations.view',      'reservations','عرض الحجوزات',          'View reservations'),
 ('reservations.create',    'reservations','حجز منتج',              'Create reservation'),
 ('reservations.complete',  'reservations','إتمام الحجز',            'Complete reservation'),
 ('reservations.cancel',    'reservations','إلغاء الحجز',           'Cancel reservation'),
 ('returns.create',         'returns',    'إنشاء مرتجع',            'Create return'),
 ('returns.approve',        'returns',    'اعتماد مرتجع',           'Approve return'),
 ('exchanges.create',       'exchanges',  'إنشاء استبدال',          'Create exchange'),
 ('customers.view',         'customers',  'عرض العملاء',           'View customers'),
 ('customers.create',       'customers',  'إضافة عميل',             'Create customer'),
 ('suppliers.view',         'suppliers',  'عرض الموردين',           'View suppliers'),
 ('suppliers.manage',       'suppliers',  'إدارة الموردين',         'Manage suppliers'),
 ('purchases.view',         'purchases',  'عرض المشتريات',          'View purchases'),
 ('purchases.create',       'purchases',  'إنشاء مشتريات',          'Create purchase'),
 ('accounting.view',        'accounting', 'عرض الحسابات',           'View accounting'),
 ('expenses.create',        'expenses',   'تسجيل مصروف',            'Create expense'),
 ('expenses.approve',       'expenses',   'اعتماد مصروف',           'Approve expense'),
 ('shifts.open',            'shifts',     'فتح وردية',             'Open shift'),
 ('shifts.close',           'shifts',     'إغلاق وردية',            'Close shift'),
 ('reports.view',           'reports',    'عرض التقارير',           'View reports'),
 ('reports.export',         'reports',    'تصدير تقارير',           'Export reports'),
 ('settings.view',          'settings',   'عرض الإعدادات',           'View settings'),
 ('settings.update',        'settings',   'تعديل الإعدادات',         'Update settings'),
 ('users.manage',           'users',      'إدارة المستخدمين',        'Manage users'),
 ('coupons.manage',         'coupons',    'إدارة الكوبونات',          'Manage coupons'),
 ('alerts.manage',          'alerts',     'إدارة التنبيهات',          'Manage alerts')
ON CONFLICT (code) DO NOTHING;

-- ---------- Role → Permissions ----------
-- Admin: everything
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'admin'
ON CONFLICT DO NOTHING;

-- Manager: everything except users.manage
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'manager' AND p.code <> 'users.manage'
ON CONFLICT DO NOTHING;

-- Cashier
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'cashier' AND p.code IN (
  'dashboard.view','products.view','inventory.view',
  'pos.sell','pos.discount',
  'reservations.view','reservations.create','reservations.complete',
  'returns.create','exchanges.create',
  'customers.view','customers.create',
  'shifts.open','shifts.close'
)
ON CONFLICT DO NOTHING;

-- Salesperson
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'salesperson' AND p.code IN (
  'dashboard.view','products.view','inventory.view',
  'pos.sell','reservations.view','reservations.create',
  'customers.view','customers.create','reports.view'
)
ON CONFLICT DO NOTHING;

-- Inventory staff
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'inventory' AND p.code IN (
  'dashboard.view','products.view','products.create','products.update','products.import',
  'inventory.view','inventory.adjust','inventory.transfer','inventory.count',
  'suppliers.view','purchases.view','purchases.create'
)
ON CONFLICT DO NOTHING;

-- ---------- Default admin user ----------
-- Password = "Admin@123" — bcrypt hash (replace in production!)
-- Generated with:  node -e "console.log(require('bcryptjs').hashSync('Admin@123',10))"
INSERT INTO users (id, full_name, username, email, password_hash, role_id, is_active, must_change_pwd, locale)
SELECT
  uuid_generate_v4(),
  'مدير النظام',
  'admin',
  'admin@zahran.eg',
  '$2b$10$6wVSN0EH9s2ULd82SuW2e.Ed3wlz3z6H2BiOet4II.tMxcZ6SkY1y',
  r.id,
  TRUE,
  TRUE,
  'ar'
FROM roles r WHERE r.code = 'admin'
ON CONFLICT (username) DO NOTHING;

-- ---------- Warehouses (main branch) ----------
INSERT INTO warehouses (code, name_ar, name_en, is_main, is_retail, is_active)
VALUES ('ZHR-01','الفرع الرئيسي','Main Branch', TRUE, TRUE, TRUE)
ON CONFLICT (code) DO NOTHING;

-- ---------- Cashbox (main) ----------
INSERT INTO cashboxes (name_ar, name_en, warehouse_id)
SELECT 'الخزينة الرئيسية', 'Main Cashbox', w.id
FROM warehouses w WHERE w.code = 'ZHR-01'
ON CONFLICT DO NOTHING;

-- ---------- Payment methods ----------
INSERT INTO payment_methods (code, name_ar, name_en, sort_order, requires_reference) VALUES
 ('cash',             'كاش',            'Cash',             1, FALSE),
 ('card_visa',        'فيزا',           'Visa Card',        2, TRUE),
 ('card_mastercard',  'ماستركارد',      'MasterCard',       3, TRUE),
 ('card_meeza',       'ميزة',           'Meeza',            4, TRUE),
 ('instapay',         'إنستا باي',      'InstaPay',         5, TRUE),
 ('vodafone_cash',    'فودافون كاش',    'Vodafone Cash',    6, TRUE),
 ('orange_cash',      'أورانج كاش',     'Orange Cash',      7, TRUE),
 ('bank_transfer',    'تحويل بنكي',     'Bank Transfer',    8, TRUE),
 ('credit',           'آجل',            'Credit',           9, FALSE),
 ('other',            'أخرى',           'Other',           10, FALSE)
ON CONFLICT (code) DO NOTHING;

-- ---------- Categories ----------
INSERT INTO categories (name_ar, name_en, slug, sort_order) VALUES
 ('أحذية',     'Shoes',        'shoes',         1),
 ('حقائب',     'Bags',         'bags',          2),
 ('إكسسوارات', 'Accessories',  'accessories',   3)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO categories (parent_id, name_ar, name_en, slug, sort_order)
SELECT c.id, v.name_ar, v.name_en, v.slug, v.sort_order
FROM categories c
JOIN (VALUES
    ('shoes','أحذية سهرة','Evening Shoes','evening-shoes',1),
    ('shoes','أحذية كاجوال','Casual Shoes','casual-shoes',2),
    ('shoes','أحذية رياضية','Sport Shoes','sport-shoes',3),
    ('shoes','صنادل','Sandals','sandals',4),
    ('shoes','بوت','Boots','boots',5),
    ('bags', 'شنط يد',  'Hand Bags', 'hand-bags', 1),
    ('bags', 'كلاتش',   'Clutch',    'clutch',    2),
    ('bags', 'ظهر',     'Backpacks', 'backpacks', 3),
    ('bags', 'كروس',    'Crossbody', 'crossbody', 4)
) AS v(parent_slug, name_ar, name_en, slug, sort_order)
ON c.slug = v.parent_slug
ON CONFLICT (slug) DO NOTHING;

-- ---------- Colors ----------
INSERT INTO colors (name_ar, name_en, hex_code) VALUES
 ('أسود',      'Black',      '#000000'),
 ('أبيض',      'White',      '#FFFFFF'),
 ('أحمر',      'Red',        '#E53935'),
 ('وردي',      'Pink',       '#EC407A'),
 ('وردي فاتح', 'Light Pink', '#F8BBD0'),
 ('بيج',       'Beige',      '#D7CCC8'),
 ('بني',       'Brown',      '#6D4C41'),
 ('ذهبي',      'Gold',       '#D4AF37'),
 ('فضي',       'Silver',     '#C0C0C0'),
 ('أزرق',      'Blue',       '#1E88E5'),
 ('أزرق نيلي', 'Navy',       '#0D47A1'),
 ('أخضر',      'Green',      '#43A047'),
 ('زيتي',      'Olive',      '#827717'),
 ('رمادي',     'Grey',       '#757575'),
 ('نسكافيه',   'Camel',      '#A47148')
ON CONFLICT (name_ar) DO NOTHING;

-- ---------- Sizes (EU shoes 35..44) ----------
INSERT INTO sizes (size_label, size_system, sort_order) VALUES
 ('35','EU',1),('36','EU',2),('37','EU',3),('38','EU',4),
 ('39','EU',5),('40','EU',6),('41','EU',7),('42','EU',8),
 ('43','EU',9),('44','EU',10)
ON CONFLICT (size_label) DO NOTHING;

-- ---------- Expense categories ----------
INSERT INTO expense_categories (code, name_ar, name_en, is_fixed, allocate_to_cogs) VALUES
 ('rent',        'إيجار',             'Rent',              TRUE,  TRUE),
 ('salaries',    'رواتب',             'Salaries',          TRUE,  TRUE),
 ('utilities',   'كهرباء ومرافق',      'Utilities',         TRUE,  TRUE),
 ('marketing',   'تسويق وإعلان',       'Marketing',         FALSE, FALSE),
 ('maintenance', 'صيانة',             'Maintenance',       FALSE, FALSE),
 ('supplies',    'مستلزمات',          'Supplies',          FALSE, FALSE),
 ('transport',   'نقل ومواصلات',       'Transport',         FALSE, TRUE),
 ('tax',         'ضرائب',             'Taxes',             FALSE, FALSE),
 ('other',       'أخرى',              'Other',             FALSE, FALSE)
ON CONFLICT (code) DO NOTHING;

-- ---------- Settings ----------
INSERT INTO settings (key, value, group_name, description) VALUES
 ('pos.default_payment_method', '"cash"'::jsonb,                 'pos',          'طريقة الدفع الافتراضية'),
 ('pos.allow_negative_stock',   'false'::jsonb,                  'pos',          'السماح بالبيع بمخزون سالب'),
 ('pos.require_customer',       'false'::jsonb,                  'pos',          'إجبار اختيار عميل لكل فاتورة'),
 ('pos.print_on_save',          'true'::jsonb,                   'pos',          'طباعة الفاتورة فور الحفظ'),
 ('reservation.default_deposit_pct', '30'::jsonb,                'reservation',  'نسبة العربون الافتراضية'),
 ('reservation.default_expiry_days', '7'::jsonb,                 'reservation',  'مدة الحجز بالأيام'),
 ('reservation.cancellation_fee_pct', '10'::jsonb,               'reservation',  'نسبة رسوم الإلغاء'),
 ('reservation.auto_expire',    'true'::jsonb,                   'reservation',  'إلغاء تلقائي بعد انتهاء المدة'),
 ('loyalty.rate',               '{"points_per_egp": 0.1}'::jsonb,'loyalty',      'نقطة لكل 10 جنيه'),
 ('loyalty.tiers',              '{"bronze":0,"silver":5000,"gold":20000,"platinum":50000}'::jsonb, 'loyalty', 'حدود الفئات'),
 ('smart_pricing.min_margin_default', '15'::jsonb,               'smart_pricing','أقل هامش ربح افتراضي %'),
 ('alerts.low_stock_threshold', '5'::jsonb,                      'alerts',       'حد تنبيه المخزون المنخفض'),
 ('printing.receipt_size',      '"80mm"'::jsonb,                 'printing',     'مقاس إيصال الكاشير'),
 ('printing.language',          '"ar"'::jsonb,                   'printing',     'لغة الطباعة'),
 ('offline.sync_batch_size',    '100'::jsonb,                    'offline',      'عدد العمليات في كل دفعة مزامنة'),
 ('offline.max_retry',          '5'::jsonb,                      'offline',      'أقصى عدد محاولات مزامنة')
ON CONFLICT (key) DO NOTHING;

-- ---------- Default alert rules ----------
INSERT INTO alert_rules (alert_type, name_ar, threshold_value, config, notify_channels) VALUES
 ('low_stock',             'تنبيه مخزون منخفض',   5,    '{}',                        'in_app'),
 ('out_of_stock',          'تنبيه نفاد مخزون',    0,    '{}',                        'in_app'),
 ('reservation_expiring',  'حجز على وشك الانتهاء', NULL, '{"hours_before":24}',      'in_app'),
 ('loss_product',          'منتج يباع بخسارة',    NULL, '{}',                        'in_app'),
 ('cash_mismatch',         'فرق في الخزينة',      50,   '{"currency":"EGP"}',        'in_app')
ON CONFLICT DO NOTHING;

-- ---------- Default brand ----------
INSERT INTO brands (name_ar, name_en) VALUES
 ('زهران',  'Zahran'),
 ('بلا علامة', 'Generic')
ON CONFLICT DO NOTHING;
