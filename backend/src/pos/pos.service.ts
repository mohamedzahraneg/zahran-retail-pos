import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { InvoiceEntity } from './entities/invoice.entity';
import { CreateInvoiceDto } from './dto/invoice.dto';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';
import { PaymentsService } from '../payments/payments.service';
import { resolveLogoKey } from '../payments/providers.catalog';
import { ShiftsService } from '../shifts/shifts.service';

/**
 * PR-POS-INVOICE-DELTA-1 — classify an invoice edit as monetary-only
 * or structural.
 *
 * Monetary-only means: the set of `(variant_id, quantity)` pairs is
 * unchanged, the payment shape (count + multiset of payment_method +
 * payment_account_id) is unchanged, and the customer_id is unchanged.
 * Only `unit_price`, per-line `discount`, invoice-level
 * `discount_total`, and per-payment `amount` may have moved — i.e.
 * the cash mathematically changed but no products / quantities / GL
 * routing did.
 *
 * Returns `{ monetary_only: false }` for structural edits — the
 * caller falls through to the legacy reverse-and-repost path.
 *
 * Returns `{ monetary_only: true, delta }` for monetary-only edits,
 * where `delta = (sum of new dto.payments.amount) − orig.paid_amount`.
 *
 *   delta > 0 → applyMonetaryDeltaEdit posts one additive sale JE+CT
 *               + appends one `+delta` `invoice_payments` row.
 *   delta = 0 → applyMonetaryDeltaEdit updates invoice metadata only;
 *               no GL/CT/payment writes.
 *   delta < 0 → applyMonetaryDeltaEdit returns
 *               `{ monetary_only: false }` (delegated structurally)
 *               because `invoice_payments.amount > 0` blocks a
 *               negative delta payment row.  See PR halt report.
 */
export function classifyInvoiceEdit(
  orig: { paid_amount: number | string; customer_id: string | null },
  origItems: Array<{ variant_id: string; quantity: number | string }>,
  origPayments: Array<{
    payment_method: string;
    amount: number | string;
    payment_account_id: string | null;
  }>,
  dto: {
    lines: Array<{ variant_id: string; qty: number; unit_price?: number; discount?: number }>;
    payments?: Array<{ payment_method: string; amount: number; payment_account_id?: string | null }>;
    customer_id?: string | null;
  },
): { monetary_only: true; delta: number } | { monetary_only: false; reason: string } {
  // ── 1) Lines: same variant_id + same quantity per variant, same count
  const dtoLines = dto.lines ?? [];
  if (dtoLines.length !== origItems.length) {
    return { monetary_only: false, reason: 'line_count_changed' };
  }
  // Aggregate qty per variant (multiple rows for the same variant collapse).
  const origQtyByVariant = new Map<string, number>();
  for (const i of origItems) {
    const key = i.variant_id;
    origQtyByVariant.set(
      key,
      (origQtyByVariant.get(key) ?? 0) + Number(i.quantity),
    );
  }
  const dtoQtyByVariant = new Map<string, number>();
  for (const l of dtoLines) {
    dtoQtyByVariant.set(
      l.variant_id,
      (dtoQtyByVariant.get(l.variant_id) ?? 0) + Number(l.qty),
    );
  }
  if (origQtyByVariant.size !== dtoQtyByVariant.size) {
    return { monetary_only: false, reason: 'variant_set_changed' };
  }
  // Two passes so the failure reason is precise: first verify the
  // variant_id sets match (a swap reads as 'variant_set_changed', not
  // 'qty_changed' just because the missing variant has undefined qty).
  for (const variantId of origQtyByVariant.keys()) {
    if (!dtoQtyByVariant.has(variantId)) {
      return { monetary_only: false, reason: 'variant_set_changed' };
    }
  }
  for (const [variantId, qty] of origQtyByVariant) {
    if (dtoQtyByVariant.get(variantId) !== qty) {
      return { monetary_only: false, reason: 'qty_changed' };
    }
  }

  // ── 2) Payment shape: same count, same multiset of (method, account)
  const dtoPayments = dto.payments ?? [];
  if (dtoPayments.length !== origPayments.length) {
    return { monetary_only: false, reason: 'payment_count_changed' };
  }
  const keyOf = (p: { payment_method: string; payment_account_id?: string | null }) =>
    `${p.payment_method}|${p.payment_account_id ?? ''}`;
  const origKeys = origPayments.map(keyOf).sort();
  const dtoKeys = dtoPayments.map(keyOf).sort();
  for (let i = 0; i < origKeys.length; i++) {
    if (origKeys[i] !== dtoKeys[i]) {
      return { monetary_only: false, reason: 'payment_shape_changed' };
    }
  }

  // ── 3) Customer unchanged when specified
  if (
    dto.customer_id != null &&
    dto.customer_id !== orig.customer_id
  ) {
    return { monetary_only: false, reason: 'customer_changed' };
  }

  // ── 4) Compute delta from payment amounts
  const newPaid = dtoPayments.reduce((s, p) => s + Number(p.amount || 0), 0);
  const oldPaid = Number(orig.paid_amount || 0);
  const delta = +(newPaid - oldPaid).toFixed(2);

  // Negative delta cannot use the delta-payment path (CHECK constraint
  // on invoice_payments.amount > 0).  Treat as structural and fall
  // through to legacy reverse-and-repost.
  if (delta < 0) {
    return { monetary_only: false, reason: 'negative_delta_uses_legacy_path' };
  }

  return { monetary_only: true, delta };
}

@Injectable()
export class PosService {
  constructor(
    @InjectRepository(InvoiceEntity)
    private readonly invoices: Repository<InvoiceEntity>,
    private readonly ds: DataSource,
    @Optional() private readonly realtime?: RealtimeGateway,
    @Optional() private readonly loyalty?: LoyaltyService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly posting?: AccountingPostingService,
    @Optional() private readonly engine?: FinancialEngineService,
    @Optional() private readonly payments?: PaymentsService,
    // PR-FIX-POS-INVOICE-EDIT-REFRESH-CLOSED-SHIFT-SNAPSHOT
    // Used by editInvoice to refresh the parent shift's stored
    // close-time snapshot when an invoice belonging to a closed
    // shift is edited (cash↔non-cash payment-method swap, amount
    // change, etc.). @Optional so existing unit tests that stub a
    // bare PosService keep working.
    @Optional() private readonly shifts?: ShiftsService,
  ) {}

