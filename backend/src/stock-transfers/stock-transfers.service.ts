/**
 * stock-transfers.service.ts — PR-STOCK-TRANSFERS-WORKFLOW
 *
 * Branch-aware, partially-receivable stock-transfer lifecycle. The
 * persisted workflow is:
 *
 *   draft ─submit?──► pending ─approve──► approved ──ship──► in_transit
 *     │                  │                   │                  │
 *     ├─edit/cancel ─────┼─edit/cancel ──────┴────────cancel─X (after ship)
 *     │                  │                                       │
 *     │                  │                                       ├─receive (all)─► received
 *     │                  │                                       └─receive (some)─► partially_received ──receive──► received
 *
 *  · `in_transit` is preserved as the legacy storage value so existing
 *    rows continue to parse and the FE keeps its tab/label semantics.
 *    The new statuses (`pending`, `approved`, `partially_received`,
 *    `rejected`) are added by migration 145 via a CHECK relaxation.
 *
 *  · The only `stock_movements` writers in this module are
 *    `fn_adjust_stock_v2` at the ship + receive sites. The function
 *    inserts the movement row and lets `apply_stock_movement`
 *    (migration 143b) own the `stock` UPSERT and the
 *    `balance_after_qty` back-fill. There is NO direct
 *    `INSERT INTO stock` / `UPDATE stock SET …` anywhere in this
 *    file — enforced by the static guardrail in the spec.
 *
 *  · No reconciliation: a partial receive does NOT auto-return the
 *    shortfall to source. Once shipped, the source delta is
 *    permanent for that transfer; the missing units stay "open" at
 *    `partially_received` until either (a) a later receive completes
 *    them or (b) the operator handles the gap via a separate
 *    stock-adjustment workflow.
 *
 *  · Idempotency:
 *      - ship       → status guard rejects re-ship (status moves
 *                     into `in_transit` atomically; second call gets
 *                     400).
 *      - receive    → loads each item's persisted `quantity_received`
 *                     and computes a delta against the request. Delta
 *                     of 0 emits no movement; negative deltas are
 *                     rejected as out of policy.
 *      - approve    → status guard (only `draft|pending`).
 *      - cancel     → status guard (only `draft|pending|approved`).
 *      - create     → idempotent via the HTTP interceptor only (a
 *                     fresh POST without an Idempotency-Key header
 *                     still creates a new draft, by design).
 */
import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CreateTransferDto,
  ReceiveTransferDto,
  UpdateTransferDto,
} from './dto/stock-transfer.dto';

/** Public-facing status values exposed by the API. */
export type TransferStatus =
  | 'draft'
  | 'pending'
  | 'approved'
  | 'in_transit'
  | 'partially_received'
  | 'received'
  | 'cancelled'
  | 'rejected';

/** Statuses where an admin/manager may PATCH the items + notes. */
const EDITABLE_STATUSES: TransferStatus[] = ['draft', 'pending'];

/** Statuses from which `approve` may transition to `approved`. */
const APPROVABLE_STATUSES: TransferStatus[] = ['draft', 'pending'];

/**
 * Statuses from which `ship` may transition to `in_transit`. We keep
 * `draft` here for backward compatibility with the original flow
 * where draft → ship was a single step.
 */
const SHIPPABLE_STATUSES: TransferStatus[] = ['draft', 'pending', 'approved'];

/** Statuses from which `receive` may add stock at the destination. */
const RECEIVABLE_STATUSES: TransferStatus[] = [
  'in_transit',
  'partially_received',
];

/**
 * Statuses from which `cancel` is allowed. Once a transfer is in the
 * `in_transit | partially_received | received | cancelled | rejected`
 * family, cancel is forbidden — a separate reversal workflow would
 * be needed to undo the shipped stock leg.
 */
const CANCELLABLE_STATUSES: TransferStatus[] = ['draft', 'pending', 'approved'];

