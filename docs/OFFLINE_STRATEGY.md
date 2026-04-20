# استراتيجية العمل أوفلاين — Zahran Retail System

> الهدف: الكاشير يكمل البيع حتى لو انقطع الإنترنت، ثم تُزامَن البيانات تلقائياً
> مع السيرفر لحظة عودة الاتصال بدون تدخل يدوي.

---

## 1 · نظرة كلية

```
┌──────────────────────────────────────────────────────┐
│                      React PWA                        │
│                                                       │
│   ┌─────────────────────────────────────────────┐    │
│   │  UI  (POS, Products, Customers, Reports)    │    │
│   └─────────────────────────────────────────────┘    │
│                  │                                    │
│      get/post    ▼                                    │
│   ┌─────────────────────────────────────────────┐    │
│   │  Sync Layer  (Dexie.js + RxDB patterns)     │    │
│   │  ┌─────────────┐  ┌───────────────────┐     │    │
│   │  │ Read Cache  │  │  Outbox Queue     │     │    │
│   │  │ (IndexedDB) │  │  (offline_ops)    │     │    │
│   │  └─────────────┘  └───────────────────┘     │    │
│   └──────────┬──────────────────┬───────────────┘    │
│              │                  │                     │
│   online ↓   ▼       offline ↓  ▼                     │
│   ┌─────────────────┐   ┌───────────────────┐        │
│   │ Service Worker  │   │ Background Sync   │        │
│   │ (Workbox)       │   │ (retry on online) │        │
│   └─────────────────┘   └───────────────────┘        │
└──────────────────────────────────────────────────────┘
               │ HTTP/WS when online
               ▼
     ┌──────────────────────────────┐
     │  /sync/pull   /sync/push     │
     │       API Gateway            │
     └──────────────┬───────────────┘
                    ▼
              PostgreSQL
       (offline_sync_queue جدول)
```

---

## 2 · ما يعمل أوفلاين؟

| الميزة | أوفلاين؟ | ملاحظات |
|---|:-:|---|
| تسجيل الدخول (لمستخدم سبق له الدخول) | ✅ | JWT مخزن محلياً، تحقق من `exp` |
| قائمة المنتجات والأسعار | ✅ | تُحدَّث كل 10 دقائق عند الاتصال |
| البحث بالباركود / الاسم | ✅ | فهرس IndexedDB |
| إنشاء فاتورة بيع (POS) | ✅ | يتم توليد `offline_id` |
| إضافة عميل جديد | ✅ | |
| إنشاء حجز + دفع عربون | ✅ | |
| إتمام حجز / تحويله لفاتورة | ⚠️ | فقط إذا الحجز موجود محلياً |
| مرتجع / استبدال | ⚠️ | الفاتورة الأصلية يجب أن تكون مخزنة محلياً |
| تحويلات مخزون بين الفروع | ❌ | تتطلب اتصال (قفل التحويل) |
| تقارير مجمّعة (مبيعات كل الفروع) | ❌ | تحتاج قاعدة البيانات المركزية |
| إدارة المستخدمين / الصلاحيات | ❌ | فقط مدير عبر السيرفر |

---

## 3 · التقنيات

| الطبقة | الأداة | السبب |
|---|---|---|
| Service Worker | **Workbox v7** | caching + background sync جاهزة |
| قاعدة بيانات محلية | **Dexie.js** (على IndexedDB) | API بسيط + indexing |
| إدارة الحالة | React Query + Zustand | invalidation سهل بعد sync |
| واجهة | React + Tailwind + shadcn/ui | RTL-friendly |
| الطابعة | `window.print()` / WebUSB (للثيرمل) | يعمل أوفلاين |
| الباركود | WebRTC camera + `@zxing/library` | يعمل أوفلاين |

---

## 4 · تصميم الـ IndexedDB