  /**
   * Creates a full invoice atomically. invoice_no is auto-generated by the
   * BEFORE INSERT trigger (trg_set_invoice_no → next_doc_no('INV',...)).
   */
  async createInvoice(dto: CreateInvoiceDto, userId: string) {
    if (!dto.lines?.length) {
      throw new BadRequestException('Invoice must have at least one line');
    }

    // Salesperson is required on every invoice so performance reports and
    // commissions can attribute the sale. Front-end enforces this too; the
    // backend check is the source of truth.
    if (!dto.salesperson_id) {
      throw new BadRequestException('يجب اختيار البائع قبل حفظ الفاتورة');
    }

    // Require an open shift for the cashier before accepting a sale. Falls
    // back to any open shift this user holds (warehouse mismatch shouldn't
    // block the sale, but *no open shift* means the cashier is off-duty).
    const [openShift] = await this.ds.query(
      `SELECT id FROM shifts
         WHERE opened_by = $1 AND status = 'open'
         ORDER BY opened_at DESC LIMIT 1`,
      [userId],
    );
    if (!openShift) {
      throw new BadRequestException(
        'لا يمكن تسجيل فاتورة قبل فتح وردية جديدة — برجاء فتح الوردية أولاً',
      );
    }

    const subtotal = dto.lines.reduce(
      (s, l) => s + l.unit_price * l.qty - (l.discount || 0),
      0,
    );

    // VAT config (from settings) ───────────────────────────────────
    // Egypt standard: 14%, prices inclusive of VAT.
    const [vatRow] = await this.ds.query(
      `SELECT value FROM settings WHERE key = 'vat.config'`,
    );
    const vatConfig = vatRow?.value || {
      enabled: false,
      rate: 0,
      inclusive: true,
    };
    const vatEnabled = !!vatConfig.enabled;
    const vatRate: number = vatEnabled ? Number(vatConfig.rate || 0) : 0;
    const vatInclusive: boolean = vatConfig.inclusive !== false;

    // Loyalty redemption (optional)
    let loyalty_discount = 0;
    let applied_points = 0;
    if (dto.customer_id && dto.redeem_points && dto.redeem_points > 0) {
      if (!this.loyalty) {
        throw new BadRequestException('Loyalty service not available');
      }
      const preview = await this.loyalty.preview(
        dto.customer_id,
        dto.redeem_points,
        subtotal,
      );
      loyalty_discount = preview.applied_egp;
      applied_points = preview.applied_points;
    }

    const invoice_discount = (dto.discount_total || 0) + loyalty_discount;
    const net_before_tax = Math.max(0, subtotal - invoice_discount);

    // VAT computation:
    //  inclusive  → price already contains VAT → tax = gross * rate / (100 + rate)
    //  exclusive  → add tax on top → tax = net * rate / 100
    let tax_amount = 0;
    let grand_total = net_before_tax;
    if (vatEnabled && vatRate > 0) {
      if (vatInclusive) {
        tax_amount = (net_before_tax * vatRate) / (100 + vatRate);
        grand_total = net_before_tax;
      } else {
        tax_amount = (net_before_tax * vatRate) / 100;
        grand_total = net_before_tax + tax_amount;
      }
      tax_amount = Math.round(tax_amount * 100) / 100;
      grand_total = Math.round(grand_total * 100) / 100;
    }

    const paid_total = dto.payments.reduce((s, p) => s + p.amount, 0);

    if (paid_total < grand_total) {
      throw new BadRequestException(
        `Payment short: paid ${paid_total} < total ${grand_total}`,
      );
    }
    const change_amount = Math.max(0, paid_total - grand_total);

    // Pre-load variant + product info so we can snapshot name / sku / color / size
    const variantIds = Array.from(
      new Set(dto.lines.map((l) => l.variant_id)),
    );
    const variants = await this.ds.query(
      `
      SELECT v.id, v.sku, v.cost_price,
             c.name_ar    AS color_name,
             s.size_label AS size_label,
             p.name_ar    AS product_name
      FROM product_variants v
      JOIN products  p ON p.id = v.product_id
      LEFT JOIN colors c ON c.id = v.color_id
      LEFT JOIN sizes  s ON s.id = v.size_id
      WHERE v.id = ANY($1::uuid[])
      `,
      [variantIds],
    );
    const variantMap = new Map<string, any>(variants.map((v: any) => [v.id, v]));

    return this.ds.transaction(async (em) => {
      // Resolve current open shift + cashbox for cashbox auto-updates.
      // Prefer a shift opened for THIS warehouse, but fall back to any open
      // shift the cashier has — a mismatch between the POS warehouse and the
      // shift warehouse shouldn't silently orphan the invoice.
      const primaryShift = await em.query(
        `SELECT id, cashbox_id FROM shifts
           WHERE opened_by = $1 AND status = 'open'
             AND warehouse_id = $2
           ORDER BY opened_at DESC LIMIT 1`,
        [userId, dto.warehouse_id],
      );
      const fallbackShift = primaryShift.length
        ? primaryShift
        : await em.query(
            `SELECT id, cashbox_id FROM shifts
               WHERE opened_by = $1 AND status = 'open'
               ORDER BY opened_at DESC LIMIT 1`,
            [userId],
          );
      const shift = fallbackShift[0];
      let cashboxId: string | null = shift?.cashbox_id ?? null;
      if (!cashboxId) {
        const [cb] = await em.query(
          `SELECT id FROM cashboxes
             WHERE warehouse_id = $1 AND is_active = true
             ORDER BY created_at LIMIT 1`,
          [dto.warehouse_id],
        );
        cashboxId = cb?.id ?? null;
      }

      const [invoice] = await em.query(
        `
        INSERT INTO invoices
          (warehouse_id, customer_id, cashier_id, salesperson_id, status,
           subtotal, invoice_discount, tax_rate, tax_amount,
           grand_total, paid_amount, change_amount, notes,
           shift_id, completed_at)
        VALUES ($1,$2,$3,$4,'paid',$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
        RETURNING *
        `,
        [
          dto.warehouse_id,
          dto.customer_id ?? null,
          userId,
          dto.salesperson_id ?? null,
          subtotal,
          invoice_discount,
          vatRate,
          tax_amount,
          grand_total,
          paid_total,
          change_amount,
          dto.notes ?? null,
          shift?.id ?? null,
        ],
      );

      for (const line of dto.lines) {
        const v = variantMap.get(line.variant_id);
        if (!v) {
          throw new BadRequestException(
            `Variant ${line.variant_id} not found`,
          );
        }
        const line_subtotal = line.qty * line.unit_price;
        const line_total = line_subtotal - (line.discount || 0);

        await em.query(
          `
          INSERT INTO invoice_items
            (invoice_id, variant_id,
             product_name_snapshot, sku_snapshot,
             color_name_snapshot, size_label_snapshot,
             quantity, unit_cost, unit_price,
             discount_amount, line_subtotal, line_total,
             salesperson_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          `,
          [
            invoice.id,
            line.variant_id,
            v.product_name,
            v.sku,
            v.color_name ?? null,
            v.size_label ?? null,
            line.qty,
            Number(v.cost_price || 0),
            line.unit_price,
            line.discount ?? 0,
            line_subtotal,
            line_total,
            line.salesperson_id ?? dto.salesperson_id ?? null,
          ],
        );
      }

      // PR-POS-STOCK-1 — Pre-validate stock availability before
      // letting the trigger fire. Without this, the only enforcement
      // is the `CHECK (quantity_on_hand >= 0)` constraint
      // (`database/migrations/004_inventory.sql:45`), which surfaces
      // to the cashier as a raw "violates check constraint" string.
      // Now we issue a single SELECT against `stock` for every variant
      // in this invoice (in the same transaction so the read sees a
      // consistent snapshot before the upcoming `INSERT INTO
      // stock_movements`), aggregate the requested qty per variant
      // (a cart can have multiple lines for the same variant), and
      // throw `BadRequestException` with a friendly Arabic message if
      // any line exceeds available. The DB constraint stays exactly
      // as-is — it remains the ultimate last-line defence for any
      // future writer that bypasses this service path.
      const stockRows = await em.query(
        `SELECT s.variant_id::text AS variant_id,
                s.quantity_on_hand,
                p.name_ar           AS product_name
           FROM stock s
           JOIN product_variants v ON v.id = s.variant_id
           JOIN products p ON p.id = v.product_id
          WHERE s.warehouse_id = $1
            AND s.variant_id = ANY($2::uuid[])`,
        [dto.warehouse_id, variantIds],
      );
      const stockMap = new Map<string, { available: number; name: string }>(
        stockRows.map((r: any) => [
          r.variant_id,
          {
            available: Number(r.quantity_on_hand ?? 0),
            name: String(r.product_name ?? ''),
          },
        ]),
      );
      const requestedByVariant = new Map<string, number>();
      for (const line of dto.lines) {
        requestedByVariant.set(
          line.variant_id,
          (requestedByVariant.get(line.variant_id) ?? 0) + Number(line.qty || 0),
        );
      }
      for (const [variantId, requested] of requestedByVariant) {
        const stock = stockMap.get(variantId);
        const available = stock?.available ?? 0;
        if (requested > available) {
          const v = variantMap.get(variantId);
          const label =
            stock?.name?.trim() || v?.product_name?.trim() || variantId;
          throw new BadRequestException(
            `الرصيد غير كافٍ للصنف ${label}. المتاح ${available} والمطلوب ${requested}`,
          );
        }
      }

      // Decrement stock for each sold line (trigger updates `stock.quantity_on_hand`).
      for (const line of dto.lines) {
        const v = variantMap.get(line.variant_id);
        await em.query(
          `INSERT INTO stock_movements
             (variant_id, warehouse_id, movement_type, direction,
              quantity, unit_cost, reference_type, reference_id, user_id)
           VALUES ($1,$2,'sale','out',$3,$4,'invoice',$5,$6)`,
          [
            line.variant_id,
            dto.warehouse_id,
            line.qty,
            Number(v?.cost_price || 0),
            invoice.id,
            userId,
          ],
        );
      }

      for (const pay of dto.payments) {
        // PR-PAY-1 — When a payment_account_id is supplied, freeze the
        // account into payment_account_snapshot. Receipts and reposts
        // (postInvoiceEdit) will then render/use this snapshot even if
        // admin later renames or deactivates the account.
        let snapshot: string | null = null;
        const acctId = (pay as any).payment_account_id ?? null;
        if (acctId && this.payments) {
          const acct = await this.payments.resolveForPosting(acctId, em);
          if (acct) {
            // PR-PAY-7 (Option C) — freeze the operator's per-account
            // custom logo when present. Drag-drop only; URL paste was
            // removed for security. Receipts read this BEFORE falling
            // back to the catalog logo_key, so a cashier who saw the
            // operator's custom logo at sale time still sees it on the
            // printed receipt months later.
            const meta = (acct.metadata ?? {}) as Record<string, unknown>;
            const logoDataUrl =
              typeof meta.logo_data_url === 'string'
                ? (meta.logo_data_url as string)
                : null;
            snapshot = JSON.stringify({
              id: acct.id,
              method: acct.method,
              display_name: acct.display_name,
              provider_key: acct.provider_key,
              identifier: acct.identifier,
              gl_account_code: acct.gl_account_code,
              // PR-FIX-POS-INVOICE-EDIT-WALLET-CASHBOX-ID — freeze
              // the payment_account's bound cashbox_id so the GL
              // repost in `posting.postInvoice` can tag the wallet/
              // bank/check GL line with `cashbox_id` and emit a
              // matching cash_movement (engine Guards A + B). Without
              // this, an edit cash → wallet would surface
              // "GL line on 1114 requires cashbox_id ..." and roll
              // back. Snapshot is preferred over a live lookup so a
              // later admin rename / cashbox-rebind doesn't change
              // the historical posting.
              cashbox_id: acct.cashbox_id ?? null,
              // PR-PAY-6 — frozen logo_key so receipts render the same
              // brand badge the cashier saw at sale time.
              logo_key: resolveLogoKey(acct.provider_key, acct.method),
              // PR-PAY-7 (Option C) — operator-uploaded raster only.
              logo_data_url: logoDataUrl,
            });
          }
        }
        await em.query(
          `
          INSERT INTO invoice_payments
            (invoice_id, payment_method, amount, reference_number,
             received_by, payment_account_id, payment_account_snapshot)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
          `,
          [
            invoice.id,
            pay.payment_method,
            pay.amount,
            pay.reference ?? null,
            userId,
            acctId,
            snapshot,
          ],
        );

        // Phase 2.2: cashbox leg lands atomically under postInvoice via
        // FinancialEngineService.cash_movements; no inline write here.
      }

      // Deduct loyalty points (if any) inside the same transaction
      if (applied_points > 0 && dto.customer_id && this.loyalty) {
        await this.loyalty.redeem(em, {
          customer_id: dto.customer_id,
          points: applied_points,
          invoice_id: invoice.id,
          user_id: userId,
        });
      }

      const result = {
        invoice_id: invoice.id,
        invoice_no: invoice.invoice_no,
        doc_no: invoice.invoice_no, // legacy alias
        grand_total,
        change_given: change_amount,
        tax_rate: vatRate,
        tax_amount,
        loyalty_discount,
        applied_points,
      };

      this.realtime?.emitPosEvent({
        type: 'invoice.created',
        payload: { ...result, cashier_id: userId, customer_id: dto.customer_id },
      });

      if (dto.customer_id && this.notifications) {
        this.sendThankYouNotification(invoice.id, userId).catch(() => {});
      }

      // Auto-post the sale to the general ledger. AWAITED — the previous
      // fire-and-forget meant the EntityManager was released before the
      // post ran, causing every invoice to silently fail its GL write
      // (the "invoices missing from GL" symptom). Idempotent via the
      // posting service's safe() guard, so a backfill never double-
      // posts. Any posting failure now rolls the whole invoice back —
      // correct behaviour: an unposted invoice is a data-integrity bug,
      // not a "best-effort" optimisation.
      if (this.posting) {
        const postRes = (await this.posting.postInvoice(
          invoice.id,
          userId,
          em,
        )) as any;
        if (postRes && postRes.error) {
          throw new Error(`فشل ترحيل الفاتورة للحسابات: ${postRes.error}`);
        }
      }

      return result;
    });
  }

