/**
 * inventory-counts.service.ts — PR-INVENTORY-COUNTS-WORKFLOW
 *
 * Branch-aware stocktaking with a precise multi-step lifecycle:
 *
 *   draft ──freeze──► open ──update items──► counting ──review──► review
 *     │                                                            │
 *     ├──────────── cancel (cancel allowed pre-finalize) ──────────┘
 *     │                                                            │
 *     └────────────────────────────── finalize ────────────────────► finalized
 *
 *   · Legacy values (in_progress, completed) remain valid per
 *     migration 146b's relaxed CHECK so historical rows continue to
 *     parse. New flows emit the richer set.
 *
 *   · The ONLY stock side-effect is at `finalize`, and it is emitted
 *     exclusively through `fn_adjust_stock_v2` (the movement-only
 *     helper). No `UPDATE stock` / `INSERT INTO stock` anywhere in
 *     this module — enforced by the static guardrail spec.
 *
 *   · Idempotency:
 *       - freeze     → ON CONFLICT (count_id, variant_id) DO NOTHING
 *                      on the snapshot insert, so re-running freeze
 *                      never duplicates items.
 *       - updateItems→ no stock motion at all; safe to retry.
 *       - finalize   → EXISTS check on stock_movements
 *                      (reference_type='inventory_count', reference_id
 *                      = count.id, source_action='finalize'). If the
 *                      ledger already contains finalize movements for
 *                      this count, we skip the delta loop and just
 *                      flip status to 'finalized' if needed.
 *       - cancel     → status guard rejects re-cancel and post-
 *                      finalize cancellation.
 */
import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CancelCountDto,
  CreateCountDto,
  FinalizeCountDto,
  FreezeCountDto,
  StartCountDto,
  SubmitCountDto,
} from './dto/inventory-count.dto';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';

/** Public-facing status values. */
export type CountStatus =
  | 'draft'
  | 'open'
  | 'counting'
  | 'review'
  | 'finalized'
  | 'in_progress' // legacy
  | 'completed' // legacy alias for finalized
  | 'cancelled';

const PRE_FREEZE_STATUSES: CountStatus[] = ['draft'];
const ITEM_EDIT_STATUSES: CountStatus[] = [
  'draft',
  'open',
  'counting',
  'in_progress',
];
const REVIEWABLE_STATUSES: CountStatus[] = [
  'open',
  'counting',
  'in_progress',
];
const FINALIZABLE_STATUSES: CountStatus[] = [
  'review',
  'counting',
  'in_progress',
];
const CANCELLABLE_STATUSES: CountStatus[] = [
  'draft',
  'open',
  'counting',
  'review',
  'in_progress',
];

interface ListFilters {
  status?: string;
  warehouse_id?: string;
  branch_id?: string;
  date_from?: string;
  date_to?: string;
  search?: string;
  /**
   * PR-USER-BRANCH-WAREHOUSE-ACCESS — allow-list of warehouse_ids
   * the caller may see. `undefined` = no restriction (bypass /
   * fallback-allow-all). Empty array yields zero rows.
   */
  allowed_warehouse_ids?: string[];
}

