import { api, unwrap } from './client';

export interface Category {
  id: string;
  parent_id: string | null;
  name_ar: string;
  name_en: string | null;
  slug: string | null;
  icon: string | null;
  sort_order: number;
  is_active: boolean;
  products_count?: number;
}

export interface CreateCategoryPayload {
  name_ar: string;
  name_en?: string;
  parent_id?: string | null;
  slug?: string;
  icon?: string;
  sort_order?: number;
}

export const categoriesApi = {
  list: () => unwrap<Category[]>(api.get('/categories')),
  create: (body: CreateCategoryPayload) =>
    unwrap<Category>(api.post('/categories', body)),
  update: (id: string, body: Partial<CreateCategoryPayload>) =>
    unwrap<Category>(api.patch(`/categories/${id}`, body)),
  remove: (id: string) =>
    unwrap<{ archived: boolean }>(api.delete(`/categories/${id}`)),
};
