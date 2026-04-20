import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  AddPurchasePaymentDto,
  CreatePurchaseDto,
  ListPurchasesDto,
} from './dto/purchase.dto';

/**
 * Purchases module — supplier purchase orders + receiving.
 *
 * Flow:
 *   1. create()   → inserts draft PO with items (status = 'draft')
 *   2. receive()  → marks 'received', increments stock, writes movement rows
 *                  and pushes a supplier_ledger entry.
 *   3. pay()      → records a purchase payment, updates paid_amount/status,
 *                   deducts from cashbox (if cash), updates supplier balance.
 */
@Injectable()
export class PurchasesService {
  constructor(private readonly ds: DataSource) {}

  // --------------------------------------------------------------------------
  //  List / get
  // --------------------------------------------------------------------------
  async list(query: ListPurchasesDto) {
    const where: string[] = ['1=1'];
    const params: any[] = [];
    if (query.status) {
      params.push(query.status);
      where.push(`p.status = $${params.length}`);
    }
    if (query.supplier_id) {
      params.push(query.supplier_id);
      where.push(`p.supplier_id = $${params.length}`);
    }
    if (query.from) {
      params.push(query.from);
      where.push(`p.invoice_date >= $${params.length}`);
    }
    if (query.to) {
      params.push(query.to);
      where.push(`p.invoice_date <= $${params.length}`);
    }

    return this.ds.query(
      `
      SELECT p.*,
             s.name AS supplier_name,
             s.supplier_no,
             w.code AS warehouse_code,
             (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = p.id) AS items_count
        FROM purchases p
        LEFT JOIN suppliers  s ON s.id = p.supplier_id
        LEFT JOIN warehouses w ON w.id = p.warehouse_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.invoice_date DESC, p.created_at DESC
       LIMIT 200
      `,
      params,
    );
  }

  async getOne(id: string) {
    const [purchase] = await this.ds.query(
      `
      SELECT p.*, s.name AS supplier_name, s.supplier_no,
             w.code AS warehouse_code
        FROM purchases p
        LEFT JOIN suppliers  s ON s.id = p.supplier_id
        LEFT JOIN warehouses w ON w.id = p.warehouse_id
       WHERE p.id = $1
      `,
      [id],
    );
    if (!purchase) throw new NotFoundException(`Purchase ${id} not found`);

    const items = await this.ds.query(
      `
      SELECT pi.*, pv.sku, p.name_ar AS product_name
        FROM purchase_items pi
        JOIN product_variants pv ON pv.id = pi.variant_id
        JOIN products p ON p.id = pv.product_id
       WHERE pi.purchase_id = $1
       ORDER BY p.name_ar
      `,
      [id],
    );

    const payments = await this.ds.query(
      `SELECT * FROM purchase_payments WHERE purchase_id = $1 ORDER BY paid_at DESC`,
      [id],
    );

    return { ...purchase, items, payments };
  }