```ts
// dexie-schema.ts
import Dexie, { Table } from 'dexie';

export class ZahranDB extends Dexie {
  // ----- Read cache -----
  products!:  Table<Product,  string>;
  variants!:  Table<Variant,  string>;   // indexed by sku, barcode
  customers!: Table<Customer, string>;   // indexed by phone
  settings!:  Table<Setting,  string>;

  // ----- Local operational data -----
  invoices!:     Table<LocalInvoice,     string>;  // status=draft | pending_sync | synced
  reservations!: Table<LocalReservation, string>;

  // ----- Outbox (pending ops) -----
  outbox!:       Table<OutboxOp, number>;          // auto-increment id

  constructor() {
    super('ZahranRetail');
    this.version(1).stores({
      products:     'id, sku_prefix, name_ar, product_type',
      variants:     'id, sku, barcode, product_id, *color_id',
      customers:    'id, phone, full_name',
      settings:     'key',
      invoices:     'offline_id, server_id, status, completed_at',
      reservations: 'offline_id, server_id, customer_id, status',
      outbox:       '++id, entity, operation, state, client_created_at'
    });
  }
}

export const db = new ZahranDB();
```

---

## 5 · دورة حياة الفاتورة أوفلاين

```ts
// 1 - نقطة البيع ينشئ الفاتورة محلياً
async function createInvoiceOffline(cart, customer, payments) {
  const offlineId = crypto.randomUUID();
  await db.invoices.add({
    offline_id: offlineId,
    status:     'pending_sync',
    customer_id: customer?.id,
    items:      cart,
    payments,
    completed_at: new Date().toISOString(),
    grand_total: computeTotal(cart, payments),
    // ...
  });

  // 2 - أضف إلى outbox
  await db.outbox.add({
    entity:    'invoice',
    operation: 'I',
    offline_id: offlineId,
    payload:   { cart, customer, payments },
    state:     'pending',
    client_created_at: new Date().toISOString(),
  });

  // 3 - حاول المزامنة فوراً إن كان هناك اتصال
  if (navigator.onLine) kickSync();
}

// 4 - الخدمة الدورية للمزامنة
async function kickSync() {
  const batch = await db.outbox.where('state').equals('pending').limit(100).toArray();
  if (!batch.length) return;

  const res = await api.post('/sync/push', { client_id: CLIENT_ID, ops: batch });
  // res.results: [{offline_id, server_id, state: 'synced'|'conflict', reason?}]

  await db.transaction('rw', db.outbox, db.invoices, async () => {
    for (const r of res.results) {
      if (r.state === 'synced') {
        await db.outbox.where('offline_id').equals(r.offline_id).delete();
        await db.invoices.where('offline_id').equals(r.offline_id)
                         .modify({ server_id: r.server_id, status: 'synced' });
      } else if (r.state === 'conflict') {
        await db.outbox.where('offline_id').equals(r.offline_id)
                       .modify({ state: 'conflict', last_error: r.reason });
      }
    }
  });
}

// 5 - استمع لحدث رجوع الإنترنت
window.addEventListener('online', () => kickSync());
```

### حل التعارضات
- **فاتورة باركود غير موجود على السيرفر**: السيرفر يرجع `conflict`، الواجهة
  تعرض الفاتورة للمراجعة اليدوية.
- **مخزون أوفلاين أقل من صفر عند المزامنة**: السيرفر يقبل الفاتورة لكن
  ينشئ `alert` نوعه `cash_mismatch` أو `loss_product` للمدير.
- **تكرار** (نفس `offline_id` مرسل مرتين): السيرفر يعتمد على الـ
  `UNIQUE (client_id, offline_id)` في `offline_sync_queue` ليُعيد نفس
  `server_id` بدون إنشاء فاتورة جديدة (idempotent).

---

## 6 · جانب السيرفر

### POST `/sync/push`
```json
{
  "client_id": "tablet-01-ZHR-01",
  "ops": [
    {
      "offline_id": "7b3f...-uuid",
      "entity":     "invoice",
      "operation":  "I",
      "payload":    { /* cart, customer, payments */ },
      "client_created_at": "2026-04-19T10:32:15.123Z"
    }
  ]
}
```

