import axios, { AxiosError, AxiosInstance, AxiosResponse } from 'axios';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/stores/auth.store';

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
  return config;
});

// ─── Response interceptor ───────────────────────────────────────────────
let isRefreshing = false;
let pending: ((token: string) => void)[] = [];

api.interceptors.response.use(
  (res) => res,
  async (err: AxiosError<any>) => {
    const original: any = err.config;
    const status = err.response?.status;

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
