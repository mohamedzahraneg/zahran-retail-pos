/**
 * access-scope.service.ts — PR-USER-BRANCH-WAREHOUSE-ACCESS
 *
 * Read-only helper that resolves the set of branch_ids and
 * warehouse_ids a given user is allowed to see. The rollout strategy
 * for this PR is deliberately permissive:
 *
 *   · A user who is admin / manager / super-admin is treated as
 *     scope-bypass (sees everything). Today's role names we honour:
 *     `admin`, `super_admin`, `superadmin`, `manager`. Anything else
 *     falls through to the access-table check below.
 *
 *   · A user with at least one row in `user_branch_access` is
 *     scoped to those branches; ditto for `user_warehouse_access`.
 *
 *   · A user with ZERO access rows is "fallback allow-all" —
 *     a `null` allow-list signals "no restriction". This protects
 *     existing users while operators populate the new tables.
 *
 * TODO(rollout): once every user has explicit access rows the
 * fallback-allow-all should be removed and `getUserBranchIds` /
 * `getUserWarehouseIds` should return an empty array (= no access)
 * rather than `null` for unknown users. The call-sites already
 * branch on `null` so the transition is a one-line change here.
 *
 * Strictly read-only — no INSERT / UPDATE / DELETE.
 */
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export type AccessLevel = 'view' | 'operate' | 'manage' | 'admin';
export const ACCESS_LEVELS: AccessLevel[] = [
  'view',
  'operate',
  'manage',
  'admin',
];
const LEVEL_RANK: Record<AccessLevel, number> = {
  view: 0,
  operate: 1,
  manage: 2,
  admin: 3,
};

/** Roles that bypass the access-table check entirely. */
const BYPASS_ROLES = new Set([
  'admin',
  'super_admin',
  'superadmin',
  'manager',
]);

export interface AccessRow {
  user_id: string;
  branch_id?: string;
  warehouse_id?: string;
  access_level: AccessLevel;
  is_default: boolean;
}

export interface UserAccessSummary {
  user_id: string;
  branches: AccessRow[];
  warehouses: AccessRow[];
  default_branch_id: string | null;
  default_warehouse_id: string | null;
}

/**
 * Returned by getUserBranchIds / getUserWarehouseIds when the caller
 * should treat the user as fallback-allow-all. The intersection-
 * filter helpers in callers branch on `null` and skip the filter
 * accordingly.
 */
export type AllowedIds = string[] | null;

@Injectable()
export class AccessScopeService {
  constructor(private readonly ds: DataSource) {}

  // ─── role bypass ─────────────────────────────────────────────────
  isBypassRole(role: string | undefined | null): boolean {
    if (!role) return false;
    return BYPASS_ROLES.has(String(role).toLowerCase());
  }

  // ─── branch helpers ──────────────────────────────────────────────
  /**
   * Allowed branch_ids for the user.
   *   · Bypass role → `null` (no restriction).
   *   · Zero rows  → `null` (fallback allow-all during rollout).
   *   · ≥1 rows    → the array of branch_ids, optionally filtered
   *                  by minLevel.
   */
  async getUserBranchIds(
    userId: string,
    opts: { role?: string; minLevel?: AccessLevel } = {},
  ): Promise<AllowedIds> {
    if (this.isBypassRole(opts.role)) return null;
    const min = opts.minLevel ?? 'view';
    const rows = await this.ds.query(
      `SELECT branch_id, access_level
         FROM user_branch_access
        WHERE user_id = $1::uuid`,
      [userId],
    );
    if (!rows.length) return null; // fallback allow-all
    const minRank = LEVEL_RANK[min];
    return rows
      .filter(
        (r: any) => LEVEL_RANK[r.access_level as AccessLevel] >= minRank,
      )
      .map((r: any) => r.branch_id as string);
  }

  async canAccessBranch(
    userId: string,
    branchId: string,
    opts: { role?: string; minLevel?: AccessLevel } = {},
  ): Promise<boolean> {
    if (this.isBypassRole(opts.role)) return true;
    const allowed = await this.getUserBranchIds(userId, opts);
    if (allowed === null) return true; // fallback allow-all
    return allowed.includes(branchId);
  }

  async getDefaultBranch(userId: string): Promise<string | null> {
    const [row] = await this.ds.query(
      `SELECT branch_id FROM user_branch_access
        WHERE user_id = $1::uuid AND is_default = TRUE
        LIMIT 1`,
      [userId],
    );
    return row?.branch_id ?? null;
  }

  // ─── warehouse helpers ───────────────────────────────────────────
  async getUserWarehouseIds(
    userId: string,
    opts: { role?: string; minLevel?: AccessLevel } = {},
  ): Promise<AllowedIds> {
    if (this.isBypassRole(opts.role)) return null;
    const min = opts.minLevel ?? 'view';
    const rows = await this.ds.query(
      `SELECT warehouse_id, access_level
         FROM user_warehouse_access
        WHERE user_id = $1::uuid`,
      [userId],
    );
    if (!rows.length) return null; // fallback allow-all
    const minRank = LEVEL_RANK[min];
    return rows
      .filter(
        (r: any) => LEVEL_RANK[r.access_level as AccessLevel] >= minRank,
      )
      .map((r: any) => r.warehouse_id as string);
  }

  async canAccessWarehouse(
    userId: string,
    warehouseId: string,
    opts: { role?: string; minLevel?: AccessLevel } = {},
  ): Promise<boolean> {
    if (this.isBypassRole(opts.role)) return true;
    const allowed = await this.getUserWarehouseIds(userId, opts);
    if (allowed === null) return true;
    return allowed.includes(warehouseId);
  }

  async getDefaultWarehouse(userId: string): Promise<string | null> {
    const [row] = await this.ds.query(
      `SELECT warehouse_id FROM user_warehouse_access
        WHERE user_id = $1::uuid AND is_default = TRUE
        LIMIT 1`,
      [userId],
    );
    return row?.warehouse_id ?? null;
  }

  // ─── full summary (used by GET /me/access + GET /users/:id/access) ─
  async getUserAccessSummary(userId: string): Promise<UserAccessSummary> {
    const branches = await this.ds.query(
      `SELECT uba.user_id, uba.branch_id, uba.access_level, uba.is_default,
              b.code        AS branch_code,
              b.name_ar     AS branch_name_ar,
              b.name_en     AS branch_name_en,
              b.type        AS branch_type,
              b.is_active   AS branch_is_active
         FROM user_branch_access uba
         JOIN branches b ON b.id = uba.branch_id
        WHERE uba.user_id = $1::uuid
        ORDER BY b.name_ar`,
      [userId],
    );
    const warehouses = await this.ds.query(
      `SELECT uwa.user_id, uwa.warehouse_id, uwa.access_level, uwa.is_default,
              w.code      AS warehouse_code,
              w.name_ar   AS warehouse_name_ar,
              w.name_en   AS warehouse_name_en,
              w.is_active AS warehouse_is_active
         FROM user_warehouse_access uwa
         JOIN warehouses w ON w.id = uwa.warehouse_id
        WHERE uwa.user_id = $1::uuid
        ORDER BY w.name_ar`,
      [userId],
    );
    return {
      user_id: userId,
      branches,
      warehouses,
      default_branch_id:
        branches.find((r: any) => r.is_default)?.branch_id ?? null,
      default_warehouse_id:
        warehouses.find((r: any) => r.is_default)?.warehouse_id ?? null,
    };
  }
}