  /**
   * Enqueue the 'invoice.thank_you' WhatsApp template for the customer.
   */
  private async sendThankYouNotification(invoiceId: string, userId: string) {
    try {
      const config = await this.notifications!.getConfig();
      if (config?.auto_send_invoice_receipt === false) return;

      const [row] = await this.ds.query(
        `
        SELECT
          i.invoice_no AS doc_no, i.grand_total,
          c.full_name AS customer_name,
          c.phone     AS customer_phone,
          c.loyalty_points,
          (SELECT value->>'name' FROM settings WHERE key = 'shop.info') AS shop_name,
          COALESCE(
            (SELECT SUM(points)
             FROM customer_loyalty_transactions
             WHERE reference_type = 'invoice'
               AND reference_id = i.id
               AND direction = 'in'), 0
          )::int AS earned_points
        FROM invoices i
        LEFT JOIN customers c ON c.id = i.customer_id
        WHERE i.id = $1
        `,
        [invoiceId],
      );
      if (!row?.customer_phone) return;

      await this.notifications!.enqueueFromTemplate({
        code: 'invoice.thank_you',
        recipient: row.customer_phone,
        variables: {
          customer_name: row.customer_name,
          shop_name: row.shop_name || 'زهران',
          doc_no: row.doc_no,
          grand_total: Number(row.grand_total).toFixed(2),
          earned_points: row.earned_points ?? 0,
          loyalty_points: row.loyalty_points ?? 0,
        },
        reference_type: 'invoice',
        reference_id: invoiceId,
        created_by: userId,
      });
    } catch {
      /* silent */
    }
  }

