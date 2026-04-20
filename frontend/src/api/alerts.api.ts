import { api, unwrap } from './client';

export type AlertType =
  | 'low_stock'
  | 'out_of_stock'
  | 'reservation_expiring'
  | 'reservation_expired'
  | 'loss_product'
  | 'price_below_cost'
  | 'large_discount'
  | 'cash_mismatch'
  | 'custom';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  id: number;
  alert_type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string | null;
  entity: string | null;
  entity_id: string | null;
  is_read: boolean;
  is_resolved: boolean;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  target_role_id: string | null;
  target_user_id: string | null;
  metadata: Record<string, any>;
  created_at: string;
}

export interface AlertCounts {
  total: number;
  unread: number;
  unresolved: number;
  critical: number;
  warning: number;
}

export const alertsApi = {
  list: (params?: {
    unread?: string;
    unresolved?: string;
    severity?: string;
    type?: string;
    limit?: number;
  }) => unwrap<Alert[]>(api.get('/alerts', { params })),

  counts: () => unwrap<AlertCounts>(api.get('/alerts/counts')),

  markRead: (id: number) =>
    unwrap<Alert>(api.post(`/alerts/${id}/read`)),

  markAllRead: () =>
    unwrap<{ updated: number }>(api.post('/alerts/mark-all-read')),

  resolve: (id: number) =>
    unwrap<Alert>(api.post(`/alerts/${id}/resolve`)),

  scan: () =>
    unwrap<{ created: number; alerts: Alert[] }>(api.post('/alerts/scan')),
};
