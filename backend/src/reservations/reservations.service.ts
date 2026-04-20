import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ReservationEntity } from './entities/reservation.entity';
import {
  AddReservationPaymentDto,
  CancelReservationDto,
  ConvertReservationDto,
  CreateReservationDto,
  ExtendReservationDto,
  ListReservationsQueryDto,
  ReservationPaymentInputDto,
} from './dto/reservation.dto';

@Injectable()
export class ReservationsService {
  constructor(
    @InjectRepository(ReservationEntity)
    private readonly repo: Repository<ReservationEntity>,
    private readonly ds: DataSource,
  ) {}

  // --------------------------------------------------------------------------
  // CREATE  (header + items + initial deposit inside a single transaction)
  // --------------------------------------------------------------------------
  async create(dto: CreateReservationDto, userId: string) {
    const subtotal = dto.items.reduce(
      (s, it) => s + it.quantity * it.unit_price - (it.discount_amount || 0),
      0,
    );
    const discount_amount = dto.discount_amount || 0;
    const total_amount = Math.max(0, subtotal - discount_amount);
    const paid_total = dto.payments.reduce((s, p) => s + p.amount, 0);

    const depositPct = dto.deposit_required_pct ?? 30;
    const depositRequired = (total_amount * depositPct) / 100;

    if (paid_total + 0.001 < depositRequired) {
      throw new BadRequestException(
        `الدفعة المقدمة (${paid_total}) أقل من العربون المطلوب (${depositRequired.toFixed(
          2,
        )}) أي ${depositPct}% من ${total_amount}`,
      );
    }

    if (paid_total > total_amount) {
      throw new BadRequestException(
        `الدفعة المقدمة (${paid_total}) أكبر من إجمالي الحجز (${total_amount})`,
      );
    }

    return this.ds.transaction(async (em) => {
      // 1) Insert header (trigger set_reservation_no generates the doc_no)
      const [header] = await em.query(
        `
        INSERT INTO reservations
          (customer_id, warehouse_id, status, subtotal, discount_amount,
           total_amount, deposit_required_pct, refund_policy, cancellation_fee_pct,
           reserved_at, expires_at, notes, created_by)
        VALUES ($1,$2,'active',$3,$4,$5,$6,$7,$8, now(), $9, $10, $11)
        RETURNING *
        `,
        [
          dto.customer_id,
          dto.warehouse_id,
          subtotal,
          discount_amount,
          total_amount,
          depositPct,
          dto.refund_policy ?? 'partial',
          dto.cancellation_fee_pct ?? 10,
          dto.expires_at ? new Date(dto.expires_at) : null,
          dto.notes ?? null,
          userId,
        ],
      );

      // 2) Insert items (trigger holds stock as quantity_reserved)
      for (const it of dto.items) {
        const line_total =
          it.quantity * it.unit_price - (it.discount_amount || 0);
        await em.query(
          `
          INSERT INTO reservation_items
            (reservation_id, variant_id, quantity, unit_price,
             discount_amount, line_total, notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          `,
          [
            header.id,
            it.variant_id,
            it.quantity,
            it.unit_price,
            it.discount_amount ?? 0,
            line_total,
            it.notes ?? null,
          ],
        );
      }

      // 3) Insert deposit/first payment(s)
      for (const p of dto.payments) {
        await em.query(
          `
          INSERT INTO reservation_payments
            (reservation_id, payment_method, amount, kind,
             reference_number, received_by, notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          `,
          [
            header.id,
            p.payment_method,
            p.amount,
            p.kind ?? 'deposit',
            p.reference_number ?? null,
            userId,
            p.notes ?? null,
          ],
        );
      }

      // 4) Return the final (recomputed by trigger) state
      const [final] = await em.query(
        `SELECT * FROM reservations WHERE id = $1`,
        [header.id],
      );
      return {
        id: final.id,
        reservation_no: final.reservation_no,
        total_amount: Number(final.total_amount),
        paid_amount: Number(final.paid_amount),
        remaining_amount: Number(final.remaining_amount),
        status: final.status,
      };
    });
  }

