import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CreateTransferDto,
  ReceiveTransferDto,
} from './dto/stock-transfer.dto';

@Injectable()
export class StockTransfersService {
  constructor(private readonly ds: DataSource) {}

  /** Generate TRF-YYYY-NNNNN */
  private async nextTransferNo(): Promise<string> {
    const year = new Date().getFullYear();
    const [{ max }] = await this.ds.query(
      `SELECT COALESCE(MAX(SUBSTRING(transfer_no FROM 'TRF-[0-9]+-([0-9]+)')::int), 0) AS max
       FROM stock_transfers WHERE transfer_no LIKE 'TRF-' || $1 || '-%'`,
      [year],
    );
    return `TRF-${year}-${String(Number(max) + 1).padStart(5, '0')}`;
  }

  async create(dto: CreateTransferDto, userId: string) {
    if (dto.from_warehouse_id === dto.to_warehouse_id) {
      throw new BadRequestException('المخزن المصدر والوجهة لا يجب أن يتطابقا');
    }
    const transferNo = await this.nextTransferNo();

    return this.ds.transaction(async (tx) => {
      const [transfer] = await tx.query(
        `
        INSERT INTO stock_transfers
          (transfer_no, from_warehouse_id, to_warehouse_id, status, notes, requested_by)
        VALUES ($1,$2,$3,'draft',$4,$5)
        RETURNING *
        `,
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
          `
          INSERT INTO stock_transfer_items
            (transfer_id, variant_id, quantity_requested, notes)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT (transfer_id, variant_id)
          DO UPDATE SET quantity_requested =
            stock_transfer_items.quantity_requested + EXCLUDED.quantity_requested
          `,
          [transfer.id, it.variant_id, it.quantity_requested, it.notes ?? null],
        );
      }

      return this.findOneTx(tx, transfer.id);
    });
  }

  /**
   * Approve + Ship: move status draft → in_transit
   * Deducts stock from from_warehouse using fn_adjust_stock
   */
  async ship(id: string, userId: string) {
    return this.ds.transaction(async (tx) => {
      const [t] = await tx.query(
        `SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!t) throw new NotFoundException('التحويل غير موجود');
      if (t.status !== 'draft') {
        throw new BadRequestException(
          `لا يمكن شحن تحويل بالحالة: ${t.status}`,
        );
      }

      const items = await tx.query(
        `SELECT * FROM stock_transfer_items WHERE transfer_id = $1`,
        [id],
      );
      if (items.length === 0) {
        throw new BadRequestException('لا توجد عناصر في هذا التحويل');
      }

      // Check availability
      for (const it of items) {
        const [stock] = await tx.query(
          `SELECT quantity FROM stock_levels
           WHERE variant_id = $1 AND warehouse_id = $2`,
          [it.variant_id, t.from_warehouse_id],
        );
        const available = Number(stock?.quantity ?? 0);
        if (available < it.quantity_requested) {
          throw new BadRequestException(
            `رصيد غير كافٍ للصنف ${it.variant_id}: المتاح ${available} / المطلوب ${it.quantity_requested}`,
          );
        }
      }

      // Deduct from from_warehouse
      for (const it of items) {
        await tx.query(`SELECT fn_adjust_stock($1,$2,$3,$4,$5,$6)`, [
          it.variant_id,
          t.from_warehouse_id,
          -Number(it.quantity_requested),
          `TRANSFER_OUT:${t.transfer_no}`,
          null,
          userId,
        ]);
      }

      await tx.query(
        `
        UPDATE stock_transfers SET
          status = 'in_transit',
          approved_by = $1,
          shipped_at = NOW(),
          updated_at = NOW()
        WHERE id = $2
        `,
        [userId, id],
      );

      return this.findOneTx(tx, id);
    });
  }

  /**
   * Receive at to_warehouse: in_transit → received
   * Adds quantity_received to to_warehouse via fn_adjust_stock.
   * If received < requested, the difference is returned to from_warehouse (short-ship).
   */
  async receive(id: string, dto: ReceiveTransferDto, userId: string) {
    return this.ds.transaction(async (tx) => {
      const [t] = await tx.query(
        `SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!t) throw new NotFoundException('التحويل غير موجود');
      if (t.status !== 'in_transit') {
        throw new BadRequestException(
          `لا يمكن استلام تحويل بالحالة: ${t.status}`,
        );
      }

      const items = await tx.query(
        `SELECT * FROM stock_transfer_items WHERE transfer_id = $1`,
        [id],
      );

      const map = new Map(items.map((i: any) => [i.id, i]));

      for (const r of dto.items) {
        const it = map.get(r.item_id) as any;
        if (!it) {
          throw new BadRequestException(`عنصر غير موجود: ${r.item_id}`);
        }
        const qtyReq = Number(it.quantity_requested);
        const qtyRec = Number(r.quantity_received);
        if (qtyRec > qtyReq) {
          throw new BadRequestException(
            `الكمية المستلمة أكبر من المطلوبة للصنف ${it.variant_id}`,
          );
        }

        // Add received qty to destination
        if (qtyRec > 0) {
          await tx.query(`SELECT fn_adjust_stock($1,$2,$3,$4,$5,$6)`, [
            it.variant_id,
            t.to_warehouse_id,
            qtyRec,
            `TRANSFER_IN:${t.transfer_no}`,
            null,
            userId,
          ]);
        }

        // Return the shortfall back to origin
        const shortfall = qtyReq - qtyRec;
        if (shortfall > 0) {
          await tx.query(`SELECT fn_adjust_stock($1,$2,$3,$4,$5,$6)`, [
            it.variant_id,
            t.from_warehouse_id,
            shortfall,
            `TRANSFER_RETURN:${t.transfer_no}`,
            null,
            userId,
          ]);
        }

        await tx.query(
          `UPDATE stock_transfer_items SET quantity_received = $1 WHERE id = $2`,
          [qtyRec, r.item_id],
        );
      }

      await tx.query(
        `
        UPDATE stock_transfers SET
          status = 'received',
          received_by = $1,
          received_at = NOW(),
          notes = COALESCE($2, notes),
          updated_at = NOW()
        WHERE id = $3
        `,
        [userId, dto.notes ?? null, id],
      );

      return this.findOneTx(tx, id);
    });
  }

  /**
   * Cancel transfer:
   *   - draft → just cancel
   *   - in_transit → rollback stock to from_warehouse
   *   - received → forbidden
   */
  async cancel(id: string, userId: string) {
    return this.ds.transaction(async (tx) => {
      const [t] = await tx.query(
        `SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!t) throw new NotFoundException('التحويل غير موجود');
      if (t.status === 'received') {
        throw new BadRequestException('لا يمكن إلغاء تحويل تم استلامه');
      }
      if (t.status === 'cancelled') {
        throw new BadRequestException('التحويل ملغى بالفعل');
      }

      if (t.status === 'in_transit') {
        // Rollback: put everything back in from_warehouse
        const items = await tx.query(
          `SELECT * FROM stock_transfer_items WHERE transfer_id = $1`,
          [id],
        );
        for (const it of items) {
          await tx.query(`SELECT fn_adjust_stock($1,$2,$3,$4,$5,$6)`, [
            it.variant_id,
            t.from_warehouse_id,
            Number(it.quantity_requested),
            `TRANSFER_CANCEL:${t.transfer_no}`,
            null,
            userId,
          ]);
        }
      }

      await tx.query(
        `UPDATE stock_transfers SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
        [id],
      );
      return this.findOneTx(tx, id);
    });
  }

  list(filters: { status?: string; warehouse_id?: string }) {
    const conds: string[] = [];
    const params: any[] = [];
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
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return this.ds.query(
      `
      SELECT t.*,
        wf.name AS from_warehouse_name,
        wt.name AS to_warehouse_name,
        ur.full_name AS requested_by_name,
        ua.full_name AS approved_by_name,
        urc.full_name AS received_by_name,
        (SELECT COUNT(*) FROM stock_transfer_items WHERE transfer_id = t.id)::int AS items_count,
        (SELECT SUM(quantity_requested) FROM stock_transfer_items WHERE transfer_id = t.id)::int AS total_qty
      FROM stock_transfers t
      LEFT JOIN warehouses wf ON wf.id = t.from_warehouse_id
      LEFT JOIN warehouses wt ON wt.id = t.to_warehouse_id
      LEFT JOIN users ur ON ur.id = t.requested_by
      LEFT JOIN users ua ON ua.id = t.approved_by
      LEFT JOIN users urc ON urc.id = t.received_by
      ${where}
      ORDER BY t.created_at DESC
      LIMIT 200
      `,
      params,
    );
  }

  async findOne(id: string) {
    return this.findOneTx(this.ds.manager, id);
  }

  private async findOneTx(tx: any, id: string) {
    const [t] = await tx.query(
      `
      SELECT t.*,
        wf.name AS from_warehouse_name,
        wt.name AS to_warehouse_name,
        ur.full_name AS requested_by_name,
        ua.full_name AS approved_by_name,
        urc.full_name AS received_by_name
      FROM stock_transfers t
      LEFT JOIN warehouses wf ON wf.id = t.from_warehouse_id
      LEFT JOIN warehouses wt ON wt.id = t.to_warehouse_id
      LEFT JOIN users ur ON ur.id = t.requested_by
      LEFT JOIN users ua ON ua.id = t.approved_by
      LEFT JOIN users urc ON urc.id = t.received_by
      WHERE t.id = $1
      `,
      [id],
    );
    if (!t) throw new NotFoundException('التحويل غير موجود');

    const items = await tx.query(
      `
      SELECT ti.*,
        p.name AS product_name,
        p.sku AS product_sku,
        pv.sku AS variant_sku,
        pv.color,
        pv.size
      FROM stock_transfer_items ti
      JOIN product_variants pv ON pv.id = ti.variant_id
      JOIN products p ON p.id = pv.product_id
      WHERE ti.transfer_id = $1
      ORDER BY p.name
      `,
      [id],
    );
    return { ...t, items };
  }
}