  async findOne(id: string) {
    const inv = await this.invoices.findOne({ where: { id } });
    if (!inv) throw new NotFoundException(`Invoice ${id} not found`);
    const lines = await this.ds.query(
      `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id`,
      [id],
    );
    const payments = await this.ds.query(
      `SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY paid_at`,
      [id],
    );
    return { ...inv, lines, payments };
  }

  /**
   * Rich payload for receipt printing — includes shop info, product names,
   * customer details, cashier name, salesperson name, and warehouse name.
   */
  async getReceipt(id: string) {
    const [inv] = await this.ds.query(
      `
      SELECT
        i.*,
        c.full_name   AS customer_name,
        c.phone       AS customer_phone,
        c.loyalty_points AS customer_loyalty_points,
        u.full_name   AS cashier_name,
        u.username    AS cashier_username,
        sp.full_name  AS salesperson_name,
        sp.username   AS salesperson_username,
        w.name        AS warehouse_name
      FROM invoices i
      LEFT JOIN customers c ON c.id = i.customer_id
      LEFT JOIN users     u ON u.id = i.cashier_id
      LEFT JOIN users     sp ON sp.id = i.salesperson_id
      LEFT JOIN warehouses w ON w.id = i.warehouse_id
      WHERE i.id = $1
      `,
      [id],
    );
    if (!inv) throw new NotFoundException(`Invoice ${id} not found`);

    const lines = await this.ds.query(
      `
      SELECT
        il.*,
        pv.barcode    AS barcode,
        p.name_en     AS product_name_en,
        sp.full_name  AS salesperson_name
      FROM invoice_items il
      LEFT JOIN product_variants pv ON pv.id = il.variant_id
      LEFT JOIN products         p  ON p.id  = pv.product_id
      LEFT JOIN users            sp ON sp.id = il.salesperson_id
      WHERE il.invoice_id = $1
      ORDER BY il.id
      `,
      [id],
    );

    const payments = await this.ds.query(
      `SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY paid_at`,
      [id],
    );

    const [shopRow, receiptRow, templatesRow, activeRow] = await Promise.all([
      this.ds
        .query(`SELECT value FROM settings WHERE key = 'shop.info'`)
        .then((r) => r[0]),
      this.ds
        .query(`SELECT value FROM settings WHERE key = 'shop.receipt'`)
        .then((r) => r[0]),
      this.ds
        .query(`SELECT value FROM settings WHERE key = 'shop.receipt_templates'`)
        .then((r) => r[0]),
      this.ds
        .query(`SELECT value FROM settings WHERE key = 'shop.receipt_active_template'`)
        .then((r) => r[0]),
    ]);
    const templates: any[] = Array.isArray(templatesRow?.value)
      ? templatesRow!.value
      : [];
    const activeId: string | undefined =
      typeof activeRow?.value === 'string'
        ? activeRow.value
        : activeRow?.value?.id;
    const active_template =
      templates.find((t) => t.id === activeId) || templates[0] || null;
    const shop = {
      ...(shopRow?.value ?? {}),
      ...(receiptRow?.value ?? {}),
      active_template,
    };

    const loyaltyTx = await this.ds.query(
      `
      SELECT direction, points, reason
      FROM customer_loyalty_transactions
      WHERE reference_type = 'invoice' AND reference_id = $1
      `,
      [id],
    );

    return { invoice: inv, lines, payments, shop, loyalty: loyaltyTx };
  }