interface ListFilters {
  status?: string;
  warehouse_id?: string;
  from_warehouse_id?: string;
  to_warehouse_id?: string;
  from_branch_id?: string;
  to_branch_id?: string;
  date_from?: string;
  date_to?: string;
  search?: string;
  /**
   * PR-USER-BRANCH-WAREHOUSE-ACCESS — allow-list of warehouse_ids
   * the calling user is permitted to see. The controller fills this
   * from AccessScopeService. `undefined` = no restriction. Empty
   * array yields zero rows. The filter matches transfers where
   * EITHER side (from / to) intersects the allow-list — so a
   * warehouse-operator sees inbound shipments too.
   */
  allowed_warehouse_ids?: string[];
}

@Injectable()
export class StockTransfersService {
  constructor(private readonly ds: DataSource) {}

  /** Generate TRF-YYYY-NNNNN. */
  private async nextTransferNo(): Promise<string> {
    const year = new Date().getFullYear();
    const [{ max }] = await this.ds.query(
      `SELECT COALESCE(MAX(SUBSTRING(transfer_no FROM 'TRF-[0-9]+-([0-9]+)')::int), 0) AS max
         FROM stock_transfers
        WHERE transfer_no LIKE 'TRF-' || $1 || '-%'`,
      [year],
    );
    return `TRF-${year}-${String(Number(max) + 1).padStart(5, '0')}`;
  }

  // ─── CREATE ───────────────────────────────────────────────────────
  /**
   * Create a draft transfer + its items. No stock_movements emitted
   * at this stage — the ship endpoint owns that side-effect.
   */
  async create(dto: CreateTransferDto, userId: string) {
    if (dto.from_warehouse_id === dto.to_warehouse_id) {
      throw new BadRequestException('المخزن المصدر والوجهة لا يجب أن يتطابقا');
    }
    await this.assertWarehousesActive(
      dto.from_warehouse_id,
      dto.to_warehouse_id,
    );
    const transferNo = await this.nextTransferNo();

    return this.ds.transaction(async (tx) => {
      const [transfer] = await tx.query(
        `INSERT INTO stock_transfers
           (transfer_no, from_warehouse_id, to_warehouse_id, status, notes, requested_by)
         VALUES ($1, $2, $3, 'draft', $4, $5)
         RETURNING *`,
        [
          transferNo,
          dto.from_warehouse_id,
          dto.to_warehouse_id,
          dto.notes ?? null,
          userId,
        ],
      );

      for (const it of dto.items) {
        await tx.query(
          `INSERT INTO stock_transfer_items
             (transfer_id, variant_id, quantity_requested, notes)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (transfer_id, variant_id)
           DO UPDATE SET quantity_requested =
             stock_transfer_items.quantity_requested + EXCLUDED.quantity_requested`,
          [transfer.id, it.variant_id, it.quantity_requested, it.notes ?? null],
        );
      }

      return this.findOneTx(tx, transfer.id);
    });
  }

