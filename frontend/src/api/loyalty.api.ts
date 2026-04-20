import { api, unwrap } from './client';

export interface LoyaltyConfig {
  points_per_egp: number;
  egp_per_point: number;
  min_redeem: number;
  max_redeem_ratio: number;
}

export interface LoyaltyBalance {
  id: string;
  full_name: string;
  phone: string;
  loyalty_points: number;
  loyalty_tier: string;
  config: LoyaltyConfig;
  redeemable_egp: number;
}

export interface LoyaltyPreview {
  requested_points: number;
  applied_points: number;
  applied_egp: number;
  config: LoyaltyConfig;
}

export interface LoyaltyTransaction {
  id: string;
  direction: 'in' | 'out';
  points: number;
  reason: string;
  reference_type: string | null;
  reference_id: string | null;
  created_at: string;
  username?: string | null;
  full_name?: string | null;
}

export interface LoyaltyCustomerRow {
  id: string;
  full_name: string;
  phone: string | null;
  loyalty_points: number;
  loyalty_tier: string | null;
  total_spent: number | null;
  last_visit_at: string | null;
  visits_count: number | null;
  redeemable_egp: number;
}

export const loyaltyApi = {
  config: () => unwrap<LoyaltyConfig>(api.get('/loyalty/config')),

  updateConfig: (patch: Partial<LoyaltyConfig>) =>
    unwrap<LoyaltyConfig>(api.patch('/loyalty/config', patch)),

  customers: (params?: { q?: string; tier?: string; limit?: number }) =>
    unwrap<LoyaltyCustomerRow[]>(api.get('/loyalty/customers', { params })),

  customer: (id: string) =>
    unwrap<LoyaltyBalance>(api.get(`/loyalty/customer/${id}`)),

  history: (id: string, limit = 50) =>
    unwrap<LoyaltyTransaction[]>(
      api.get(`/loyalty/customer/${id}/history`, { params: { limit } }),
    ),

  preview: (id: string, points: number, subtotal: number) =>
    unwrap<LoyaltyPreview>(
      api.post(`/loyalty/customer/${id}/preview`, { points, subtotal }),
    ),

  adjust: (id: string, body: { delta: number; reason?: string }) =>
    unwrap<{ previous: number; delta: number; current: number }>(
      api.post(`/loyalty/customer/${id}/adjust`, body),
    ),
};
