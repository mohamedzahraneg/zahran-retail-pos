# 🛠️ Zahran Backend API

Backend API لنظام **زهران للبيع بالتجزئة** — مبني على **NestJS + TypeORM + PostgreSQL**.

يقرأ ويكتب مباشرة على الـ schema اللي بنيناها في `database/` (15 migration).

---

## 🚀 تشغيل سريع

```bash
# 1) ثبت الاعتماديات
npm install

# 2) انسخ ملف البيئة
cp .env.example .env

# 3) شغل قاعدة البيانات (من المجلد الأعلى)
cd ..
docker compose up -d db redis minio

# 4) ارجع وشغّل الـ API
cd backend
npm run start:dev
```

بعد التشغيل:

| الرابط | الوصف |
|--------|-------|
| `http://localhost:3000/health` | فحص صحة الخدمة |
| `http://localhost:3000/docs` | Swagger UI تفاعلي |
| `http://localhost:3000/api/v1/auth/login` | تسجيل الدخول |

---

## 🧩 الموديولات

| Module | Endpoints | الوصف |
|--------|-----------|-------|
| `auth` | `/auth/login`, `/auth/refresh`, `/auth/me` | JWT + Refresh Tokens |
| `users` | `/users/*` | إدارة المستخدمين |
| `products` | `/products/*`, `/products/barcode/:code` | المنتجات + المتغيرات + باركود |
| `stock` | `/stock/*` | المخزون + تعديل الكميات + توصيات ذكية |
| `pos` | `/pos/invoices/*` | إنشاء الفواتير + استرجاع + إلغاء |
| `customers` | `/customers/*` | العملاء + سجل الحساب |
| `suppliers` | `/suppliers/*` | الموردون + سجل الحساب |
| `cash-desk` | `/cash-desk/*` | قبض عملاء + دفع موردين |
| `dashboard` | `/dashboard/*` | KPIs + Views + اقتراحات ذكية |
| `reservations` | `/reservations/*` | حجز منتجات + عربون + أقساط + تحويل لفاتورة |

---

## 🔐 الأدوار (Roles)

```
admin          → كامل الصلاحيات
manager        → إدارة يومية (مش بيغيّر الصلاحيات)
cashier        → نقطة البيع فقط
accountant     → الصندوق + التقارير
stock_keeper   → المخزون فقط
```

استخدم decorator `@Roles('admin', 'manager')` لتقييد endpoint معيّن.

---

## 🧪 اختبار سريع

```bash
# Login
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}'

# استخدم الـ token
curl http://localhost:3000/api/v1/dashboard \
  -H 'Authorization: Bearer <access_token>'
```

---

## 🐳 تشغيل بالـ Docker

```bash
docker compose --profile full up -d --build
```

هيشتغل: `db + redis + minio + api + web`.

---

## 📁 الهيكل

```
backend/
├── Dockerfile
├── .dockerignore
├── .env.example
├── package.json
├── tsconfig.json
├── nest-cli.json
└── src/
    ├── main.ts                    # Bootstrap + Swagger + Helmet + Validation
    ├── app.module.ts              # Root module + global guards
    ├── config/configuration.ts    # ENV loader
    ├── database/                  # TypeORM config
    ├── common/                    # Filters, Interceptors, Guards, Decorators
    ├── auth/                      # Login + JWT + Refresh
    ├── users/                     # Users + Roles
    ├── products/                  # Products + Variants
    ├── stock/                     # Stock + Warehouses + Smart views
    ├── pos/                       # Invoices (create/void/list)
    ├── customers/                 # Customers + Ledger
    ├── suppliers/                 # Suppliers + Ledger
    ├── cash-desk/                 # Payments (receive/pay)
    └── dashboard/                 # 13 views aggregated
```

---

## 🧠 ملاحظات معمارية

- **الـ Schema يُدار بـ SQL migrations** (مش TypeORM synchronize) لأن فيه triggers و views معقّدة.
- **Business logic مهم يكون في الـ DB** (مثلاً: تعديل المخزون تلقائياً عند بيع فاتورة) لضمان consistency حتى من أي مصدر.
- الـ API يستدعي functions مثل `fn_adjust_stock`, `fn_void_invoice`, `next_doc_no` لتوحيد السلوك.
- الـ Dashboard endpoints تقرأ من الـ 13 view مباشرة — صفر logic في الـ API.

---

## 📈 الخطوات اللاحقة

- [ ] Reservations module (حجز منتجات بعربون)
- [ ] Returns / Exchange module
- [ ] Reports endpoints (XLSX/PDF export)
- [ ] WebSocket gateway للتنبيهات اللحظية
- [ ] Tests (unit + e2e)
- [ ] Background jobs (BullMQ): sync, reports, alerts