  // ─── UPDATE (draft/pending) ──────────────────────────────────────
  /**
   * Patch a draft/pending transfer's notes and replace its items.
   * Items pass the same `from != to` and positive-qty checks as
   * create. No stock writes — this is purely the operator amending
   * the request before it's approved/shipped.
   */
  async update(id: string, dto: UpdateTransferDto, _userId: string) {
    return this.ds.transaction(async (tx) => {
      const [t] = await tx.query(
        `SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!t) throw new NotFoundException('التحويل غير موجود');
      if (!EDITABLE_STATUSES.includes(t.status as TransferStatus)) {
        throw new BadRequestException(
          `لا يمكن تعديل تحويل بالحالة: ${t.status}`,
        );
      }

      // Warehouse swap is allowed (still pre-ship) but must respect
      // the same active/from!=to invariants as create.
      const fromWh = dto.from_warehouse_id ?? t.from_warehouse_id;
      const toWh = dto.to_warehouse_id ?? t.to_warehouse_id;
      if (fromWh === toWh) {
        throw new BadRequestException(
          'المخزن المصدر والوجهة لا يجب أن يتطابقا',
        );
      }
      await this.assertWarehousesActive(fromWh, toWh);

      const sets: string[] = [];
      const params: any[] = [];
      if (dto.from_warehouse_id !== undefined) {
        params.push(dto.from_warehouse_id);
        sets.push(`from_warehouse_id = $${params.length}::uuid`);
      }
      if (dto.to_warehouse_id !== undefined) {
        params.push(dto.to_warehouse_id);
        sets.push(`to_warehouse_id = $${params.length}::uuid`);
      }
      if (dto.notes !== undefined) {
        params.push(dto.notes);
        sets.push(`notes = $${params.length}`);
      }
      if (dto.status !== undefined) {
        if (!EDITABLE_STATUSES.includes(dto.status as TransferStatus)) {
          throw new BadRequestException(
            'يمكن فقط نقل الحالة بين draft و pending',
          );
        }
        params.push(dto.status);
        sets.push(`status = $${params.length}`);
      }
      sets.push(`updated_at = NOW()`);
      params.push(id);

      await tx.query(
        `UPDATE stock_transfers SET ${sets.join(', ')} WHERE id = $${params.length}`,
        params,
      );

      if (dto.items) {
        // Replace items: delete the existing rows and re-insert. Safe
        // because no movements reference these item rows yet (ship
        // hasn't happened — status is draft|pending).
        await tx.query(
          `DELETE FROM stock_transfer_items WHERE transfer_id = $1`,
          [id],
        );
        for (const it of dto.items) {
          await tx.query(
            `INSERT INTO stock_transfer_items
               (transfer_id, variant_id, quantity_requested, notes)
             VALUES ($1, $2, $3, $4)`,
            [id, it.variant_id, it.quantity_requested, it.notes ?? null],
          );
        }
      }

      return this.findOneTx(tx, id);
    });
  }

  // ─── APPROVE ─────────────────────────────────────────────────────
  /**
   * Promote a draft|pending transfer to `approved`. No stock writes.
   * Idempotent via the status guard: a second approve call on an
   * already-approved row raises 400.
   */
  async approve(id: string, userId: string) {
    return this.ds.transaction(async (tx) => {
      const [t] = await tx.query(
        `SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!t) throw new NotFoundException('التحويل غير موجود');
      if (!APPROVABLE_STATUSES.includes(t.status as TransferStatus)) {
        throw new ConflictException(
          `لا يمكن اعتماد تحويل بالحالة: ${t.status}`,
        );
      }
      const itemCount = await tx.query(
        `SELECT COUNT(*)::int AS n FROM stock_transfer_items WHERE transfer_id = $1`,
        [id],
      );
      if (Number(itemCount[0]?.n ?? 0) === 0) {
        throw new BadRequestException('لا توجد عناصر في هذا التحويل');
      }
      await tx.query(
        `UPDATE stock_transfers SET
           status      = 'approved',
           approved_by = $1,
           approved_at = NOW(),
           updated_at  = NOW()
         WHERE id = $2`,
        [userId, id],
      );
      return this.findOneTx(tx, id);
    });
  }

