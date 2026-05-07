import axios, { AxiosError, AxiosInstance, AxiosResponse } from 'axios';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/stores/auth.store';
// PR-FE-IDEM-RESPONSE-INTERCEPTOR (Sprint 5 / FE-IDEM PR 1)
// Shared frontend handling for the four idempotency-specific BE
// responses + the success replay header. Implementation lives at the
// bottom of this file as `_handleIdempotencyReplay` /
// `_handleIdempotencyError` (exported for unit tests). The logic is
// inert for any request that does NOT carry an Idempotency-Key — the
// BE never emits these codes without the header — so behavior on the
// 51 protected routes is unchanged when callers don't opt in.
// PR-AUDIT-IDEMPOTENCY-POS-INVOICE-FE — opt-in Idempotency-Key on
// the single online POST /pos/invoices route. See lib module for the
// gating rules; this interceptor delegates entirely to it.
import { attachCheckoutIdempotencyKeyIfApplicable } from '@/lib/checkout-idempotency';
// PR-AUDIT-IDEMPOTENCY-CASH-DESK-TRANSFER-FE — opt-in Idempotency-Key
// on POST /cash-desk/transfer. Same shape, sibling helper. The two
// helpers gate on disjoint URLs so they cannot cross-fire.
import { attachTransferIdempotencyKeyIfApplicable } from '@/lib/transfer-idempotency';
// PR-AUDIT-IDEMPOTENCY-ACCOUNTING-EXPENSES-FE — opt-in Idempotency-Key
// on the two expense-create routes. Same shape, third sibling helper.
// Strict equality on the URL gate so suffix routes (e.g.
// /accounting/expenses/:id/approve) can't accidentally receive the header.
import { attachExpenseIdempotencyKeyIfApplicable } from '@/lib/expense-idempotency';
// PR-AUDIT-IDEMPOTENCY-CASH-DESK-CUSTOMER-PAYMENTS-FE — fourth sibling
// helper. Gates strictly on POST /cash-desk/customer-payments — does
// NOT fire on the /:id/void suffix route or on supplier-payments.
import { attachCustomerPaymentIdempotencyKeyIfApplicable } from '@/lib/customer-payment-idempotency';
// PR-AUDIT-IDEMPOTENCY-CASH-DESK-SUPPLIER-PAYMENTS-FE — fifth sibling
// helper. Gates strictly on POST /cash-desk/supplier-payments — does
// NOT fire on /:id/void, on customer-payments, or on /suppliers/:id/pay.
import { attachSupplierPaymentIdempotencyKeyIfApplicable } from '@/lib/supplier-payment-idempotency';
// PR-FE-IDEM-CASHDESK-DEPOSIT (Sprint 5 / FE-IDEM PR 2) — sixth sibling
// helper. Gates strictly on POST /cash-desk/deposit (which serves both
// deposit `direction:'in'` and withdraw `direction:'out'` — single
// route, single helper). Disjoint URL gate from the other 5 helpers.
import { attachCashDeskDepositIdempotencyKeyIfApplicable } from '@/lib/cash-desk-deposit-idempotency';

const envApiUrl = import.meta.env.VITE_API_URL as string | undefined;
const baseURL = envApiUrl ?? 'http://localhost:3000';

export const api: AxiosInstance = axios.create({
  baseURL: `${baseURL}/api/v1`,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
});

// ─── Request interceptor ────────────────────────────────────────────────
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // PR-AUDIT-IDEMPOTENCY-POS-INVOICE-FE — no-op on every route except
  // POST /pos/invoices, where it adds the per-checkout key.
  attachCheckoutIdempotencyKeyIfApplicable(config);
  // PR-AUDIT-IDEMPOTENCY-CASH-DESK-TRANSFER-FE — no-op on every route
  // except POST /cash-desk/transfer, where it adds the per-modal key.
  attachTransferIdempotencyKeyIfApplicable(config);
  // PR-AUDIT-IDEMPOTENCY-ACCOUNTING-EXPENSES-FE — no-op on every
  // route except POST /accounting/expenses and POST
  // /accounting/expenses/daily, where it adds the per-modal key.
  attachExpenseIdempotencyKeyIfApplicable(config);
  // PR-AUDIT-IDEMPOTENCY-CASH-DESK-CUSTOMER-PAYMENTS-FE — no-op on
  // every route except POST /cash-desk/customer-payments, where it
  // adds the per-ReceiptModal key.
  attachCustomerPaymentIdempotencyKeyIfApplicable(config);
  // PR-AUDIT-IDEMPOTENCY-CASH-DESK-SUPPLIER-PAYMENTS-FE — no-op on
  // every route except POST /cash-desk/supplier-payments, where it
  // adds the per-SupplierPayModal key.
  attachSupplierPaymentIdempotencyKeyIfApplicable(config);
  // PR-FE-IDEM-CASHDESK-DEPOSIT — no-op on every route except POST
  // /cash-desk/deposit, where it adds the per-DepositModal key.
  // Same single endpoint serves both deposit and withdraw directions.
  attachCashDeskDepositIdempotencyKeyIfApplicable(config);
  return config;
});

