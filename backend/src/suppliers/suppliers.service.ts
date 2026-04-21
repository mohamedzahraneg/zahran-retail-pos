import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, ILike, Repository } from 'typeorm';
import { SupplierEntity } from './entities/supplier.entity';

@Injectable()
export class SuppliersService {
  constructor(
    @InjectRepository(SupplierEntity)
    private readonly repo: Repository<SupplierEntity>,
    private readonly ds: DataSource,
  ) {}

  list(q?: string) {
    const where: any = { is_active: true };
    if (q) where.name = ILike(`%${q}%`);
    return this.repo.find({ where, order: { created_at: 'DESC' } });
  }

  async findOne(id: string) {
    const s = await this.repo.findOne({ where: { id } });
    if (!s) throw new NotFoundException(`Supplier ${id} not found`);
    return s;
  }

  async create(body: Partial<SupplierEntity>) {
    // Auto-generate a numeric code if not supplied — MAX(code)+1 so
    // renumbering survives soft-deletes.
    if (!body.code) {
      const [row] = await this.ds.query(
        `SELECT COALESCE(MAX(code::int), 0) + 1 AS next_code
           FROM suppliers
          WHERE code ~ '^[0-9]+$' AND deleted_at IS NULL`,
      );
      body.code = String(row?.next_code || 1);
    }
    const saved = await this.repo.save(this.repo.create(body));
    // Seed the opening balance as the current balance on first save so
    // the supplier starts off the ledger matching the user's input.
    if (Number((body as any).opening_balance) > 0) {
      await this.ds.query(
        `UPDATE suppliers
            SET current_balance = $2
          WHERE id = $1`,
        [saved.id, Number((body as any).opening_balance)],
      );
      await this.ds.query(
        `INSERT INTO supplier_ledger
           (supplier_id, direction, amount, reference_type, reference_id,
            balance_after, notes)
         VALUES ($1,'in',$2,'opening_balance',NULL,$2,'رصيد افتتاحي')`,
        [saved.id, Number((body as any).opening_balance)],
      ).catch(() => {
        /* supplier_ledger schema may not exist yet on older DBs — not fatal */
      });
    }
    return this.findOne(saved.id);
  }

  async update(id: string, body: Partial<SupplierEntity>) {
    const supplier = await this.repo.findOne({ where: { id } });
    if (!supplier) throw new NotFoundException(`Supplier ${id} not found`);
    await this.repo.update(id, body);
    return this.findOne(id);
  }

  async remove(id: string) {
    const supplier = await this.repo.findOne({ where: { id } });
    if (!supplier) throw new NotFoundException(`Supplier ${id} not found`);
    if (Number(supplier.current_balance) !== 0) {
      throw new BadRequestException(
        'لا يمكن حذف مورد له رصيد مستحق — يجب تسوية الحساب أولاً',
      );
    }
    await this.repo.update(id, { is_active: false });
    return { archived: true };
  }

  ledger(supplierId: string) {
    return this.ds.query(
      `SELECT * FROM supplier_ledger WHERE supplier_id = $1 ORDER BY entry_date DESC LIMIT 200`,
      [supplierId],
    );
  }

  outstanding() {
    return this.ds.query(
      `SELECT
         s.id                                AS supplier_id,
         s.id                                AS id,
         s.supplier_no,
         s.name,
         s.phone,
         COALESCE(s.current_balance, 0)      AS current_balance,
         COALESCE(s.current_balance, 0)      AS outstanding,
         COALESCE(s.credit_limit, 0)         AS credit_limit,
         (SELECT MAX(sl.created_at)
            FROM supplier_ledger sl
           WHERE sl.supplier_id = s.id)      AS last_entry_at
       FROM suppliers s
       WHERE s.deleted_at IS NULL
       ORDER BY COALESCE(s.current_balance, 0) DESC`,
    );
  }

  /**
   * Pay a supplier — allocates the payment across unpaid purchases in FIFO
   * order (oldest first). Any remainder that exceeds outstanding balance
   * is rejected. Updates purchases.paid_amount/status, supplier balance,
   * and writes a supplier_ledger row.
   */
  async payGeneral(
    supplierId: string,
    payload: {
      amount: number;
      payment_method: string;
      reference_number?: string;
      notes?: string;
    },
    userId: string,
  ) {
    if (!payload.amount || payload.amount <= 0) {
      throw new BadRequestException('المبلغ يجب أن يكون أكبر من صفر');
    }
    return this.ds.transaction(async (m) => {
      const [supplier] = await m.query(
        `SELECT * FROM suppliers WHERE id = $1 FOR UPDATE`,
        [supplierId],
      );
      if (!supplier) throw new NotFoundException('المورد غير موجود');

      // FIFO allocation against unpaid received purchases
      const purchases = await m.query(
        `SELECT * FROM purchases
          WHERE supplier_id = $1
            AND status IN ('received','partial')
          ORDER BY invoice_date, created_at`,
        [supplierId],
      );

      let remaining = Number(payload.amount);
      const allocations: Array<{ purchase_id: string; applied: number }> = [];

      for (const p of purchases) {
        if (remaining <= 0) break;
        const unpaid = Number(p.remaining_amount);
        if (unpaid <= 0) continue;
        const apply = Math.min(remaining, unpaid);

        await m.query(
          `INSERT INTO purchase_payments
             (purchase_id, payment_method, amount, reference_number, notes, paid_by)
           VALUES ($1, $2::payment_method_code, $3, $4, $5, $6)`,
          [
            p.id,
            payload.payment_method,
            apply,
            payload.reference_number ?? null,
            payload.notes ?? null,
            userId,
          ],
        );

        const newPaid = Number(p.paid_amount) + apply;
        const newStatus =
          newPaid >= Number(p.grand_total) ? 'paid' : 'partial';
        await m.query(
          `UPDATE purchases SET paid_amount = $1, status = $2, updated_at = NOW()
            WHERE id = $3`,
          [newPaid, newStatus, p.id],
        );

        allocations.push({ purchase_id: p.id, applied: apply });
        remaining -= apply;
      }

      if (remaining > 0) {
        throw new BadRequestException(
          `المبلغ المتبقي ${remaining.toFixed(2)} أكبر من رصيد المورد المستحق`,
        );
      }

      // supplier balance down + ledger row
      await m.query(
        `UPDATE suppliers SET current_balance = current_balance - $1,
                updated_at = NOW() WHERE id = $2`,
        [payload.amount, supplierId],
      );
      const [{ current_balance }] = await m.query(
        `SELECT current_balance FROM suppliers WHERE id = $1`,
        [supplierId],
      );
      await m.query(
        `INSERT INTO supplier_ledger
            (supplier_id, direction, amount, reference_type, reference_id,
             balance_after, notes, user_id)
         VALUES ($1,'out', $2, 'payment', NULL, $3, $4, $5)`,
        [
          supplierId,
          payload.amount,
          current_balance,
          payload.notes ?? `سداد للمورد ${supplier.name}`,
          userId,
        ],
      );

      return {
        paid: true,
        amount: payload.amount,
        allocations,
        new_balance: Number(current_balance),
      };
    });
  }

