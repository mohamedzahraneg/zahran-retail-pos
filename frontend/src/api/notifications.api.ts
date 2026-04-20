import { api, unwrap } from './client';

export type NotificationChannel = 'whatsapp' | 'sms' | 'email';
export type NotificationStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled';

export interface NotificationRecord {
  id: string;
  channel: NotificationChannel;
  recipient: string;
  subject?: string | null;
  body: string;
  status: NotificationStatus;
  attempts: number;
  last_error?: string | null;
  provider?: string | null;
  provider_msg_id?: string | null;
  reference_type?: string | null;
  reference_id?: string | null;
  template_code?: string | null;
  metadata?: Record<string, any>;
  scheduled_at?: string | null;
  sent_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationTemplate {
  id: string;
  code: string;
  name_ar: string;
  channel: NotificationChannel;
  subject?: string | null;
  body: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface NotificationStats {
  by_status: { status: NotificationStatus; count: number }[];
  by_channel: { channel: NotificationChannel; count: number }[];
  today_count: number;
}

export const notificationsApi = {
  list: (params?: {
    status?: NotificationStatus;
    channel?: NotificationChannel;
    reference_type?: string;
    reference_id?: string;
    limit?: number;
  }) =>
    unwrap<NotificationRecord[]>(
      api.get('/notifications', { params }),
    ),

  stats: () => unwrap<NotificationStats>(api.get('/notifications/stats')),

  templates: () =>
    unwrap<NotificationTemplate[]>(api.get('/notifications/templates')),

  upsertTemplate: (body: Partial<NotificationTemplate>) =>
    unwrap<NotificationTemplate>(api.post('/notifications/templates', body)),

  sendFromTemplate: (body: {
    code: string;
    recipient?: string;
    variables?: Record<string, any>;
    reference_type?: string;
    reference_id?: string;
  }) => unwrap<NotificationRecord>(api.post('/notifications/send-template', body)),

  sendAdHoc: (body: {
    channel: NotificationChannel;
    recipient: string;
    body: string;
    subject?: string;
  }) => unwrap<any>(api.post('/notifications/send', body)),

  sendNow: (id: string) =>
    unwrap<any>(api.post(`/notifications/${id}/send`)),

  retry: (id: string) =>
    unwrap<any>(api.post(`/notifications/${id}/retry`)),

  cancel: (id: string) =>
    unwrap<NotificationRecord>(api.post(`/notifications/${id}/cancel`)),

  processQueue: (limit = 25) =>
    unwrap<{ processed: number; results: any[] }>(
      api.post(`/notifications/process-queue?limit=${limit}`),
    ),
};
