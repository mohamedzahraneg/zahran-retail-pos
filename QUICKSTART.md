# Zahran — دليل التشغيل السريع (Quickstart)

كل ما تحتاجه لتجربة النظام من الصفر على جهازك.

---

## الطريقة الأسهل: Docker Compose (أمر واحد)

### المتطلبات
- Docker Desktop (Mac/Windows) أو Docker Engine (Linux)
- 4 GB RAM متاحة
- بورتات فاضية: `3000`, `5173`, `5432`, `6379`, `9000`, `9001`

### خطوات

```bash
cd Zahran

# 1) انسخ ملف البيئة
cp .env.example .env

# 2) شغّل الستاك كامل (DB + Redis + MinIO + API + Frontend)
docker compose --profile full up -d

# 3) استنى ~30 ثانية لحد ما الـ API يبقى healthy
docker compose ps
```

### الـ URLs بعد التشغيل

| الخدمة          | الرابط                        | بيانات الدخول       |
| --------------- | ----------------------------- | ------------------- |
| **واجهة POS**   | http://localhost:8080         | admin / admin123    |
| **API**         | http://localhost:3000         | —                   |
| **MinIO Console** | http://localhost:9001       | zahran / change_me_strong |
| **PostgreSQL**  | localhost:5432                | zahran / change_me_strong |

---

## الطريقة الثانية: Dev Mode (للتطوير السريع)

### 1) شغّل الـ DB فقط
```bash
docker compose up -d db redis
```

### 2) Backend
```bash
cd backend
cp .env.example .env
npm install
npm run start:dev
# يشتغل على http://localhost:3000
```

### 3) Frontend (في terminal تاني)
```bash
cd frontend
npm install
npm run dev
# يشتغل على http://localhost:5173
```

افتح **http://localhost:5173** وسجّل دخول بـ `admin` / `admin123`.

---

## جرّب الفيتشرز الجديدة (التاسكات #87–#94)

بعد تسجيل الدخول:

### ١. POS متعدد الفروع + البائع (#87, #93)
- افتح **POS** → لاحظ في الـ sidebar:
  - dropdown **الفرع/المخزن**
  - dropdown **البائع**
- اختار فرع + بائع، وضيف منتج، واعمل فاتورة. البائع والفرع بيتسجلوا في الـ DB.

### ٢. ضريبة القيمة المضافة VAT (#88)
```sql
-- فعّل الضريبة من SQL (لحد ما تعمل شاشة إعدادات):
UPDATE settings
SET value = '{"enabled": true, "rate": 14.0, "inclusive": true}'::jsonb
WHERE key = 'vat.config';
```
- اعمل فاتورة جديدة من POS → الضريبة هتتحسب تلقائياً.
- شوف الـ view: `SELECT * FROM v_vat_monthly;`

### ٣. رفع صور المنتجات (#89)
```bash
curl -X POST http://localhost:3000/uploads/image \
  -H "Authorization: Bearer <TOKEN>" \
  -F "file=@product.jpg"
# يرجع { url: "/uploads/xxx.jpg" }
```
- الصور بتتخزن في `backend/uploads/` وبتتقدّم عبر `/uploads/*`.

### ٤. نقاط الولاء التلقائية (#90)
- اعمل فاتورة لعميل مسجّل → النقاط تضاف **فوراً** (كان فيه bug — الـ trigger بقى يشتغل على INSERT).
- تحقق: `SELECT * FROM loyalty_ledger WHERE customer_id = '...';`

### ٥. مدفوعات الموردين (#91)
- من Postman/curl:
```bash
POST /api/suppliers/:id/pay
{ "amount": 5000, "method": "cash", "note": "دفعة يناير" }
```
- النظام بيوزّع الدفعة FIFO على الفواتير غير المدفوعة تلقائياً.

### ٦. مرتجعات المشتريات (#92)
```bash
POST /api/purchases/returns
{
  "supplier_id": "...",
  "purchase_id": "...",
  "items": [{ "variant_id": "...", "quantity": 2, "unit_cost": 150 }],
  "reason": "بضاعة معيبة"
}
```
- المخزون بينقص، ورصيد المورد بيقل، وفيه `return_no` تلقائي.

### ٧. التقارير المتقدمة (#94)
- `GET /api/reports/profit-margin` — هامش ربح لكل منتج
- `GET /api/reports/dead-stock?days=90` — مخزون راكد + رأس المال المعلّق
- `GET /api/reports/compare-periods?from_a=...&to_a=...&from_b=...&to_b=...`
- `GET /api/reports/sales-daily?from=...&to=...`

---

## تشغيل E2E Tests (#74)

```bash
cd e2e
npm install
npx playwright install --with-deps
npm test          # headless
npm run test:ui   # واجهة تفاعلية
```
Playwright هيشغّل الـ backend والـ frontend تلقائياً لو مش شغّالين.

---

## إيقاف كل حاجة

```bash
docker compose down              # يوقف الحاويات (البيانات تفضل)
docker compose down -v           # يمسح البيانات بالكامل (خطر!)
```

---

## مشاكل شائعة

| المشكلة                          | الحل                                                         |
| -------------------------------- | ------------------------------------------------------------ |
| `port is already allocated`      | غيّر البورت في `.env` أو أوقف الخدمة اللي شاغلاه             |
| `database "zahran_retail" does not exist` | `docker compose down -v` وشغّل تاني           |
| `ECONNREFUSED 127.0.0.1:3000`    | الـ API لسه بيقوم — استنى 30 ثانية                          |
| صفحة فاضية في الـ frontend       | افتح Console — غالباً CORS أو `VITE_API_URL` غلط في `.env`  |

---

## الدخول للـ DB مباشرة

```bash
docker compose exec db psql -U zahran -d zahran_retail

# بعض الـ queries المفيدة:
\dt                                    -- list tables
SELECT * FROM users;                   -- شوف المستخدمين
SELECT * FROM v_sales_daily LIMIT 10;  -- مبيعات يومية
SELECT * FROM v_dead_stock LIMIT 20;   -- مخزون راكد
```
