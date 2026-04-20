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

  create(body: Partial<SupplierEntity>) {
    return this.repo.save(this.repo.create(body));
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