// ─── Response interceptor ───────────────────────────────────────────────
let isRefreshing = false;
let pending: ((token: string) => void)[] = [];

api.interceptors.response.use(
  (res) => {
    // PR-FE-IDEM-RESPONSE-INTERCEPTOR — tag replays so callers can
    // skip duplicate success toasts. Inert for non-replay responses.
    return _handleIdempotencyReplay(res);
  },
  async (err: AxiosError<any>) => {
    const original: any = err.config;
    const status = err.response?.status;

    // PR-FE-IDEM-RESPONSE-INTERCEPTOR — must come BEFORE the 401
    // refresh path and BEFORE the generic error toast so that:
    //   · 425 IN_PROGRESS auto-retries with the same Idempotency-Key
    //     before the generic toast spam fires;
    //   · 409/503/400 idempotency errors get their dedicated Arabic
    //     message instead of the generic `err.response.data.message`
    //     toast at the bottom of this interceptor.
    // Returns 'unhandled' for every non-idempotency status (incl.
    // 401/403/500/etc.), so existing flow is preserved.
    const idemp = await _handleIdempotencyError(err, (cfg) => api(cfg));
    if (idemp.kind === 'retry') return idemp.promise;
    if (idemp.kind === 'rejected') return Promise.reject(err);

    // Try refresh on 401
    if (status === 401 && !original._retry) {
      original._retry = true;
      const store = useAuthStore.getState();

      if (isRefreshing) {
        return new Promise((resolve) => {
          pending.push((token) => {
            original.headers.Authorization = `Bearer ${token}`;
            resolve(api(original));
          });
        });
      }

      isRefreshing = true;
      try {
        const refreshed = await store.refresh();
        isRefreshing = false;
        pending.forEach((cb) => cb(refreshed));
        pending = [];
        original.headers.Authorization = `Bearer ${refreshed}`;
        return api(original);
      } catch (e) {
        isRefreshing = false;
        pending = [];
        store.logout();
        toast.error('انتهت الجلسة، يرجى تسجيل الدخول مجدداً');
        window.location.href = '/login';
        return Promise.reject(e);
      }
    }

    // Show user-friendly error messages.
    // Silence 403 (forbidden by role) — those are expected when a user
    // doesn't have access to a feature; the UI should hide such features
    // rather than toast-spam. Also silence 401 (handled by refresh above).
    const msg =
      err.response?.data?.message ||
      err.response?.data?.error ||
      err.message ||
      'حدث خطأ غير متوقع';
    if (status && status >= 400 && status !== 401 && status !== 403) {
      toast.error(Array.isArray(msg) ? msg[0] : String(msg));
    }
    return Promise.reject(err);
  },
);

/** Helper to unwrap `{ success, data }` envelope */
export function unwrap<T>(promise: Promise<AxiosResponse<T>>): Promise<T> {
  return promise.then((res) => {
    const body: any = res.data;
    if (body && typeof body === 'object' && 'data' in body) {
      return body.data as T;
    }
    return body as T;
  });
}

// ─── PR-FE-IDEM-RESPONSE-INTERCEPTOR ────────────────────────────────────
// Shared handling for the four idempotency-specific BE responses + the
// success replay header. Logic is extracted to module-level functions
// so the interceptor closures stay thin AND the unit spec
// (`client.idempotency.spec.ts`) can drive them with synthetic
// AxiosError / AxiosResponse objects without standing up a real network.
//
// BE error contract (from backend/src/common/interceptors/idempotency.interceptor.ts):
//   · 400 IDEMPOTENCY_KEY_INVALID         — malformed/oversized key
//   · 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH — key reused with a different body
//   · 425 IDEMPOTENCY_KEY_IN_PROGRESS     — original request still in flight
//   · 503 IDEMPOTENCY_CACHE_UNAVAILABLE   — Redis unavailable, fail-closed
//
// Without an Idempotency-Key header, the BE never emits these codes, so
// this entire path is inert for unkeyed requests. Auth refresh on 401
// and the silent-403 behavior remain untouched (this handler returns
// `unhandled` for any status that is not in the four above).

