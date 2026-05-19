/**
 * branches.service.ts — PR-BRANCHES-WAREHOUSES-FOUNDATION
 *
 * Pure organisational CRUD over the new `branches` table + warehouse
 * linking via `warehouse_branches`. Strictly read-only towards every
 * existing financial / inventory write surface:
 *
 *   · NO writes to stock / stock_movements / invoices / purchases /
 *     returns / stock_transfers / inventory_counts / cashboxes /
 *     journal_entries / journal_lines / supplier_* / payment_*.
 *   · NO mutation of warehouse-row business fields (code, name_*,
 *     type, is_main, is_retail). The two warehouse-touch points
 *     (`linkWarehouse`, `setPrimary`, `unlinkWarehouse`) only write
 *     to `warehouse_branches`.
 *
 * The static guardrail in branches.service.spec.ts encodes this rule
 * by scanning the file for forbidden table writes.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

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

export interface CreateBranchDto {
  code: string;
  name_ar: string;
  name_en?: string | null;
  type?: BranchType;
  parent_branch_id?: string | null;
  manager_id?: string | null;
  address?: string | null;
  phone?: string | null;
  is_active?: boolean;
}

export type UpdateBranchDto = Partial<CreateBranchDto>;

@Injectable()
export class BranchesService {
  constructor(private readonly ds: DataSource) {}

  // ─── Branches CRUD ────────────────────────────────────────────────
  list(includeInactive = false) {
    return this.ds.query(
      `SELECT b.id,
              b.code,
              b.name_ar,
              b.name_en,
              b.type,
              b.parent_branch_id,
              b.manager_id,
              u.full_name        AS manager_name,
              b.address,
              b.phone,
              b.is_active,
              b.created_at,
              b.updated_at,
              (
                SELECT COUNT(*)::int FROM warehouse_branches wb
                  WHERE wb.branch_id = b.id
              )                  AS warehouses_count
         FROM branches b
         LEFT JOIN users u ON u.id = b.manager_id
        ${includeInactive ? '' : 'WHERE b.is_active = TRUE'}
        ORDER BY b.is_active DESC, b.code`,
    );
  }

  async findOne(id: string) {
    const [row] = await this.ds.query(
      `SELECT b.*, u.full_name AS manager_name
         FROM branches b
         LEFT JOIN users u ON u.id = b.manager_id
        WHERE b.id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException(`Branch ${id} not found`);
    return row;
  }

  async create(dto: CreateBranchDto) {
    const code = dto.code?.trim();
    const nameAr = dto.name_ar?.trim();
    if (!code) throw new BadRequestException('كود الفرع مطلوب');
    if (!nameAr) throw new BadRequestException('الاسم العربي مطلوب');
    const type: BranchType = dto.type ?? 'retail';
    if (!BRANCH_TYPES.includes(type)) {
      throw new BadRequestException(`نوع الفرع غير صالح: ${type}`);
    }

    // Duplicate code → 409 with an actionable message, instead of the
    // raw PG error bubbling up to the operator.
    const [dup] = await this.ds.query(
      `SELECT id FROM branches WHERE code = $1 LIMIT 1`,
      [code],
    );
    if (dup) {
      throw new ConflictException(`كود الفرع "${code}" مستخدم بالفعل`);
    }

    const [row] = await this.ds.query(
      `INSERT INTO branches
         (code, name_ar, name_en, type, parent_branch_id, manager_id,
          address, phone, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, TRUE))
       RETURNING *`,
      [
        code,
        nameAr,
        dto.name_en?.trim() || null,
        type,
        dto.parent_branch_id || null,
        dto.manager_id || null,
        dto.address ?? null,
        dto.phone ?? null,
        dto.is_active,
      ],
    );
    return row;
  }

  async update(id: string, dto: UpdateBranchDto) {
    if (dto.type && !BRANCH_TYPES.includes(dto.type)) {
      throw new BadRequestException(`نوع الفرع غير صالح: ${dto.type}`);
    }
    if (dto.code !== undefined) {
      const code = dto.code?.trim();
      if (!code) throw new BadRequestException('كود الفرع مطلوب');
      const [dup] = await this.ds.query(
        `SELECT id FROM branches WHERE code = $1 AND id <> $2 LIMIT 1`,
        [code, id],
      );
      if (dup) {
        throw new ConflictException(`كود الفرع "${code}" مستخدم بالفعل`);
      }
    }

    const fields: string[] = [];
    const params: any[] = [];
    let i = 1;
    const map: Record<string, any> = {
      code: dto.code?.trim(),
      name_ar: dto.name_ar?.trim(),
      name_en:
        dto.name_en !== undefined
          ? dto.name_en?.trim() || null
          : undefined,
      type: dto.type,
      parent_branch_id:
        dto.parent_branch_id !== undefined
          ? dto.parent_branch_id || null
          : undefined,
      manager_id:
        dto.manager_id !== undefined ? dto.manager_id || null : undefined,
      address: dto.address,
      phone: dto.phone,
      is_active: dto.is_active,
    };
    for (const [k, v] of Object.entries(map)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i++}`);
      params.push(v);
    }
    if (!fields.length) return this.findOne(id);
    fields.push(`updated_at = NOW()`);
    params.push(id);
    const [row] = await this.ds.query(
      `UPDATE branches SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      params,
    );
    if (!row) throw new NotFoundException(`Branch ${id} not found`);
    return row;
  }

  // ─── Warehouse links ──────────────────────────────────────────────
  async listWarehouses(branchId: string) {
    await this.findOne(branchId); // 404 propagation for unknown branch
    return this.ds.query(
      `SELECT w.id,
              w.code,
              w.name,
              w.name_ar,
              w.name_en,
              w.is_active,
              w.warehouse_type,
              w.is_sellable,
              w.allow_negative_stock,
              w.sort_order,
              wb.is_primary,
              wb.created_at AS linked_at
         FROM warehouse_branches wb
         JOIN warehouses w ON w.id = wb.warehouse_id
        WHERE wb.branch_id = $1
        ORDER BY wb.is_primary DESC, w.code`,
      [branchId],
    );
  }

  async linkWarehouse(
    branchId: string,
    warehouseId: string,
    opts: { is_primary?: boolean } = {},
  ) {
    await this.findOne(branchId);
    const [wh] = await this.ds.query(
      `SELECT id FROM warehouses WHERE id = $1`,
      [warehouseId],
    );
    if (!wh) throw new NotFoundException(`Warehouse ${warehouseId} not found`);

    return this.ds.transaction(async (mgr) => {
      // If the new link is to be primary, demote any existing primary
      // for that warehouse FIRST so we don't fight the partial unique
      // index.
      if (opts.is_primary) {
        await mgr.query(
          `UPDATE warehouse_branches
              SET is_primary = FALSE
            WHERE warehouse_id = $1 AND is_primary = TRUE`,
          [warehouseId],
        );
      }
      const [row] = await mgr.query(
        `INSERT INTO warehouse_branches (warehouse_id, branch_id, is_primary)
         VALUES ($1, $2, COALESCE($3, FALSE))
         ON CONFLICT (warehouse_id, branch_id)
         DO UPDATE SET is_primary = EXCLUDED.is_primary OR warehouse_branches.is_primary
         RETURNING warehouse_id, branch_id, is_primary, created_at`,
        [warehouseId, branchId, opts.is_primary ?? false],
      );
      return row;
    });
  }

  async unlinkWarehouse(branchId: string, warehouseId: string) {
    await this.findOne(branchId);
    const result = await this.ds.query(
      `DELETE FROM warehouse_branches
        WHERE branch_id = $1 AND warehouse_id = $2
        RETURNING warehouse_id`,
      [branchId, warehouseId],
    );
    if (!result?.length) {
      throw new NotFoundException(
        `Warehouse ${warehouseId} not linked to branch ${branchId}`,
      );
    }
    return { unlinked: true };
  }

  async setPrimary(branchId: string, warehouseId: string) {
    await this.findOne(branchId);
    // Demote then promote, both atomically.
    return this.ds.transaction(async (mgr) => {
      await mgr.query(
        `UPDATE warehouse_branches
            SET is_primary = FALSE
          WHERE warehouse_id = $1 AND is_primary = TRUE`,
        [warehouseId],
      );
      const result = await mgr.query(
        `UPDATE warehouse_branches
            SET is_primary = TRUE
          WHERE warehouse_id = $1 AND branch_id = $2
          RETURNING warehouse_id, branch_id, is_primary`,
        [warehouseId, branchId],
      );
      if (!result?.length) {
        throw new NotFoundException(
          `Warehouse ${warehouseId} not linked to branch ${branchId}`,
        );
      }
      return result[0];
    });
  }

  // ─── Read helper: warehouses + branches roll-up ───────────────────
  /**
   * Return every warehouse joined with its primary branch + all
   * linked branches. Pure SELECT. Used by GET /warehouses/with-branches
   * (exposed via a thin BranchesController endpoint to keep the new
   * surface in this module — settings.controller stays untouched).
   */
  listWarehousesWithBranches() {
    return this.ds.query(
      `SELECT w.id,
              w.code,
              w.name,
              w.name_ar,
              w.name_en,
              w.address,
              w.phone,
              w.manager_id,
              w.is_main,
              w.is_retail,
              w.is_active,
              w.warehouse_type,
              w.is_sellable,
              w.allow_negative_stock,
              w.sort_order,
              (
                SELECT jsonb_build_object(
                         'id', b.id,
                         'code', b.code,
                         'name_ar', b.name_ar,
                         'name_en', b.name_en,
                         'type', b.type
                       )
                  FROM warehouse_branches wb
                  JOIN branches b ON b.id = wb.branch_id
                 WHERE wb.warehouse_id = w.id
                   AND wb.is_primary = TRUE
                 LIMIT 1
              )                                       AS primary_branch,
              (
                SELECT COALESCE(jsonb_agg(
                         jsonb_build_object(
                           'id', b.id,
                           'code', b.code,
                           'name_ar', b.name_ar,
                           'name_en', b.name_en,
                           'type', b.type,
                           'is_primary', wb.is_primary
                         )
                         ORDER BY wb.is_primary DESC, b.code
                       ), '[]'::jsonb)
                  FROM warehouse_branches wb
                  JOIN branches b ON b.id = wb.branch_id
                 WHERE wb.warehouse_id = w.id
              )                                       AS branches
         FROM warehouses w
        ORDER BY w.is_main DESC, w.sort_order, w.code`,
    );
  }
}
