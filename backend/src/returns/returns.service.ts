import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ReturnEntity } from './entities/return.entity';
import {
  ApproveReturnDto,
  CreateExchangeDto,
  CreateReturnDto,
  ListReturnsQueryDto,
  RefundReturnDto,
  RejectReturnDto,
} from './dto/return.dto';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';

@Injectable()
export class ReturnsService {
  constructor(
    @InjectRepository(ReturnEntity)
    private readonly repo: Repository<ReturnEntity>,
    private readonly ds: DataSource,
    @Optional() private readonly posting?: AccountingPostingService,
  ) {}

  // ==========================================================================
  //  RETURNS  (customer returns items from an invoice for refund)
  // ==========================================================================

  /**
   * Step 1: Create a return in `pending` status.
   *   - Validates the invoice exists and qty doesn't exceed what was sold
   *     minus what was already returned.
   *   - No stock movement yet — that happens on approve/refund.
   */
  async createReturn(dto: CreateReturnDto, userId: string) {
    // Walk-in / lost-receipt flow: no original_invoice_id. Skip all
    // the per-line invoice validation and just require a warehouse
    // + variants to know where stock lands.
    const standalone = !dto.original_invoice_id;

    let invoice: any = null;
    if (!standalone) {
      const [inv] = await this.ds.query(
        `SELECT * FROM invoices WHERE id = $1`,
        [dto.original_invoice_id],
      );
      if (!inv) throw new NotFoundException('الفاتورة غير موجودة');
      if (inv.status !== 'completed' && inv.status !== 'paid') {
        throw new BadRequestException(
          `لا يمكن عمل مرتجع لفاتورة بحالة "${inv.status}"`,
        );
      }
      invoice = inv;

      for (const it of dto.items) {
        if (!it.original_invoice_item_id) {
          throw new BadRequestException(
            'يجب اختيار السطر الأصلي لكل صنف عند ارجاع من فاتورة',
          );
        }
        const [orig] = await this.ds.query(
          `SELECT quantity, variant_id FROM invoice_items
            WHERE id = $1 AND invoice_id = $2`,
          [it.original_invoice_item_id, dto.original_invoice_id],
        );
        if (!orig) {
          throw new BadRequestException(
            `العنصر ${it.original_invoice_item_id} ليس من هذه الفاتورة`,
          );
        }
        if (orig.variant_id !== it.variant_id) {
          throw new BadRequestException('variant_id لا يطابق السطر الأصلي');
        }

        const [{ already_returned }] = await this.ds.query(
          `
          SELECT COALESCE(SUM(ri.quantity),0)::int AS already_returned
            FROM return_items ri
            JOIN returns r ON r.id = ri.return_id
           WHERE ri.original_invoice_item_id = $1
             AND r.status IN ('approved','refunded')
          `,
          [it.original_invoice_item_id],
        );

        const remaining = Number(orig.quantity) - Number(already_returned);
        if (it.quantity > remaining) {
          throw new BadRequestException(
            `لا يمكن إرجاع ${it.quantity} — الكمية المتاحة للإرجاع ${remaining}`,
          );
        }
      }
    } else {
      // Standalone — ensure every line has a variant_id and a
      // warehouse was provided (fallback to the default if missing).
      if (!dto.warehouse_id) {
        const [w] = await this.ds.query(
          `SELECT id FROM warehouses WHERE is_active = TRUE ORDER BY created_at LIMIT 1`,
        );
        if (!w) {
          throw new BadRequestException('لا يوجد مخزن افتراضي للمرتجعات');
        }
        dto.warehouse_id = w.id;
      }
      for (const it of dto.items) {
        if (!it.variant_id) {
          throw new BadRequestException('كل صنف لازم يحدد variant_id');
        }
      }
    }

    const total_refund = dto.items.reduce((s, i) => s + i.refund_amount, 0);
    const restocking_fee = dto.restocking_fee || 0;
    const net_refund = Math.max(0, total_refund - restocking_fee);

    return this.ds.transaction(async (em) => {
      const [ret] = await em.query(
        `
        INSERT INTO returns
          (original_invoice_id, customer_id, warehouse_id, status,
           reason, reason_details,
           total_refund, restocking_fee, net_refund, refund_method,
           requested_by, notes)
        VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *
        `,
        [
          dto.original_invoice_id ?? null,
          dto.customer_id ?? invoice?.customer_id ?? null,
          invoice?.warehouse_id ?? dto.warehouse_id,
          dto.reason ?? 'other',
          dto.reason_details ?? null,
          total_refund,
          restocking_fee,
          net_refund,
          dto.refund_method ?? null,
          userId,
          dto.notes ?? null,
        ],
      );

      for (const it of dto.items) {
        await em.query(
          `
          INSERT INTO return_items
            (return_id, original_invoice_item_id, variant_id, quantity,
             unit_price, refund_amount, condition, back_to_stock, notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          `,
          [
            ret.id,
            it.original_invoice_item_id ?? null,
            it.variant_id,
            it.quantity,
            it.unit_price,
            it.refund_amount,
            it.condition ?? 'resellable',
            it.back_to_stock ?? true,
            it.notes ?? null,
          ],
        );
      }

      return {
        id: ret.id,
        return_no: ret.return_no,
        status: ret.status,
        total_refund: Number(ret.total_refund),
        net_refund: Number(ret.net_refund),
      };
    });
  }

