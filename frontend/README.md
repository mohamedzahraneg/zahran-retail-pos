# 🛍️ Zahran Retail Frontend — React PWA

واجهة المستخدم الرسمية لنظام **زهران للبيع بالتجزئة** (محل شنط وأحذية حريمي).
مبنية بـ **React 18 + Vite 5 + TypeScript + TailwindCSS (RTL)** مع دعم كامل للعمل **Offline-First** كـ PWA.

---

## 🚀 التشغيل السريع (Dev)

```bash
# 1) تثبيت الحزم
npm install

# 2) إعداد متغيرات البيئة
cp .env.example .env
# عدّل VITE_API_URL + VITE_DEFAULT_WAREHOUSE_ID

# 3) تشغيل سيرفر التطوير
npm run dev
# → http://localhost:5173
```

> لازم يكون الـ Backend شغّال على `http://localhost:3000` (أو أي URL تحطه في `VITE_API_URL`).

---

## 📦 متغيرات البيئة

| المتغير | الشرح | مثال |
|---|---|---|
| `VITE_API_URL` | عنوان الـ Backend API | `http://localhost:3000` أو `/api` داخل Docker |
| `VITE_DEFAULT_WAREHOUSE_ID` | UUID للمستودع الرئيسي | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `VITE_OFFLINE_MAX_RETRY` | عدد محاولات المزامنة للفواتير الأوفلاين | `5` |

---

## 🗂️ هيكل المشروع

```
frontend/
├─ public/                     # static assets (favicon, logo, icons)
├─ src/
│  ├─ api/
│  │  ├─ client.ts            # Axios + interceptors (Bearer + 401 refresh queue)
│  │  ├─ auth.api.ts
│  │  ├─ products.api.ts
│  │  ├─ pos.api.ts
│  │  ├─ customers.api.ts
│  │  ├─ suppliers.api.ts
│  │  ├─ cash-desk.api.ts
│  │  └─ dashboard.api.ts
│  ├─ components/
│  │  ├─ layout/
│  │  │  ├─ Sidebar.tsx       # navigation by role
│  │  │  ├─ Topbar.tsx        # user + online indicator
│  │  │  └─ Layout.tsx        # RTL shell
│  │  └─ ui/                  # Button, Input, Card, Modal, Toast wrappers
│  ├─ lib/
│  │  ├─ db.ts                # Dexie (IndexedDB) schema
│  │  ├─ offline-queue.ts     # queue + auto-sync
│  │  ├─ format.ts            # Arabic currency + date helpers
│  │  └─ constants.ts         # payment methods, categories
│  ├─ pages/
│  │  ├─ Login.tsx
│  │  ├─ Dashboard.tsx        # KPIs + Charts (Chart.js)
│  │  ├─ POS.tsx              # شاشة البيع الرئيسية
│  │  ├─ Products.tsx
│  │  ├─ Customers.tsx
│  │  ├─ Suppliers.tsx
│  │  ├─ CashDesk.tsx         # قبض/صرف
│  │  ├─ Reservations.tsx     # ComingSoon
│  │  └─ Settings.tsx
│  ├─ stores/
│  │  ├─ auth.store.ts        # Zustand + persist ('zahran-auth')
│  │  └─ cart.store.ts        # سلة الفاتورة الحالية
│  ├─ App.tsx                 # Router + Providers
│  ├─ main.tsx                # entry + QueryClient + Toaster + startAutoSync
│  └─ index.css               # Tailwind + RTL overrides
├─ index.html                 # Arabic <html lang="ar" dir="rtl">
├─ vite.config.ts             # vite-plugin-pwa + proxy
├─ tailwind.config.js         # brand colors (pink/purple gradient)
├─ tsconfig.json
├─ Dockerfile                 # multi-stage (node → nginx)
├─ nginx.conf
├─ .env.example
├─ .dockerignore
└─ .gitignore
```

---

## 📄 الصفحات الجاهزة

| الصفحة | المسار | الدور المسموح | الوصف |
|---|---|---|---|
| تسجيل الدخول | `/login` | الجميع | Form + Gradient background |
| Dashboard | `/` | admin, manager | KPIs + 4 charts + alerts |
| POS | `/pos` | admin, manager, cashier | شاشة بيع كاملة + PaymentModal |
| المنتجات | `/products` | admin, manager, stock_keeper | قائمة + بحث + تعديل سعر/مخزون |
| العملاء | `/customers` | admin, manager, accountant | ملفات العملاء + الذمم |
| الموردون | `/suppliers` | admin, manager, accountant | ملفات الموردين + المستحقات |
| الخزينة | `/cash-desk` | admin, manager, accountant | قبض/صرف + كشف يومي |
| الحجوزات | `/reservations` | admin, manager, cashier | _Coming Soon_ |
| الإعدادات | `/settings` | admin | المستخدمون + الأدوار + النسخ الاحتياطي |

