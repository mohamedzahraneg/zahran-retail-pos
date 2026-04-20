import { api, unwrap } from './client';

export interface CustomerGroup {
  id: string;
  code: string;
  name_ar: string;
  name_en?: string;
  description?: string;
  is_wholesale: boolean;
  default_discount_pct: number;
  min_order_amount: number;
  credit_limit: number;
  payment_terms_days: number;
  is_active: boolean;
  is_default: boolean;
  customers_count?: number;
  variant_overrides_count?: number;
  category_rules_count?: number;
}

export interface GroupPrice {
  id: string;
  group_id: string;
  variant_id: string;
  price: number;
  min_qty: number;
  valid_from?: string;
  valid_to?: string;
  is_active: boolean;
  notes?: string;
  sku?: string;
  product_name?: string;
  base_price?: number;
  color_name?: string;
  size_value?: string;
}

export interface GroupCategoryRule {
  id: string;
  group_id: string;
  category_id: string;
  discount_pct: number;
  is_active: boolean;
  category_name?: string;
  category_code?: string;
}

export interface CreateCustomerGroupInput {
  code: string;
  name_ar: string;
  name_en?: string;
  description?: string;
  is_wholesale?: boolean;
  default_discount_pct?: number;
  min_order_amount?: number;
  credit_limit?: number;
  payment_terms_days?: number;
  is_active?: boolean;
  is_default?: boolean;
}

export interface UpsertPriceInput {
  variant_id: string;
  price: number;
  min_qty?: number;
  valid_from?: string | null;
  valid_to?: string | null;
  is_active?: boolean;
  notes?: string;
}

export interface UpsertCategoryRuleInput {
  category_id: string;
  discount_pct: number;
  is_active?: boolean;
}

export const customerGroupsApi = {
  list: (include_inactive = false) =>
    unwrap<CustomerGroup[]>(
      api.get('/customer-groups', {
        params: { include_inactive: include_inactive || undefined },
      }),
    ),
  get: (id: string) =>
    unwrap<
      CustomerGroup & { prices: GroupPrice[]; categories: GroupCategoryRule[] }
    >(api.get(`/customer-groups/${id}`)),
  create: (dto: CreateCustomerGroupInput) =>
    unwrap<CustomerGroup>(api.post('/customer-groups', dto)),
  update: (id: string, dto: Partial<CreateCustomerGroupInput>) =>
    unwrap<CustomerGroup>(api.patch(`/customer-groups/${id}`, dto)),
  remove: (id: string) =>
    unwrap<{ success: boolean }>(api.delete(`/customer-groups/${id}`)),

  listPrices: (id: string) =>
    unwrap<GroupPrice[]>(api.get(`/customer-groups/${id}/prices`)),
  upsertPrice: (id: string, dto: UpsertPriceInput) =>
    unwrap<GroupPrice>(api.post(`/customer-groups/${id}/prices`, dto)),
  bulkPrices: (id: string, items: UpsertPriceInput[]) =>
    unwrap<{ count: number; results: GroupPrice[] }>(
      api.post(`/customer-groups/${id}/prices/bulk`, { items }),
    ),
  removePrice: (priceId: string) =>
    unwrap<{ success: boolean }>(
      api.delete(`/customer-groups/prices/${priceId}`),
    ),

  upsertCategoryRule: (id: string, dto: UpsertCategoryRuleInput) =>
    unwrap<GroupCategoryRule>(
      api.post(`/customer-groups/${id}/categories`, dto),
    ),
  removeCategoryRule: (ruleId: string) =>
    unwrap<{ success: boolean }>(
      api.delete(`/customer-groups/categories/${ruleId}`),
    ),

  /**
   * Resolve effective prices for a batch of variants for a given customer.
   * Returns { variant_id: price }.
   */
  resolve: (
    variant_ids: string[],
    customer_id?: string,
    qty = 1,
  ) =>
    unwrap<Record<string, number>>(
      api.post('/customer-groups/resolve', {
        variant_ids,
        customer_id,
        qty,
      }),
    ),
};
