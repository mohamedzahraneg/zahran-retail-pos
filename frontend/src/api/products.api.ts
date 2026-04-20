import { api, unwrap } from './client';

export interface Product {
  id: string;
  /** Server auto-generates when blank. */
  sku_root?: string;
  name_ar: string;
  name_en?: string;
  type: 'shoe' | 'bag' | 'accessory';
  base_price: number;
  cost_price: number;
  is_active: boolean;
  created_at: string;
  category_id?: string | null;
  brand_id?: string | null;
  supplier_id?: string | null;
  uom?: string;
  primary_image_url?: string | null;
  description?: string | null;
  /** Aggregated across variants (current warehouse or all warehouses). */
  total_stock?: number;
  stock_value?: number;
  variants_count?: number;
}

export interface ColorOption {
  id: string;
  name_ar: string;
  name_en: string | null;
  hex_code: string | null;
}

export interface SizeOption {
  id: string;
  size_label: string;
  size_system: string;
  sort_order: number;
}

export interface Variant {
  id: string;
  product_id: string;
  /** Server auto-generates when blank. */
  sku?: string;
  barcode?: string | null;
  color?: string | null;
  color_id?: string | null;
  size?: string | null;
  size_id?: string | null;
  cost_price?: number | string;
  selling_price?: number | string;
  price_override?: number | null;
  image_url?: string | null;
}

export const productsApi = {
  list: (params?: {
    type?: string;
    q?: string;
    page?: number;
    limit?: number;
    warehouse_id?: string;
    category_id?: string;
    active?: boolean;
  }) => unwrap<{ data: Product[]; meta: any }>(api.get('/products', { params })),

  get: (id: string) => unwrap<Product & { variants: Variant[] }>(api.get(`/products/${id}`)),

  byBarcode: (code: string) =>
    unwrap<{ product: Product; variant: Variant }>(api.get(`/products/barcode/${code}`)),

  create: (body: Partial<Product>) =>
    unwrap<Product>(api.post('/products', body)),

  update: (id: string, body: Partial<Product>) =>
    unwrap<Product>(api.patch(`/products/${id}`, body)),

  remove: (id: string) => unwrap<void>(api.delete(`/products/${id}`)),

  // Variants CRUD
  addVariant: (body: Partial<Variant> & { product_id: string; sku: string }) =>
    unwrap<Variant>(api.post('/products/variants', body)),

  updateVariant: (id: string, body: Partial<Variant>) =>
    unwrap<Variant>(api.patch(`/products/variants/${id}`, body)),

  removeVariant: (id: string) =>
    unwrap<{ archived: boolean }>(api.delete(`/products/variants/${id}`)),

  // Master lists
  colors: () => unwrap<ColorOption[]>(api.get('/products/catalog/colors')),
  sizes: () => unwrap<SizeOption[]>(api.get('/products/catalog/sizes')),

  /** Preview the next product SKU the DB trigger would assign. */
  nextProductSku: (type: string) =>
    unwrap<{ sku: string }>(
      api.get('/products/catalog/next-sku', { params: { type } }),
    ),

  /** Preview the variant SKU for a given product + color + size combo. */
  nextVariantSku: (product_id: string, color_id: string, size_id?: string) =>
    unwrap<{ sku: string }>(
      api.get('/products/catalog/next-variant-sku', {
        params: { product_id, color_id, size_id: size_id || undefined },
      }),
    ),
};