  /**
   * Step 2: Approve — manager confirms the return; stock is restored for
   * resellable items flagged `back_to_stock`.
   */
  async approve(id: string, dto: ApproveReturnDto, userId: string) {
    const ret = await this.mustBeStatus(id, ['pending']);

    return this.ds.transaction(async (em) => {
      // Restore stock for resellable items
      const items = await em.query(
        `SELECT * FROM return_items WHERE return_id = $1`,
        [id],
      );
      for (const it of items) {
        if (it.back_to_stock && it.condition === 'resellable') {
          // Positive delta = stock-in
          await em.query(
            `SELECT fn_adjust_stock($1, $2, $3, $4, $5, $6)`,
            [
              it.variant_id,
              ret.warehouse_id,
              Number(it.quantity),
              `return:${ret.return_no}`,
              Number(it.unit_price),
              userId,
            ],
          );
        }
      }

      await em.query(
        `
        UPDATE returns
           SET status      = 'approved',
               approved_at = now(),
               approved_by = $2,
               notes       = COALESCE(notes,'') || $3
         WHERE id = $1
        `,
        [id, userId, dto.notes ? `\n[Approved] ${dto.notes}` : ''],
      );

      // Auto-post the return to the GL (reverse sale + restore inventory).
      await this.posting
        ?.postReturn(id, userId, em)
        .catch(() => undefined);

      return this.findOne(id);
    });
  }

