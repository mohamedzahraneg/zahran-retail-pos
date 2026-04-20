# زهران — نظام إدارة المحلات  |  Zahran Retail System

<div dir="rtl">

نظام إدارة محل نسائي كامل (أحذية وحقائب) يدعم نقطة البيع، المخزون، الحسابات،
الحجوزات بعربون جزئي، المرتجعات/الاستبدال، التنبيهات الذكية، وتقارير الأرباح —
**مع إمكانية العمل أوفلاين**.

</div>

> **⚠️ الحالة الحالية:** هذه الحزمة تحتوي على **قاعدة البيانات الكاملة (PostgreSQL)**
> + رسم ERD + قالب استيراد Excel + دليل النشر. طبقات الـ Backend والـ Frontend
> لم تُبنى بعد في هذا التسليم (حسب الأولوية التي اختيرت). الهيكل أُعدّ بحيث
> يُبنى فوقه مباشرة NestJS/Laravel + React PWA.

---

## 📁 محتويات هذا المجلد

```
Zahran/
├── README.md                          ← هذا الملف
├── database/
│   ├── schema.sql                     ← ملف التشغيل الرئيسي (\i imports)
│   ├── schema_combined.sql            ← نسخة مدمجة (single-file)
│   ├── VALIDATION_REPORT.md           ← تقرير التحقق من صحة الـSQL
│   ├── ERD.md                         ← رسم ERD بصيغة Mermaid
│   └── migrations/
│       ├── 001_extensions_and_enums.sql
│       ├── 002_rbac_users.sql
│       ├── 003_catalog.sql
│       ├── 004_inventory.sql
│       ├── 005_customers_suppliers.sql
│       ├── 006_pos_and_discounts.sql
│       ├── 007_reservations.sql       🔥
│       ├── 008_returns_exchanges.sql
│       ├── 009_accounting_shifts.sql
│       ├── 010_support_alerts_settings_offline.sql
│       ├── 011_functions_and_triggers.sql
│       ├── 012_views_for_reports.sql
│       ├── 013_seed_data.sql
│       ├── 014_cash_desk.sql              ← قسم الصندوق (استلام/دفع نقدية) 💰
│       └── 015_dashboard_views.sql        ← داشبورد + توصيات ذكية 📊
├── templates/
│   ├── zahran_products_import_template.xlsx   ← قالب Excel كامل (RTL + Validation)
│   └── zahran_products_import_template.csv
└── docs/
    ├── DEPLOYMENT.md                  ← دليل النشر (Docker + PWA)
    └── OFFLINE_STRATEGY.md            ← استراتيجية الأوفلاين تفصيلاً
```

---

## 🚀 التشغيل السريع

### 1) إنشاء قاعدة البيانات
```bash
# PostgreSQL 14 أو أحدث مطلوب
createdb zahran_retail
psql -d zahran_retail -v ON_ERROR_STOP=1 -f database/schema.sql
```

**أو** استخدم النسخة المدمجة:
```bash
psql -d zahran_retail -f database/schema_combined.sql
```

النتيجة المتوقعة تنتهي بـ:
```
== Schema installed successfully ✅ ==
```

### 2) تسجيل الدخول الافتراضي
بعد تشغيل الـ seed تُنشأ عدة جداول مرجعية + مستخدم أدمن:

| الحقل       | القيمة                 |
|-------------|------------------------|
| اسم المستخدم | `admin`                |
| كلمة المرور | `Admin@123`            |
| البريد      | `admin@zahran.eg`      |
| الدور       | مدير النظام            |

**🔒 غيّر كلمة المرور فوراً بعد أول تسجيل دخول** (`must_change_pwd = TRUE`).

### 3) معاينة الـ ERD
افتح `database/ERD.md` في أي عارض Markdown يدعم Mermaid
(GitHub, VS Code + Mermaid extension, Obsidian...).

---

## 🧩 معمارية النظام المقترحة

