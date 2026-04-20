import { api, unwrap } from './client';

export interface Setting {
  id: string;
  key: string;
  value: any;
  group_name: string;
  is_public: boolean;
  description: string | null;
  updated_at: string;
}

export interface CompanyProfile {
  id: string;
  name_ar: string;
  name_en?: string | null;
  tax_number?: string | null;
  commercial_register?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  logo_url?: string | null;
  receipt_footer_ar?: string | null;
  receipt_footer_en?: string | null;
  currency?: string | null;
  tax_rate?: number | null;
}

export interface Warehouse {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  address: string | null;
  phone: string | null;
  manager_id: string | null;
  manager_name?: string | null;
  is_main: boolean;
  is_retail: boolean;
  is_active: boolean;
}

export interface Cashbox {
  id: string;
  name_ar: string;
  name_en: string | null;
  warehouse_id: string;
  warehouse_name?: string;
  current_balance: number;
  is_active: boolean;
}

export interface Role {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  description: string | null;
  permissions: string[];
  is_system: boolean;
  is_active: boolean;
  users_count?: number;
}

export interface PaymentMethod {
  code: string;
  name_ar: string;
  name_en: string;
  is_active: boolean;
  requires_reference: boolean;
  sort_order: number;
}

export const settingsApi = {
  list: (group?: string) =>
    unwrap<Setting[]>(api.get('/settings', { params: { group } })),
  get: (key: string) => unwrap<Setting>(api.get(`/settings/by-key/${key}`)),
  upsert: (body: Partial<Setting>) =>
    unwrap<Setting>(api.post('/settings', body)),
  delete: (key: string) =>
    unwrap<{ deleted: boolean }>(api.delete(`/settings/by-key/${key}`)),

  getCompany: () => unwrap<CompanyProfile>(api.get('/settings/company')),
  updateCompany: (body: Partial<CompanyProfile>) =>
    unwrap<CompanyProfile>(api.patch('/settings/company', body)),

  listWarehouses: (include_inactive = false) =>
    unwrap<Warehouse[]>(
      api.get('/settings/warehouses', {
        params: { include_inactive: include_inactive || undefined },
      }),
    ),
  createWarehouse: (body: Partial<Warehouse>) =>
    unwrap<Warehouse>(api.post('/settings/warehouses', body)),
  updateWarehouse: (id: string, body: Partial<Warehouse>) =>
    unwrap<Warehouse>(api.patch(`/settings/warehouses/${id}`, body)),

  listCashboxes: (warehouse_id?: string) =>
    unwrap<Cashbox[]>(
      api.get('/settings/cashboxes', { params: { warehouse_id } }),
    ),
  createCashbox: (body: Partial<Cashbox>) =>
    unwrap<Cashbox>(api.post('/settings/cashboxes', body)),
  updateCashbox: (id: string, body: Partial<Cashbox>) =>
    unwrap<Cashbox>(api.patch(`/settings/cashboxes/${id}`, body)),

  listRoles: () => unwrap<Role[]>(api.get('/settings/roles')),
  createRole: (body: {
    code: string;
    name_ar: string;
    name_en?: string;
    description?: string;
    permissions?: string[];
  }) => unwrap<Role>(api.post('/settings/roles', body)),
  updateRole: (
    id: string,
    body: {
      name_ar?: string;
      name_en?: string;
      description?: string;
      permissions?: string[];
    },
  ) => unwrap<Role>(api.patch(`/settings/roles/${id}`, body)),
  deleteRole: (id: string) =>
    unwrap<{ archived: boolean }>(api.delete(`/settings/roles/${id}`)),

  listPermissions: () =>
    unwrap<{
      groups: Record<string, Array<{ code: string; label: string }>>;
      all?: string[];
    }>(api.get('/settings/permissions')),

  listPaymentMethods: () =>
    unwrap<PaymentMethod[]>(api.get('/settings/payment-methods')),
  togglePaymentMethod: (code: string, is_active: boolean) =>
    unwrap<PaymentMethod>(
      api.patch(`/settings/payment-methods/${code}`, { is_active }),
    ),
};