@Injectable()
export class InventoryCountsService {
  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly posting?: AccountingPostingService,
  ) {}

  /** Generate CNT-YYYY-NNNNN */
  private async nextCountNo(): Promise<string> {
    const year = new Date().getFullYear();
    const [{ max }] = await this.ds.query(
      `SELECT COALESCE(MAX(SUBSTRING(count_no FROM 'CNT-[0-9]+-([0-9]+)')::int), 0) AS max
         FROM inventory_counts
        WHERE count_no LIKE 'CNT-' || $1 || '-%'`,
      [year],
    );
    return `CNT-${year}-${String(Number(max) + 1).padStart(5, '0')}`;
  }

  private async assertWarehouseActive(warehouseId: string) {
    const [w] = await this.ds.query(
      `SELECT id, is_active FROM warehouses WHERE id = $1`,
      [warehouseId],
    );
    if (!w) throw new BadRequestException('المخزن غير موجود');
    if (!w.is_active) throw new BadRequestException('المخزن غير نشط');
  }

  // ─── CREATE (pure header, no snapshot) ───────────────────────────
  async create(dto: CreateCountDto, userId: string) {
    await this.assertWarehouseActive(dto.warehouse_id);
    const countNo = await this.nextCountNo();
    return this.ds.transaction(async (tx) => {
      const [count] = await tx.query(
        `INSERT INTO inventory_counts
           (count_no, warehouse_id, status, started_by, notes)
         VALUES ($1, $2, 'draft', $3, $4)
         RETURNING *`,
        [countNo, dto.warehouse_id, userId, dto.notes ?? null],
      );
      return this.findOneTx(tx, count.id);
    });
  }

  // ─── LEGACY START (create + freeze in one step) ──────────────────
  /**
   * Backwards-compatible "start" endpoint used by the existing FE.
   * Equivalent to create() then freeze() in one transaction.
   */
  async start(dto: StartCountDto, userId: string) {
    await this.assertWarehouseActive(dto.warehouse_id);
    const countNo = await this.nextCountNo();
    return this.ds.transaction(async (tx) => {
      const [count] = await tx.query(
        `INSERT INTO inventory_counts
           (count_no, warehouse_id, status, started_by, notes)
         VALUES ($1, $2, 'open', $3, $4)
         RETURNING *`,
        [countNo, dto.warehouse_id, userId, dto.notes ?? null],
      );
      await this.snapshotItems(tx, count.id, dto.warehouse_id, {
        variant_ids: dto.variant_ids,
      });
      return this.findOneTx(tx, count.id);
    });
  }

  // ─── FREEZE (snapshot stock into items) ──────────────────────────
  async freeze(id: string, dto: FreezeCountDto, _userId: string) {
    return this.ds.transaction(async (tx) => {
      const [c] = await tx.query(
        `SELECT * FROM inventory_counts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!c) throw new NotFoundException('الجرد غير موجود');
      if (!PRE_FREEZE_STATUSES.includes(c.status as CountStatus)) {
        // Idempotency: a second freeze call sees status='open'/
        // 'counting'/etc. We still re-run the snapshot under
        // ON CONFLICT DO NOTHING so newly-stocked variants since
        // the last freeze get picked up — but we don't error or
        // duplicate.
        await this.snapshotItems(tx, id, c.warehouse_id, dto);
        return this.findOneTx(tx, id);
      }

      await this.snapshotItems(tx, id, c.warehouse_id, dto);

      await tx.query(
        `UPDATE inventory_counts SET status = 'open', updated_at = updated_at WHERE id = $1`,
        [id],
      );
      return this.findOneTx(tx, id);
    });
  }

  /**
   * Reusable snapshot insert. Idempotent via ON CONFLICT on the
   * (count_id, variant_id) unique constraint.
   */
  private async snapshotItems(
    tx: any,
    countId: string,
    warehouseId: string,
    dto: FreezeCountDto,
  ) {
    const conds: string[] = [`sl.warehouse_id = $2`];
    const params: any[] = [countId, warehouseId];

    if (dto.variant_ids && dto.variant_ids.length > 0) {
      params.push(dto.variant_ids);
      conds.push(`sl.variant_id = ANY($${params.length}::uuid[])`);
    }
    if (dto.category_id) {
      params.push(dto.category_id);
      conds.push(`p.category_id = $${params.length}::uuid`);
    }
    if (dto.brand_id) {
      params.push(dto.brand_id);
      conds.push(`p.brand_id = $${params.length}::uuid`);
    }
    if (dto.product_id) {
      params.push(dto.product_id);
      conds.push(`pv.product_id = $${params.length}::uuid`);
    }
    if (dto.group_id) {
      params.push(dto.group_id);
      conds.push(
        `EXISTS (
           SELECT 1 FROM product_group_variants pgv
            WHERE pgv.variant_id = pv.id
              AND pgv.group_id   = $${params.length}::uuid
         )`,
      );
    }

    // When no explicit scope is supplied, default to "every row that
    // currently has on-hand quantity > 0" — same behavior the legacy
    // `start` had for ergonomic snapshots.
    if (
      !dto.variant_ids?.length &&
      !dto.category_id &&
      !dto.brand_id &&
      !dto.group_id &&
      !dto.product_id
    ) {
      conds.push(`COALESCE(sl.quantity_on_hand, 0) > 0`);
    }

    const where = conds.join(' AND ');

    await tx.query(
      `INSERT INTO inventory_count_items (count_id, variant_id, system_qty)
         SELECT $1::uuid,
                sl.variant_id,
                COALESCE(sl.quantity_on_hand, 0)
           FROM stock sl
           JOIN product_variants pv ON pv.id = sl.variant_id
           JOIN products p          ON p.id  = pv.product_id
          WHERE ${where}
       ON CONFLICT (count_id, variant_id) DO NOTHING`,
      params,
    );
  }

  // ─── UPDATE ITEMS (counted_qty / notes) ──────────────────────────
  async updateItems(id: string, dto: SubmitCountDto, _userId: string) {
    return this.ds.transaction(async (tx) => {
      const [c] = await tx.query(
        `SELECT * FROM inventory_counts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!c) throw new NotFoundException('الجرد غير موجود');
      if (!ITEM_EDIT_STATUSES.includes(c.status as CountStatus)) {
        throw new ConflictException(
          `لا يمكن تعديل عناصر جرد بالحالة: ${c.status}`,
        );
      }

      for (const e of dto.items) {
        if (Number(e.counted_qty) < 0) {
          throw new BadRequestException(
            'الكمية المعدودة لا يمكن أن تكون أقل من الصفر',
          );
        }
        const res = await tx.query(
          `UPDATE inventory_count_items SET
             counted_qty = $1,
             notes       = COALESCE($2, notes)
           WHERE id = $3 AND count_id = $4
           RETURNING id`,
          [e.counted_qty, e.notes ?? null, e.item_id, id],
        );
        if (!res?.length) {
          throw new BadRequestException(`عنصر غير موجود: ${e.item_id}`);
        }
      }

      // Promote draft → counting once at least one counted_qty has
      // landed. We keep `in_transit` / `open` valid as inputs and
      // bump them to `counting` on the same edge.
      if (c.status === 'open' || c.status === 'draft' || c.status === 'in_progress') {
        const [{ counted }] = await tx.query(
          `SELECT COUNT(*)::int AS counted
             FROM inventory_count_items
            WHERE count_id = $1 AND counted_qty IS NOT NULL`,
          [id],
        );
        if (Number(counted) > 0 && c.status !== 'in_progress') {
          await tx.query(
            `UPDATE inventory_counts SET status = 'counting' WHERE id = $1`,
            [id],
          );
        }
      }

      return this.findOneTx(tx, id);
    });
  }

  // ─── REVIEW ──────────────────────────────────────────────────────
  /**
   * Transition counting/open → review once every item has a
   * counted_qty. Items the operator deliberately wants to mark as
   * zero must be set to 0 explicitly via updateItems — we refuse to
   * silently treat NULL as zero at this gate.
   */
  async review(id: string, _userId: string) {
    return this.ds.transaction(async (tx) => {
      const [c] = await tx.query(
        `SELECT * FROM inventory_counts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!c) throw new NotFoundException('الجرد غير موجود');
      if (!REVIEWABLE_STATUSES.includes(c.status as CountStatus)) {
        throw new ConflictException(
          `لا يمكن نقل جرد إلى مراجعة بالحالة: ${c.status}`,
        );
      }
      const [{ missing }] = await tx.query(
        `SELECT COUNT(*)::int AS missing
           FROM inventory_count_items
          WHERE count_id = $1 AND counted_qty IS NULL`,
        [id],
      );
      if (Number(missing) > 0) {
        throw new BadRequestException(
          `لا يمكن المراجعة قبل عدّ جميع الأصناف (${missing} غير معدود)`,
        );
      }
      await tx.query(
        `UPDATE inventory_counts SET status = 'review' WHERE id = $1`,
        [id],
      );
      return this.findOneTx(tx, id);
    });
  }

  // ─── FINALIZE (apply variances via fn_adjust_stock_v2) ───────────
  async finalize(id: string, dto: FinalizeCountDto, userId: string) {
    return this.ds.transaction(async (tx) => {
      const [c] = await tx.query(
        `SELECT * FROM inventory_counts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!c) throw new NotFoundException('الجرد غير موجود');

      // Idempotency fast path 1: status already finalized/completed
      // → no-op return.
      if (c.status === 'finalized' || c.status === 'completed') {
        return this.findOneTx(tx, id);
      }
      if (!FINALIZABLE_STATUSES.includes(c.status as CountStatus)) {
        throw new ConflictException(
          `لا يمكن اعتماد جرد بالحالة: ${c.status}`,
        );
      }

      const [{ missing }] = await tx.query(
        `SELECT COUNT(*)::int AS missing
           FROM inventory_count_items
          WHERE count_id = $1 AND counted_qty IS NULL`,
        [id],
      );
      if (Number(missing) > 0) {
        throw new BadRequestException(
          `لا يمكن الاعتماد قبل عدّ جميع الأصناف (${missing} غير معدود)`,
        );
      }

      // Idempotency fast path 2: stock_movements already exist for
      // this count's finalize action. This guards against the rare
      // race where the row's status guard above clears but a prior
      // partial commit emitted some movements.
      const [{ existing }] = await tx.query(
        `SELECT COUNT(*)::int AS existing
           FROM stock_movements
          WHERE reference_type::text = 'inventory_count'
            AND reference_id         = $1
            AND source_action        = 'finalize'`,
        [id],
      );
      if (Number(existing) > 0) {
        await tx.query(
          `UPDATE inventory_counts SET
             status                    = 'finalized',
             completed_by              = COALESCE(completed_by, $1),
             completed_at              = COALESCE(completed_at, NOW()),
             finalized_at              = COALESCE(finalized_at, NOW()),
             finalized_movement_count  = GREATEST(finalized_movement_count, $2::int),
             notes                     = COALESCE($3, notes)
           WHERE id = $4`,
          [userId, Number(existing), dto.notes ?? null, id],
        );
        return this.findOneTx(tx, id);
      }

      const items = await tx.query(
        `SELECT id, variant_id, system_qty, counted_qty,
                (COALESCE(counted_qty, 0) - system_qty) AS difference
           FROM inventory_count_items
          WHERE count_id = $1`,
        [id],
      );
      const withDiff = items.filter(
        (i: any) => i.counted_qty !== null && Number(i.difference) !== 0,
      );

      let netValue = 0; // + = overage, - = shortage
      for (const it of withDiff) {
        // Variant cost-price snapshot for the optional GL post.
        // Read-only.
        const [cp] = await tx.query(
          `SELECT COALESCE(cost_price, 0)::numeric(14,2) AS cp
             FROM product_variants WHERE id = $1`,
          [it.variant_id],
        );
        const unitCost = Number(cp?.cp ?? 0);
        netValue += unitCost * Number(it.difference);

        await tx.query(
          `SELECT fn_adjust_stock_v2(
             $1::uuid, $2::uuid, $3::int, $4::text,
             $5::entity_type, $6::uuid,
             $7::numeric, $8::uuid,
             $9::text, $10::text,
             $11::stock_movement_type
           )`,
          [
            it.variant_id,
            c.warehouse_id,
            Number(it.difference),
            `INVENTORY_COUNT:${c.count_no}`,
            'inventory_count',
            c.id,
            unitCost,
            userId,
            'inventory_counts',
            'finalize',
            Number(it.difference) > 0
              ? 'adjustment_in'
              : 'adjustment_out',
          ],
        );
      }

      await tx.query(
        `UPDATE inventory_counts SET
           status                   = 'finalized',
           completed_by             = $1,
           completed_at             = NOW(),
           finalized_at             = NOW(),
           finalized_movement_count = $2::int,
           notes                    = COALESCE($3, notes)
         WHERE id = $4`,
        [userId, withDiff.length, dto.notes ?? null, id],
      );

      // Optional GL posting — keeps the existing accounting hook.
      // The spec asks us NOT to change financial entries, so the
      // call shape stays identical to the legacy code; we just
      // skip it when no net value moved.
      if (Math.abs(netValue) >= 0.01) {
        await this.posting
          ?.postInventoryAdjustment(
            id,
            netValue,
            `جرد فعلي ${c.count_no}`,
            userId,
            tx,
          )
          .catch(() => undefined);
      }

      return this.findOneTx(tx, id);
    });
  }

  // ─── CANCEL (pre-finalize only) ──────────────────────────────────
  async cancel(id: string, dto: CancelCountDto, userId: string) {
    return this.ds.transaction(async (tx) => {
      const [c] = await tx.query(
        `SELECT * FROM inventory_counts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!c) throw new NotFoundException('الجرد غير موجود');
      if (!CANCELLABLE_STATUSES.includes(c.status as CountStatus)) {
        throw new ConflictException(
          `لا يمكن إلغاء جرد بالحالة: ${c.status}`,
        );
      }
      await tx.query(
        `UPDATE inventory_counts SET
           status        = 'cancelled',
           cancelled_by  = $1,
           cancelled_at  = NOW(),
           cancel_reason = $2
         WHERE id = $3`,
        [userId, dto?.reason ?? null, id],
      );
      return this.findOneTx(tx, id);
    });
  }

  // ─── LIST ────────────────────────────────────────────────────────
  async list(filters: ListFilters = {}) {
    const conds: string[] = [];
    const params: any[] = [];

    if (filters.status) {
      params.push(filters.status);
      conds.push(`c.status = $${params.length}`);
    }
    if (filters.warehouse_id) {
      params.push(filters.warehouse_id);
      conds.push(`c.warehouse_id = $${params.length}::uuid`);
    }
    if (filters.branch_id) {
      // EXISTS over warehouse_branches keeps the row count stable
      // when a warehouse is linked to multiple branches.
      params.push(filters.branch_id);
      conds.push(
        `EXISTS (
           SELECT 1 FROM warehouse_branches wb
            WHERE wb.warehouse_id = c.warehouse_id
              AND wb.branch_id    = $${params.length}::uuid
         )`,
      );
    }
    if (filters.date_from) {
      params.push(filters.date_from);
      conds.push(`c.started_at >= $${params.length}::timestamptz`);
    }
    if (filters.date_to) {
      params.push(filters.date_to);
      conds.push(`c.started_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    if (filters.search && filters.search.trim()) {
      const term = `%${filters.search.trim()}%`;
      params.push(term);
      conds.push(
        `(c.count_no ILIKE $${params.length} OR c.notes ILIKE $${params.length})`,
      );
    }
    // PR-USER-BRANCH-WAREHOUSE-ACCESS — intersect with the caller's
    // allowed warehouses.
    if (filters.allowed_warehouse_ids !== undefined) {
      if (filters.allowed_warehouse_ids.length === 0) {
        conds.push('FALSE');
      } else {
        params.push(filters.allowed_warehouse_ids);
        conds.push(
          `c.warehouse_id = ANY($${params.length}::uuid[])`,
        );
      }
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    return this.ds.query(
      `SELECT c.*,
              w.name        AS warehouse_name,
              u1.full_name  AS started_by_name,
              u2.full_name  AS completed_by_name,
              uc.full_name  AS cancelled_by_name,
              pb.primary_branch AS primary_branch,
              (SELECT COUNT(*)::int FROM inventory_count_items
                WHERE count_id = c.id)                                AS items_total,
              (SELECT COUNT(*)::int FROM inventory_count_items
                WHERE count_id = c.id AND counted_qty IS NOT NULL)    AS items_counted,
              (SELECT COUNT(*)::int FROM inventory_count_items
                WHERE count_id = c.id
                  AND counted_qty IS NOT NULL
                  AND difference <> 0)                                AS items_with_diff,
              (SELECT COALESCE(SUM(GREATEST(difference, 0)), 0)::int
                 FROM inventory_count_items
                WHERE count_id = c.id AND counted_qty IS NOT NULL)    AS positive_diff_qty,
              (SELECT COALESCE(SUM(ABS(LEAST(difference, 0))), 0)::int
                 FROM inventory_count_items
                WHERE count_id = c.id AND counted_qty IS NOT NULL)    AS negative_diff_qty
         FROM inventory_counts c
         LEFT JOIN warehouses w ON w.id  = c.warehouse_id
         LEFT JOIN users u1     ON u1.id = c.started_by
         LEFT JOIN users u2     ON u2.id = c.completed_by
         LEFT JOIN users uc     ON uc.id = c.cancelled_by
         LEFT JOIN LATERAL (
           SELECT jsonb_build_object(
                    'id',      b.id,
                    'code',    b.code,
                    'name_ar', b.name_ar,
                    'name_en', b.name_en,
                    'type',    b.type
                  ) AS primary_branch
             FROM warehouse_branches wb
             JOIN branches b ON b.id = wb.branch_id
            WHERE wb.warehouse_id = c.warehouse_id
              AND wb.is_primary   = TRUE
            LIMIT 1
         ) pb ON TRUE
         ${where}
         ORDER BY c.started_at DESC
         LIMIT 200`,
      params,
    );
  }

  findOne(id: string) {
    return this.findOneTx(this.ds.manager, id);
  }

  private async findOneTx(tx: any, id: string) {
    const [c] = await tx.query(
      `SELECT c.*,
              w.name        AS warehouse_name,
              u1.full_name  AS started_by_name,
              u2.full_name  AS completed_by_name,
              uc.full_name  AS cancelled_by_name,
              pb.primary_branch AS primary_branch
         FROM inventory_counts c
         LEFT JOIN warehouses w ON w.id  = c.warehouse_id
         LEFT JOIN users u1     ON u1.id = c.started_by
         LEFT JOIN users u2     ON u2.id = c.completed_by
         LEFT JOIN users uc     ON uc.id = c.cancelled_by
         LEFT JOIN LATERAL (
           SELECT jsonb_build_object(
                    'id',      b.id,
                    'code',    b.code,
                    'name_ar', b.name_ar,
                    'name_en', b.name_en,
                    'type',    b.type
                  ) AS primary_branch
             FROM warehouse_branches wb
             JOIN branches b ON b.id = wb.branch_id
            WHERE wb.warehouse_id = c.warehouse_id
              AND wb.is_primary   = TRUE
            LIMIT 1
         ) pb ON TRUE
        WHERE c.id = $1`,
      [id],
    );
    if (!c) throw new NotFoundException('الجرد غير موجود');

    const items = await tx.query(
      `SELECT ci.*,
              p.name_ar                                  AS product_name,
              COALESCE(p.sku_root, p.sku_prefix)         AS product_sku,
              pv.sku                                     AS variant_sku,
              pv.barcode::text                           AS barcode,
              pv.color,
              pv.size
         FROM inventory_count_items ci
         JOIN product_variants pv ON pv.id = ci.variant_id
         JOIN products p          ON p.id  = pv.product_id
        WHERE ci.count_id = $1
        ORDER BY p.name_ar, pv.color, pv.size`,
      [id],
    );

    // Linked stock_movements emitted by finalize. Pure SELECT.
    const movements = await tx.query(
      `SELECT sm.id::text             AS id,
              sm.created_at,
              sm.movement_type::text  AS movement_type,
              sm.direction::text      AS direction,
              sm.quantity,
              sm.source_action,
              sm.balance_after_qty,
              sm.warehouse_id,
              w.name                  AS warehouse_name,
              sm.variant_id,
              pv.sku                  AS variant_sku
         FROM stock_movements sm
         LEFT JOIN warehouses w        ON w.id  = sm.warehouse_id
         LEFT JOIN product_variants pv ON pv.id = sm.variant_id
        WHERE sm.reference_type::text = 'inventory_count'
          AND sm.reference_id         = $1
        ORDER BY sm.created_at ASC, sm.id ASC`,
      [id],
    );

    return { ...c, items, movements };
  }
}