  // --------------------------------------------------------------------------
  // LIST  (with search + status filter + customer filter)
  // --------------------------------------------------------------------------
  async list(q: ListReservationsQueryDto) {
    const where: string[] = [];
    const params: any[] = [];

    if (q.status) {
      params.push(q.status);
      where.push(`r.status = $${params.length}`);
    }
    if (q.customer_id) {
      params.push(q.customer_id);
      where.push(`r.customer_id = $${params.length}`);
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(
        `(r.reservation_no ILIKE $${params.length} OR c.full_name ILIKE $${params.length} OR c.phone ILIKE $${params.length})`,
      );
    }

    const limit = Math.min(Math.max(parseInt(q.limit ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0);
    params.push(limit, offset);

    const sql = `
      SELECT
        r.id, r.reservation_no, r.status,
        r.customer_id, c.full_name AS customer_name, c.phone AS customer_phone,
        r.warehouse_id,
        r.total_amount, r.paid_amount, r.refunded_amount, r.remaining_amount,
        r.reserved_at, r.expires_at, r.completed_at, r.cancelled_at,
        r.converted_invoice_id,
        (SELECT COUNT(*)::int FROM reservation_items ri WHERE ri.reservation_id = r.id) AS items_count,
        (SELECT COALESCE(SUM(quantity),0)::int FROM reservation_items ri WHERE ri.reservation_id = r.id) AS units_count
      FROM reservations r
      LEFT JOIN customers c ON c.id = r.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    return this.ds.query(sql, params);
  }

  // --------------------------------------------------------------------------
  // GET ONE  (header + items + payments + refunds)
  // --------------------------------------------------------------------------
  async findOne(id: string) {
    const [header] = await this.ds.query(
      `
      SELECT
        r.*,
        c.full_name AS customer_name,
        c.phone     AS customer_phone,
        c.email     AS customer_email,
        w.name      AS warehouse_name,
        u1.full_name AS created_by_name,
        u2.full_name AS completed_by_name,
        u3.full_name AS cancelled_by_name
      FROM reservations r
      LEFT JOIN customers  c ON c.id  = r.customer_id
      LEFT JOIN warehouses w ON w.id  = r.warehouse_id
      LEFT JOIN users     u1 ON u1.id = r.created_by
      LEFT JOIN users     u2 ON u2.id = r.completed_by
      LEFT JOIN users     u3 ON u3.id = r.cancelled_by
      WHERE r.id = $1
      `,
      [id],
    );
    if (!header) throw new NotFoundException(`Reservation ${id} not found`);

    const items = await this.ds.query(
      `
      SELECT ri.*, p.name_ar AS product_name, pv.sku, pv.barcode,
             pv.color, pv.size
      FROM reservation_items ri
      JOIN product_variants pv ON pv.id = ri.variant_id
      JOIN products p ON p.id = pv.product_id
      WHERE ri.reservation_id = $1
      ORDER BY ri.id
      `,
      [id],
    );

    const payments = await this.ds.query(
      `
      SELECT rp.*, u.full_name AS received_by_name
      FROM reservation_payments rp
      LEFT JOIN users u ON u.id = rp.received_by
      WHERE rp.reservation_id = $1
      ORDER BY rp.paid_at
      `,
      [id],
    );

    const refunds = await this.ds.query(
      `
      SELECT rr.*, u.full_name AS refunded_by_name
      FROM reservation_refunds rr
      LEFT JOIN users u ON u.id = rr.refunded_by
      WHERE rr.reservation_id = $1
      ORDER BY rr.refunded_at
      `,
      [id],
    );

    return { ...header, items, payments, refunds };
  }

  // --------------------------------------------------------------------------
  // ADD PAYMENT  (installment / final toward an open reservation)
  // --------------------------------------------------------------------------
  async addPayment(id: string, dto: AddReservationPaymentDto, userId: string) {
    const res = await this.mustBeActive(id);

    if (dto.amount > Number(res.remaining_amount) + 0.001) {
      throw new BadRequestException(
        `الدفعة (${dto.amount}) أكبر من المتبقي (${res.remaining_amount})`,
      );
    }

    await this.ds.query(
      `
      INSERT INTO reservation_payments
        (reservation_id, payment_method, amount, kind,
         reference_number, received_by, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      `,
      [
        id,
        dto.payment_method,
        dto.amount,
        dto.kind ?? 'installment',
        dto.reference_number ?? null,
        userId,
        dto.notes ?? null,
      ],
    );

    return this.findOne(id);
  }

  // --------------------------------------------------------------------------
  // CONVERT TO INVOICE  (customer collects product; closes the reservation)
  // --------------------------------------------------------------------------
  async convert(
    id: string,
    dto: ConvertReservationDto,
    userId: string,
  ) {
    const res = await this.mustBeActive(id);

    return this.ds.transaction(async (em) => {
      // 1) Gather items + totals
      const items = await em.query(
        `SELECT * FROM reservation_items WHERE reservation_id = $1`,
        [id],
      );
      if (!items.length) {
        throw new BadRequestException('الحجز لا يحتوي على أصناف');
      }

      // 2) Validate final payments cover the remaining balance (if any)
      const finalPayments: ReservationPaymentInputDto[] =
        dto.final_payments ?? [];
      const finalPaid = finalPayments.reduce((s, p) => s + p.amount, 0);
      const remaining = Number(res.remaining_amount);

      if (finalPaid + 0.001 < remaining) {
        throw new BadRequestException(
          `المبالغ المحصلة (${finalPaid}) أقل من المتبقي (${remaining})`,
        );
      }
      const change_given = Math.max(0, finalPaid - remaining);

      // 3) Release stock reservation (trigger will fire on status change)
      //    But conversion is a *sale*, so we also decrement on_hand via invoice_lines.
      await em.query(
        `UPDATE stock
           SET quantity_reserved = GREATEST(0, quantity_reserved - ri.quantity)
          FROM reservation_items ri
         WHERE ri.reservation_id = $1
           AND stock.variant_id   = ri.variant_id
           AND stock.warehouse_id = $2`,
        [id, res.warehouse_id],
      );

      // 4) Create invoice (status=completed)  → triggers decrement on_hand + log movements
      const [{ doc_no }] = await em.query(
        `SELECT next_doc_no('INV') AS doc_no`,
      );

      const [invoice] = await em.query(
        `
        INSERT INTO invoices
          (doc_no, customer_id, warehouse_id, cashier_id, reservation_id,
           status, subtotal, discount_total, grand_total,
           paid_total, change_given, notes, completed_at)
        VALUES ($1,$2,$3,$4,$5,'completed',$6,$7,$8,$9,$10,$11, now())
        RETURNING *
        `,
        [
          doc_no,
          res.customer_id,
          res.warehouse_id,
          userId,
          id,
          Number(res.subtotal),
          Number(res.discount_amount),
          Number(res.total_amount),
          Number(res.paid_amount) + finalPaid,
          change_given,
          dto.notes ?? `Converted from reservation ${res.reservation_no}`,
        ],
      );

      // 5) Invoice lines
      for (const it of items) {
        await em.query(
          `
          INSERT INTO invoice_lines
            (invoice_id, variant_id, warehouse_id, qty, unit_price, discount, line_total)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          `,
          [
            invoice.id,
            it.variant_id,
            res.warehouse_id,
            it.quantity,
            Number(it.unit_price),
            Number(it.discount_amount),
            Number(it.line_total),
          ],
        );
      }

      // 6) Record the final payments against the invoice (cashbox + ledger)
      for (const p of finalPayments) {
        await em.query(
          `
          INSERT INTO invoice_payments
            (invoice_id, payment_method, amount, reference)
          VALUES ($1,$2,$3,$4)
          `,
          [invoice.id, p.payment_method, p.amount, p.reference_number ?? null],
        );

        // Also record on the reservation so history is preserved
        await em.query(
          `
          INSERT INTO reservation_payments
            (reservation_id, payment_method, amount, kind,
             reference_number, received_by, notes)
          VALUES ($1,$2,$3,'final',$4,$5,$6)
          `,
          [
            id,
            p.payment_method,
            p.amount,
            p.reference_number ?? null,
            userId,
            `Collected at conversion to ${doc_no}`,
          ],
        );
      }

      // 7) Close the reservation
      await em.query(
        `
        UPDATE reservations
           SET status               = 'completed',
               completed_at         = now(),
               completed_by         = $2,
               converted_invoice_id = $3
         WHERE id = $1
        `,
        [id, userId, invoice.id],
      );

      return {
        reservation_id: id,
        invoice_id: invoice.id,
        doc_no: invoice.doc_no,
        change_given,
      };
    });
  }

  // --------------------------------------------------------------------------
  // CANCEL  (releases stock; records refund per policy)
  // --------------------------------------------------------------------------
  async cancel(id: string, dto: CancelReservationDto, userId: string) {
    const res = await this.mustBeActive(id);

    const policy = dto.refund_policy ?? res.refund_policy;
    const paid = Number(res.paid_amount);
    const feePct = Number(res.cancellation_fee_pct);
    let gross = 0;
    let fee = 0;
    let net = 0;

    if (policy === 'full') {
      gross = paid;
      fee = 0;
      net = paid;
    } else if (policy === 'partial') {
      gross = paid;
      fee = Math.round((paid * feePct) / 100 * 100) / 100;
      net = Math.max(0, paid - fee);
    } else {
      // policy === 'none'
      gross = 0;
      fee = 0;
      net = 0;
    }

    return this.ds.transaction(async (em) => {
      // 1) Record refund row (if any)
      if (net > 0) {
        await em.query(
          `
          INSERT INTO reservation_refunds
            (reservation_id, payment_method, gross_amount, fee_amount,
             net_refund_amount, reason, approved_by, refunded_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          `,
          [
            id,
            dto.refund_method ?? 'cash',
            gross,
            fee,
            net,
            dto.reason,
            userId,
            userId,
          ],
        );
      }

      // 2) Update status → trigger releases stock.quantity_reserved
      await em.query(
        `
        UPDATE reservations
           SET status              = 'cancelled',
               cancelled_at        = now(),
               cancelled_by        = $2,
               cancellation_reason = $3
         WHERE id = $1
        `,
        [id, userId, dto.reason],
      );

      return {
        reservation_id: id,
        cancelled: true,
        refund: { policy, gross, fee, net },
      };
    });
  }

  // --------------------------------------------------------------------------
  // EXTEND  (push expiry_date)
  // --------------------------------------------------------------------------
  async extend(id: string, dto: ExtendReservationDto) {
    const res = await this.mustBeActive(id);
    const newExp = new Date(dto.expires_at);
    if (newExp <= new Date()) {
      throw new BadRequestException('تاريخ التمديد يجب أن يكون في المستقبل');
    }
    await this.ds.query(
      `UPDATE reservations SET expires_at = $2 WHERE id = $1`,
      [id, newExp],
    );
    return this.findOne(id);
  }

  // --------------------------------------------------------------------------
  // helper
  // --------------------------------------------------------------------------
  private async mustBeActive(id: string): Promise<ReservationEntity> {
    const res = await this.repo.findOne({ where: { id } });
    if (!res) throw new NotFoundException(`Reservation ${id} not found`);
    if (res.status !== 'active') {
      throw new ConflictException(
        `لا يمكن تعديل حجز بحالة ${res.status}. يجب أن يكون 'active'.`,
      );
    }
    return res;
  }
}
