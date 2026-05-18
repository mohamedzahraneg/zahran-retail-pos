/**
 * productGroups.api.ts — PR-P9.1a
 *
 * Read + manage manual product groups. Pure CRUD + membership.
 * No `apply` verbs anywhere — group membership is selector-only;
 * price/cost changes still go through the existing smart-pricing
 * and cost-adjustment endpoints.
 */
import { api, unwrap } from './client';

export interface ProductGroup {
  id: string;
  name_ar: string;
  name_en: string | null;
  description: string | null;
  color: string | null;
  is_active: boolean;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
  member_count?: number;
}

export interface ProductGroupMember {
  variant_id: string;
  added_at: string;
  sku: string;
  barcode: string | null;
  current_cost_price: string | number;
  current_selling_price: string | number;
  variant_is_active: boolean;
  product_id: string;
  product_name: string;
  color_name: string | null;
  size_label: string | null;
  stock_on_hand: number;
}

export interface ProductGroupDetail extends ProductGroup {
  members: ProductGroupMember[];
}

export interface CreateProductGroupPayload {
  name_ar: string;
  name_en?: string;
  description?: string;
  /** Optional 6-digit hex color tag (`#RRGGBB`). */
  color?: string;
}

export interface UpdateProductGroupPayload {
  name_ar?: string;
  name_en?: string;
  description?: string;
  color?: string;
  is_active?: boolean;
}

export interface AddProductGroupVariantsPayload {
  variant_ids: string[];
}

export interface AddProductGroupVariantsResponse {
  group_id: string;
  requested: number;
  added: number;
  skipped: number;
  member_count: number;
}

export interface RemoveProductGroupVariantResponse {
  group_id: string;
  variant_id: string;
  removed: boolean;
  member_count: number;
}

export const productGroupsApi = {
  list: (params?: { q?: string; is_active?: boolean }) =>
    unwrap<ProductGroup[]>(api.get('/product-groups', { params })),
  get: (id: string) =>
    unwrap<ProductGroupDetail>(api.get(`/product-groups/${id}`)),
  create: (body: CreateProductGroupPayload) =>
    unwrap<ProductGroup>(api.post('/product-groups', body)),
  update: (id: string, body: UpdateProductGroupPayload) =>
    unwrap<ProductGroup>(api.patch(`/product-groups/${id}`, body)),
  remove: (id: string) =>
    unwrap<{ deactivated: boolean; id: string }>(
      api.delete(`/product-groups/${id}`),
    ),
  addVariants: (id: string, body: AddProductGroupVariantsPayload) =>
    unwrap<AddProductGroupVariantsResponse>(
      api.post(`/product-groups/${id}/variants`, body),
    ),
  removeVariant: (id: string, variantId: string) =>
    unwrap<RemoveProductGroupVariantResponse>(
      api.delete(`/product-groups/${id}/variants/${variantId}`),
    ),
};