  /**
   * Full smart summary for a supplier — used by the dedicated
   * supplier page. Bundles profile, running totals, purchases
   * breakdown, payment history, discounts allocated to their items,
   * and the raw ledger in one call.
   */
  async summary(supplierId: string) {
    const [supplier] = await this.ds.query(
      `SELECT s.*,
              (SELECT COUNT(*) FROM purchases WHERE supplier_id = s.id)::int
                 AS purchase_count,
              (SELECT COALESCE(SUM(grand_total), 0) FROM purchases
                WHERE supplier_id = s.id)::numeric(14,2) AS purchases_total,
              (SELECT COALESCE(SUM(paid_amount), 0) FROM purchases
                WHERE supplier_id = s.id)::numeric(14,2) AS paid_total,
              (SELECT COALESCE(SUM(grand_total - paid_amount), 0)
                 FROM purchases WHERE supplier_id = s.id
                  AND status IN ('received','partial'))::numeric(14,2) AS unpaid_total
         FROM suppliers s
        WHERE s.id = $1 AND s.deleted_at IS NULL`,
      [supplierId],
    );
    if (!supplier) throw new NotFoundException('المورد غير موجود');

    const purchases = await this.ds.query(
      `SELECT id, purchase_no, invoice_date, grand_total, paid_amount,
              (grand_total - paid_amount) AS remaining, status
         FROM purchases
        WHERE supplier_id = $1
        ORDER BY invoice_date DESC, created_at DESC
        LIMIT 200`,
      [supplierId],
    );

    const payments = await this.ds.query(
      `SELECT pp.id, pp.paid_at, pp.amount, pp.payment_method,
              pp.reference_number, pp.notes,
              pu.purchase_no,
              u.full_name AS paid_by_name
         FROM purchase_payments pp
         JOIN purchases pu ON pu.id = pp.purchase_id
         LEFT JOIN users u ON u.id = pp.paid_by
        WHERE pu.supplier_id = $1
        ORDER BY pp.paid_at DESC
        LIMIT 200`,
      [supplierId],
    );

    const ledger = await this.ds.query(
      `SELECT * FROM supplier_ledger
        WHERE supplier_id = $1
        ORDER BY entry_date DESC, created_at DESC
        LIMIT 200`,
      [supplierId],
    ).catch(() => [] as any[]);

    // Discounts distributed across items bought from this supplier.
    // Each purchase_item carries an invoice-level allocated discount
    // (discount_amount_share) in most schemas; if not present we just
    // surface the purchase-level discount.
    const discounts = await this.ds.query(
      `SELECT pi.id, pi.product_name_snapshot AS name, pi.sku_snapshot AS sku,
              pi.quantity, pi.unit_cost,
              COALESCE(pi.discount_amount, 0)::numeric(14,2) AS discount,
              pu.purchase_no, pu.invoice_date
         FROM purchase_items pi
         JOIN purchases pu ON pu.id = pi.purchase_id
        WHERE pu.supplier_id = $1
          AND COALESCE(pi.discount_amount, 0) > 0
        ORDER BY pu.invoice_date DESC
        LIMIT 200`,
      [supplierId],
    ).catch(() => [] as any[]);

    return {
      supplier,
      purchases,
      payments,
      ledger,
      discounts,
      credit_usage_pct:
        Number(supplier.credit_limit || 0) > 0
          ? Math.round(
              (Number(supplier.current_balance || 0) /
                Number(supplier.credit_limit)) *
                10000,
            ) / 100
          : null,
    };
  }

  /** All payments made to this supplier (across all invoices). */
  supplierPayments(supplierId: string, limit = 100) {
    return this.ds.query(
      `SELECT pp.*, pu.purchase_no, pu.invoice_date, u.username AS paid_by_username
         FROM purchase_payments pp
         JOIN purchases pu ON pu.id = pp.purchase_id
         LEFT JOIN users u ON u.id = pp.paid_by
        WHERE pu.supplier_id = $1
        ORDER BY pp.paid_at DESC
        LIMIT $2`,
      [supplierId, limit],
    );
  }
}
