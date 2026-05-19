/**
 * branches.api.ts — PR-BRANCHES-WAREHOUSES-FOUNDATION
 *
 * Thin client for the new branches + warehouse-linking surface.
 * Strictly admin / manager — no stock / financial side-effects from
 * any endpoint here. POST/PATCH/DELETE only touch the new
 * `branches` and `warehouse_branches` tables (enforced server-side
 * by the static guardrail spec in branches.service.spec.ts).
 *
 * Tenant-readiness: the `code` uniqueness is currently global; it
 * will move to `(tenant_id, code)` when the tenant foundation ships.
 */
import { api, unwrap } from './client';

export type BranchType =
  | 'retail'
  | 'warehouse'
  | 'online'
  | 'mobile'
  | 'virtual'
  | 'head_office';

export const BRANCH_TYPES: BranchType[] = [
  'retail',
  'warehouse',
  'online',
  'mobile',
  'virtual',
  'head_office',
];

export const BRANCH_TYPE_LABELS_AR: Record<BranchType, string> = {
  retail: 'فرع بيع',
  warehouse: 'مخزن',
  online: 'متجر إلكتروني',
  mobile: 'بيع متنقّل',
  virtual: 'افتراضي',
  head_office: 'الإدارة العامة',
};

export interface Branch {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  type: BranchType;
  parent_branch_id: string | null;
  manager_id: string | null;
  manager_name?: string | null;
  address: string | null;
  phone: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  warehouses_count?: number;
}

export interface CreateBranchBody {
  code: string;
  name_ar: string;
  name_en?: string;
  type?: BranchType;
  parent_branch_id?: string | null;
  manager_id?: string | null;
  address?: string | null;
  phone?: string | null;
  is_active?: boolean;
}

export type UpdateBranchBody = Partial<CreateBranchBody>;

export interface BranchWarehouseRow {
  id: string;
  code: string;
  name: string | null;
  name_ar: string | null;
  name_en: string | null;
  is_active: boolean;
  warehouse_type: string | null;
  is_sellable: boolean;
  allow_negative_stock: boolean;
  sort_order: number;
  is_primary: boolean;
  linked_at: string;
}

export interface WarehouseBranchSummary {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  type: BranchType;
  is_primary?: boolean;
}

export interface WarehouseWithBranches {
  id: string;
  code: string;
  name: string | null;
  name_ar: string | null;
  name_en: string | null;
  address: string | null;
  phone: string | null;
  manager_id: string | null;
  is_main: boolean;
  is_retail: boolean;
  is_active: boolean;
  warehouse_type: string | null;
  is_sellable: boolean;
  allow_negative_stock: boolean;
  sort_order: number;
  primary_branch: WarehouseBranchSummary | null;
  branches: WarehouseBranchSummary[];
}

export const branchesApi = {
  list: (include_inactive = false) =>
    unwrap<Branch[]>(
      api.get('/branches', {
        params: { include_inactive: include_inactive || undefined },
      }),
    ),
  get: (id: string) => unwrap<Branch>(api.get(`/branches/${id}`)),
  create: (body: CreateBranchBody) =>
    unwrap<Branch>(api.post('/branches', body)),
  update: (id: string, body: UpdateBranchBody) =>
    unwrap<Branch>(api.patch(`/branches/${id}`, body)),

  // Warehouse linking
  listWarehouses: (branchId: string) =>
    unwrap<BranchWarehouseRow[]>(
      api.get(`/branches/${branchId}/warehouses`),
    ),
  linkWarehouse: (
    branchId: string,
    warehouseId: string,
    body: { is_primary?: boolean } = {},
  ) =>
    unwrap<{ warehouse_id: string; branch_id: string; is_primary: boolean }>(
      api.post(`/branches/${branchId}/warehouses/${warehouseId}`, body),
    ),
  unlinkWarehouse: (branchId: string, warehouseId: string) =>
    unwrap<{ unlinked: boolean }>(
      api.delete(`/branches/${branchId}/warehouses/${warehouseId}`),
    ),
  setPrimary: (branchId: string, warehouseId: string) =>
    unwrap<{ warehouse_id: string; branch_id: string; is_primary: boolean }>(
      api.patch(`/branches/${branchId}/warehouses/${warehouseId}/primary`),
    ),

  // Read-only roll-up
  listWarehousesWithBranches: () =>
    unwrap<WarehouseWithBranches[]>(api.get('/warehouses/with-branches')),
};