  /**
   * Step 3: Refund — actually pay the customer back.
   *   - Records a cashbox out-flow via customer_payments (negative) or a
   *     simple journal record. We use a reservation_refunds-like
   *     customer_payments row with a negative effect by convention.
   *   - For simplicity here we just stamp the return as refunded and log to
   *     customer ledger via an outflow in cash-desk style.
   */
  async refund(id: string, dto: RefundReturnDto, userId: string) {
    const ret = await this.mustBeStatus(id, ['approved']);

    return this.ds.transaction(async (em) => {
      // Persist refund method on the return row
      await em.query(
        `
        UPDATE returns
           SET status        = 'refunded',
               refunded_at   = now(),
               refunded_by   = $2,
               refund_method = $3
         WHERE id = $1
        `,
        [id, userId, dto.refund_method],
      );

      // Cash refund → deduct from cashbox automatically.
      if (dto.refund_method === 'cash') {
        // Look up a cashbox: prefer the user's open shift, else the warehouse default.
        const [shift] = await em.query(
          `SELECT cashbox_id FROM shifts
             WHERE opened_by = $1 AND status='open'
             ORDER BY opened_at DESC LIMIT 1`,
          [userId],
        );
        let cashboxId: string | null = shift?.cashbox_id ?? null;
        if (!cashboxId) {
          const [cb] = await em.query(
            `SELECT c.id FROM cashboxes c
               JOIN returns r ON r.warehouse_id = c.warehouse_id
              WHERE r.id = $1 AND c.is_active = true
              ORDER BY c.created_at LIMIT 1`,
            [id],
          );
          cashboxId = cb?.id ?? null;
        }
        if (cashboxId) {
          await em.query(
            `SELECT fn_record_cashbox_txn($1,'out',$2,'refund','return',$3,$4,$5)`,
            [
              cashboxId,
              Number(ret.net_refund),
              id,
              userId,
              `استرداد نقدي — مرتجع ${ret.return_no}`,
            ],
          );
        }
      }

      // Ledger entry (best-effort; don't block the refund if schema differs)
      await em.query(
        `
        INSERT INTO general_ledger_entries
          (entry_type, reference_type, reference_id,
           debit_account, credit_account, amount, description, created_by)
        VALUES
          ('refund','return',$1,
           'returns_expense','cash',$2,$3,$4)
        ON CONFLICT DO NOTHING
        `,
        [
          id,
          Number(ret.net_refund),
          `Refund for return ${ret.return_no} via ${dto.refund_method}`,
          userId,
        ],
      ).catch(() => {
        /* if the ledger table/cols differ we don't want to block the refund */
      });

      return this.findOne(id);
    });
  }

  async reject(id: string, dto: RejectReturnDto, userId: string) {
    await this.mustBeStatus(id, ['pending']);
    await this.ds.query(
      `
      UPDATE returns
         SET status      = 'rejected',
             rejected_at = now(),
             notes       = COALESCE(notes,'') || $2
       WHERE id = $1
      `,
      [id, `\n[Rejected by ${userId}] ${dto.reason}`],
    );
    return this.findOne(id);
  }

  // ==========================================================================
  //  LIST / GET
  // ==========================================================================

