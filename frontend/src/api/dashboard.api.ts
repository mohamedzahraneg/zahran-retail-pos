import { api, unwrap } from './client';

// PR-PAY-5 — Owner dashboard payment channel response shape.
export interface PaymentChannelAccount {
  payment_account_id: string | null;
  display_name: string | null;
  identifier: string | null;
  provider_key: string | null;
  total_amount: number;
  invoice_count: number;
  payment_count: number;
  share_pct: number;
}

export interface PaymentChannelMethod {
  method: string;
  method_label_ar: string;
  total_amount: number;
  invoice_count: number;
  payment_count: number;
  share_pct: number;
  accounts: PaymentChannelAccount[];
}

export interface PaymentChannelsResponse {
  range: { from: string; to: string };
  cash_total: number;
  non_cash_total: number;
  grand_total: number;
  channels: PaymentChannelMethod[];
}

export const dashboardApi = {
  overview: () => unwrap<any>(api.get('/dashboard')),
  today: () => unwrap<any>(api.get('/dashboard/today')),
  revenue: (days = 30) => unwrap<any[]>(api.get(`/dashboard/revenue?days=${days}`)),
  smart: () => unwrap<{ reorder: any[]; dead: any[]; loss: any[] }>(api.get('/dashboard/smart-suggestions')),
  alerts: (limit = 50) => unwrap<any[]>(api.get(`/dashboard/alerts?limit=${limit}`)),
  analytics: (from?: string, to?: string) =>
    unwrap<any>(
      api.get('/dashboard/analytics', {
        params: { from: from || undefined, to: to || undefined },
      }),
    ),
  paymentChannels: (from?: string, to?: string) =>
    unwrap<PaymentChannelsResponse>(
      api.get('/dashboard/payment-channels', {
        params: { from: from || undefined, to: to || undefined },
      }),
    ),
};