  async listRecent(
    limit = 50,
    filters: {
      from?: string;
      to?: string;
      status?: string;
      q?: string;
      cashier_id?: string;
    } = {},
  ) {
    const conds: string[] = [];
    const params: any[] = [];
    if (filters.from) {
      params.push(filters.from);
      conds.push(`i.created_at::date >= $${params.length}::date`);
    }
    if (filters.to) {
      params.push(filters.to);
      conds.push(`i.created_at::date <= $${params.length}::date`);
    }
    if (filters.status && filters.status !== 'all') {
      params.push(filters.status);
      conds.push(`i.status = $${params.length}`);
    }
    if (filters.cashier_id) {
      params.push(filters.cashier_id);
      conds.push(`i.cashier_id = $${params.length}`);
    }
    if (filters.q) {
      params.push(`%${filters.q}%`);
      const p = params.length;
      conds.push(
        `(i.invoice_no ILIKE $${p} OR c.full_name ILIKE $${p} OR c.phone ILIKE $${p})`,
      );
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(limit);
    return this.ds.query(
      `
      SELECT i.*,
             c.full_name AS customer_name,
             c.phone     AS customer_phone,
             u.full_name AS cashier_name,
             sp.full_name AS salesperson_name,
             (
               SELECT COALESCE(
                 json_agg(
                   json_build_object(
                     'name',  it.product_name_snapshot,
                     'sku',   it.sku_snapshot,
                     'color', it.color_name_snapshot,
                     'size',  it.size_label_snapshot,
                     'qty',   it.quantity,
                     'price', it.unit_price
                   ) ORDER BY it.id
                 ), '[]'::json)
                 FROM invoice_items it
                WHERE it.invoice_id = i.id
             )                                     AS items_summary,
             (
               SELECT COUNT(*)::int FROM invoice_edit_requests ier
                WHERE ier.invoice_id = i.id AND ier.status = 'pending'
             )                                     AS pending_edit_requests
      FROM invoices i
      LEFT JOIN customers c ON c.id = i.customer_id
      LEFT JOIN users     u ON u.id = i.cashier_id
      LEFT JOIN users    sp ON sp.id = i.salesperson_id
      ${where}
      ORDER BY i.created_at DESC
      LIMIT $${params.length}
      `,
      params,
    );
  }

  async voidInvoice(id: string, userId: string, reason: string) {
    await this.ds.query(`SELECT fn_void_invoice($1, $2, $3)`, [
      id,
      userId,
      reason,
    ]);
    // Reverse the GL entry so the income statement / trial balance
    // reflect the cancellation. Awaited — we want a failed reversal to
    // surface, not silently leave an over-booked revenue line.
    await this.posting
      ?.reverseByReference('invoice', id, reason, userId)
      .catch((err) => {
        // Reversal failure is logged but doesn't block the void —
        // fn_void_invoice already removed the physical effects. The
        // backfill/reconciliation layer will re-reverse on its next
        // pass.
        // eslint-disable-next-line no-console
        console.error('invoice reversal failed:', err);
      });
    this.realtime?.emitPosEvent({
      type: 'invoice.voided',
      payload: { invoice_id: id, reason, voided_by: userId },
    });
    return { voided: true };
  }

  /**
   * Edit a previously-issued invoice in place.
   *
   *  1. Snapshot the current invoice + items + payments into
   *     invoice_edit_history so nothing is lost.
   *  2. Reverse the old stock movements and cashbox cash-in entries.
   *  3. Swap in the new items/payments and recompute the monetary
   *     totals (VAT, discounts, grand total, COGS, profit).
   *  4. Re-apply stock and cashbox for the new content.
   *  5. Bump edit_count / last_edited_at and return the refreshed row.
   *
   * The invoice_no and id are preserved, so customers/receivers still
   * see the same document — only the line-level content changes and a
   * history row records who changed what and when.
   *
   * PR-POS-INVOICE-DELTA-1 — early-exit for the monetary-only positive
   * delta case.  When the edit changes ONLY the total / unit_price /
   * discount (no line product/qty changes, same payment shape, same
   * customer) AND the delta is > 0, we take a different path that
   * APPENDS one `+delta` payment row + posts one additive sale JE+CT,
   * without voiding the original.  Zero-delta monetary-only edits skip
   * the GL posting entirely.  Negative deltas + every structural shape
   * keep the original reverse-and-repost path because the
   * `invoice_payments.amount > 0` CHECK constraint blocks the negative
   * payment row a symmetric "delta" path would need.
   */
  async editInvoice(
    id: string,
    dto: any,
    userId: string,
    reason: string,
  ) {
    if (!dto?.lines?.length) {
      throw new BadRequestException('Invoice must have at least one line');
    }

    return this.ds.transaction(async (em) => {
      // ── Snapshot original state ───────────────────────────────────
      const [orig] = await em.query(
        `SELECT * FROM invoices WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!orig) throw new BadRequestException('الفاتورة غير موجودة');
      if (orig.status === 'cancelled') {
        throw new BadRequestException('لا يمكن تعديل فاتورة ملغاة');
      }
      const origItems = await em.query(
        `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id`,
        [id],
      );
      const origPayments = await em.query(
        `SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY id`,
        [id],
      );

      // ── PR-POS-INVOICE-DELTA-1 — monetary-only short-circuit ─────
      // Detect "price-only / total-only" edits and skip the heavy
      // reverse-and-repost path when the change is just a monetary
      // tweak.  Negative-delta + structural changes still fall through
      // to the legacy path below.
      const classification = classifyInvoiceEdit(orig, origItems, origPayments, dto);
      if (classification.monetary_only) {
        return this.applyMonetaryDeltaEdit(
          em,
          id,
          orig,
          origPayments,
          dto,
          userId,
          reason,
          classification.delta,
        );
      }

      // ── 1) Reverse stock (one adjustment-in per original line) ───
      for (const it of origItems) {
        await em.query(
          `INSERT INTO stock_movements
             (variant_id, warehouse_id, movement_type, direction,
              quantity, unit_cost, reference_type, reference_id,
              user_id, notes)
           VALUES ($1,$2,'adjustment','in',$3,$4,'invoice',$5,$6,$7)`,
          [
            it.variant_id,
            orig.warehouse_id,
            it.quantity,
            it.unit_cost || 0,
            id,
            userId,
            'تعديل فاتورة — عكس بند سابق',
          ],
        );
      }

      // ── 2) [REMOVED — PR-FIX-POS-EDIT-CASH-GL-ALIGNMENT] ──────────
      // The cashbox CT side used to be reversed here via
      // `recordCashOnlyMovement('edit_reversal')` and re-written below
      // via `recordCashOnlyMovement('edit_replay')`. The GL side was
      // owned by `posting.postInvoiceEdit` which called `postInvoice`
      // with `skipCashMovements: true` to avoid double-writing CTs.
      //
      // After PR-FIN-CASHBOX-GL-PREVENTION-GUARDS landed, the engine's
      // Guard B started rejecting that posting because the GL cash
      // leg had no in-memory paired `cash_movements` entry — even
      // though the database CT was correctly written via the side
      // channel. Production error:
      //   "فشل ترحيل القيد بعد تعديل الفاتورة: cash GL line on 1111
      //    has no paired cashbox_transactions movement"
      //
      // The fix routes BOTH layers through the engine in
      // `postInvoiceEdit`:
      //   1. `reverseByReference('invoice', id)` — engine voids the
      //      old JE atomically with the inverse cash CTs (category
      //      `reversal_sale`).
      //   2. `postInvoice(id)` (without `skipCashMovements`) — engine
      //      posts the new JE with paired `sale` cash CTs.
      // Net cashbox effect: original `sale` (+old) + `reversal_sale`
      // (-old) + new `sale` (+new) = +new. Correct, and each engine
      // call now satisfies Guards A + B + C.
      //
      // Audit-trail note: cashUnchanged edits (item-only edits with
      // identical cash totals) used to short-circuit and emit zero CT
      // rows. Under the new flow they emit one offsetting pair
      // (reversal_sale -old + sale +old = 0). The math is correct;
      // the audit feed just shows two extra rows per such edit. The
      // alternative — keeping the dual-ownership pattern — required
      // either `accounting_only=true` (which the project policy bans
      // when actual cash moved) or extending the engine with a new
      // "cash owned externally" flag (out of scope for this fix).
      // The `cashboxId` lookup below is still useful because some
      // downstream code paths in this method reference an invoice's
      // resolved cashbox; we keep the lookup but no longer gate
      // anything on `cashUnchanged`.
      const [cbRef] = await em.query(
        `SELECT cashbox_id FROM cashbox_transactions
          WHERE reference_type = 'invoice' AND reference_id = $1
          ORDER BY id LIMIT 1`,
        [id],
      );
      const cashboxId = cbRef?.cashbox_id ?? null;
      void cashboxId;

      // ── 3) Persist the snapshot to edit history ───────────────────
      const [historyRow] = await em.query(
        `INSERT INTO invoice_edit_history
           (invoice_id, edited_by, reason, before_snapshot)
         VALUES ($1,$2,$3,$4::jsonb)
         RETURNING id`,
        [
          id,
          userId,
          reason,
          JSON.stringify({ invoice: orig, items: origItems, payments: origPayments }),
        ],
      );
      const historyId = historyRow.id;

      // ── 4) Wipe old lines + payments ──────────────────────────────
      await em.query(`DELETE FROM invoice_items    WHERE invoice_id = $1`, [id]);
      await em.query(`DELETE FROM invoice_payments WHERE invoice_id = $1`, [id]);

      // ── 5) Recompute totals from the new content ──────────────────
      const lines = dto.lines as Array<{
        variant_id: string;
        qty: number;
        unit_price: number;
        discount?: number;
      }>;
      // PR-PAY-1: align with the DB enum + accept payment_account_id.
      const payments = (dto.payments || []) as Array<{
        payment_method: string;
        amount: number;
        reference?: string;
        payment_account_id?: string;
      }>;

      const subtotal = lines.reduce(
        (s, l) => s + l.unit_price * l.qty - (l.discount || 0),
        0,
      );
      const invoice_discount = Number(dto.discount_total || 0);
      const net_before_tax = Math.max(0, subtotal - invoice_discount);

      // Keep the original VAT configuration from the invoice row.
      const vatRate = Number(orig.tax_rate || 0);
      let tax_amount = 0;
      const grand_total = net_before_tax;
      if (vatRate > 0) {
        // Assume inclusive (matches what createInvoice does by default).
        tax_amount = (net_before_tax * vatRate) / (100 + vatRate);
      }

      const paid_total = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
      const change_amount = Math.max(0, paid_total - grand_total);

      // ── 6) Re-apply new stock + insert items + capture cogs ───────
      const variants = await em.query(
        `SELECT v.id, v.cost_price, v.sku,
                p.name_ar AS product_name,
                v.color   AS color_name,
                v.size    AS size_label
           FROM product_variants v
           JOIN products p ON p.id = v.product_id
          WHERE v.id = ANY($1::uuid[])`,
        [lines.map((l) => l.variant_id)],
      );
      const vmap = new Map<string, any>(variants.map((v: any) => [v.id, v]));

      let cogs_total = 0;
      for (const line of lines) {
        const v = vmap.get(line.variant_id);
        if (!v) throw new BadRequestException(`Variant ${line.variant_id} not found`);
        const unit_cost = Number(v.cost_price || 0);
        const line_subtotal = line.qty * line.unit_price;
        const line_total = line_subtotal - (line.discount || 0);
        cogs_total += unit_cost * line.qty;
        await em.query(
          `INSERT INTO invoice_items
             (invoice_id, variant_id,
              product_name_snapshot, sku_snapshot,
              color_name_snapshot, size_label_snapshot,
              quantity, unit_cost, unit_price,
              discount_amount, line_subtotal, line_total,
              salesperson_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id,
            line.variant_id,
            v.product_name,
            v.sku,
            v.color_name ?? null,
            v.size_label ?? null,
            line.qty,
            unit_cost,
            line.unit_price,
            line.discount || 0,
            line_subtotal,
            line_total,
            dto.salesperson_id ?? orig.salesperson_id ?? null,
          ],
        );
        await em.query(
          `INSERT INTO stock_movements
             (variant_id, warehouse_id, movement_type, direction,
              quantity, unit_cost, reference_type, reference_id,
              user_id, notes)
           VALUES ($1,$2,'sale','out',$3,$4,'invoice',$5,$6,$7)`,
          [
            line.variant_id,
            orig.warehouse_id,
            line.qty,
            unit_cost,
            id,
            userId,
            'تعديل فاتورة — بند جديد',
          ],
        );
      }

      // ── 7) Insert new payments + cashbox in ───────────────────────
      for (const p of payments) {
        // PR-PAY-1: snapshot the chosen payment account at edit-time
        // so postInvoiceEdit reposts to the correct GL even if admin
        // later renames/deactivates the account.
        let snapshot: string | null = null;
        const acctId = p.payment_account_id ?? null;
        if (acctId && this.payments) {
          const acct = await this.payments.resolveForPosting(acctId, em);
          if (acct) {
            // PR-PAY-7 (Option C) — freeze the operator's per-account
            // custom logo when present. Drag-drop only; URL paste was
            // removed for security. Receipts read this BEFORE falling
            // back to the catalog logo_key, so a cashier who saw the
            // operator's custom logo at sale time still sees it on the
            // printed receipt months later.
            const meta = (acct.metadata ?? {}) as Record<string, unknown>;
            const logoDataUrl =
              typeof meta.logo_data_url === 'string'
                ? (meta.logo_data_url as string)
                : null;
            snapshot = JSON.stringify({
              id: acct.id,
              method: acct.method,
              display_name: acct.display_name,
              provider_key: acct.provider_key,
              identifier: acct.identifier,
              gl_account_code: acct.gl_account_code,
              // PR-FIX-POS-INVOICE-EDIT-WALLET-CASHBOX-ID — freeze
              // the payment_account's bound cashbox_id so the GL
              // repost in `posting.postInvoice` can tag the wallet/
              // bank/check GL line with `cashbox_id` and emit a
              // matching cash_movement (engine Guards A + B). Without
              // this, an edit cash → wallet would surface
              // "GL line on 1114 requires cashbox_id ..." and roll
              // back. Snapshot is preferred over a live lookup so a
              // later admin rename / cashbox-rebind doesn't change
              // the historical posting.
              cashbox_id: acct.cashbox_id ?? null,
              // PR-PAY-6 — frozen logo_key so receipts render the same
              // brand badge the cashier saw at sale time.
              logo_key: resolveLogoKey(acct.provider_key, acct.method),
              // PR-PAY-7 (Option C) — operator-uploaded raster only.
              logo_data_url: logoDataUrl,
            });
          }
        }
        await em.query(
          `INSERT INTO invoice_payments
             (invoice_id, payment_method, amount, reference,
              payment_account_id, payment_account_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
          [
            id,
            p.payment_method,
            p.amount,
            p.reference ?? null,
            acctId,
            snapshot,
          ],
        );
        // [REMOVED — PR-FIX-POS-EDIT-CASH-GL-ALIGNMENT]
        // The matching `edit_replay` recordCashOnlyMovement call used
        // to live here. See the long-form comment in step 2 above for
        // the full rationale. Both legs are now owned by the engine
        // via `posting.postInvoiceEdit` → `reverseByReference` +
        // `postInvoice` (no `skipCashMovements`).
      }

      // ── 8) Update invoice totals + edit marker ────────────────────
      const gross_profit = grand_total - cogs_total;
      const [updated] = await em.query(
        `UPDATE invoices
            SET subtotal         = $2,
                invoice_discount = $3,
                tax_amount       = $4,
                grand_total      = $5,
                paid_amount      = $6,
                change_amount    = $7,
                cogs_total       = $8,
                gross_profit     = $9,
                customer_id      = COALESCE($10, customer_id),
                salesperson_id   = COALESCE($11, salesperson_id),
                notes            = $12,
                edit_count       = edit_count + 1,
                last_edited_at   = NOW(),
                updated_at       = NOW()
          WHERE id = $1
          RETURNING *`,
        [
          id,
          subtotal,
          invoice_discount,
          tax_amount,
          grand_total,
          paid_total,
          change_amount,
          cogs_total,
          gross_profit,
          dto.customer_id ?? null,
          dto.salesperson_id ?? null,
          dto.notes ?? orig.notes ?? null,
        ],
      );

      // Backfill the history row with both the summary AND the full
      // post-edit items snapshot. Storing the after-items lets the UI
      // render a proper before/after diff for historical edits — not
      // just the most recent one.
      const newItems = await em.query(
        `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id`,
        [id],
      );
      const newPayments = await em.query(
        `SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY id`,
        [id],
      );
      await em.query(
        `UPDATE invoice_edit_history
            SET after_summary  = $2::jsonb,
                after_snapshot = $3::jsonb
          WHERE id = $1`,
        [
          historyId,
          JSON.stringify({
            items_count: lines.length,
            grand_total,
            cogs_total,
            gross_profit,
            paid: paid_total,
          }),
          JSON.stringify({
            invoice: updated,
            items: newItems,
            payments: newPayments,
          }),
        ],
      );

      // ── 9) PR-DRIFT-3E — refresh the GL after the edit ────────────
      // editInvoice used to leave the original invoice JE untouched,
      // so any change to amount or payment method silently desynced
      // the cashbox bucket from reality. postInvoiceEdit voids the
      // old JE and reposts a fresh one based on the post-edit
      // invoice/payments state. Runs in the same transaction so a
      // failure rolls the whole edit back — we will not ship an edit
      // that breaks the GL. (`posting` is @Optional only for stubbed
      // unit tests; in any real boot it's wired by AccountingModule.)
      if (this.posting) {
        const postRes = (await this.posting.postInvoiceEdit(
          id,
          userId,
          em,
        )) as any;
        if (postRes?.error) {
          throw new BadRequestException(
            `فشل ترحيل القيد بعد تعديل الفاتورة: ${postRes.error}`,
          );
        }
      }

      // ── 10) PR-FIX-POS-INVOICE-EDIT-REFRESH-CLOSED-SHIFT-SNAPSHOT
      // If the invoice belongs to an already-closed shift, the cash
      // delta from a payment-method swap (e.g. cash → InstaPay) leaves
      // the shift's stored close snapshot stale: total_cash_in /
      // expected_closing still reflect the pre-edit cash, so the
      // generated `difference` mis-flags the shift as a shortage.
      //
      // Recompute the snapshot inside the SAME transaction so a
      // failure rolls the entire edit back. If finance has already
      // posted a variance JE / treatment for the shift, refuse with a
      // clear 409 — the user must reverse the variance treatment
      // first.
      if (orig.shift_id && this.shifts) {
        const refresh = await this.shifts.refreshClosedShiftSnapshot(
          orig.shift_id,
          em,
        );
        if (refresh.status === 'blocked') {
          throw new ConflictException(
            'لا يمكن تعديل فاتورة لوردية مغلقة سبق ترحيل فروقاتها محاسبياً. يجب تسوية أو إلغاء معالجة الفروقات أولاً.',
          );
        }
      }

      this.realtime?.emitPosEvent({
        type: 'invoice.created', // same channel — the UI refetches
        payload: { invoice_id: id, edited: true, edited_by: userId },
      });

      return { invoice: updated, edited: true, history_id: historyId };
    });
  }

  /**
   * PR-POS-INVOICE-DELTA-1 — apply a monetary-only edit (positive or
   * zero delta) WITHOUT reversing the original invoice JE.  Caller
   * (`editInvoice`) has already classified the edit as monetary-only
   * via `classifyInvoiceEdit` and is running inside the outer
   * transaction.
   *
   * What this method does:
   *   1. INSERT an `invoice_edit_history` row with the before-snapshot.
   *   2. (delta > 0 ONLY) INSERT one `+delta` `invoice_payments` row
   *      using the FIRST original payment row's method + account
   *      (mirroring the cashbox/GL routing of the historical sale).
   *   3. UPDATE invoices grand_total / paid_amount / tax_amount /
   *      change_amount / notes / customer_id / salesperson_id /
   *      edit_count / last_edited_at.
   *   4. Backfill the history row's after-snapshot.
   *   5. (delta > 0 ONLY) Call `posting.postInvoiceDelta` which posts
   *      ONE additive JE+CT for the delta only.
   *   6. Refresh the closed shift snapshot if the invoice belongs to
   *      one (same logic as the legacy path).
   *   7. Emit the realtime event so the UI refetches.
   *
   * What this method explicitly does NOT do (vs the legacy path):
   *   · Does not reverse stock (lines are unchanged).
   *   · Does not DELETE invoice_items (lines are unchanged).
   *   · Does not DELETE the original invoice_payments rows.
   *   · Does not call `reverseByReference` / `postInvoiceEdit`.
   *   · Does not emit a `reversal_sale` CT or a `refund` JE.
   */
  private async applyMonetaryDeltaEdit(
    em: any,
    id: string,
    orig: any,
    origPayments: Array<any>,
    dto: any,
    userId: string,
    reason: string,
    delta: number,
  ) {
    // Recompute totals from the DTO.  Lines are unchanged by definition
    // (monetary-only classification), so we read item rows for COGS
    // pass-through and trust the DTO's per-line unit_price + discount
    // + invoice-level discount_total.
    const lines = dto.lines as Array<{
      variant_id: string;
      qty: number;
      unit_price: number;
      discount?: number;
    }>;
    const subtotal = lines.reduce(
      (s, l) => s + Number(l.unit_price) * Number(l.qty) - Number(l.discount || 0),
      0,
    );
    const invoice_discount = Number(dto.discount_total || 0);
    const net_before_tax = Math.max(0, subtotal - invoice_discount);
    const vatRate = Number(orig.tax_rate || 0);
    let tax_amount = 0;
    if (vatRate > 0) {
      tax_amount = (net_before_tax * vatRate) / (100 + vatRate);
    }
    const grand_total = net_before_tax;
    const newPaidTotal = (dto.payments ?? []).reduce(
      (s: number, p: any) => s + Number(p.amount || 0),
      0,
    );
    const change_amount = Math.max(0, newPaidTotal - grand_total);

    // ── 1) History row with before-snapshot ────────────────────────
    const origItems = await em.query(
      `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id`,
      [id],
    );
    const [historyRow] = await em.query(
      `INSERT INTO invoice_edit_history
         (invoice_id, edited_by, reason, before_snapshot)
       VALUES ($1,$2,$3,$4::jsonb)
       RETURNING id`,
      [
        id,
        userId,
        reason,
        JSON.stringify({ invoice: orig, items: origItems, payments: origPayments }),
      ],
    );
    const historyId = historyRow.id;

    // ── 2) Append +delta payment row (delta > 0 only) ──────────────
    // Mirror the first original payment's method + account so the
    // delta row routes through the same GL bucket the historical sale
    // touched (which postInvoiceDelta will mirror on the JE side).
    if (delta > 0) {
      const proto = origPayments[0];
      await em.query(
        `INSERT INTO invoice_payments
           (invoice_id, payment_method, amount, reference,
            payment_account_id, payment_account_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          id,
          proto.payment_method,
          delta,
          // Reference label makes the row identifiable in audit views.
          `PR-POS-INVOICE-DELTA-1 +${delta}`,
          proto.payment_account_id ?? null,
          proto.payment_account_snapshot
            ? JSON.stringify(proto.payment_account_snapshot)
            : null,
        ],
      );
    }

    // ── 3) Update invoice totals + edit marker ─────────────────────
    // COGS doesn't change for monetary-only edits (lines unchanged),
    // so gross_profit moves by exactly `delta`.
    const cogs_total = Number(orig.cogs_total || 0);
    const gross_profit = grand_total - cogs_total;
    const [updated] = await em.query(
      `UPDATE invoices
          SET subtotal         = $2,
              invoice_discount = $3,
              tax_amount       = $4,
              grand_total      = $5,
              paid_amount      = $6,
              change_amount    = $7,
              gross_profit     = $8,
              customer_id      = COALESCE($9, customer_id),
              salesperson_id   = COALESCE($10, salesperson_id),
              notes            = $11,
              edit_count       = edit_count + 1,
              last_edited_at   = NOW(),
              updated_at       = NOW()
        WHERE id = $1
        RETURNING *`,
      [
        id,
        subtotal,
        invoice_discount,
        tax_amount,
        grand_total,
        newPaidTotal,
        change_amount,
        gross_profit,
        dto.customer_id ?? null,
        dto.salesperson_id ?? null,
        dto.notes ?? orig.notes ?? null,
      ],
    );

    // ── 4) Backfill history with after-snapshot ────────────────────
    const newPayments = await em.query(
      `SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY id`,
      [id],
    );
    await em.query(
      `UPDATE invoice_edit_history
          SET after_summary  = $2::jsonb,
              after_snapshot = $3::jsonb
        WHERE id = $1`,
      [
        historyId,
        JSON.stringify({
          items_count: lines.length,
          grand_total,
          cogs_total,
          gross_profit,
          paid: newPaidTotal,
          delta,
          path: 'monetary_delta',
        }),
        JSON.stringify({
          invoice: updated,
          items: origItems, // unchanged
          payments: newPayments,
        }),
      ],
    );

    // ── 5) Post delta JE+CT (delta > 0 only) ───────────────────────
    if (delta > 0 && this.posting) {
      const postRes = (await this.posting.postInvoiceDelta(
        id,
        delta,
        userId,
        em,
      )) as any;
      if (postRes?.error) {
        throw new BadRequestException(
          `فشل ترحيل دلتا تعديل الفاتورة: ${postRes.error}`,
        );
      }
    }

    // ── 6) Refresh closed-shift snapshot if applicable ─────────────
    if (orig.shift_id && this.shifts) {
      const refresh = await this.shifts.refreshClosedShiftSnapshot(
        orig.shift_id,
        em,
      );
      if (refresh.status === 'blocked') {
        throw new ConflictException(
          'لا يمكن تعديل فاتورة لوردية مغلقة سبق ترحيل فروقاتها محاسبياً. يجب تسوية أو إلغاء معالجة الفروقات أولاً.',
        );
      }
    }

    this.realtime?.emitPosEvent({
      type: 'invoice.created',
      payload: { invoice_id: id, edited: true, edited_by: userId, path: 'monetary_delta' },
    });

    return { invoice: updated, edited: true, history_id: historyId };
  }

  /** Return the edit-history timeline for an invoice. */
  editHistory(invoiceId: string) {
    return this.ds.query(
      `SELECT h.id, h.invoice_id, h.edited_at, h.reason,
              h.before_snapshot, h.after_snapshot, h.after_summary,
              u.full_name  AS edited_by_name,  u.username AS edited_by_username,
              req.id       AS request_id,
              req.reason   AS request_reason,
              req.requested_at,
              ru.full_name AS requested_by_name,
              ru.username  AS requested_by_username
         FROM invoice_edit_history h
         LEFT JOIN users u                    ON u.id = h.edited_by
         LEFT JOIN invoice_edit_requests req  ON req.history_id = h.id
         LEFT JOIN users ru                   ON ru.id = req.requested_by
        WHERE h.invoice_id = $1
        ORDER BY h.edited_at DESC`,
      [invoiceId],
    );
  }

  // ─── Approval workflow ──────────────────────────────────────────────
  /**
   * Store an edit payload for later approval. Used by staff who don't
   * hold invoices.edit but do hold invoices.edit_request.
   */
  async submitEditRequest(
    invoiceId: string,
    dto: any,
    userId: string,
    reason: string,
  ) {
    if (!dto?.lines?.length) {
      throw new BadRequestException('Invoice must have at least one line');
    }
    const [inv] = await this.ds.query(
      `SELECT id, status FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    if (!inv) throw new BadRequestException('الفاتورة غير موجودة');
    if (inv.status === 'cancelled') {
      throw new BadRequestException('لا يمكن طلب تعديل على فاتورة ملغاة');
    }
    const [row] = await this.ds.query(
      `INSERT INTO invoice_edit_requests
         (invoice_id, requested_by, reason, proposed_changes, status)
       VALUES ($1, $2, $3, $4::jsonb, 'pending')
       RETURNING *`,
      [invoiceId, userId, reason, JSON.stringify(dto)],
    );
    this.realtime?.emitAlert({
      title: 'طلب تعديل فاتورة جديد',
      body: `فاتورة ${invoiceId} — في انتظار موافقة مدير النظام`,
      severity: 'info',
      kind: 'invoice_edit_request',
    });
    return row;
  }

  listEditRequests(invoiceId: string) {
    return this.ds.query(
      `SELECT r.*,
              ru.full_name  AS requested_by_name,
              ru.username   AS requested_by_username,
              du.full_name  AS decided_by_name,
              du.username   AS decided_by_username
         FROM invoice_edit_requests r
         LEFT JOIN users ru ON ru.id = r.requested_by
         LEFT JOIN users du ON du.id = r.decided_by
        WHERE r.invoice_id = $1
        ORDER BY r.requested_at DESC`,
      [invoiceId],
    );
  }

  listPendingEditRequests() {
    return this.ds.query(
      `SELECT r.id, r.invoice_id, r.requested_at, r.reason, r.proposed_changes,
              i.invoice_no, i.grand_total, i.status AS invoice_status,
              ru.full_name AS requested_by_name, ru.username AS requested_by_username
         FROM invoice_edit_requests r
         JOIN invoices i  ON i.id = r.invoice_id
         LEFT JOIN users ru ON ru.id = r.requested_by
        WHERE r.status = 'pending'
        ORDER BY r.requested_at DESC`,
    );
  }

  async approveEditRequest(requestId: string, userId: string, note?: string) {
    const [req] = await this.ds.query(
      `SELECT * FROM invoice_edit_requests WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    if (!req) throw new BadRequestException('الطلب غير موجود');
    if (req.status !== 'pending') {
      throw new BadRequestException('الطلب تم البت فيه مسبقًا');
    }
    // Apply the edit using the existing in-place flow. Requester's reason
    // propagates into invoice_edit_history.
    const result = await this.editInvoice(
      req.invoice_id,
      req.proposed_changes,
      userId,
      `موافقة على طلب تعديل: ${req.reason || ''}`.trim(),
    );
    await this.ds.query(
      `UPDATE invoice_edit_requests
          SET status          = 'approved',
              decided_by      = $2,
              decided_at      = NOW(),
              decision_reason = $3,
              history_id      = $4
        WHERE id = $1`,
      [requestId, userId, note || null, (result as any).history_id ?? null],
    );
    return { approved: true, ...result };
  }

  async rejectEditRequest(requestId: string, userId: string, reason: string) {
    if (!reason?.trim()) {
      throw new BadRequestException('يجب كتابة سبب الرفض');
    }
    const [req] = await this.ds.query(
      `SELECT status FROM invoice_edit_requests WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    if (!req) throw new BadRequestException('الطلب غير موجود');
    if (req.status !== 'pending') {
      throw new BadRequestException('الطلب تم البت فيه مسبقًا');
    }
    await this.ds.query(
      `UPDATE invoice_edit_requests
          SET status          = 'rejected',
              decided_by      = $2,
              decided_at      = NOW(),
              decision_reason = $3
        WHERE id = $1`,
      [requestId, userId, reason],
    );
    return { rejected: true };
  }
}