```
┌────────────────────────────────────────────────────────────┐
│                    React PWA (RTL Arabic)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │  POS screen  │  │ Dashboard    │  │ Reports / Admin  │ │
│  └──────────────┘  └──────────────┘  └──────────────────┘ │
│         │                                                   │
│   IndexedDB (local) + Service Worker + Workbox            │
└──────────────┬─────────────────────────────────────────────┘
               │  REST + WebSocket (JWT)
               ▼
┌────────────────────────────────────────────────────────────┐
│             NestJS (or Laravel) API Gateway               │
│  Auth • RBAC • POS • Inventory • Reservations • Profit    │
│  Sync endpoint (/sync/push, /sync/pull)                   │
└──────────────┬─────────────────────────────────────────────┘
               │
               ▼
┌────────────────────────────────────────────────────────────┐
│          PostgreSQL 14+  (هذا المجلد schema.sql)            │
│   + Redis (cache/queue)     + MinIO/S3 (product images)    │
└────────────────────────────────────────────────────────────┘
```

---

## 🔑 أبرز مميزات قاعدة البيانات

### 1. ✅ نظام حجز بعربون جزئي 🔥  (`reservations`)
- عميل يختار منتج → يدفع جزءاً من الثمن.
- المخزون يُحجز تلقائياً (`stock.quantity_reserved += qty`).
- لا يمكن بيع القطعة المحجوزة في نقطة البيع.
- عند العودة: تحويل الحجز إلى فاتورة مع احتساب المبلغ المدفوع.
- عند الإلغاء: استرداد جزئي حسب السياسة (% رسوم إلغاء).
- إلغاء تلقائي بعد انتهاء الصلاحية (إعداد اختياري).

### 2. ✅ نظام خصومات متعدد المستويات
- خصم على مستوى المنتج (فيكس / %).
- خصم على مستوى الفاتورة.
- تتبع من أعطى الخصم + السبب (`discount_usages`).
- تقارير: إجمالي الخصومات / لكل كاشير / لكل منتج.

### 3. ✅ كوبونات (`coupons`)
- كود فريد + نسبة/فيكس + حد أدنى للطلب.
- تاريخ انتهاء + حد أقصى للاستخدام.
- قابل للتخصيص على تصنيف/منتج معين.

### 4. ✅ متعدد المستودعات/الفروع
- جدول `stock` يحمل الكمية لكل (variant × warehouse).
- تحويلات داخلية بين الفروع (`stock_transfers`).
- جرد فعلي مع التسويات الموثقة.

### 5. ✅ محرك الأرباح (`v_daily_profit`)
- ربح إجمالي = إيراد − تكلفة البضاعة المباعة.
- ربح صافي = ربح إجمالي − مصروفات موزّعة (تُعلَّم `allocate_to_cogs`).

### 6. ✅ الذكاء في التسعير (`v_pricing_suggestions`)
- سعر مقترح يحافظ على هامش `min_margin_pct`.
- تنبيه تلقائي عند بيع منتج بخسارة (`v_loss_products`).

### 7. ✅ نظام تنبيهات مرن
- مخزون منخفض، نفاد مخزون، حجز ينتهي، منتج يباع بخسارة، فرق خزينة.
- قواعد `alert_rules` قابلة للتخصيص.

### 8. ✅ عربي RTL من البداية
- كل حقل له `name_ar` + `name_en`.
- تنسيق `CITEXT` للبريد والباركود.
- دعم `pg_trgm` للبحث النصي السريع.

### 9. ✅ صلاحيات RBAC كاملة
- 5 أدوار افتراضية: Admin، Manager، Cashier، Salesperson، Inventory.
- ~38 صلاحية محددة بدقة.

### 10. ✅ جاهز للأوفلاين (`offline_sync_queue`)
- كل عملية أوفلاين لها `offline_id` (UUID من العميل).
- السيرفر يحل التعارضات ثم يعيد `server_id`.
- مؤشر `state = pending | synced | conflict | failed`.