  async list(q: ListReturnsQueryDto) {
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
        `(r.return_no ILIKE $${params.length} OR i.invoice_no ILIKE $${params.length} OR c.full_name ILIKE $${params.length})`,
      );
    }
    const limit = Math.min(
      Math.max(parseInt(q.limit ?? '50', 10) || 50, 1),
      200,
    );
    const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0);
    params.push(limit, offset);

    return this.ds.query(
      `
      SELECT
        r.id, r.return_no, r.status, r.reason,
        r.total_refund, r.restocking_fee, r.net_refund, r.refund_method,
        r.requested_at, r.approved_at, r.refunded_at, r.rejected_at,
        r.original_invoice_id, i.invoice_no,
        r.customer_id, c.full_name AS customer_name, c.phone AS customer_phone,
        (SELECT COUNT(*)::int FROM return_items ri WHERE ri.return_id = r.id) AS items_count,
        (SELECT COALESCE(SUM(quantity),0)::int FROM return_items ri WHERE ri.return_id = r.id) AS units_count
      FROM returns r
      LEFT JOIN invoices  i ON i.id = r.original_invoice_id
      LEFT JOIN customers c ON c.id = r.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.requested_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params,
    );
  }

  async findOne(id: string) {
    const [header] = await this.ds.query(
      `
      SELECT
        r.*,
        i.invoice_no, i.completed_at AS invoice_date,
        c.full_name AS customer_name, c.phone AS customer_phone,
        w.name AS warehouse_name,
        u1.full_name AS requested_by_name,
        u2.full_name AS approved_by_name,
        u3.full_name AS refunded_by_name
      FROM returns r
      LEFT JOIN invoices  i ON i.id  = r.original_invoice_id
      LEFT JOIN customers c ON c.id  = r.customer_id
      LEFT JOIN warehouses w ON w.id = r.warehouse_id
      LEFT JOIN users    u1 ON u1.id = r.requested_by
      LEFT JOIN users    u2 ON u2.id = r.approved_by
      LEFT JOIN users    u3 ON u3.id = r.refunded_by
      WHERE r.id = $1
      `,
      [id],
    );
    if (!header) throw new NotFoundException(`Return ${id} not found`);

    const items = await this.ds.query(
      `
      SELECT ri.*,
             p.name_ar AS product_name,
             pv.sku, pv.barcode, pv.color, pv.size
      FROM return_items ri
      JOIN product_variants pv ON pv.id = ri.variant_id
      JOIN products p ON p.id = pv.product_id
      WHERE ri.return_id = $1
      ORDER BY ri.id
      `,
      [id],
    );

    return { ...header, items };
  }

  /**
   * Lookup an invoice by its number + return its items with
   * the remaining quantity already-returned subtracted.
   * Useful for the frontend "create return" workflow.
   */
  async lookupInvoice(invoiceNo: string) {
    const [inv] = await this.ds.query(
      `
      SELECT
        i.id, i.invoice_no, i.completed_at, i.grand_total, i.paid_amount, i.status,
        i.customer_id, c.full_name AS customer_name, c.phone AS customer_phone,
        i.warehouse_id, w.name AS warehouse_name
      FROM invoices i
      LEFT JOIN customers c  ON c.id = i.customer_id
      LEFT JOIN warehouses w ON w.id = i.warehouse_id
      WHERE i.invoice_no = $1
      `,
      [invoiceNo],
    );
    if (!inv) throw new NotFoundException(`فاتورة ${invoiceNo} غير موجودة`);
    if (inv.status !== 'completed' && inv.status !== 'paid') {
      throw new BadRequestException(
        `لا يمكن إرجاع عناصر من فاتورة بحالة "${inv.status}"`,
      );
    }

    const items = await this.ds.query(
      `
      SELECT
        ii.id AS invoice_item_id,
        ii.variant_id,
        ii.product_name_snapshot AS product_name,
        ii.sku_snapshot AS sku,
        ii.color_name_snapshot AS color,
        ii.size_label_snapshot AS size,
        ii.quantity AS original_quantity,
        ii.unit_price,
        ii.line_total,
        (
          SELECT COALESCE(SUM(ri.quantity),0)::int
            FROM return_items ri
            JOIN returns r ON r.id = ri.return_id
           WHERE ri.original_invoice_item_id = ii.id
             AND r.status IN ('approved','refunded')
        ) AS already_returned
      FROM invoice_items ii
      WHERE ii.invoice_id = $1
      ORDER BY ii.id
      `,
      [inv.id],
    );

    return {
      invoice: inv,
      items: items.map((r: any) => ({
        ...r,
        available_to_return:
          Number(r.original_quantity) - Number(r.already_returned),
      })),
    };
  }

  // ==========================================================================
  //  EXCHANGES
  // ==========================================================================

  /**
   * One-shot exchange:
   *   - Restore stock for returned items (if resellable).
   *   - Create a new invoice (status=completed) for new items.
   *   - Record price difference as either a customer payment or refund.
   */
  async createExchange(dto: CreateExchangeDto, userId: string) {
    const [invoice] = await this.ds.query(
      `SELECT * FROM invoices WHERE id = $1`,
      [dto.original_invoice_id],
    );
    if (!invoice) {
      throw new NotFoundException('الفاتورة الأصلية غير موجودة');
    }

    const returned_value = dto.returned_items.reduce(
      (s, i) => s + i.quantity * i.unit_price,
      0,
    );
    const new_items_value = dto.new_items.reduce(
      (s, i) => s + i.quantity * i.unit_price,
      0,
    );
    const price_difference = new_items_value - returned_value;

    if (price_difference > 0 && !dto.payment_method) {
      throw new BadRequestException(
        'الفرق مستحق على العميل — أدخل payment_method',
      );
    }
    if (price_difference < 0 && !dto.refund_method) {
      throw new BadRequestException(
        'العميل له فرق مرتجع — أدخل refund_method',
      );
    }

    return this.ds.transaction(async (em) => {
      // 1) Create exchange header (trigger generates exchange_no)
      const [exc] = await em.query(
        `
        INSERT INTO exchanges
          (original_invoice_id, customer_id, warehouse_id,
           returned_value, new_items_value,
           payment_method, refund_method,
           status, reason, reason_details,
           handled_by, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'completed',$8,$9,$10,$11)
        RETURNING *
        `,
        [
          dto.original_invoice_id,
          invoice.customer_id,
          invoice.warehouse_id,
          returned_value,
          new_items_value,
          dto.payment_method ?? null,
          dto.refund_method ?? null,
          dto.reason ?? 'other',
          dto.reason_details ?? null,
          userId,
          dto.notes ?? null,
        ],
      );

      // 2) Insert exchange_items (both returned + new)
      for (const it of dto.returned_items) {
        await em.query(
          `
          INSERT INTO exchange_items
            (exchange_id, variant_id, kind, quantity, unit_price,
             line_total, condition, notes)
          VALUES ($1,$2,'returned',$3,$4,$5,$6,$7)
          `,
          [
            exc.id,
            it.variant_id,
            it.quantity,
            it.unit_price,
            it.quantity * it.unit_price,
            it.condition ?? 'resellable',
            it.notes ?? null,
          ],
        );

        // restore stock if resellable
        if ((it.condition ?? 'resellable') === 'resellable') {
          await em.query(
            `SELECT fn_adjust_stock($1,$2,$3,$4,$5,$6)`,
            [
              it.variant_id,
              invoice.warehouse_id,
              Number(it.quantity),
              `exchange:${exc.exchange_no}`,
              Number(it.unit_price),
              userId,
            ],
          );
        }
      }

      for (const it of dto.new_items) {
        await em.query(
          `
          INSERT INTO exchange_items
            (exchange_id, variant_id, kind, quantity, unit_price,
             line_total, condition, notes)
          VALUES ($1,$2,'new',$3,$4,$5,'resellable',$6)
          `,
          [
            exc.id,
            it.variant_id,
            it.quantity,
            it.unit_price,
            it.quantity * it.unit_price,
            it.notes ?? null,
          ],
        );
      }

      // 3) Create a new invoice for the new items (fires stock decrement via triggers)
      const [newInv] = await em.query(
        `
        INSERT INTO invoices
          (warehouse_id, customer_id, cashier_id, status, is_exchange,
           parent_invoice_id, source,
           subtotal, grand_total, paid_amount, change_amount,
           notes, completed_at)
        VALUES ($1,$2,$3,'completed', TRUE, $4,'pos',
                $5,$5,$6,0,$7, now())
        RETURNING *
        `,
        [
          invoice.warehouse_id,
          invoice.customer_id,
          userId,
          dto.original_invoice_id,
          new_items_value,
          Math.max(0, price_difference),
          `Exchange ${exc.exchange_no} for invoice ${invoice.invoice_no}`,
        ],
      );

      for (const it of dto.new_items) {
        // Fetch snapshot info
        const [pv] = await em.query(
          `
          SELECT pv.sku, pv.color, pv.size, p.name_ar
          FROM product_variants pv
          JOIN products p ON p.id = pv.product_id
          WHERE pv.id = $1
          `,
          [it.variant_id],
        );
        await em.query(
          `
          INSERT INTO invoice_items
            (invoice_id, variant_id,
             product_name_snapshot, sku_snapshot,
             color_name_snapshot, size_label_snapshot,
             quantity, unit_price, line_subtotal, line_total)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
          `,
          [
            newInv.id,
            it.variant_id,
            pv?.name_ar ?? '',
            pv?.sku ?? '',
            pv?.color ?? null,
            pv?.size ?? null,
            it.quantity,
            it.unit_price,
            it.quantity * it.unit_price,
          ],
        );
      }

      // 4) Payment for the positive price difference
      if (price_difference > 0) {
        await em.query(
          `
          INSERT INTO invoice_payments
            (invoice_id, payment_method, amount, received_by)
          VALUES ($1,$2,$3,$4)
          `,
          [newInv.id, dto.payment_method, price_difference, userId],
        );
      }

      // 5) Link new invoice to exchange
      await em.query(
        `UPDATE exchanges SET new_invoice_id = $2, completed_at = now() WHERE id = $1`,
        [exc.id, newInv.id],
      );

      return {
        exchange_id: exc.id,
        exchange_no: exc.exchange_no,
        new_invoice_id: newInv.id,
        new_invoice_no: newInv.invoice_no,
        returned_value,
        new_items_value,
        price_difference,
      };
    });
  }

  async getExchange(id: string) {
    const [header] = await this.ds.query(
      `
      SELECT e.*,
             oi.invoice_no AS original_invoice_no,
             ni.invoice_no AS new_invoice_no,
             c.full_name AS customer_name,
             u.full_name AS handled_by_name
      FROM exchanges e
      LEFT JOIN invoices oi ON oi.id = e.original_invoice_id
      LEFT JOIN invoices ni ON ni.id = e.new_invoice_id
      LEFT JOIN customers c ON c.id = e.customer_id
      LEFT JOIN users    u ON u.id = e.handled_by
      WHERE e.id = $1
      `,
      [id],
    );
    if (!header) throw new NotFoundException(`Exchange ${id} not found`);

    const items = await this.ds.query(
      `
      SELECT ei.*, p.name_ar AS product_name,
             pv.sku, pv.color, pv.size
      FROM exchange_items ei
      JOIN product_variants pv ON pv.id = ei.variant_id
      JOIN products p ON p.id = pv.product_id
      WHERE ei.exchange_id = $1
      ORDER BY ei.kind DESC, ei.id
      `,
      [id],
    );
    return { ...header, items };
  }

  async listExchanges(q: ListReturnsQueryDto) {
    const where: string[] = [];
    const params: any[] = [];
    if (q.customer_id) {
      params.push(q.customer_id);
      where.push(`e.customer_id = $${params.length}`);
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(
        `(e.exchange_no ILIKE $${params.length} OR oi.invoice_no ILIKE $${params.length})`,
      );
    }
    const limit = Math.min(
      Math.max(parseInt(q.limit ?? '50', 10) || 50, 1),
      200,
    );
    const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0);
    params.push(limit, offset);

    return this.ds.query(
      `
      SELECT e.id, e.exchange_no, e.status,
             e.returned_value, e.new_items_value, e.price_difference,
             e.created_at, e.completed_at,
             oi.invoice_no AS original_invoice_no,
             ni.invoice_no AS new_invoice_no,
             c.full_name AS customer_name, c.phone AS customer_phone
      FROM exchanges e
      LEFT JOIN invoices oi ON oi.id = e.original_invoice_id
      LEFT JOIN invoices ni ON ni.id = e.new_invoice_id
      LEFT JOIN customers c ON c.id = e.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params,
    );
  }

  // ==========================================================================
  //  helpers
  // ==========================================================================

  private async mustBeStatus(
    id: string,
    allowed: Array<'pending' | 'approved' | 'refunded' | 'rejected'>,
  ): Promise<ReturnEntity> {
    const ret = await this.repo.findOne({ where: { id } });
    if (!ret) throw new NotFoundException(`Return ${id} not found`);
    if (!allowed.includes(ret.status)) {
      throw new ConflictException(
        `المرتجع حالته "${ret.status}" — العمليات المسموحة: ${allowed.join(', ')}`,
      );
    }
    return ret;
  }
}
