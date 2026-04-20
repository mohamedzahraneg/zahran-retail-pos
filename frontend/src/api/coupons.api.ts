import { api, unwrap } from './client';

export type CouponType = 'fixed' | 'percentage';

export interface Coupon {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  coupon_type: CouponType;
  value: string;
  max_discount_amount: string | null;
  applies_to_category: string | null;
  applies_to_product: string | null;
  min_order_value: string;
  starts_at: string | null;
  expires_at: string | null;
  max_uses_total: number | null;
  max_uses_per_customer: number;
  uses_count: number;
  is_active: boolean;
  created_by?: string;
  created_by_name?: string;
  category_name?: string | null;
  product_name?: string | null;
  created_at: string;
  updated_at: string;
  usages?: Array<{
    id: number;
    coupon_id: string;
    invoice_id: string;
    customer_id: string | null;
    invoice_no?: string;
    customer_name?: string;
    discount_amount: string;
    used_at: string;
  }>;
}

export interface CreateCouponPayload {
  code: string;
  name_ar: string;
  name_en?: string;
  coupon_type: CouponType;
  value: number;
  max_discount_amount?: number;
  applies_to_category?: string;
  applies_to_product?: string;
  min_order_value?: number;
  starts_at?: string;
  expires_at?: string;
  max_uses_total?: number;
  max_uses_per_customer?: number;
  is_active?: boolean;
}

export interface ValidateCouponResult {
  coupon_id: string;
  code: string;
  name_ar: string;
  coupon_type: CouponType;
  value: string;
  discount_amount: number;
  subtotal: number;
}

export const couponsApi = {
  list: (params?: { q?: string; active?: string }) =>
    unwrap<Coupon[]>(api.get('/coupons', { params })),

  get: (id: string) => unwrap<Coupon>(api.get(`/coupons/${id}`)),

  create: (payload: CreateCouponPayload) =>
    unwrap<Coupon>(api.post('/coupons', payload)),

  update: (id: string, payload: Partial<CreateCouponPayload>) =>
    unwrap<Coupon>(api.patch(`/coupons/${id}`, payload)),

  remove: (id: string) => unwrap<{ id: string }>(api.delete(`/coupons/${id}`)),

  validate: (payload: {
    code: string;
    customer_id?: string;
    subtotal: number;
  }) => unwrap<ValidateCouponResult>(api.post('/coupons/validate', payload)),
};
