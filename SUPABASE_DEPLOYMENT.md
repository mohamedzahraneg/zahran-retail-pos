# 🌿 Zahran Retail — Supabase Deployment Summary

تم رفع قاعدة البيانات كاملة إلى Supabase ✅

---

## 📡 Connection Info

| Item | Value |
|---|---|
| **Project Name** | zahran-retail |
| **Project ID / Ref** | `wzjnjxxfydyodplbitde` |
| **Region** | `eu-central-2` (Zurich) |
| **Status** | `ACTIVE_HEALTHY` |
| **Postgres Version** | 17.6.1.104 |
| **Created** | 2026-04-19 07:59 UTC |

### URLs

- **Project URL (REST/Realtime/Storage):** `https://wzjnjxxfydyodplbitde.supabase.co`
- **Dashboard:** `https://supabase.com/dashboard/project/wzjnjxxfydyodplbitde`
- **DB host:** `db.wzjnjxxfydyodplbitde.supabase.co`

### API Keys

- **Anon (legacy JWT):**
  `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind6am5qeHhmeWR5b2RwbGJpdGRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1ODU1NzcsImV4cCI6MjA5MjE2MTU3N30.QQc22SOuB5KdFhw3k6pqa70GO_O2WZZ6qDKlhVVuR0Q`
- **Publishable (new format):** `sb_publishable_6ZXRmODDYoXrCcjgSB0CHw_Aqnh9Kac`
- **Service Role key:** اذهب إلى Supabase Dashboard → Settings → API وانسخها (لا تشاركها أبدًا)

### Direct DB Connection String (for backend)

```
# Pooled (recommended for Node/Nest backend)
postgres://postgres.wzjnjxxfydyodplbitde:<YOUR-DB-PASSWORD>@aws-0-eu-central-2.pooler.supabase.com:6543/postgres

# Direct (for migrations, psql)
postgres://postgres:<YOUR-DB-PASSWORD>@db.wzjnjxxfydyodplbitde.supabase.co:5432/postgres
```

كلمة السر الخاصة بالـ DB تظهر مرة واحدة فقط عند إنشاء المشروع — إن فُقدت يمكن إعادة تعيينها من
Dashboard → Settings → Database → Reset database password.

---

## 🗂️ ما تم رفعه

| # | المايجريشن | الحالة |
|---|---|---|
| 001 | extensions + enums | ✅ |
| 002 | RBAC + users | ✅ |
| 003 | catalog (categories/brands/products) | ✅ |
| 004 | inventory (warehouses/variants/stock) | ✅ |
| 005 | customers + suppliers | ✅ |
| 006 | POS + invoices + discounts + coupons | ✅ |
| 007 | reservations | ✅ |
| 008 | returns + exchanges | ✅ |
| 009 | accounting + shifts | ✅ |
| 010 | alerts + settings + offline | ✅ |
| 011 | functions + triggers | ✅ |
| 012 | views for reports | ✅ |
| 013 | seed data (admin/roles/sizes/colors) | ✅ |
| 014 | cash desk (customer/supplier payments) | ✅ |
| 015 | dashboard views + smart suggestions | ✅ |
| 016 | realistic demo seed (+ patch 016a for enum casts) | ⚠️ مسحتُ الداتا التجريبية بعد اختبار الـ triggers |
| 017 | notifications (templates + outbox) | ✅ |
| 018 | recurring expenses | ✅ |
| 019 | customer groups + wholesale pricing | ✅ |
| 020 | returns analytics views | ✅ |
| 021 | VAT support (14%) | ✅ |
| 022 | loyalty earn on INSERT trigger | ✅ |
| 023 | purchase returns (to supplier) | ✅ |
| 024 | advanced reports (profit margin, dead stock) | ✅ |
| 025 | users.branch_id | ✅ |
| 026 | roles.permissions array | ✅ |
| 027 | entity compatibility columns | ✅ |
| 028 | schema sync (aliases + sync triggers) | ✅ |
| 029 | final sync (enums + notifications + fn_adjust_stock) | ✅ |

**Totals:** `75 tables · 45 views · 217 functions`