  // ─── SHIP ────────────────────────────────────────────────────────
  /**
   * Deduct the requested quantities from the source warehouse and
   * mark the transfer as `in_transit`. The legacy flow allowed
   * draft → ship directly; that's preserved by accepting any of
   * `draft|pending|approved` as the source state.
   *
   * Stock side-effect: one fn_adjust_stock_v2 call per item with
   *   reference_type = 'stock_transfer'
   *   reference_id   = transfer.id
   *   source_module  = 'stock_transfers'
   *   source_action  = 'ship'
   *   movement_type  = 'transfer_out'
   *   direction      = out (delta < 0)
   */
  async ship(id: string, userId: string) {
    return this.ds.transaction(async (tx) => {
      const [t] = await tx.query(
        `SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!t) throw new NotFoundException('التحويل غير موجود');
      if (!SHIPPABLE_STATUSES.includes(t.status as TransferStatus)) {
        // Repeated ship hits this branch — second call sees status
        // already `in_transit` (or beyond) and bails. No stock motion.
        throw new ConflictException(`لا يمكن شحن تحويل بالحالة: ${t.status}`);
      }

      const items = await tx.query(
        `SELECT * FROM stock_transfer_items WHERE transfer_id = $1`,
        [id],
      );
      if (items.length === 0) {
        throw new BadRequestException('لا توجد عناصر في هذا التحويل');
      }

      // Availability check against v_stock_unified (the canonical
      // read view added by migration 143b). Available is on-hand
      // minus reserved; we deduct from the on-hand bucket so a stock
      // line with reserved > 0 may legitimately fail here.
      for (const it of items) {
        const [stock] = await tx.query(
          `SELECT quantity_on_hand
             FROM v_stock_unified
            WHERE variant_id = $1 AND warehouse_id = $2`,
          [it.variant_id, t.from_warehouse_id],
        );
        const onHand = Number(stock?.quantity_on_hand ?? 0);
        if (onHand < it.quantity_requested) {
          throw new BadRequestException(
            `رصيد غير كافٍ للصنف ${it.variant_id}: المتاح ${onHand} / المطلوب ${it.quantity_requested}`,
          );
        }
      }

      for (const it of items) {
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
            t.from_warehouse_id,
            -Number(it.quantity_requested),
            `TRANSFER_OUT:${t.transfer_no}`,
            'stock_transfer',
            t.id,
            null,
            userId,
            'stock_transfers',
            'ship',
            'transfer_out',
          ],
        );
      }

      await tx.query(
        `UPDATE stock_transfers SET
           status      = 'in_transit',
           approved_by = COALESCE(approved_by, $1),
           approved_at = COALESCE(approved_at, NOW()),
           shipped_at  = NOW(),
           updated_at  = NOW()
         WHERE id = $2`,
        [userId, id],
      );

      return this.findOneTx(tx, id);
    });
  }

  // ─── RECEIVE (idempotent, partial-aware) ─────────────────────────
  /**
   * Record receipts at the destination warehouse. For each item the
   * request supplies an absolute (cumulative) `quantity_received`
   * value; this method computes the delta against the persisted
   * value and only adjusts stock by that delta. A duplicate request
   * with the same quantities therefore writes zero movements.
   *
   *   delta = new_qty − persisted_qty
   *     · delta > 0     → emit one fn_adjust_stock_v2(+delta) into
   *                       the destination warehouse, update item row.
   *     · delta == 0    → no-op (idempotent re-submission).
   *     · delta < 0     → 400 (stock_movements is append-only;
   *                       reducing a receipt is not in scope and
   *                       would require a reversal workflow).
   *
   * After processing all items the transfer status flips to
   * `partially_received` (some item still short of its requested
   * quantity) or `received` (every item at quantity_requested).
   */
  async receive(id: string, dto: ReceiveTransferDto, userId: string) {
    return this.ds.transaction(async (tx) => {
      const [t] = await tx.query(
        `SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!t) throw new NotFoundException('التحويل غير موجود');
      if (!RECEIVABLE_STATUSES.includes(t.status as TransferStatus)) {
        throw new ConflictException(
          `لا يمكن استلام تحويل بالحالة: ${t.status}`,
        );
      }

      const items = await tx.query(
        `SELECT * FROM stock_transfer_items WHERE transfer_id = $1 FOR UPDATE`,
        [id],
      );
      const byId = new Map(items.map((i: any) => [i.id, i]));

      // Validate every payload row before writing anything. We want
      // the whole receive to fail atomically if even one item is bad.
      for (const r of dto.items) {
        const it = byId.get(r.item_id) as any;
        if (!it) {
          throw new BadRequestException(`عنصر غير موجود: ${r.item_id}`);
        }
        const newQty = Number(r.quantity_received);
        const persistedQty = Number(it.quantity_received) || 0;
        const requested = Number(it.quantity_requested) || 0;
        if (newQty < 0) {
          throw new BadRequestException(
            `الكمية المستلمة يجب أن تكون 0 أو أكبر للصنف ${it.variant_id}`,
          );
        }
        if (newQty > requested) {
          throw new BadRequestException(
            `الكمية المستلمة أكبر من المطلوبة للصنف ${it.variant_id}`,
          );
        }
        if (newQty < persistedQty) {
          // Idempotent floor: we never reduce a receipt. The caller
          // can re-send the same quantity (delta=0) without issue,
          // but going backwards would require a separate reversal
          // workflow that this PR does not implement.
          throw new BadRequestException(
            `لا يمكن تخفيض الكمية المستلمة للصنف ${it.variant_id} (${persistedQty} → ${newQty})`,
          );
        }
      }

      for (const r of dto.items) {
        const it = byId.get(r.item_id) as any;
        const newQty = Number(r.quantity_received);
        const persistedQty = Number(it.quantity_received) || 0;
        const delta = newQty - persistedQty;
        if (delta === 0) continue; // idempotent no-op

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
            t.to_warehouse_id,
            delta,
            `TRANSFER_IN:${t.transfer_no}`,
            'stock_transfer',
            t.id,
            null,
            userId,
            'stock_transfers',
            'receive',
            'transfer_in',
          ],
        );
        await tx.query(
          `UPDATE stock_transfer_items
              SET quantity_received = $1
            WHERE id = $2`,
          [newQty, r.item_id],
        );
      }

      // Recompute the rollup status from the resulting item rows.
      const after = await tx.query(
        `SELECT quantity_requested, quantity_received
           FROM stock_transfer_items
          WHERE transfer_id = $1`,
        [id],
      );
      const allFull = after.every(
        (r: any) => Number(r.quantity_received) >= Number(r.quantity_requested),
      );
      const newStatus: TransferStatus = allFull
        ? 'received'
        : 'partially_received';

      await tx.query(
        `UPDATE stock_transfers SET
           status      = $1,
           received_by = CASE WHEN $1 = 'received' THEN $2 ELSE received_by END,
           received_at = CASE WHEN $1 = 'received' THEN NOW() ELSE received_at END,
           notes       = COALESCE($3, notes),
           updated_at  = NOW()
         WHERE id = $4`,
        [newStatus, userId, dto.notes ?? null, id],
      );

      return this.findOneTx(tx, id);
    });
  }

  // ─── CANCEL (pre-ship only) ──────────────────────────────────────
  /**
   * Cancel a transfer that has not been shipped yet. Once a transfer
   * has been shipped (status ∈ in_transit | partially_received |
   * received) a manual reversal workflow is required — this method
   * refuses to invent stock movements.
   *
   * Idempotent: the status guard rejects re-cancelling.
   */
  async cancel(id: string, userId: string) {
    return this.ds.transaction(async (tx) => {
      const [t] = await tx.query(
        `SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!t) throw new NotFoundException('التحويل غير موجود');
      if (!CANCELLABLE_STATUSES.includes(t.status as TransferStatus)) {
        throw new ConflictException(
          `لا يمكن إلغاء تحويل بالحالة: ${t.status} — يلزم إجراء مرتجع/تسوية يدوي`,
        );
      }
      await tx.query(
        `UPDATE stock_transfers SET
           status       = 'cancelled',
           cancelled_by = $1,
           cancelled_at = NOW(),
           updated_at   = NOW()
         WHERE id = $2`,
        [userId, id],
      );
      return this.findOneTx(tx, id);
    });
  }

  // ─── LIST ────────────────────────────────────────────────────────
  async list(filters: ListFilters = {}) {
    const conds: string[] = [];
    const params: any[] = [];
    const push = (cond: string, ...vals: any[]) => {
      for (const v of vals) params.push(v);
      conds.push(cond);
    };

    if (filters.status) {
      params.push(filters.status);
      conds.push(`t.status = $${params.length}`);
    }
    if (filters.warehouse_id) {
      params.push(filters.warehouse_id);
      conds.push(
        `(t.from_warehouse_id = $${params.length} OR t.to_warehouse_id = $${params.length})`,
      );
    }
    if (filters.from_warehouse_id) {
      params.push(filters.from_warehouse_id);
      conds.push(`t.from_warehouse_id = $${params.length}::uuid`);
    }
    if (filters.to_warehouse_id) {
      params.push(filters.to_warehouse_id);
      conds.push(`t.to_warehouse_id = $${params.length}::uuid`);
    }
    // PR-STOCK-TRANSFERS-WORKFLOW — branch filters via EXISTS over
    // `warehouse_branches`. EXISTS keeps the row count stable when a
    // warehouse is linked to multiple branches.
    if (filters.from_branch_id) {
      params.push(filters.from_branch_id);
      push(
        `EXISTS (
           SELECT 1 FROM warehouse_branches wb_f
            WHERE wb_f.warehouse_id = t.from_warehouse_id
              AND wb_f.branch_id    = $${params.length}::uuid
         )`,
      );
    }
    if (filters.to_branch_id) {
      params.push(filters.to_branch_id);
      push(
        `EXISTS (
           SELECT 1 FROM warehouse_branches wb_t
            WHERE wb_t.warehouse_id = t.to_warehouse_id
              AND wb_t.branch_id    = $${params.length}::uuid
         )`,
      );
    }
    if (filters.date_from) {
      params.push(filters.date_from);
      conds.push(`t.created_at >= $${params.length}::timestamptz`);
    }
    if (filters.date_to) {
      params.push(filters.date_to);
      conds.push(
        `t.created_at < ($${params.length}::date + INTERVAL '1 day')`,
      );
    }
    if (filters.search && filters.search.trim()) {
      const term = `%${filters.search.trim()}%`;
      params.push(term);
      conds.push(
        `(t.transfer_no ILIKE $${params.length} OR t.notes ILIKE $${params.length})`,
      );
    }
    // PR-USER-BRANCH-WAREHOUSE-ACCESS — intersect with the caller's
    // allowed warehouses. A transfer is visible if EITHER its source
    // OR its destination is in the allow-list (a warehouse-operator
    // should see inbound shipments as well as outbound).
    if (filters.allowed_warehouse_ids !== undefined) {
      if (filters.allowed_warehouse_ids.length === 0) {
        conds.push('FALSE');
      } else {
        params.push(filters.allowed_warehouse_ids);
        conds.push(
          `(t.from_warehouse_id = ANY($${params.length}::uuid[]) OR t.to_warehouse_id = ANY($${params.length}::uuid[]))`,
        );
      }
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    // Branch roll-up: the LATERAL sub-query returns a single jsonb
    // object per warehouse representing its primary branch — no row
    // multiplication if a warehouse is linked to multiple branches.
    return this.ds.query(
      `SELECT t.*,
              wf.name      AS from_warehouse_name,
              wt.name      AS to_warehouse_name,
              ur.full_name AS requested_by_name,
              ua.full_name AS approved_by_name,
              urc.full_name AS received_by_name,
              uc.full_name  AS cancelled_by_name,
              fpb.primary_branch AS from_primary_branch,
              tpb.primary_branch AS to_primary_branch,
              (SELECT COUNT(*)::int FROM stock_transfer_items
                WHERE transfer_id = t.id)                          AS items_count,
              (SELECT COALESCE(SUM(quantity_requested), 0)::int FROM stock_transfer_items
                WHERE transfer_id = t.id)                          AS total_qty_requested,
              (SELECT COALESCE(SUM(quantity_received), 0)::int FROM stock_transfer_items
                WHERE transfer_id = t.id)                          AS total_qty_received
         FROM stock_transfers t
         LEFT JOIN warehouses wf  ON wf.id  = t.from_warehouse_id
         LEFT JOIN warehouses wt  ON wt.id  = t.to_warehouse_id
         LEFT JOIN users ur       ON ur.id  = t.requested_by
         LEFT JOIN users ua       ON ua.id  = t.approved_by
         LEFT JOIN users urc      ON urc.id = t.received_by
         LEFT JOIN users uc       ON uc.id  = t.cancelled_by
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
            WHERE wb.warehouse_id = t.from_warehouse_id
              AND wb.is_primary   = TRUE
            LIMIT 1
         ) fpb ON TRUE
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
            WHERE wb.warehouse_id = t.to_warehouse_id
              AND wb.is_primary   = TRUE
            LIMIT 1
         ) tpb ON TRUE
         ${where}
         ORDER BY t.created_at DESC
         LIMIT 200`,
      params,
    );
  }

  // ─── DETAIL ──────────────────────────────────────────────────────
  async findOne(id: string) {
    return this.findOneTx(this.ds.manager, id);
  }

  private async findOneTx(tx: any, id: string) {
    const [t] = await tx.query(
      `SELECT t.*,
              wf.name      AS from_warehouse_name,
              wt.name      AS to_warehouse_name,
              ur.full_name AS requested_by_name,
              ua.full_name AS approved_by_name,
              urc.full_name AS received_by_name,
              uc.full_name  AS cancelled_by_name,
              fpb.primary_branch AS from_primary_branch,
              tpb.primary_branch AS to_primary_branch
         FROM stock_transfers t
         LEFT JOIN warehouses wf  ON wf.id  = t.from_warehouse_id
         LEFT JOIN warehouses wt  ON wt.id  = t.to_warehouse_id
         LEFT JOIN users ur       ON ur.id  = t.requested_by
         LEFT JOIN users ua       ON ua.id  = t.approved_by
         LEFT JOIN users urc      ON urc.id = t.received_by
         LEFT JOIN users uc       ON uc.id  = t.cancelled_by
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
            WHERE wb.warehouse_id = t.from_warehouse_id
              AND wb.is_primary   = TRUE
            LIMIT 1
         ) fpb ON TRUE
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
            WHERE wb.warehouse_id = t.to_warehouse_id
              AND wb.is_primary   = TRUE
            LIMIT 1
         ) tpb ON TRUE
        WHERE t.id = $1`,
      [id],
    );
    if (!t) throw new NotFoundException('التحويل غير موجود');

    const items = await tx.query(
      `SELECT ti.*,
              p.name       AS product_name,
              p.sku        AS product_sku,
              pv.sku       AS variant_sku,
              pv.color,
              pv.size
         FROM stock_transfer_items ti
         JOIN product_variants pv ON pv.id = ti.variant_id
         JOIN products p          ON p.id  = pv.product_id
        WHERE ti.transfer_id = $1
        ORDER BY p.name`,
      [id],
    );

    // Read-only roll-up of the stock_movements that ship + receive
    // produced for this transfer. The FE renders these as the
    // "movement references" trail. Pure SELECT; no writes.
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
        WHERE sm.reference_type::text = 'stock_transfer'
          AND sm.reference_id         = $1
        ORDER BY sm.created_at ASC, sm.id ASC`,
      [id],
    );

    return { ...t, items, movements };
  }

  // ─── Helpers ─────────────────────────────────────────────────────
  private async assertWarehousesActive(fromId: string, toId: string) {
    const rows = await this.ds.query(
      `SELECT id, is_active FROM warehouses WHERE id = ANY($1::uuid[])`,
      [[fromId, toId]],
    );
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    const from = byId.get(fromId) as any;
    const to = byId.get(toId) as any;
    if (!from) throw new BadRequestException('المخزن المصدر غير موجود');
    if (!to) throw new BadRequestException('المخزن الوجهة غير موجود');
    if (!from.is_active) {
      throw new BadRequestException('المخزن المصدر غير نشط');
    }
    if (!to.is_active) {
      throw new BadRequestException('المخزن الوجهة غير نشط');
    }
  }
}