### 11. ✅ قسم الصندوق — استلام/دفع نقدية 💰  (`customer_payments` / `supplier_payments`)
- استلام دفعات من العملاء (مقدم، سداد آجل، advance) بدون الحاجة لفاتورة.
- دفع دفعات للموردين (سداد آجل، advance) بدون الحاجة لفاتورة شراء.
- ربط الدفعة الواحدة بعدة فواتير/مشتريات (`*_payment_allocations`).
- أرقام تلقائية: **CR-2026-000001** للمقبوضات، **CP-2026-000001** للمدفوعات.
- تحديث تلقائي لـ: الخزينة (`cashboxes.current_balance`)، رصيد العميل/المورد، دفتر الأستاذ، تحركات الصندوق.
- دعم Void مع استرجاع كامل (تحديث معكوس للخزينة والرصيد ودفتر الأستاذ).
- Views جاهزة: `v_customer_outstanding` + `v_supplier_outstanding` لعرض الأرصدة + الحد الائتماني المتاح.

---

## 📋 قالب استيراد المنتجات (Excel)

ملف `templates/zahran_products_import_template.xlsx`:
- 4 أوراق: **Products** (للإدخال) + **Instructions** (دليل) + **ValidColors** + **ValidSizes**.
- RTL عربي.
- Data validation على نوع المنتج، الأسعار، والكميات.
- 6 صفوف مثال قابلة للحذف أو الاستبدال.

### الأعمدة
| Column | Arabic | Required | Notes |
|---|---|:-:|---|
| product_name   | اسم المنتج            | ✅ |  |
| category       | التصنيف الرئيسي       | ✅ | يجب أن يطابق قيماً موجودة |
| subcategory    | التصنيف الفرعي        | ❌ |  |
| type           | النوع                 | ✅ | `shoe` / `bag` / `accessory` |
| color          | اللون                 | ✅ | راجع ورقة ValidColors |
| size           | المقاس                | ⚠️ | إجباري للأحذية فقط |
| cost_price     | سعر التكلفة           | ✅ | ≥ 0 |
| selling_price  | سعر البيع             | ✅ | ≥ 0 |
| quantity       | الكمية                | ✅ | integer ≥ 0 |
| sku            | SKU                   | ❌ | يُولَّد تلقائياً إن ترك فارغاً |
| barcode        | الباركود              | ❌ | يجب أن يكون فريداً |
| brand          | الماركة               | ❌ |  |
| target_audience| الفئة                 | ❌ | women/men/kids/unisex |
| warehouse_code | كود المخزن            | ❌ | افتراضي ZHR-01 |
| notes          | ملاحظات               | ❌ |  |

---

## 🔌 الخطوات التالية (Roadmap)

هذه الحزمة هي الأساس — الطبقات الباقية يمكن بناؤها فوقها بسهولة:

1. **Backend (NestJS المُوصى به):**
   - Modules: `auth`, `users`, `products`, `inventory`, `pos`, `reservations`,
     `returns`, `customers`, `suppliers`, `reports`, `import`, `sync`.
   - TypeORM / Prisma entities مولّدة من الـ schema.
   - JWT + Passport + Guards لكل endpoint حسب `permissions.code`.
   - WebSocket gateway للتنبيهات الفورية.
2. **Frontend (React + Tailwind + Vite + PWA):**
   - Workbox service worker بنمط `StaleWhileRevalidate` للـ GET
     و `BackgroundSync` للـ POST.
   - Dexie.js (فوق IndexedDB) لتخزين المنتجات والفواتير محلياً.
   - RTL-first (`dir="rtl"` + `tailwindcss-rtl`).
   - شاشة POS كبيرة الأزرار (تابلت).
3. **Infra:**
   - `docker-compose.yml`: `db` (postgres) + `api` + `web` + `redis` + `minio`.
   - `.env.example` مع كل متغيرات الاتصال.
   - GitHub Actions: lint/test/build.

انظر `docs/DEPLOYMENT.md` و `docs/OFFLINE_STRATEGY.md` للتفاصيل.

---

## 📝 الترخيص & الملكية
هذا النظام مبني خصيصاً لـ **زهران لأحذية وحقائب السيدات**.
Commercial — جميع الحقوق محفوظة للعميل.

---

## 🆘 الدعم
لأي استفسار عن الـ schema أو خطوات البناء المقبلة، راجع:
- `database/VALIDATION_REPORT.md` — تقرير التحقق
- `database/ERD.md` — رسم العلاقات
- `docs/DEPLOYMENT.md` — النشر
- `docs/OFFLINE_STRATEGY.md` — الأوفلاين