---

## 👤 المستخدم الإداري الافتراضي

| | |
|---|---|
| Username | `admin` |
| Email | `admin@zahran.eg` |
| Password | `admin123` *(غيّرها فورًا في أول تسجيل دخول)* |
| Role | `admin` (permissions = `['*']`) |

### الأدوار المُعرَّفة
- `admin` — كل الصلاحيات (`*`)
- `manager` — 37 صلاحية
- `cashier` — 14 صلاحية
- `inventory` — 12 صلاحية
- `salesperson` — 9 صلاحيات

### الفرع الافتراضي
- `ZHR-01` — الفرع الرئيسي (type = `branch`)

### مجموعات العملاء (Pricing tiers)
- `RETAIL` (افتراضي، بدون خصم)
- `WHS-SILVER` (جملة فضية 10%)
- `WHS-GOLD` (جملة ذهبية 20%)
- `CORPORATE` (شركات 15%)

---

## 🔧 .env لتشغيل الـ Backend (NestJS)

```dotenv
# backend/.env
NODE_ENV=production
PORT=3000

DATABASE_URL=postgres://postgres.wzjnjxxfydyodplbitde:<DB_PASSWORD>@aws-0-eu-central-2.pooler.supabase.com:6543/postgres?pgbouncer=true
DB_SSL=require

SUPABASE_URL=https://wzjnjxxfydyodplbitde.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind6am5qeHhmeWR5b2RwbGJpdGRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1ODU1NzcsImV4cCI6MjA5MjE2MTU3N30.QQc22SOuB5KdFhw3k6pqa70GO_O2WZZ6qDKlhVVuR0Q
SUPABASE_SERVICE_ROLE_KEY=<انسخه من Dashboard>

JWT_SECRET=<32+ char random string>
JWT_EXPIRES_IN=12h
REFRESH_TOKEN_DAYS=14

CORS_ORIGIN=https://your-frontend.vercel.app,http://localhost:5173
TZ=Africa/Cairo
```

## 🔧 .env لتشغيل الـ Frontend (React/Vite)

```dotenv
# frontend/.env
VITE_API_URL=https://your-backend.com
VITE_SUPABASE_URL=https://wzjnjxxfydyodplbitde.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_6ZXRmODDYoXrCcjgSB0CHw_Aqnh9Kac
```

---

## 🚦 خطوات ما بعد النشر

1. **غيّر كلمة سر admin فورًا** (من واجهة الـ POS أو بـ UPDATE في SQL).
2. **أنشئ وريدو باكاب تلقائي:** Supabase → Project Settings → Backups (تلقائي في الخطة المدفوعة).
3. **فعّل Row Level Security** على الجداول الحساسة:
   ```sql
   ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
   ALTER TABLE invoices  ENABLE ROW LEVEL SECURITY;
   -- …
   ```
4. **ارفع صور المنتجات** إلى bucket اسمه `zahran-media` في Supabase Storage.
5. **أضف domain مخصص** في Dashboard → Custom Domains.
6. **شغّل الـ backend** على Railway/Render/Fly.io مع `.env` أعلاه.
7. **شغّل الـ frontend** على Vercel/Netlify/Cloudflare Pages مع `.env` أعلاه.

---

## ⚠️ ملاحظات مهمة

- الـ Demo data (المنتجات/العملاء/الفواتير التجريبية في 016) تم مسحها أثناء التحقق؛ يمكن إعادة تشغيل `016_realistic_seed.sql` يدويًا إذا رغبت في بيانات تجريبية.
- الـ views `v_customer_outstanding` و `v_supplier_outstanding` أعيد إنشاؤها في 029 لتحتوي على عمود `outstanding` (كانت 012 بنسخة مختلفة).
- تم إضافة قيم enum جديدة لـ `stock_movement_type` (`adjustment`, `transfer`, `correction`, `opening`).
- تم تطبيق trigger cascade على الـ invoices للحفاظ على التزامن بين أسماء الأعمدة القديمة والجديدة (`invoice_no` ⇄ `doc_no`, `paid_amount` ⇄ `paid_total`, إلخ).
