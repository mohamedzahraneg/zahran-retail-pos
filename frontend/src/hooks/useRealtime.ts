import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Realtime WebSocket hook — connects to the backend `/realtime` namespace,
 * authenticates with JWT, and:
 *   • Invalidates relevant React Query caches when events arrive
 *   • Surfaces toast notifications for new alerts and POS events
 *
 * Mount once at the root of the authenticated app shell (e.g. AppLayout).
 */
export function useRealtime() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const isHydrated = useAuthStore((s) => s.isHydrated);
  const qc = useQueryClient();
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!isHydrated || !accessToken) return;

    const envApiUrl = import.meta.env.VITE_API_URL as string | undefined;
    const baseURL = envApiUrl ?? 'http://localhost:3000';

    const socket = io(`${baseURL}/realtime`, {
      auth: { token: accessToken },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1500,
      reconnectionAttempts: 10,
    });

    socketRef.current = socket;

    // ─── Connection lifecycle ──────────────────────────────────────────
    socket.on('connect', () => {
      // eslint-disable-next-line no-console
      console.log('[realtime] connected', socket.id);
    });

    socket.on('connected', (info: { userId: string; rooms: string[] }) => {
      // eslint-disable-next-line no-console
      console.log('[realtime] joined rooms:', info.rooms);
    });

    socket.on('connect_error', (err) => {
      // eslint-disable-next-line no-console
      console.warn('[realtime] connect_error:', err.message);
    });

    socket.on('error', (err: { message: string }) => {
      // eslint-disable-next-line no-console
      console.warn('[realtime] server error:', err);
    });

    // ─── Alerts ────────────────────────────────────────────────────────
    socket.on('alert:new', (alert: any) => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['alerts-counts'] });

      const icon =
        alert.severity === 'critical'
          ? '🔴'
          : alert.severity === 'warning'
            ? '🟡'
            : '🔵';
      toast(`${icon} ${alert.title || 'تنبيه جديد'}`, {
        duration: alert.severity === 'critical' ? 8000 : 4000,
        style:
          alert.severity === 'critical'
            ? { background: '#fee2e2', color: '#991b1b', fontWeight: 600 }
            : undefined,
      });
    });

    // ─── POS events ────────────────────────────────────────────────────
    socket.on('pos:invoice.created', (payload: any) => {
      qc.invalidateQueries({ queryKey: ['dashboard-kpis'] });
      qc.invalidateQueries({ queryKey: ['recent-invoices'] });
      qc.invalidateQueries({ queryKey: ['shifts'] });
      // Silent — too noisy to toast every invoice
      void payload;
    });

    socket.on('pos:invoice.voided', () => {
      qc.invalidateQueries({ queryKey: ['dashboard-kpis'] });
      qc.invalidateQueries({ queryKey: ['recent-invoices'] });
    });

    socket.on('pos:return.created', () => {
      qc.invalidateQueries({ queryKey: ['returns'] });
      qc.invalidateQueries({ queryKey: ['dashboard-kpis'] });
    });

    // ─── Inventory events ──────────────────────────────────────────────
    socket.on('inventory:low_stock', () => {
      qc.invalidateQueries({ queryKey: ['stock'] });
      qc.invalidateQueries({ queryKey: ['low-stock'] });
    });

    socket.on('inventory:out_of_stock', (payload: any) => {
      qc.invalidateQueries({ queryKey: ['stock'] });
      toast.error(`نفد المخزون: ${payload?.product_name ?? 'صنف'}`);
    });

    socket.on('inventory:transfer.shipped', () => {
      qc.invalidateQueries({ queryKey: ['stock-transfers'] });
      qc.invalidateQueries({ queryKey: ['stock'] });
    });

    socket.on('inventory:transfer.received', () => {
      qc.invalidateQueries({ queryKey: ['stock-transfers'] });
      qc.invalidateQueries({ queryKey: ['stock'] });
    });

    socket.on('inventory:count.completed', () => {
      qc.invalidateQueries({ queryKey: ['inventory-counts'] });
      qc.invalidateQueries({ queryKey: ['stock'] });
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [accessToken, isHydrated, qc]);

  return socketRef;
}