### POST `/sync/pull`
```json
{ "client_id": "tablet-01-ZHR-01", "since": "2026-04-19T09:00:00Z" }
```
يعيد delta للمنتجات، العملاء، الإعدادات، الأسعار المحدّثة.

### الحل داخل السيرفر
```ts
// pseudo
const q = await db.query(
  'INSERT INTO offline_sync_queue (client_id, user_id, entity, operation,
     offline_id, payload, client_created_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7)
   ON CONFLICT (client_id, offline_id) DO UPDATE SET attempts = offline_sync_queue.attempts+1
   RETURNING id, state, server_id',
  [...]
);

// لو state = pending => شغّل المنطق الحقيقي (create invoice) في نفس Transaction
// ثم UPDATE offline_sync_queue SET state='synced', server_id=..., server_processed_at=NOW()
```

---

## 7 · خطة التخزين المحلي

| عنصر | الحجم المتوقع | سياسة التنظيف |
|---|---|---|
| products + variants | ~5MB لكل 10,000 منتج | تحديث كامل يومياً |
| customers | ~1MB لكل 5,000 عميل | تحميل آخر 6 أشهر فقط |
| invoices المؤرشفة | ~2KB لكل فاتورة | احتفاظ 30 يوماً ثم حذف |
| outbox | يفترض أن يبقى صغيراً | يُمسح بعد المزامنة |
| product images | cacheable عبر Workbox | `maxEntries: 500`, `maxAgeSeconds: 30d` |

---

## 8 · اختبارات أوفلاين موصى بها

1. **اختبار انقطاع**: افتح POS → أوقف الإنترنت من DevTools → نفّذ 10 فواتير → رجّع الإنترنت → تحقق أن الـ outbox أصبح فارغاً وكل الفواتير بحالة `synced`.
2. **اختبار تعارض**: احذف منتجاً من السيرفر بينما العميل أوفلاين يحاول بيعه → تأكد من أن الفاتورة تصبح `conflict` مع رسالة واضحة.
3. **اختبار أجهزة متعددة**: جهازان يبيعان نفس القطعة (qty=1) أوفلاين → عند المزامنة أحدهما ينجح والآخر يتحول لـ `conflict`.
4. **اختبار إعادة تشغيل**: أغلق المتصفح قبل المزامنة → أعد فتحه بدون إنترنت → تأكد من بقاء الفواتير في IndexedDB.
5. **اختبار 100K ops**: حاكي تراكم كبير في outbox لقياس أداء المزامنة.

---

## 9 · إعدادات Workbox (sw.ts)

```ts
import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { StaleWhileRevalidate, NetworkFirst } from 'workbox-strategies';
import { BackgroundSyncPlugin } from 'workbox-background-sync';

precacheAndRoute(self.__WB_MANIFEST);

// Images: Cache-first
registerRoute(
  ({ request }) => request.destination === 'image',
  new StaleWhileRevalidate({ cacheName: 'images' })
);

// GET /api/** : Network-first, fallback on cache
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/'),
  new NetworkFirst({ cacheName: 'api', networkTimeoutSeconds: 3 }),
  'GET'
);

// POST /api/sync/push : background sync (retry when online)
const bgSync = new BackgroundSyncPlugin('zahran-sync-queue', {
  maxRetentionTime: 24 * 60, // 24h
});
registerRoute(
  ({ url }) => url.pathname === '/api/sync/push',
  new NetworkFirst({ plugins: [bgSync] }),
  'POST'
);
```

---

## 10 · مؤشرات سريعة للـ UI
- أيقونة 🌐 في شريط أعلى الشاشة: أخضر = online، برتقالي = offline، أحمر = conflict موجود.
- شارة عدد العمليات المعلّقة (`outbox.count`) على أيقونة المزامنة.
- Toast تلقائي عند نجاح sync + شاشة كاملة لعرض التعارضات.
