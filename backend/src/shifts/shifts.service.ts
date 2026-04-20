import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OpenShiftDto, CloseShiftDto } from './dto/shift.dto';

@Injectable()
export class ShiftsService {
  constructor(private readonly ds: DataSource) {}

  async open(dto: OpenShiftDto, userId: string) {
    // Prevent multiple open shifts for same cashbox
    const [existing] = await this.ds.query(
      `SELECT id, shift_no FROM shifts WHERE cashbox_id = $1 AND status = 'open' LIMIT 1`,
      [dto.cashbox_id],
    );
    if (existing) {
      throw new BadRequestException(
        `يوجد وردية مفتوحة على هذه الخزينة: ${existing.shift_no}`,
      );
    }

    const year = new Date().getFullYear();
    const [{ max }] = await this.ds.query(
      `SELECT COALESCE(MAX(SUBSTRING(shift_no FROM 'SHF-[0-9]+-([0-9]+)')::int), 0) AS max
       FROM shifts WHERE shift_no LIKE 'SHF-' || $1 || '-%'`,
      [year],
    );
    const shiftNo = `SHF-${year}-${String(Number(max) + 1).padStart(5, '0')}`;

    const [row] = await this.ds.query(
      `
      INSERT INTO shifts
        (shift_no, cashbox_id, warehouse_id, opened_by, status, opening_balance, expected_closing, notes)
      VALUES ($1,$2,$3,$4,'open',$5,$5,$6)
      RETURNING *
      `,
      [shiftNo, dto.cashbox_id, dto.warehouse_id, userId, dto.opening_balance, dto.notes ?? null],
    );
    return row;
  }

  async close(id: string, dto: CloseShiftDto, userId: string) {
    const [shift] = await this.ds.query(
      `SELECT * FROM shifts WHERE id = $1`,
      [id],
    );
    if (!shift) throw new NotFoundException('الوردية غير موجودة');
    if (shift.status !== 'open') {
      throw new BadRequestException('الوردية مغلقة بالفعل');
    }

    // Compute totals from invoices / returns / expenses / cash movements
    const [stats] = await this.ds.query(
      `
      SELECT
        COALESCE((SELECT SUM(grand_total) FROM invoices WHERE shift_id = $1 AND status = 'completed'), 0)::numeric AS total_sales,
        COALESCE((SELECT COUNT(*) FROM invoices WHERE shift_id = $1 AND status = 'completed'), 0)::int AS invoice_count,
        COALESCE((SELECT SUM(r.net_refund) FROM returns r
                  JOIN invoices i ON i.id = r.original_invoice_id
                  WHERE i.shift_id = $1 AND r.status = 'refunded'), 0)::numeric AS total_returns,
        COALESCE((SELECT SUM(amount) FROM cashbox_transactions
                  WHERE cashbox_id = $2 AND direction = 'in'
                    AND created_at >= $3), 0)::numeric AS total_cash_in,
        COALESCE((SELECT SUM(amount) FROM cashbox_transactions
                  WHERE cashbox_id = $2 AND direction = 'out'
                    AND created_at >= $3), 0)::numeric AS total_cash_out,
        COALESCE((SELECT SUM(amount) FROM expenses
                  WHERE cashbox_id = $2 AND expense_date >= $3::date), 0)::numeric AS total_expenses
      `,
      [id, shift.cashbox_id, shift.opened_at],
    );

    const expectedClosing =
      Number(shift.opening_balance) +
      Number(stats.total_sales) -
      Number(stats.total_returns) -
      Number(stats.total_expenses) +
      Number(stats.total_cash_in) -
      Number(stats.total_cash_out);

    const [updated] = await this.ds.query(
      `
      UPDATE shifts SET
        status = 'closed',
        closed_by = $1,
        closed_at = NOW(),
        actual_closing = $2,
        expected_closing = $3,
        total_sales = $4,
        total_returns = $5,
        total_expenses = $6,
        total_cash_in = $7,
        total_cash_out = $8,
        invoice_count = $9,
        notes = COALESCE($10, notes)
      WHERE id = $11
      RETURNING *
      `,
      [
        userId,
        dto.actual_closing,
        expectedClosing,
        stats.total_sales,
        stats.total_returns,
        stats.total_expenses,
        stats.total_cash_in,
        stats.total_cash_out,
        stats.invoice_count,
        dto.notes ?? null,
        id,
      ],
    );
    return updated;
  }

  list(status?: string, userId?: string) {
    const conds: string[] = [];
    const params: any[] = [];
    if (status) {
      params.push(status);
      conds.push(`s.status = $${params.length}`);
    }
    if (userId) {
      params.push(userId);
      conds.push(`s.opened_by = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return this.ds.query(
      `
      SELECT
        s.*,
        cb.name_ar AS cashbox_name,
        w.name_ar AS warehouse_name,
        u1.full_name AS opened_by_name,
        u2.full_name AS closed_by_name
      FROM shifts s
      LEFT JOIN cashboxes cb ON cb.id = s.cashbox_id
      LEFT JOIN warehouses w ON w.id = s.warehouse_id
      LEFT JOIN users u1 ON u1.id = s.opened_by
      LEFT JOIN users u2 ON u2.id = s.closed_by
      ${where}
      ORDER BY s.opened_at DESC
      LIMIT 200
      `,
      params,
    );
  }

  async findOne(id: string) {
    const [shift] = await this.ds.query(
      `
      SELECT s.*,
        cb.name_ar AS cashbox_name,
        w.name_ar AS warehouse_name,
        u1.full_name AS opened_by_name,
        u2.full_name AS closed_by_name
      FROM shifts s
      LEFT JOIN cashboxes cb ON cb.id = s.cashbox_id
      LEFT JOIN warehouses w ON w.id = s.warehouse_id
      LEFT JOIN users u1 ON u1.id = s.opened_by
      LEFT JOIN users u2 ON u2.id = s.closed_by
      WHERE s.id = $1
      `,
      [id],
    );
    if (!shift) throw new NotFoundException('الوردية غير موجودة');

    const invoices = await this.ds.query(
      `SELECT id, invoice_no, grand_total, paid_amount, status, completed_at
       FROM invoices WHERE shift_id = $1 ORDER BY completed_at DESC LIMIT 200`,
      [id],
    );
    return { ...shift, invoices };
  }

  async currentOpen(userId: string) {
    const [row] = await this.ds.query(
      `SELECT s.*, cb.name_ar AS cashbox_name
       FROM shifts s
       LEFT JOIN cashboxes cb ON cb.id = s.cashbox_id
       WHERE s.opened_by = $1 AND s.status = 'open'
       ORDER BY s.opened_at DESC LIMIT 1`,
      [userId],
    );
    return row || null;
  }
}
