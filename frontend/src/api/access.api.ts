/**
 * access.api.ts — PR-USER-BRANCH-WAREHOUSE-ACCESS
 *
 * Client for the user-branch / user-warehouse access surface.
 *
 *   GET  /me/access              → current-user summary
 *   GET  /users/:id/access       → per-user summary (admin)
 *   PATCH /users/:id/access      → replace lists + defaults
 */
import { api, unwrap } from './client';

export type AccessLevel = 'view' | 'operate' | 'manage' | 'admin';
export const ACCESS_LEVELS: AccessLevel[] = [
  'view',
  'operate',
  'manage',
  'admin',
];

export const ACCESS_LEVEL_LABELS_AR: Record<AccessLevel, string> = {
  view: 'عرض',
  operate: 'تشغيل',
  manage: 'إدارة',
  admin: 'صلاحيات كاملة',
};

export interface BranchAccessRow {
  user_id: string;
  branch_id: string;
  access_level: AccessLevel;
  is_default: boolean;
  branch_code?: string;
  branch_name_ar?: string;
  branch_name_en?: string | null;
  branch_type?: string;
  branch_is_active?: boolean;
}

export interface WarehouseAccessRow {
  user_id: string;
  warehouse_id: string;
  access_level: AccessLevel;
  is_default: boolean;
  warehouse_code?: string;
  warehouse_name_ar?: string;
  warehouse_name_en?: string | null;
  warehouse_is_active?: boolean;
}

export interface UserAccessSummary {
  user_id: string;
  branches: BranchAccessRow[];
  warehouses: WarehouseAccessRow[];
  default_branch_id: string | null;
  default_warehouse_id: string | null;
}

export interface UpdateUserAccessPayload {
  branch_access?: Array<{ branch_id: string; access_level: AccessLevel }>;
  warehouse_access?: Array<{
    warehouse_id: string;
    access_level: AccessLevel;
  }>;
  default_branch_id?: string | null;
  default_warehouse_id?: string | null;
}

export const accessApi = {
  getMyAccess: () => unwrap<UserAccessSummary>(api.get('/me/access')),

  getUserAccess: (userId: string) =>
    unwrap<UserAccessSummary>(api.get(`/users/${userId}/access`)),

  updateUserAccess: (userId: string, payload: UpdateUserAccessPayload) =>
    unwrap<UserAccessSummary>(
      api.patch(`/users/${userId}/access`, payload),
    ),
};
