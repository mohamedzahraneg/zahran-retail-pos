import { api, unwrap } from './client';

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
};
