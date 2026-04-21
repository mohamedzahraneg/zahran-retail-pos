import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OpenShiftDto, CloseShiftDto } from './dto/shift.dto';

/**
 * Cashier shift (وردية) service.
 *
 * A shift is the period between a cashier opening a cashbox with an opening
 * balance and closing it with a counted cash amount. At close we reconcile:
 *
 *   expected_closing = opening_balance
 *                      + cash_sales
 *                      - cash_refunds
 *                      + customer_payments       (cash in from receivables)
 *                      - supplier_payments       (cash out to payables)
 *                      - cash_expenses
 *                      + other_cash_in           (manual deposits)
 *                      - other_cash_out          (manual withdrawals)
 *
 *   variance = actual_closing - expected_closing    (+ surplus / − deficit)
 */
@Injectable()
export class ShiftsService {
  constructor(private readonly ds: DataSource) {}

  async open(dto: OpenShiftDto, userId: string) {
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

  /**
   * Gather every number that matters for the close-out dialog. Accepts any
   * shift id (open or closed) and returns a fresh reconciled summary.
   */
  async summary(id: string) {
    const [shift] = await this.ds.query(`SELECT * FROM shifts WHERE id = $1`, [id]);
    if (!shift) throw new NotFoundException('الوردية غير موجودة');
    return this.computeSummary(shift);
  }

  private async computeSummary(shift: any) {
    // When the shift is still open we bound by NOW; when closed we stop at
    // the closed_at timestamp. This lets the summary stay stable for closed
    // shifts and live for open ones.
    const upperBound = shift.closed_at || new Date();

    // Invoice totals — match either by explicit shift_id OR by the same
    // cashier creating invoices during the shift window. This makes us
    // resilient to shift_id being NULL (e.g. warehouse mismatch or pre-fix
    // legacy rows).
    const invMatch = `(
      i.shift_id = $1
      OR (
        i.shift_id IS NULL
        AND i.cashier_id = $2
        AND i.created_at >= $3
        AND i.created_at <= $4
      )
    )`;

    const [inv] = await this.ds.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN i.status IN ('paid','completed','partially_paid') THEN i.grand_total ELSE 0 END),0)::numeric AS total_sales,
        COALESCE(SUM(CASE WHEN i.status = 'cancelled' THEN i.grand_total ELSE 0 END),0)::numeric AS total_cancelled,
        COUNT(*) FILTER (WHERE i.status IN ('paid','completed','partially_paid'))::int AS invoice_count,
        COUNT(*) FILTER (WHERE i.status = 'cancelled')::int AS cancelled_count,
        COALESCE(SUM(CASE WHEN i.status IN ('paid','completed','partially_paid') THEN (i.grand_total - i.paid_amount) ELSE 0 END),0)::numeric AS remaining_receivable
      FROM invoices i
      WHERE ${invMatch}
      `,
      [shift.id, shift.opened_by, shift.opened_at, upperBound],
    );

    // Payment method breakdown.
    const payRows = await this.ds.query(
      `
      SELECT ip.payment_method::text AS method,
             COALESCE(SUM(ip.amount),0)::numeric AS amount,
             COUNT(*)::int AS count
        FROM invoice_payments ip
        JOIN invoices i ON i.id = ip.invoice_id
       WHERE ${invMatch}
         AND i.status IN ('paid','completed','partially_paid')
       GROUP BY ip.payment_method
      `,
      [shift.id, shift.opened_by, shift.opened_at, upperBound],
    );
    const byMethod: Record<string, { amount: number; count: number }> = {};
    for (const r of payRows) {
      byMethod[r.method] = { amount: Number(r.amount), count: r.count };
    }
    const cashFromSales = Number(byMethod.cash?.amount || 0);
    const cardSales = Number(byMethod.card?.amount || 0);
    const instapaySales = Number(byMethod.instapay?.amount || 0);
    const bankSales = Number(byMethod.bank_transfer?.amount || 0);

    // Returns refunded within the shift window against the same invoices.
    const [ret] = await this.ds.query(
      `
      SELECT
        COALESCE(SUM(r.net_refund),0)::numeric AS total_returns,
        COUNT(*)::int AS return_count
        FROM returns r
        JOIN invoices i ON i.id = r.original_invoice_id
       WHERE ${invMatch}
         AND r.status IN ('refunded','approved')
      `,
      [shift.id, shift.opened_by, shift.opened_at, upperBound],
    );

    // Cashbox txns during the shift — these cover BOTH invoice-linked
    // in/outs AND manual receipts / disbursements. We break them down by
    // category (the actual column; some older code called it "source").
    const txRows = await this.ds.query(
      `
      SELECT direction::text AS direction, category::text AS category,
             COALESCE(SUM(amount),0)::numeric AS amount,
             COUNT(*)::int AS count
        FROM cashbox_transactions
       WHERE cashbox_id = $1 AND created_at >= $2
       GROUP BY direction, category
      `,
      [shift.cashbox_id, shift.opened_at],
    );
    const tx: Record<string, { amount: number; count: number }> = {};
    for (const r of txRows) {
      tx[`${r.direction}_${r.category}`] = {
        amount: Number(r.amount),
        count: r.count,
      };
    }
    // Customer receipts (قبض من عميل — direction 'in', category 'receipt').
    const customerReceipts = Number(tx.in_receipt?.amount || 0);
    // Supplier payments (صرف لمورد — direction 'out', category 'payment' or 'purchase').
    const supplierPayments =
      Number(tx.out_payment?.amount || 0) +
      Number(tx.out_purchase?.amount || 0);
    // Manual cash adjustments — anything labeled 'manual' / 'other' / 'adjustment'.
    const otherCashIn =
      Number(tx.in_manual?.amount || 0) +
      Number(tx.in_other?.amount || 0) +
      Number(tx.in_adjustment?.amount || 0) +
      Number(tx.in_deposit?.amount || 0);
    const otherCashOut =
      Number(tx.out_manual?.amount || 0) +
      Number(tx.out_other?.amount || 0) +
      Number(tx.out_adjustment?.amount || 0) +
      Number(tx.out_withdrawal?.amount || 0);

    // Expenses posted during the shift window. Match generously: same
    // cashbox OR same warehouse OR created by the shift opener — cashiers
    // often leave cashbox_id blank when adding expenses from the UI.
    const expenseRows = await this.ds.query(
      `
      SELECT e.id, e.expense_no, e.amount, e.description,
             ec.name_ar AS category_name, e.expense_date,
             CASE WHEN e.is_approved THEN 'approved' ELSE 'pending' END AS status
        FROM expenses e
        LEFT JOIN expense_categories ec ON ec.id = e.category_id
       WHERE e.created_at >= $1
         AND e.created_at <= $2
         AND (
           e.cashbox_id = $3
           OR (e.cashbox_id IS NULL)
           OR e.warehouse_id = $4
           OR e.created_by = $5
         )
       ORDER BY e.expense_date DESC, e.created_at DESC
      `,
      [
        shift.opened_at,
        upperBound,
        shift.cashbox_id,
        shift.warehouse_id,
        shift.opened_by,
      ],
    );
    const totalExpenses = expenseRows.reduce(
      (s: number, e: any) => s + Number(e.amount || 0),
      0,
    );

    // Cash receipts are already the cash-method invoice payments; cash refunds
    // happen when a return is settled in cash — we proxy them by subtracting
    // total_returns here (simple model: treat every refund as cash out).
    const cashRefunds = Number(ret.total_returns || 0);

    // Totals
    const totalCashIn = cashFromSales + customerReceipts + otherCashIn;
    const totalCashOut =
      cashRefunds + supplierPayments + totalExpenses + otherCashOut;
    const expectedClosing =
      Number(shift.opening_balance || 0) + totalCashIn - totalCashOut;

    // Variance against a counted cash (only meaningful post-close)
    const actualClosing = Number(shift.actual_closing ?? 0);
    const variance = shift.closed_at
      ? actualClosing - expectedClosing
      : null;

    return {
      shift_id: shift.id,
      shift_no: shift.shift_no,
      status: shift.status,
      opening_balance: Number(shift.opening_balance || 0),
      opened_at: shift.opened_at,
      closed_at: shift.closed_at,

      // sales
      total_sales: Number(inv.total_sales),
      invoice_count: inv.invoice_count,
      cancelled_count: inv.cancelled_count,
      total_cancelled: Number(inv.total_cancelled),
      remaining_receivable: Number(inv.remaining_receivable),

      // payment method split
      payment_breakdown: {
        cash: { amount: cashFromSales, count: byMethod.cash?.count || 0 },
        card: { amount: cardSales, count: byMethod.card?.count || 0 },
        instapay: {
          amount: instapaySales,
          count: byMethod.instapay?.count || 0,
        },
        bank_transfer: {
          amount: bankSales,
          count: byMethod.bank_transfer?.count || 0,
        },
      },

      // cashbox flows
      customer_receipts: customerReceipts,
      supplier_payments: supplierPayments,
      other_cash_in: otherCashIn,
      other_cash_out: otherCashOut,

      // returns + expenses
      total_returns: Number(ret.total_returns),
      return_count: ret.return_count,
      total_expenses: totalExpenses,
      expense_count: expenseRows.length,
      expenses: expenseRows,

      // reconciliation
      total_cash_in: totalCashIn,
      total_cash_out: totalCashOut,
      expected_closing: expectedClosing,
      actual_closing: shift.closed_at ? actualClosing : null,
      variance,
    };
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

    const summary = await this.computeSummary(shift);

    // Build a notes field that preserves any user note AND appends the cash
    // denomination breakdown for the audit trail.
    let notesOut: string | null = dto.notes ?? null;
    if (dto.denominations && Object.keys(dto.denominations).length > 0) {
      const lines = Object.entries(dto.denominations)
        .filter(([, c]) => Number(c) > 0)
        .sort(([a], [b]) => Number(b) - Number(a))
        .map(
          ([v, c]) =>
            `${v} × ${c} = ${Number(v) * Number(c)}`,
        );
      const breakdown = `عدّ الدرج:\n${lines.join('\n')}`;
      notesOut = notesOut ? `${notesOut}\n\n${breakdown}` : breakdown;
    }

    // Every parameter is explicitly cast so Postgres can parse the statement
    // even when some values arrive as null (driver can't infer type there).
    const [updated] = await this.ds.query(
      `
      UPDATE shifts SET
        status           = 'closed',
        closed_by        = $1::uuid,
        closed_at        = NOW(),
        actual_closing   = $2::numeric,
        expected_closing = $3::numeric,
        total_sales      = $4::numeric,
        total_returns    = $5::numeric,
        total_expenses   = $6::numeric,
        total_cash_in    = $7::numeric,
        total_cash_out   = $8::numeric,
        invoice_count    = $9::int,
        notes            = COALESCE($10::text, notes)
      WHERE id = $11::uuid
      RETURNING *
      `,
      [
        userId,
        Number(dto.actual_closing) || 0,
        Number(summary.expected_closing) || 0,
        Number(summary.total_sales) || 0,
        Number(summary.total_returns) || 0,
        Number(summary.total_expenses) || 0,
        Number(summary.total_cash_in) || 0,
        Number(summary.total_cash_out) || 0,
        Number(summary.invoice_count) || 0,
        notesOut,
        id,
      ],
    );
    return {
      ...updated,
      summary: {
        ...summary,
        actual_closing: Number(dto.actual_closing),
        variance: Number(dto.actual_closing) - summary.expected_closing,
      },
    };
  }

  // ── Request / approve close-out flow ───────────────────────────────
  /**
   * A cashier without shifts.close_approve submits their closing
   * balance here; the shift enters `pending_close` status and stays
   * open for business until a supervisor decides. This lets the
   * owner review variance before money is committed to the ledger.
   */
  async requestClose(
    id: string,
    dto: { actual_closing: number; notes?: string },
    userId: string,
  ) {
    const [shift] = await this.ds.query(
      `SELECT * FROM shifts WHERE id = $1`,
      [id],
    );
    if (!shift) throw new NotFoundException('الوردية غير موجودة');
    if (shift.status !== 'open') {
      throw new BadRequestException('لا يمكن طلب إقفال وردية غير مفتوحة');
    }

    // Auto-close when the counted cash matches the expected closing
    // within a 1-piaster tolerance. Any surplus OR deficit sends the
    // shift into `pending_close` so a supervisor can review before the
    // ledger is finalized.
    const summary = await this.computeSummary(shift);
    const actual = Number(dto.actual_closing) || 0;
    const variance = actual - Number(summary.expected_closing || 0);

    if (Math.abs(variance) < 0.01) {
      // Matches exactly — skip review, close immediately.
      const result = await this.close(
        id,
        { actual_closing: actual, notes: dto.notes || '' } as any,
        userId,
      );
      return { pending: false, auto_closed: true, shift: result };
    }

    // Variance (surplus OR deficit) → park in pending_close for review.
    const [row] = await this.ds.query(
      `UPDATE shifts
          SET status                 = 'pending_close',
              close_requested_at     = NOW(),
              close_requested_by     = $1,
              close_requested_amount = $2::numeric,
              close_requested_notes  = $3
        WHERE id = $4
        RETURNING *`,
      [userId, actual, dto.notes ?? null, id],
    );
    return {
      pending: true,
      shift: row,
      variance,
      expected_closing: Number(summary.expected_closing || 0),
    };
  }

  /** Admin approves → runs the real close() with the requested amount. */
  async approveClose(id: string, userId: string) {
    const [shift] = await this.ds.query(
      `SELECT * FROM shifts WHERE id = $1`,
      [id],
    );
    if (!shift) throw new NotFoundException('الوردية غير موجودة');
    if (shift.status !== 'pending_close') {
      throw new BadRequestException('الوردية ليست في انتظار الإقفال');
    }
    const actual = Number(shift.close_requested_amount || 0);
    const result = await this.close(
      id,
      { actual_closing: actual, notes: shift.close_requested_notes || '' } as any,
      userId,
    );
    await this.ds.query(
      `UPDATE shifts
          SET close_approved_at = NOW(),
              close_approved_by = $2
        WHERE id = $1`,
      [id, userId],
    );
    return { approved: true, shift: result };
  }

  /** Admin rejects → shift reopens, rejection reason is stored. */
  async rejectClose(id: string, userId: string, reason: string) {
    if (!reason?.trim()) {
      throw new BadRequestException('يجب كتابة سبب الرفض');
    }
    const [shift] = await this.ds.query(
      `SELECT status FROM shifts WHERE id = $1`,
      [id],
    );
    if (!shift) throw new NotFoundException('الوردية غير موجودة');
    if (shift.status !== 'pending_close') {
      throw new BadRequestException('الوردية ليست في انتظار الإقفال');
    }
    const [row] = await this.ds.query(
      `UPDATE shifts
          SET status                 = 'open',
              close_rejection_reason = $2,
              close_approved_by      = $3,
              close_approved_at      = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, reason, userId],
    );
    return { rejected: true, shift: row };
  }

  /** Admin inbox — every shift waiting on approval. */
  listPendingCloses() {
    return this.ds.query(
      `SELECT s.*, u.full_name AS requested_by_name, u.username AS requested_by_username
         FROM shifts s
         LEFT JOIN users u ON u.id = s.close_requested_by
        WHERE s.status = 'pending_close'
        ORDER BY s.close_requested_at DESC`,
    );
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
        u2.full_name AS closed_by_name,
        (s.actual_closing - s.expected_closing) AS variance
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

    const upperBound = shift.closed_at || new Date();
    const invoices = await this.ds.query(
      `SELECT id, invoice_no, grand_total, paid_amount, status, completed_at, created_at
         FROM invoices i
        WHERE i.shift_id = $1
           OR (i.shift_id IS NULL
               AND i.cashier_id = $2
               AND i.created_at >= $3
               AND i.created_at <= $4)
        ORDER BY COALESCE(i.completed_at, i.created_at) DESC LIMIT 200`,
      [id, shift.opened_by, shift.opened_at, upperBound],
    );
    const summary = await this.computeSummary(shift);
    return { ...shift, invoices, summary };
  }

  async currentOpen(userId: string) {
    const [row] = await this.ds.query(
      `SELECT s.*, cb.name_ar AS cashbox_name, w.name_ar AS warehouse_name
       FROM shifts s
       LEFT JOIN cashboxes cb ON cb.id = s.cashbox_id
       LEFT JOIN warehouses w ON w.id = s.warehouse_id
       WHERE s.opened_by = $1 AND s.status = 'open'
       ORDER BY s.opened_at DESC LIMIT 1`,
      [userId],
    );
    if (!row) return null;
    const summary = await this.computeSummary(row);
    return { ...row, summary };
  }
}
