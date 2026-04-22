import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  StartCountDto,
  SubmitCountDto,
  FinalizeCountDto,
} from './dto/inventory-count.dto';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';

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
       FROM inventory_counts WHERE count_no LIKE 'CNT-' || $1 || '-%'`,
      [year],
    );
    return `CNT-${year}-${String(Number(max) + 1).padStart(5, '0')}`;
  }

  /**
   * Start a new inventory count. Freezes current stock quantities in
   * inventory_count_items as system_qty.
   */
  async start(dto: StartCountDto, userId: string) {
    const countNo = await this.nextCountNo();

    return this.ds.transaction(async (tx) => {
      const [count] = await tx.query(
        `
        INSERT INTO inventory_counts
          (count_no, warehouse_id, status, started_by, notes)
        VALUES ($1,$2,'in_progress',$3,$4)
        RETURNING *
        `,
        [countNo, dto.warehouse_id, userId, dto.notes ?? null],
      );

      // Snapshot current stock
      let snapshotSQL: string;
      const params: any[] = [count.id, dto.warehouse_id];
      if (dto.variant_ids && dto.variant_ids.length > 0) {
        params.push(dto.variant_ids);
        snapshotSQL = `
          INSERT INTO inventory_count_items (count_id, variant_id, system_qty)
          SELECT $1, sl.variant_id, COALESCE(sl.quantity_on_hand, sl.quantity, 0)
          FROM stock sl
          WHERE sl.warehouse_id = $2
            AND sl.variant_id = ANY($3::uuid[])
        `;
      } else {
        snapshotSQL = `
          INSERT INTO inventory_count_items (count_id, variant_id, system_qty)
          SELECT $1, sl.variant_id, COALESCE(sl.quantity_on_hand, sl.quantity, 0)
          FROM stock sl
          WHERE sl.warehouse_id = $2
            AND COALESCE(sl.quantity_on_hand, sl.quantity, 0) > 0
        `;
      }
      await tx.query(snapshotSQL, params);

      return this.findOneTx(tx, count.id);
    });
  }

  async submitEntries(id: string, dto: SubmitCountDto) {
    return this.ds.transaction(async (tx) => {
      const [c] = await tx.query(
        `SELECT * FROM inventory_counts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!c) throw new NotFoundException('الجرد غير موجود');
      if (c.status !== 'in_progress') {
        throw new BadRequestException('الجرد مغلق بالفعل');
      }

      for (const e of dto.items) {
        const res = await tx.query(
          `UPDATE inventory_count_items SET
             counted_qty = $1,
             notes = COALESCE($2, notes)
           WHERE id = $3 AND count_id = $4
           RETURNING id`,
          [e.counted_qty, e.notes ?? null, e.item_id, id],
        );
        if (!res || res.length === 0) {
          throw new BadRequestException(`عنصر غير موجود: ${e.item_id}`);
        }
      }

      return this.findOneTx(tx, id);
    });
  }

  /**
   * Finalize (Apply): marks count as completed and creates stock_adjustments
   * to reconcile differences via fn_adjust_stock.
   */
  async finalize(id: string, dto: FinalizeCountDto, userId: string) {
    return this.ds.transaction(async (tx) => {
      const [c] = await tx.query(
        `SELECT * FROM inventory_counts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!c) throw new NotFoundException('الجرد غير موجود');
      if (c.status !== 'in_progress') {
        throw new BadRequestException('الجرد مغلق بالفعل');
      }

      const items = await tx.query(
        `SELECT * FROM inventory_count_items WHERE count_id = $1`,
        [id],
      );

      const withDiff = items.filter(
        (i: any) => i.counted_qty !== null && Number(i.difference) !== 0,
      );

      let netValue = 0; // + = overage, - = shortage
      if (withDiff.length > 0) {
        for (const it of withDiff) {
          await tx.query(`SELECT fn_adjust_stock($1,$2,$3,$4,$5,$6)`, [
            it.variant_id,
            c.warehouse_id,
            Number(it.difference),
            `INVENTORY_COUNT:${c.count_no}`,
            null,
            userId,
          ]);
          // Value the delta at the variant's cost price for GL.
          const [cp] = await tx.query(
            `SELECT COALESCE(cost_price, 0)::numeric(14,2) AS cp
               FROM product_variants WHERE id = $1`,
            [it.variant_id],
          );
          netValue += Number(cp?.cp || 0) * Number(it.difference);
        }
      }

      await tx.query(
        `UPDATE inventory_counts SET
           status = 'completed',
           completed_by = $1,
           completed_at = NOW(),
           notes = COALESCE($2, notes)
         WHERE id = $3`,
        [userId, dto.notes ?? null, id],
      );

      // Post the net value to the GL (shortage → shrinkage, overage → revenue).
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

  async cancel(id: string) {
    const [c] = await this.ds.query(
      `SELECT * FROM inventory_counts WHERE id = $1`,
      [id],
    );
    if (!c) throw new NotFoundException('الجرد غير موجود');
    if (c.status !== 'in_progress') {
      throw new BadRequestException('الجرد مغلق بالفعل');
    }
    await this.ds.query(
      `UPDATE inventory_counts SET status = 'cancelled' WHERE id = $1`,
      [id],
    );
    return { id, status: 'cancelled' };
  }

  list(status?: string, warehouseId?: string) {
    const conds: string[] = [];
    const params: any[] = [];
    if (status) {
      params.push(status);
      conds.push(`c.status = $${params.length}`);
    }
    if (warehouseId) {
      params.push(warehouseId);
      conds.push(`c.warehouse_id = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return this.ds.query(
      `
      SELECT c.*,
        w.name AS warehouse_name,
        u1.full_name AS started_by_name,
        u2.full_name AS completed_by_name,
        (SELECT COUNT(*) FROM inventory_count_items WHERE count_id = c.id)::int AS items_total,
        (SELECT COUNT(*) FROM inventory_count_items WHERE count_id = c.id AND counted_qty IS NOT NULL)::int AS items_counted,
        (SELECT COUNT(*) FROM inventory_count_items WHERE count_id = c.id AND counted_qty IS NOT NULL AND difference <> 0)::int AS items_with_diff,
        (SELECT COALESCE(SUM(ABS(difference)),0)::int FROM inventory_count_items WHERE count_id = c.id AND counted_qty IS NOT NULL) AS total_abs_diff
      FROM inventory_counts c
      LEFT JOIN warehouses w ON w.id = c.warehouse_id
      LEFT JOIN users u1 ON u1.id = c.started_by
      LEFT JOIN users u2 ON u2.id = c.completed_by
      ${where}
      ORDER BY c.started_at DESC
      LIMIT 200
      `,
      params,
    );
  }

  findOne(id: string) {
    return this.findOneTx(this.ds.manager, id);
  }

  private async findOneTx(tx: any, id: string) {
    const [c] = await tx.query(
      `
      SELECT c.*,
        w.name AS warehouse_name,
        u1.full_name AS started_by_name,
        u2.full_name AS completed_by_name
      FROM inventory_counts c
      LEFT JOIN warehouses w ON w.id = c.warehouse_id
      LEFT JOIN users u1 ON u1.id = c.started_by
      LEFT JOIN users u2 ON u2.id = c.completed_by
      WHERE c.id = $1
      `,
      [id],
    );
    if (!c) throw new NotFoundException('الجرد غير موجود');

    const items = await tx.query(
      `
      SELECT ci.*,
        p.name_ar AS product_name,
        COALESCE(p.sku_root, p.sku_prefix) AS product_sku,
        pv.sku AS variant_sku,
        pv.color,
        pv.size
      FROM inventory_count_items ci
      JOIN product_variants pv ON pv.id = ci.variant_id
      JOIN products p ON p.id = pv.product_id
      WHERE ci.count_id = $1
      ORDER BY p.name_ar, pv.color, pv.size
      `,
      [id],
    );
    return { ...c, items };
  }
}