---

## 🧠 النقاط المعمارية المهمة

### 1) Auth Flow (JWT + Refresh)
- عند الـ login: نخزّن `access_token` (12h) + `refresh_token` (14d) في `localStorage` (Zustand persist).
- كل request بيرفق `Authorization: Bearer ...` عبر Axios interceptor.
- لو رجع 401: `client.ts` يعمل **single-flight refresh** — الطلبات المتزامنة تنتظر في `pending[]` حتى ينتهي الـ refresh، ثم تعيد المحاولة تلقائيًا.
- لو الـ refresh فشل: logout + redirect لـ `/login`.

### 2) Offline-First (PWA)
- **Workbox** (via `vite-plugin-pwa`) يـ cache:
  - `StaleWhileRevalidate` لـ `/api/v1/products*`
  - `NetworkFirst` (3s timeout) لـ `/api/v1/dashboard*`
  - `CacheFirst` للـ Google Fonts
- **Offline Invoice Queue**: لو الكاشير عمل فاتورة والنت مقطوع، الفاتورة بتتخزن في **IndexedDB (Dexie)** ثم بتتزامن:
  - على event `online`
  - كل 60 ثانية (polling)
  - بـ `MAX_RETRIES = 5`، وبعد كده بتنحذف (مع log).
- Service Worker يحدّث تلقائيًا (`registerType: 'autoUpdate'`).

### 3) State Management
- **Zustand** للـ global state (auth + cart) مع `persist` middleware.
- **TanStack Query** لكل الـ server state (cache + refetch + mutations).
- `refetchInterval: 30_000` للـ Dashboard علشان يبقى live.

### 4) RBAC (Role-Based Access)
- `Sidebar` بيفلتر الروابط حسب `user.role`.
- `ProtectedRoute` بيمنع الوصول للصفحات بدون الدور المناسب.
- الـ backend هو الـ source of truth — الـ frontend UX gate فقط.

### 5) Form Integrity
- كل الـ validation على الـ backend (class-validator).
- الـ frontend بيعرض الأخطاء من `error.response.data.message`.

---

## 🎨 التصميم (Design System)

- **ألوان**: pink-500 → purple-600 gradient (matching الـ landing page).
- **خطوط**: Tajawal (من Google Fonts) + ICONS من lucide-react.
- **RTL**: TailwindCSS + `dir="rtl"` في `index.html`.
- **Responsive**: Desktop-first، يشتغل على tablet كمان.

---

## 🐳 Docker

### Build + Run محلي
```bash
docker build -t zahran-frontend:latest \
  --build-arg VITE_API_URL=/api .

docker run -p 8080:80 zahran-frontend:latest
# → http://localhost:8080
```

### عبر docker-compose (full stack)
```bash
# من root الـ repo
docker compose up -d web api db redis
```

- **Image size**: ~30MB (nginx:1.25-alpine).
- **Healthcheck**: `wget http://localhost/` كل 30s.
- **Non-root**: nginx الافتراضي.
- **Timezone**: Africa/Cairo.

---

## 🛠️ Scripts

| Command | Description |
|---|---|
| `npm run dev` | Vite dev server + HMR |
| `npm run build` | Production build → `dist/` |
| `npm run preview` | Preview الـ production build |
| `npm run lint` | ESLint على `src/` |
| `npm run typecheck` | `tsc --noEmit` |

---

## 🧪 الاختبار اليدوي (Manual QA Checklist)

- [ ] تسجيل دخول (admin/manager/cashier) — تحقق من الصفحات المتاحة.
- [ ] POS: إضافة منتج → خصم → دفع بـ 2 طريقة → طباعة.
- [ ] POS: قطع النت → عمل فاتورة → التأكد من ظهور الرسالة "تم الحفظ أوفلاين".
- [ ] الرجوع للنت → التأكد من مزامنة الفاتورة تلقائيًا.
- [ ] Dashboard: تحقق من تحديث الأرقام كل 30 ثانية.
- [ ] Refresh token: ابقى مسجل دخول > 12 ساعة → تأكد إنه طول على نفس الـ session.
- [ ] PWA install: افتح الموقع → منيو المتصفح → "Install app".

---

## 🗺️ خارطة الطريق (Roadmap)

- [ ] شاشة Reservations (حجز + عربون)
- [ ] شاشة Returns / Exchange
- [ ] تقارير PDF/XLSX (export)
- [ ] إشعارات فورية (WebSocket)
- [ ] اختبارات (Vitest + Playwright)
- [ ] دعم طباعة إيصال حراري (58mm/80mm)
- [ ] Dark mode

---

## 📞 الدعم

أي مشكلة؟ راجع:
- `../backend/README.md` — توثيق الـ API
- `../db/migrations/` — Schema الـ DB
- `../docs/` — Architecture diagrams

**تم التصميم ❤️ لمحل زهران**