  // --------------------------------------------------------------------------
  //  Create
  // --------------------------------------------------------------------------
  async create(dto: CreatePurchaseDto, userId: string) {
    if (!dto.items?.length) {
      throw new BadRequestException('يجب إضافة صنف واحد على الأقل');
    }

    return this.ds.transaction(async (m) => {
      const subtotal = dto.items.reduce(
        (s, i) =>
          s +
          (i.quantity * i.unit_cost - (i.discount || 0) + (i.tax || 0)),
        0,
      );
      const grand_total =
        subtotal -
        (dto.discount_amount || 0) +
        (dto.tax_amount || 0) +
        (dto.shipping_cost || 0);

      const [purchase] = await m.query(
        `
        INSERT INTO purchases
            (supplier_id, warehouse_id, invoice_date, due_date, supplier_ref,
             subtotal, discount_amount, tax_amount, shipping_cost, grand_total,
             notes, created_by)
        VALUES ($1,$2, COALESCE($3::date, CURRENT_DATE), $4, $5,
                $6, $7, $8, $9, $10,
                $11, $12)
        RETURNING *
        `,
        [
          dto.supplier_id,
          dto.warehouse_id,
          dto.invoice_date ?? null,
          dto.due_date ?? null,
          dto.supplier_ref ?? null,
          subtotal,
          dto.discount_amount || 0,
          dto.tax_amount || 0,
          dto.shipping_cost || 0,
          grand_total,
          dto.notes ?? null,
          userId,
        ],
      );

      for (const it of dto.items) {
        const line_total =
          it.quantity * it.unit_cost -
          (it.discount || 0) +
          (it.tax || 0);
        await m.query(
          `INSERT INTO purchase_items
             (purchase_id, variant_id, quantity, unit_cost, discount, tax, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            purchase.id,
            it.variant_id,
            it.quantity,
            it.unit_cost,
            it.discount || 0,
            it.tax || 0,
            line_total,
          ],
        );
      }

      return purchase;
    });
  }

  // --------------------------------------------------------------------------
  //  Receive — increment stock, ledger
  // --------------------------------------------------------------------------
  async receive(id: string, userId: string) {
    return this.ds.transaction(async (m) => {
      const [p] = await m.query(
        `SELECT * FROM purchases WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!p) throw new NotFoundException(`Purchase ${id} not found`);
      if (p.status !== 'draft') {
        throw new BadRequestException('لا يمكن استلام فاتورة غير مسودة');
      }

      const items = await m.query(
        `SELECT * FROM purchase_items WHERE purchase_id = $1`,
        [id],
      );

      for (const it of items) {
        // Insert stock movement ONLY. Trigger `trg_apply_stock_movement` will
        // update `stock.quantity_on_hand` automatically. Doing both here would
        // double the stock increase.
        await m.query(
          `
          INSERT INTO stock_movements
              (variant_id, warehouse_id, movement_type, direction,
               quantity, unit_cost, reference_type, reference_id, user_id)
          VALUES ($1,$2,'purchase','in', $3, $4, 'purchase', $5, $6)
          `,
          [it.variant_id, p.warehouse_id, it.quantity, it.unit_cost, id, userId],
        );

        // update variant cost (moving average — simple: just overwrite for now)
        await m.query(
          `UPDATE product_variants
             SET cost_price = $1, updated_at = NOW()
           WHERE id = $2`,
          [it.unit_cost, it.variant_id],
        );
      }

      // supplier balance — we owe them the grand_total
      await m.query(
        `
        UPDATE suppliers
           SET current_balance = current_balance + $1,
               updated_at = NOW()
         WHERE id = $2
        `,
        [p.grand_total, p.supplier_id],
      );

      const [{ current_balance }] = await m.query(
        `SELECT current_balance FROM suppliers WHERE id = $1`,
        [p.supplier_id],
      );

      await m.query(
        `
        INSERT INTO supplier_ledger
            (supplier_id, direction, amount, reference_type, reference_id,
             balance_after, notes, user_id)
        VALUES ($1,'in', $2, 'purchase', $3, $4, $5, $6)
        `,
        [
          p.supplier_id,
          p.grand_total,
          id,
          current_balance,
          `استلام فاتورة ${p.purchase_no}`,
          userId,
        ],
      );

      // mark received
      await m.query(
        `UPDATE purchases
            SET status = 'received', received_by = $1, received_at = NOW(), updated_at = NOW()
          WHERE id = $2`,
        [userId, id],
      );

      return this.getOne(id);
    });
  }

  // --------------------------------------------------------------------------
  //  Pay
  // --------------------------------------------------------------------------
  async pay(id: string, dto: AddPurchasePaymentDto, userId: string) {
    return this.ds.transaction(async (m) => {
      const [p] = await m.query(
        `SELECT * FROM purchases WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!p) throw new NotFoundException(`Purchase ${id} not found`);
      if (p.status === 'cancelled') {
        throw new BadRequestException('لا يمكن سداد فاتورة ملغاة');
      }
      if (dto.amount > Number(p.remaining_amount)) {
        throw new BadRequestException('المبلغ المدفوع أكبر من المتبقي');
      }

      await m.query(
        `
        INSERT INTO purchase_payments
            (purchase_id, payment_method, amount, reference_number, notes, paid_by)
        VALUES ($1, $2::payment_method_code, $3, $4, $5, $6)
        `,
        [id, dto.payment_method, dto.amount, dto.reference_number ?? null, dto.notes ?? null, userId],
      );

      const newPaid = Number(p.paid_amount) + dto.amount;
      const status =
        newPaid >= Number(p.grand_total) ? 'paid' : 'partial';

      await m.query(
        `UPDATE purchases
            SET paid_amount = $1,
                status = $2,
                updated_at = NOW()
          WHERE id = $3`,
        [newPaid, status, id],
      );

      // supplier balance down, ledger entry
      await m.query(
        `UPDATE suppliers
            SET current_balance = current_balance - $1,
                updated_at = NOW()
          WHERE id = $2`,
        [dto.amount, p.supplier_id],
      );
      const [{ current_balance }] = await m.query(
        `SELECT current_balance FROM suppliers WHERE id = $1`,
        [p.supplier_id],
      );
      await m.query(
        `INSERT INTO supplier_ledger
            (supplier_id, direction, amount, reference_type, reference_id,
             balance_after, notes, user_id)
          VALUES ($1,'out', $2, 'purchase', $3, $4, $5, $6)`,
        [
          p.supplier_id,
          dto.amount,
          id,
          current_balance,
          `سداد فاتورة ${p.purchase_no}`,
          userId,
        ],
      );

      return { paid_amount: newPaid, status };
    });
  }

  async cancel(id: string) {
    const [p] = await this.ds.query(
      `SELECT * FROM purchases WHERE id = $1`,
      [id],
    );
    if (!p) throw new NotFoundException(`Purchase ${id} not found`);
    if (p.status !== 'draft') {
      throw new BadRequestException('يمكن إلغاء المسودات فقط');
    }
    await this.ds.query(
      `UPDATE purchases SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [id],
    );
    return { cancelled: true };
  }

  // --------------------------------------------------------------------------
  //  Purchase Returns (إرجاع للمورد)
  // --------------------------------------------------------------------------
  listReturns(supplierId?: string) {
    const params: any[] = [];
    let where = '';
    if (supplierId) {
      params.push(supplierId);
      where = `WHERE supplier_id = $1`;
    }
    return this.ds.query(
      `SELECT * FROM v_purchase_returns_summary ${where} LIMIT 200`,
      params,
    );
  }

  async getReturn(id: string) {
    const [header] = await this.ds.query(
      `SELECT pr.*, s.name AS supplier_name, w.name_ar AS warehouse_name,
              u.full_name AS created_by_name
         FROM purchase_returns pr
         LEFT JOIN suppliers s ON s.id = pr.supplier_id
         LEFT JOIN warehouses w ON w.id = pr.warehouse_id
         LEFT JOIN users u ON u.id = pr.created_by
        WHERE pr.id = $1`,
      [id],
    );
    if (!header) throw new NotFoundException('Return not found');
    const items = await this.ds.query(
      `SELECT pri.*, pv.sku, p.name_ar AS product_name
         FROM purchase_return_items pri
         JOIN product_variants pv ON pv.id = pri.variant_id
         JOIN products p ON p.id = pv.product_id
        WHERE pri.purchase_return_id = $1
        ORDER BY p.name_ar`,
      [id],
    );
    return { ...header, items };
  }

  /**
   * Create a supplier return. Decrements stock, writes stock_movements,
   * reduces supplier balance (we owe them less), writes a supplier_ledger
   * row (direction = 'out') and posts the return.
   */
  async createReturn(
    dto: {
      supplier_id: string;
      warehouse_id: string;
      purchase_id?: string;
      return_date?: string;
      reason?: string;
      notes?: string;
      items: Array<{
        variant_id: string;
        quantity: number;
        unit_cost: number;
      }>;
    },
    userId: string,
  ) {
    if (!dto.items?.length) {
      throw new BadRequestException('يجب إضافة صنف واحد على الأقل');
    }

    return this.ds.transaction(async (m) => {
      const total = dto.items.reduce(
        (s, i) => s + i.quantity * i.unit_cost,
        0,
      );

      const [ret] = await m.query(
        `INSERT INTO purchase_returns
            (purchase_id, supplier_id, warehouse_id, return_date,
             total_amount, reason, notes, created_by)
         VALUES ($1,$2,$3, COALESCE($4::date, CURRENT_DATE), $5, $6, $7, $8)
         RETURNING *`,
        [
          dto.purchase_id ?? null,
          dto.supplier_id,
          dto.warehouse_id,
          dto.return_date ?? null,
          total,
          dto.reason ?? null,
          dto.notes ?? null,
          userId,
        ],
      );

      for (const it of dto.items) {
        const lineTotal = it.quantity * it.unit_cost;

        // verify enough stock
        const [stockRow] = await m.query(
          `SELECT quantity_on_hand FROM stock
            WHERE variant_id = $1 AND warehouse_id = $2 FOR UPDATE`,
          [it.variant_id, dto.warehouse_id],
        );
        const onHand = Number(stockRow?.quantity_on_hand ?? 0);
        if (onHand < it.quantity) {
          throw new BadRequestException(
            `الكمية غير كافية للصنف ${it.variant_id} (المتاح ${onHand})`,
          );
        }

        await m.query(
          `INSERT INTO purchase_return_items
              (purchase_return_id, variant_id, quantity, unit_cost, line_total)
           VALUES ($1,$2,$3,$4,$5)`,
          [ret.id, it.variant_id, it.quantity, it.unit_cost, lineTotal],
        );

        // decrement stock
        await m.query(
          `UPDATE stock
              SET quantity_on_hand = quantity_on_hand - $1, updated_at = NOW()
            WHERE variant_id = $2 AND warehouse_id = $3`,
          [it.quantity, it.variant_id, dto.warehouse_id],
        );

        // stock movement
        await m.query(
          `INSERT INTO stock_movements
             (variant_id, warehouse_id, movement_type, direction,
              quantity, unit_cost, reference_type, reference_id, user_id)
           VALUES ($1,$2,'purchase_return','out', $3, $4, 'purchase_return', $5, $6)`,
          [it.variant_id, dto.warehouse_id, it.quantity, it.unit_cost, ret.id, userId],
        );
      }

      // Reduce supplier balance (we owe less because we're returning goods)
      await m.query(
        `UPDATE suppliers
            SET current_balance = current_balance - $1, updated_at = NOW()
          WHERE id = $2`,
        [total, dto.supplier_id],
      );
      const [{ current_balance }] = await m.query(
        `SELECT current_balance FROM suppliers WHERE id = $1`,
        [dto.supplier_id],
      );
      await m.query(
        `INSERT INTO supplier_ledger
           (supplier_id, direction, amount, reference_type, reference_id,
            balance_after, notes, user_id)
         VALUES ($1,'out', $2, 'purchase_return', $3, $4, $5, $6)`,
        [
          dto.supplier_id,
          total,
          ret.id,
          current_balance,
          `مرتجع مشتريات ${ret.return_no}`,
          userId,
        ],
      );

      return this.getReturn(ret.id);
    });
  }

  async cancelReturn(id: string, userId: string) {
    return this.ds.transaction(async (m) => {
      const [ret] = await m.query(
        `SELECT * FROM purchase_returns WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!ret) throw new NotFoundException('Return not found');
      if (ret.status === 'cancelled') {
        throw new BadRequestException('المرتجع ملغى بالفعل');
      }

      const items = await m.query(
        `SELECT * FROM purchase_return_items WHERE purchase_return_id = $1`,
        [id],
      );

      // restore stock
      for (const it of items) {
        await m.query(
          `INSERT INTO stock (variant_id, warehouse_id, quantity_on_hand)
             VALUES ($1,$2,$3)
             ON CONFLICT (variant_id, warehouse_id) DO UPDATE
               SET quantity_on_hand = stock.quantity_on_hand + EXCLUDED.quantity_on_hand,
                   updated_at = NOW()`,
          [it.variant_id, ret.warehouse_id, it.quantity],
        );
        await m.query(
          `INSERT INTO stock_movements
             (variant_id, warehouse_id, movement_type, direction,
              quantity, unit_cost, reference_type, reference_id, user_id, notes)
           VALUES ($1,$2,'purchase_return','in', $3, $4, 'purchase_return', $5, $6, 'إلغاء مرتجع مشتريات')`,
          [
            it.variant_id,
            ret.warehouse_id,
            it.quantity,
            it.unit_cost,
            id,
            userId,
          ],
        );
      }

      // restore supplier balance
      await m.query(
        `UPDATE suppliers
            SET current_balance = current_balance + $1, updated_at = NOW()
          WHERE id = $2`,
        [ret.total_amount, ret.supplier_id],
      );

      await m.query(
        `UPDATE purchase_returns SET status = 'cancelled', updated_at = NOW()
          WHERE id = $1`,
        [id],
      );

      return { cancelled: true };
    });
  }
}