/** Single source of truth for operator-facing Arabic strings. */
export const IDEMPOTENCY_MESSAGES = {
  PAYLOAD_MISMATCH:
    'تم استخدام هذا الطلب من قبل ببيانات مختلفة. أعد فتح النافذة وحاول مرة أخرى.',
  IN_PROGRESS_RETRY: 'الطلب الأصلي قيد المعالجة، جاري الانتظار...',
  IN_PROGRESS_FINAL:
    'الطلب لا يزال قيد المعالجة. حدّث الصفحة بعد لحظات.',
  CACHE_UNAVAILABLE:
    'خدمة الحماية من التكرار غير متوفرة الآن. حاول مرة أخرى بعد قليل.',
  KEY_INVALID: 'خطأ تقني في مفتاح منع التكرار. أعد المحاولة.',
} as const;

/** 1.5 s — midpoint of the user-spec's "1–2 seconds" retry window. */
export const IDEMPOTENCY_RETRY_DELAY_MS = 1500;

const IDEMPOTENCY_REPLAY_HEADER = 'x-idempotent-replay';
const IDEMPOTENCY_REPLAY_FLAG = '__isIdempotentReplay';
const IDEMPOTENCY_RETRY_MARK = '_idempotencyRetried';

/**
 * Tag the response with `__isIdempotentReplay = true` when the BE
 * served a cached body for an Idempotency-Key replay. Callers that
 * care (e.g. flows showing a "Saved" toast in onSuccess) can read
 * this flag and skip the duplicate toast. Inert otherwise.
 */
export function _handleIdempotencyReplay<T extends AxiosResponse>(res: T): T {
  const headers = (res.headers ?? {}) as Record<string, unknown>;
  // Axios lowercases response header keys, but we honor either casing
  // defensively in case a future axios version changes.
  const v =
    headers[IDEMPOTENCY_REPLAY_HEADER] ?? headers['X-Idempotent-Replay'];
  if (v === 'true' || v === true) {
    (res as any)[IDEMPOTENCY_REPLAY_FLAG] = true;
  }
  return res;
}

export type IdempotencyHandled =
  | { kind: 'unhandled' }
  | { kind: 'rejected' }
  | { kind: 'retry'; promise: Promise<AxiosResponse> };

/**
 * Inspect an axios error for one of the four idempotency-specific
 * responses. Side effects:
 *   · 409 → dedicated Arabic toast, returns 'rejected'
 *   · 425 first hit → loading toast + 1.5 s wait + retry with the SAME
 *     axios config (same Idempotency-Key, same body); marks the
 *     config so a second 425 cannot loop. Returns 'retry' with the
 *     in-flight retry promise.
 *   · 425 second hit (already-marked config) → final Arabic toast,
 *     returns 'rejected'. Caller surfaces the original 425 to react-
 *     query / the form, but no further auto-retry is attempted.
 *   · 503 → dedicated Arabic toast, returns 'rejected'
 *   · 400 IDEMPOTENCY_KEY_INVALID → dedicated Arabic toast, returns
 *     'rejected'. Treated as a developer/key-generation bug.
 *   · Anything else (incl. 401, 403, generic 5xx, network errors) →
 *     'unhandled'. The caller (the response interceptor) MUST then
 *     fall through to its existing 401-refresh / 403-silence /
 *     generic-toast logic.
 */
export async function _handleIdempotencyError(
  err: AxiosError<any>,
  retry: (config: any) => Promise<AxiosResponse>,
): Promise<IdempotencyHandled> {
  const status = err.response?.status;
  const code = err.response?.data?.code as string | undefined;
  const original: any = err.config;

  if (status === 409 && code === 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH') {
    toast.error(IDEMPOTENCY_MESSAGES.PAYLOAD_MISMATCH);
    return { kind: 'rejected' };
  }

  if (status === 425 && code === 'IDEMPOTENCY_KEY_IN_PROGRESS') {
    if (original?.[IDEMPOTENCY_RETRY_MARK]) {
      // Second 425 in a row — the original request is still in flight
      // beyond our patience window. Stop retrying; surface the error.
      toast.error(IDEMPOTENCY_MESSAGES.IN_PROGRESS_FINAL);
      return { kind: 'rejected' };
    }
    if (original) original[IDEMPOTENCY_RETRY_MARK] = true;
    toast.loading(IDEMPOTENCY_MESSAGES.IN_PROGRESS_RETRY, {
      duration: IDEMPOTENCY_RETRY_DELAY_MS,
    });
    await new Promise((r) => setTimeout(r, IDEMPOTENCY_RETRY_DELAY_MS));
    return { kind: 'retry', promise: retry(original) };
  }

  if (status === 503 && code === 'IDEMPOTENCY_CACHE_UNAVAILABLE') {
    toast.error(IDEMPOTENCY_MESSAGES.CACHE_UNAVAILABLE);
    return { kind: 'rejected' };
  }

  if (status === 400 && code === 'IDEMPOTENCY_KEY_INVALID') {
    toast.error(IDEMPOTENCY_MESSAGES.KEY_INVALID);
    return { kind: 'rejected' };
  }

  return { kind: 'unhandled' };
}
