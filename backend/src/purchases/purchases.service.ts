import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  AddPurchasePaymentDto,
  CreatePurchaseDto,
  ListPurchasesDto,
} from './dto/purchase.dto';
import { CreatePurchaseReturnDto } from './dto/purchase-return.dto';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';
import {
  allocateLandedCosts,
  ManualAllocationError,
  type AllocatorExtraInput,
  type AllocatorLineInput,
} from './landed-cost.allocator';

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
  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly posting?: AccountingPostingService,
  ) {}

  // --------------------------------------------------------------------------
  //  List / get
  // --------------------------------------------------------------------------
  async list(query: ListPurchasesDto) {
    const where: string[] = ['1=1'];
    const params: any[] = [];
    if (query.status) {
      // Explicit status filter — the operator asked for a specific
      // status (including 'cancelled'), honour it verbatim.
      params.push(query.status);
      where.push(`p.status = $${params.length}`);
    } else if (!query.include_cancelled) {
      // Purchases UX fixes — by default hide cancelled invoices from
      // the list. The rows still exist in the DB and remain reachable
      // by passing `status=cancelled` or `include_cancelled=true`.
      where.push(`p.status <> 'cancelled'`);
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

    // PR-PURCHASES-P2.1 — surface landed-cost extras alongside items
    // + payments. Returns empty array when the purchase has no extras
    // (legacy purchases, no schema break).
    const extra_costs = await this.ds.query(
      `SELECT id, cost_type, label, amount, capitalize_to_inventory,
              allocation_method, notes, sort_order, created_at
         FROM purchase_extra_costs
        WHERE purchase_id = $1
        ORDER BY sort_order, created_at`,
      [id],
    ).catch(() => [] as any[]);

    return { ...purchase, items, payments, extra_costs };
  }

  // --------------------------------------------------------------------------
  //  Allocator helper — shared by create() and draft edit()
  // --------------------------------------------------------------------------
  /**
   * Run the landed-cost allocator on a Create/Edit DTO and map any
   * `ManualAllocationError` to the canonical Arabic
   * `BadRequestException`. Pure helper — no transaction, no I/O.
   *
   * Shared by `create()` (initial PO insert) and `edit()`'s draft
   * branch (PR-PURCHASES-P2.3A) so the allocation rules can't drift
   * between the two paths.
   */
  private runAllocatorOrThrow(dto: CreatePurchaseDto) {
    const allocatorLines: AllocatorLineInput[] = (dto.items ?? []).map((i) => ({
      variant_id: i.variant_id,
      quantity: i.quantity,
      base_unit_cost: i.unit_cost,
      discount: i.discount ?? 0,
      tax: i.tax ?? 0,
    }));
    const allocatorExtras: AllocatorExtraInput[] = (dto.extra_costs ?? []).map(
      (e) => ({
        cost_type: e.cost_type,
        amount: e.amount,
        // capitalize defaults to true (same default as the DB column)
        capitalize_to_inventory: e.capitalize_to_inventory !== false,
        // allocation_method defaults to by_value (same as DB)
        allocation_method: e.allocation_method ?? 'by_value',
        manual_allocations: e.manual_allocations,
      }),
    );
    try {
      return allocateLandedCosts(allocatorLines, allocatorExtras);
    } catch (err) {
      if (err instanceof ManualAllocationError) {
        // Canonical Arabic operator-facing message — the precise reason
        // is logged via the underlying err.message + reason code.
        throw new BadRequestException(
          'إجمالي التوزيع اليدوي للمصاريف يجب أن يساوي قيمة المصروف.',
        );
      }
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  //  Create
  // --------------------------------------------------------------------------
  /**
   * PR-PURCHASES-P2.3B — accepts an optional `em: EntityManager` so the
   * new safe-edit replacement flow can run create()+receive() inside
   * the same transaction as fn_void_purchase + reverseByReference.
   * When `em` is omitted (the common public path), behavior is
   * unchanged: opens its own transaction.
   *
   * Allocator runs OUTSIDE the transaction (callers that pass `em`
   * must call `runAllocatorOrThrow(dto)` beforehand themselves so a
   * manual-allocation mismatch surfaces BEFORE the txn starts and we
   * don't half-void the old purchase).
   */
  async create(dto: CreatePurchaseDto, userId: string, em?: EntityManager) {
    if (!dto.items?.length) {
      throw new BadRequestException('يجب إضافة صنف واحد على الأقل');
    }

    // PR-PURCHASES-P2.1 — run the landed-cost allocator BEFORE the
    // transaction opens. The DTO's `unit_cost` is treated as the BASE
    // (raw) price; the allocator turns it into the landed `unit_cost`
    // that gets written to `purchase_items` and (via receive()) into
    // `product_variants.cost_price`.
    const allocation = this.runAllocatorOrThrow(dto);

    const body = async (m: EntityManager) => {
      // subtotal stays as the BASE products subtotal (unchanged
      // semantics; reports keep using it as "products total before
      // landed cost"). grand_total now adds the capitalized AND
      // non-capitalized extras alongside the legacy shipping/tax/
      // discount fields.
      const base_subtotal = allocation.base_subtotal;
      const extra_costs_capitalized = allocation.capitalized_total;
      const extra_costs_non_capitalized = allocation.non_capitalized_total;
      const grand_total = +(
        base_subtotal
        - (dto.discount_amount || 0)
        + (dto.tax_amount || 0)
        + (dto.shipping_cost || 0)
        + extra_costs_capitalized
        + extra_costs_non_capitalized
      ).toFixed(2);

      const [purchase] = await m.query(
        `
        INSERT INTO purchases
            (supplier_id, warehouse_id, invoice_date, due_date, supplier_ref,
             subtotal, discount_amount, tax_amount, shipping_cost, grand_total,
             extra_costs_capitalized, extra_costs_non_capitalized,
             notes, created_by)
        VALUES ($1,$2, COALESCE($3::date, CURRENT_DATE), $4, $5,
                $6, $7, $8, $9, $10,
                $11, $12,
                $13, $14)
        RETURNING *
        `,
        [
          dto.supplier_id,
          dto.warehouse_id,
          dto.invoice_date ?? null,
          dto.due_date ?? null,
          dto.supplier_ref ?? null,
          base_subtotal,
          dto.discount_amount || 0,
          dto.tax_amount || 0,
          dto.shipping_cost || 0,
          grand_total,
          extra_costs_capitalized,
          extra_costs_non_capitalized,
          dto.notes ?? null,
          userId,
        ],
      );

      for (const line of allocation.lines) {
        await m.query(
          `INSERT INTO purchase_items
             (purchase_id, variant_id, quantity,
              base_unit_cost, allocated_cost_total, allocated_cost_per_unit,
              unit_cost, discount, tax, line_total,
              manual_allocation)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            purchase.id,
            line.variant_id,
            line.quantity,
            line.base_unit_cost,
            line.allocated_cost_total,
            line.allocated_cost_per_unit,
            line.unit_cost,
            line.discount,
            line.tax,
            line.line_total,
            line.manual_allocation,
          ],
        );
      }

      // Persist each extra cost row alongside the parent purchase.
      const extras = dto.extra_costs ?? [];
      for (let i = 0; i < extras.length; i++) {
        const e = extras[i];
        await m.query(
          `INSERT INTO purchase_extra_costs
             (purchase_id, cost_type, label, amount,
              capitalize_to_inventory, allocation_method,
              notes, sort_order, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            purchase.id,
            e.cost_type,
            e.label ?? null,
            e.amount,
            e.capitalize_to_inventory !== false,
            e.allocation_method ?? 'by_value',
            e.notes ?? null,
            e.sort_order ?? i,
            userId,
          ],
        );
      }

      return purchase;
    };
    return em ? body(em) : this.ds.transaction(body);
  }

  // --------------------------------------------------------------------------
  //  Receive — increment stock, ledger
  // --------------------------------------------------------------------------
  /**
   * PR-PURCHASES-P2.3B — accepts an optional `em: EntityManager` so the
   * safe-edit replacement flow can call receive() inside the same
   * transaction. When `em` is provided the trailing `getOne(id)`
   * read is skipped (the caller already has the new purchase row from
   * create()'s return value). Public callers (no `em`) keep the
   * existing rich getOne return shape.
   */
  async receive(id: string, userId: string, em?: EntityManager) {
    const body = async (m: EntityManager) => {
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

      // Auto-post inventory capitalization to the GL.
      await this.posting?.postPurchase(id, userId, m).catch(() => undefined);
    };
    if (em) {
      await body(em);
      return;
    }
    return this.ds.transaction(async (m) => {
      await body(m);
      return this.getOne(id);
    });
  }

  // --------------------------------------------------------------------------
  //  Pay
  // --------------------------------------------------------------------------
  /**
   * Pay against a specific purchase invoice.
   *
   * REFACTORED: previously wrote directly to `purchase_payments`,
   * `suppliers.current_balance`, and `supplier_ledger` — leaving the
   * cashbox untouched and the GL unposted (bug C3 in the audit:
   * "cashbox shows 20,905 vs 18,250"). The system already had a
   * correct path at POST /cash-desk/supplier-payments. Every purchase-
   * level payment now funnels through that same unified path:
   *
   *   1. INSERT `supplier_payments` — trigger `trg_supplier_payment_apply`
   *      (migration 014) atomically moves cash + updates supplier
   *      balance + writes supplier_ledger
   *   2. INSERT `supplier_payment_allocations` against this purchase —
   *      the trigger `trg_supplier_alloc_recompute` recomputes
   *      `supplier_payments.allocated_amount` but does NOT touch the
   *      purchases row.
   *   3. Inline UPDATE on `purchases` to recompute `paid_amount` and
   *      advance `status` (paid / partial / received) — fills the
   *      gap that the trigger leaves. Kept on the OFFICIAL path: no
   *      new endpoint, no new cashbox / GL primitive, no migration.
   *   4. Await `postSupplierPayment` → GL: DR 211 · CR Cash
   *
   * cashbox_id is resolved from the caller's open shift so the
   * existing public DTO (no cashbox_id field) keeps working.
   */
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

      // Resolve cashbox from the user's open shift — the DTO doesn't
      // ship one and every payment must land in a real cashbox.
      const [openShift] = await m.query(
        `SELECT cashbox_id FROM shifts
          WHERE opened_by = $1 AND status = 'open'
          ORDER BY opened_at DESC LIMIT 1`,
        [userId],
      );
      const cashboxId = openShift?.cashbox_id ?? null;
      if (!cashboxId) {
        throw new BadRequestException(
          'لا توجد وردية مفتوحة — افتح وردية قبل تسجيل السداد',
        );
      }

      const [{ seq }] = await m.query(
        `SELECT nextval('seq_supplier_payment_no') AS seq`,
      );
      const paymentNo = `CP-${String(seq).padStart(6, '0')}`;

      // Single INSERT — the trigger cascades the cash + supplier side.
      const [sp] = await m.query(
        `INSERT INTO supplier_payments
           (payment_no, supplier_id, cashbox_id, warehouse_id,
            payment_method, amount, reference_number, notes, paid_by)
         VALUES ($1, $2, $3, $4, $5::payment_method_code, $6, $7, $8, $9)
         RETURNING id`,
        [
          paymentNo,
          p.supplier_id,
          cashboxId,
          p.warehouse_id,
          dto.payment_method,
          dto.amount,
          dto.reference_number ?? null,
          dto.notes ?? `سداد فاتورة ${p.purchase_no}`,
          userId,
        ],
      );

      // Allocate this payment against the specific purchase.
      await m.query(
        `INSERT INTO supplier_payment_allocations
           (payment_id, purchase_id, amount)
         VALUES ($1, $2, $3)`,
        [sp.id, id, dto.amount],
      );

      // Cash-flow bug fix — recompute purchases.paid_amount and
      // purchases.status from the live allocations. The
      // `trg_supplier_alloc_recompute` trigger (migration 014) only
      // updates `supplier_payments.allocated_amount` — it has never
      // touched the purchases row. Before this fix every successful
      // pay() left `purchases.paid_amount = 0` and the status pinned
      // at 'received' even though the supplier balance + cashbox + GL
      // had all moved correctly. We stay on the OFFICIAL path: no
      // new endpoint, no new cashbox / supplier-ledger / GL writer,
      // no new migration. The recompute is read-only against
      // supplier_payment_allocations + supplier_payments (skipping
      // voided parents) and writes only the purchases row.
      await m.query(
        `WITH new_total AS (
           SELECT COALESCE(SUM(spa.amount), 0)::numeric(14,2) AS paid
             FROM supplier_payment_allocations spa
             JOIN supplier_payments sp ON sp.id = spa.payment_id
            WHERE spa.purchase_id = $1
              AND COALESCE(sp.is_void, FALSE) = FALSE
         )
         UPDATE purchases p
            SET paid_amount = new_total.paid,
                status = CASE
                  WHEN new_total.paid >= p.grand_total THEN 'paid'
                  WHEN new_total.paid > 0              THEN 'partial'
                  ELSE 'received'
                END,
                updated_at = NOW()
           FROM new_total
          WHERE p.id = $1`,
        [id],
      );

      // Post GL — awaited so a failure rolls back the whole payment.
      if (this.posting) {
        const res = (await this.posting.postSupplierPayment(
          sp.id,
          userId,
          m,
        )) as any;
        if (res && res.error) {
          throw new BadRequestException(
            `فشل ترحيل السداد للحسابات: ${res.error}`,
          );
        }
      }

      const [{ paid_amount, status }] = await m.query(
        `SELECT paid_amount, status FROM purchases WHERE id = $1`,
        [id],
      );
      return { paid_amount: Number(paid_amount), status };
    });
  }

  async cancel(id: string, userId?: string) {
    const [p] = await this.ds.query(
      `SELECT * FROM purchases WHERE id = $1`,
      [id],
    );
    if (!p) throw new NotFoundException(`Purchase ${id} not found`);
    if (p.status === 'cancelled') {
      throw new BadRequestException('الفاتورة ملغاة بالفعل');
    }
    if (p.status === 'draft') {
      await this.ds.query(
        `UPDATE purchases SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
        [id],
      );
      return { cancelled: true };
    }
    // Received / paid — go through the reversal SP to put stock back and
    // reverse any cash payments.
    await this.ds.query(`SELECT fn_void_purchase($1, $2, $3)`, [
      id,
      userId || null,
      'إلغاء فاتورة مشتريات',
    ]);
    // Reverse the GL entry so inventory and supplier payables rebound.
    await this.posting
      ?.reverseByReference(
        'purchase',
        id,
        'إلغاء فاتورة مشتريات',
        userId || '',
      )
      .catch(() => undefined);
    return { cancelled: true, reversed: true };
  }

  /**
   * Edit a purchase invoice.
   *
   * DRAFT (PR-PURCHASES-P2.3A): full in-place edit that re-runs the
   * landed-cost allocator and rewrites items + extras. UNCHANGED.
   * Same `id` + same `purchase_no` preserved.
   *
   * CANCELLED: blocked.
   *
   * RECEIVED (paid_amount = 0): BLOCKED (PR-PURCHASES-P2.3C-FIX).
   * The previous P2.3B safe-replacement flow created a brand-new
   * purchase_no + id for every received edit, which surfaced as
   * "تم إصدار فاتورة بديلة" in the UI — not what the operator wants.
   * In-place delta editing of a received purchase requires a
   * dedicated stock/supplier/GL delta design and is deferred to its
   * own phase. The operator's interim workarounds are documented in
   * the Arabic blocking message (raise a purchase return for the
   * affected items, or cancel + re-create if the invoice is still
   * fully unpaid).
   *
   * PARTIAL / PAID / paid_amount > 0: blocked.
   *
   * Hard guarantees (pinned by the spec in this directory):
   *   · No call to `fn_void_purchase` from edit() anymore.
   *   · No call to `posting.reverseByReference` from edit() anymore.
   *   · No call to `create()` / `receive()` from edit().
   *   · No write to `replaces_purchase_id` / `replaced_by_purchase_id`
   *     from edit(). Existing chained rows from prior P2.3B usage
   *     keep their links intact; the columns are inert going forward.
   *   · No direct `journal_entries` / `journal_lines` /
   *     `cashbox_transactions` / `cashbox_balances` / supplier_ledger
   *     writes from edit().
   *   · No `backend/src/provisioning/` touch.
   */
  async edit(
    id: string,
    dto: CreatePurchaseDto & { edit_reason?: string },
    userId: string,
    _reason: string,
  ) {
    const [existing] = await this.ds.query(
      `SELECT * FROM purchases WHERE id = $1`,
      [id],
    );
    if (!existing) throw new NotFoundException(`Purchase ${id} not found`);
    if (existing.status === 'cancelled') {
      throw new BadRequestException('الفاتورة ملغاة — لا يمكن تعديلها');
    }

    // ── DRAFT → in-place full edit with allocator ──────────────────
    if (existing.status === 'draft') {
      if (!dto.items?.length) {
        throw new BadRequestException('يجب إضافة صنف واحد على الأقل');
      }
      // Allocator runs OUTSIDE the transaction (same shape as create())
      // so manual-allocation mismatches surface before we touch the
      // DB. Throws BadRequestException with the canonical Arabic
      // message on mismatch.
      const allocation = this.runAllocatorOrThrow(dto);

      const base_subtotal = allocation.base_subtotal;
      const extra_costs_capitalized = allocation.capitalized_total;
      const extra_costs_non_capitalized = allocation.non_capitalized_total;
      const grand_total = +(
        base_subtotal
        - (dto.discount_amount || 0)
        + (dto.tax_amount || 0)
        + (dto.shipping_cost || 0)
        + extra_costs_capitalized
        + extra_costs_non_capitalized
      ).toFixed(2);

      return this.ds.transaction(async (em) => {
        await em.query(
          `UPDATE purchases
              SET supplier_id              = $2,
                  warehouse_id             = $3,
                  notes                    = $4,
                  subtotal                 = $5,
                  shipping_cost            = $6,
                  discount_amount          = $7,
                  tax_amount               = $8,
                  grand_total              = $9,
                  extra_costs_capitalized  = $10,
                  extra_costs_non_capitalized = $11,
                  updated_at               = NOW()
            WHERE id = $1`,
          [
            id,
            dto.supplier_id ?? existing.supplier_id,
            dto.warehouse_id ?? existing.warehouse_id,
            dto.notes ?? existing.notes,
            base_subtotal,
            dto.shipping_cost || 0,
            dto.discount_amount || 0,
            dto.tax_amount || 0,
            grand_total,
            extra_costs_capitalized,
            extra_costs_non_capitalized,
          ],
        );
        await em.query(
          `DELETE FROM purchase_items WHERE purchase_id = $1`,
          [id],
        );
        for (const line of allocation.lines) {
          await em.query(
            `INSERT INTO purchase_items
               (purchase_id, variant_id, quantity,
                base_unit_cost, allocated_cost_total, allocated_cost_per_unit,
                unit_cost, discount, tax, line_total,
                manual_allocation)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              id,
              line.variant_id,
              line.quantity,
              line.base_unit_cost,
              line.allocated_cost_total,
              line.allocated_cost_per_unit,
              line.unit_cost,
              line.discount,
              line.tax,
              line.line_total,
              line.manual_allocation,
            ],
          );
        }
        await em.query(
          `DELETE FROM purchase_extra_costs WHERE purchase_id = $1`,
          [id],
        );
        const extras = dto.extra_costs ?? [];
        for (let i = 0; i < extras.length; i++) {
          const e = extras[i];
          await em.query(
            `INSERT INTO purchase_extra_costs
               (purchase_id, cost_type, label, amount,
                capitalize_to_inventory, allocation_method,
                notes, sort_order, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              id,
              e.cost_type,
              e.label ?? null,
              e.amount,
              e.capitalize_to_inventory !== false,
              e.allocation_method ?? 'by_value',
              e.notes ?? null,
              e.sort_order ?? i,
              userId,
            ],
          );
        }
        const [out] = await em.query(
          `SELECT * FROM purchases WHERE id = $1`,
          [id],
        );
        return { edited: true, purchase: out };
      });
    }

    // ── PR-PURCHASES-P2.3C-FIX — paid / partial / paid_amount > 0 stay
    // BLOCKED until a dedicated refund + top-up flow ships. Defensive
    // `paid_amount > 0` check covers the edge case where status is
    // somehow still 'received' but a payment has landed.
    const paidAmount = Number(existing.paid_amount ?? 0);
    if (
      existing.status === 'partial'
      || existing.status === 'paid'
      || paidAmount > 0
    ) {
      throw new BadRequestException(
        'الفاتورة مسددة جزئيًا أو كليًا. التعديل بعد بدء السداد يحتاج خطوة استرداد أو دفعة إضافية، وسيتم تنفيذه في المرحلة القادمة.',
      );
    }

    // ── PR-PURCHASES-P2.3C-FIX — received + unpaid is now BLOCKED.
    //
    // The previous P2.3B "safe replacement" flow (fn_void_purchase +
    // reverseByReference + create + receive + replaces_*_id link) is
    // removed:
    //
    //   · It generated a NEW purchase_no and a NEW purchase id for
    //     every edit, surfacing as "تم إصدار فاتورة بديلة" in the UI —
    //     not what the operator wants.
    //   · `fn_void_purchase` was crashing at runtime on the invalid
    //     `sp.purchase_id` reference in migration 033 (now fixed in
    //     migration 140, but this path no longer calls it).
    //
    // In-place delta editing of a received purchase requires a
    // dedicated design for stock/supplier/GL deltas and is deferred
    // to its own phase (P2.5). For now the operator has two
    // workarounds documented in the Arabic message: raise a purchase
    // return (P2.4A) for the impacted items, or cancel the invoice
    // and re-create it (only safe when the invoice is still unpaid).
    throw new BadRequestException(
      'تعديل الفاتورة بعد الاستلام غير متاح حاليًا. استخدم مرتجع مشتريات للأصناف التي تم إرجاعها، أو ألغِ الفاتورة وأعد إنشاءها إذا كانت غير مسددة.',
    );
  }

  // --------------------------------------------------------------------------
  //  Purchase Returns (إرجاع للمورد) — PR-P2.4A
  //
  //  Upgraded the existing /purchases/returns* methods in place (no
  //  second namespace, no second module). Adds four settlement modes,
  //  per-item returnable-qty enforcement (received − sum(posted)),
  //  cashbox refund-in via fn_record_cashbox_txn, and GL via
  //  PostingService.postPurchaseReturn.
  //
  //  Write footprint (pinned by spec):
  //   · INSERT INTO purchase_returns / purchase_return_items
  //   · UPDATE stock + INSERT INTO stock_movements
  //   · UPDATE suppliers + INSERT INTO supplier_ledger  (supplier_credit)
  //   · SELECT fn_record_cashbox_txn(...)                (cash/bank_refund)
  //   · GL only via posting.postPurchaseReturn / reverseByReference
  //   · NO direct journal_entries/journal_lines/cashbox_transactions writes.
  // --------------------------------------------------------------------------
  listReturns(filters?: {
    q?: string;
    supplier_id?: string;
    status?: string;
    from?: string;
    to?: string;
  }) {
    const params: any[] = [];
    const conds: string[] = [];
    if (filters?.q && filters.q.trim()) {
      params.push(`%${filters.q.trim()}%`);
      const i = params.length;
      conds.push(
        `(pr.return_no ILIKE $${i}::text OR s.name ILIKE $${i}::text)`,
      );
    }
    if (filters?.supplier_id) {
      params.push(filters.supplier_id);
      conds.push(`pr.supplier_id = $${params.length}::uuid`);
    }
    if (filters?.status) {
      params.push(filters.status);
      conds.push(`pr.status = $${params.length}`);
    }
    if (filters?.from) {
      params.push(filters.from);
      conds.push(`pr.return_date >= $${params.length}::date`);
    }
    if (filters?.to) {
      params.push(filters.to);
      conds.push(`pr.return_date <= $${params.length}::date`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return this.ds.query(
      `SELECT pr.id, pr.return_no, pr.return_date, pr.supplier_id,
              s.name AS supplier_name,
              pr.warehouse_id, w.name_ar AS warehouse_name,
              pr.total_amount, pr.status, pr.reason,
              pr.settlement_type, pr.refund_amount, pr.cashbox_id,
              pr.posted_at, pr.cancelled_at,
              (SELECT COUNT(*) FROM purchase_return_items pri
                WHERE pri.purchase_return_id = pr.id)::int AS items_count
         FROM purchase_returns pr
         LEFT JOIN suppliers s  ON s.id = pr.supplier_id
         LEFT JOIN warehouses w ON w.id = pr.warehouse_id
         ${where}
         ORDER BY pr.return_date DESC, pr.created_at DESC
         LIMIT 500`,
      params,
    );
  }

  async getReturn(id: string) {
    const [header] = await this.ds.query(
      `SELECT pr.*, s.name AS supplier_name, w.name_ar AS warehouse_name,
              cb.name_ar AS cashbox_name, cb.kind AS cashbox_kind,
              u_created.full_name    AS created_by_name,
              u_posted.full_name     AS posted_by_name,
              u_cancelled.full_name  AS cancelled_by_name
         FROM purchase_returns pr
         LEFT JOIN suppliers s            ON s.id = pr.supplier_id
         LEFT JOIN warehouses w           ON w.id = pr.warehouse_id
         LEFT JOIN cashboxes cb           ON cb.id = pr.cashbox_id
         LEFT JOIN users u_created        ON u_created.id = pr.created_by
         LEFT JOIN users u_posted         ON u_posted.id = pr.posted_by
         LEFT JOIN users u_cancelled      ON u_cancelled.id = pr.cancelled_by
        WHERE pr.id = $1`,
      [id],
    );
    if (!header) throw new NotFoundException(`Purchase return ${id} not found`);
    const items = await this.ds.query(
      `SELECT pri.*, pv.sku, pv.barcode,
              p.id AS product_id, p.name_ar AS product_name,
              c.name_ar AS color_name, s.size_label AS size_label
         FROM purchase_return_items pri
         JOIN product_variants pv ON pv.id = pri.variant_id
         JOIN products p          ON p.id = pv.product_id
         LEFT JOIN colors c       ON c.id = pv.color_id
         LEFT JOIN sizes s        ON s.id = pv.size_id
        WHERE pri.purchase_return_id = $1
        ORDER BY p.name_ar, pv.sku`,
      [id],
    );
    return { ...header, items };
  }

  /**
   * Per-item returnable qty for a parent purchase:
   *   received − sum(posted purchase_return_items.quantity for same purchase_item_id)
   */
  async getReturnableItems(purchaseId: string) {
    const [purchase] = await this.ds.query(
      `SELECT id, purchase_no, supplier_id, warehouse_id, status
         FROM purchases WHERE id = $1`,
      [purchaseId],
    );
    if (!purchase) {
      throw new NotFoundException(`Purchase ${purchaseId} not found`);
    }
    if (purchase.status === 'draft' || purchase.status === 'cancelled') {
      throw new BadRequestException(
        'لا يمكن إنشاء مرتجع لفاتورة مسودة أو ملغاة',
      );
    }
    const items = await this.ds.query(
      `SELECT
         pi.id                          AS purchase_item_id,
         pi.variant_id,
         pv.sku, pv.barcode,
         p.id                           AS product_id,
         p.name_ar                      AS product_name,
         c.name_ar                      AS color_name,
         s.size_label                   AS size_label,
         pi.quantity                    AS received,
         pi.unit_cost                   AS unit_cost,
         pi.base_unit_cost              AS base_unit_cost,
         COALESCE((
           SELECT SUM(pri.quantity)
             FROM purchase_return_items pri
             JOIN purchase_returns pr ON pr.id = pri.purchase_return_id
            WHERE pri.purchase_item_id = pi.id
              AND pr.status = 'posted'
         ), 0)::numeric(12,3)           AS already_returned,
         (pi.quantity - COALESCE((
           SELECT SUM(pri.quantity)
             FROM purchase_return_items pri
             JOIN purchase_returns pr ON pr.id = pri.purchase_return_id
            WHERE pri.purchase_item_id = pi.id
              AND pr.status = 'posted'
         ), 0))::numeric(12,3)          AS returnable
        FROM purchase_items pi
        JOIN product_variants pv ON pv.id = pi.variant_id
        JOIN products p          ON p.id = pv.product_id
        LEFT JOIN colors c       ON c.id = pv.color_id
        LEFT JOIN sizes s        ON s.id = pv.size_id
       WHERE pi.purchase_id = $1
       ORDER BY p.name_ar, pv.sku`,
      [purchaseId],
    );
    return {
      purchase: {
        id: purchase.id,
        purchase_no: purchase.purchase_no,
        supplier_id: purchase.supplier_id,
        warehouse_id: purchase.warehouse_id,
        status: purchase.status,
      },
      items,
    };
  }

  /**
   * Create + post a purchase return atomically. 4 settlement modes:
   *  · supplier_credit  → AP credit (DR 211 / CR 1131) + supplier_ledger 'out'
   *  · cash_refund      → cash cashbox refund-in (DR cash COA / CR 1131)
   *  · bank_refund      → non-cash cashbox refund-in (DR bank COA / CR 1131)
   *  · no_settlement    → stock-only return (no ledger, no cashbox, no GL)
   *
   * Hard rule for P2.4A: cash/bank refund_amount === total_amount.
   */
  async createReturn(dto: CreatePurchaseReturnDto, userId: string) {
    const settlementType = dto.settlement_type;
    if (
      settlementType === 'cash_refund'
      || settlementType === 'bank_refund'
    ) {
      if (!dto.cashbox_id) {
        throw new BadRequestException(
          'يجب تحديد الخزنة للاسترداد النقدي أو البنكي',
        );
      }
      if (dto.refund_amount === undefined || dto.refund_amount === null) {
        throw new BadRequestException(
          'يجب تحديد مبلغ الاسترداد للاسترداد النقدي أو البنكي',
        );
      }
    } else {
      if (dto.cashbox_id) {
        throw new BadRequestException(
          'لا تُحدد خزنة لطرق التسوية بخلاف الاسترداد النقدي/البنكي',
        );
      }
      if (dto.refund_amount !== undefined && dto.refund_amount !== null) {
        throw new BadRequestException(
          'لا تُحدد مبلغ استرداد لطرق التسوية بخلاف الاسترداد النقدي/البنكي',
        );
      }
    }
    if (!dto.reason || dto.reason.trim().length < 3) {
      throw new BadRequestException('يجب كتابة سبب المرتجع (3 أحرف على الأقل)');
    }
    if (!dto.items?.length) {
      throw new BadRequestException('يجب إضافة صنف واحد على الأقل');
    }
    const totalAmount = +dto.items
      .reduce((s, i) => s + Number(i.quantity) * Number(i.unit_cost), 0)
      .toFixed(2);
    if (totalAmount < 0.01) {
      throw new BadRequestException('قيمة المرتجع يجب أن تكون أكبر من صفر');
    }
    if (
      (settlementType === 'cash_refund' || settlementType === 'bank_refund')
      && Math.abs(Number(dto.refund_amount) - totalAmount) > 0.005
    ) {
      throw new BadRequestException(
        'مبلغ الاسترداد يجب أن يساوي إجمالي قيمة المرتجع في هذه المرحلة',
      );
    }

    if (dto.purchase_id) {
      const [parent] = await this.ds.query(
        `SELECT id, status FROM purchases WHERE id = $1`,
        [dto.purchase_id],
      );
      if (!parent) {
        throw new NotFoundException(`Purchase ${dto.purchase_id} not found`);
      }
      if (parent.status === 'draft' || parent.status === 'cancelled') {
        throw new BadRequestException(
          'لا يمكن إنشاء مرتجع لفاتورة مسودة أو ملغاة',
        );
      }
    }

    if (dto.cashbox_id) {
      const [cb] = await this.ds.query(
        `SELECT id, kind FROM cashboxes WHERE id = $1`,
        [dto.cashbox_id],
      );
      if (!cb) {
        throw new BadRequestException('الخزنة المحددة غير موجودة');
      }
      if (cb.kind === 'cash' && settlementType === 'bank_refund') {
        throw new BadRequestException(
          'لا يمكن استخدام خزنة نقدية لاسترداد بنكي',
        );
      }
      if (cb.kind && cb.kind !== 'cash' && settlementType === 'cash_refund') {
        throw new BadRequestException(
          'لا يمكن استخدام حساب بنكي/محفظة لاسترداد نقدي',
        );
      }
    }

    return this.ds.transaction(async (m) => {
      const [ret] = await m.query(
        `INSERT INTO purchase_returns
            (purchase_id, supplier_id, warehouse_id, return_date,
             total_amount, reason, notes, status,
             settlement_type, refund_amount, cashbox_id,
             posted_at, posted_by, created_by)
         VALUES ($1,$2,$3, COALESCE($4::date, CURRENT_DATE),
                 $5, $6, $7, 'posted',
                 $8, $9, $10,
                 NOW(), $11, $11)
         RETURNING *`,
        [
          dto.purchase_id ?? null,
          dto.supplier_id,
          dto.warehouse_id,
          dto.return_date ?? null,
          totalAmount,
          dto.reason.trim(),
          dto.notes?.trim() || null,
          settlementType,
          settlementType === 'cash_refund' || settlementType === 'bank_refund'
            ? totalAmount
            : null,
          dto.cashbox_id ?? null,
          userId,
        ],
      );
      const returnId = ret.id as string;

      for (const it of dto.items) {
        if (it.purchase_item_id) {
          const [pi] = await m.query(
            `SELECT pi.id, pi.purchase_id, pi.variant_id, pi.quantity
               FROM purchase_items pi
              WHERE pi.id = $1 FOR UPDATE`,
            [it.purchase_item_id],
          );
          if (!pi) {
            throw new BadRequestException(
              `بند المشتريات غير موجود: ${it.purchase_item_id}`,
            );
          }
          if (dto.purchase_id && pi.purchase_id !== dto.purchase_id) {
            throw new BadRequestException('بند المشتريات لا ينتمي لهذه الفاتورة');
          }
          if (pi.variant_id !== it.variant_id) {
            throw new BadRequestException('الصنف غير مطابق لبند المشتريات');
          }
          const [prevRow] = await m.query(
            `SELECT COALESCE(SUM(pri.quantity), 0)::numeric(12,3) AS already
               FROM purchase_return_items pri
               JOIN purchase_returns pr ON pr.id = pri.purchase_return_id
              WHERE pri.purchase_item_id = $1 AND pr.status = 'posted'`,
            [it.purchase_item_id],
          );
          const alreadyReturned = Number(prevRow?.already ?? 0);
          const received = Number(pi.quantity);
          const returnable = received - alreadyReturned;
          if (Number(it.quantity) > returnable + 0.0005) {
            throw new BadRequestException(
              `الكمية المطلوبة (${it.quantity}) تتجاوز الكمية القابلة للإرجاع (${returnable.toFixed(3)}) للصنف ${it.variant_id}`,
            );
          }
        }

        const [stockRow] = await m.query(
          `SELECT quantity_on_hand FROM stock
            WHERE variant_id = $1 AND warehouse_id = $2 FOR UPDATE`,
          [it.variant_id, dto.warehouse_id],
        );
        const onHand = Number(stockRow?.quantity_on_hand ?? 0);
        if (onHand < Number(it.quantity)) {
          throw new BadRequestException(
            `الكمية غير كافية للصنف ${it.variant_id} (المتاح ${onHand})`,
          );
        }

        const lineTotal = +(
          Number(it.quantity) * Number(it.unit_cost)
        ).toFixed(2);

        await m.query(
          `INSERT INTO purchase_return_items
              (purchase_return_id, purchase_item_id, variant_id,
               quantity, unit_cost, line_total)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            returnId,
            it.purchase_item_id ?? null,
            it.variant_id,
            it.quantity,
            it.unit_cost,
            lineTotal,
          ],
        );

        await m.query(
          `UPDATE stock
              SET quantity_on_hand = quantity_on_hand - $1, updated_at = NOW()
            WHERE variant_id = $2 AND warehouse_id = $3`,
          [it.quantity, it.variant_id, dto.warehouse_id],
        );
        await m.query(
          // PR-PURCHASES-P2.4A-FIX-ENUM: 'purchase_return' is NOT a member
          // of the stock_movement_type enum. Use the generic 'adjustment'
          // value (same pattern as fn_void_purchase and POS cancel) and
          // keep the semantic linkage via reference_type / reference_id.
          `INSERT INTO stock_movements
             (variant_id, warehouse_id, movement_type, direction,
              quantity, unit_cost, reference_type, reference_id, user_id)
           VALUES ($1,$2,'adjustment','out', $3, $4, 'purchase_return', $5, $6)`,
          [
            it.variant_id,
            dto.warehouse_id,
            it.quantity,
            it.unit_cost,
            returnId,
            userId,
          ],
        );
      }

      if (settlementType === 'supplier_credit') {
        await m.query(
          `UPDATE suppliers
              SET current_balance = current_balance - $1, updated_at = NOW()
            WHERE id = $2`,
          [totalAmount, dto.supplier_id],
        );
        const [{ current_balance }] = await m.query(
          `SELECT current_balance FROM suppliers WHERE id = $1`,
          [dto.supplier_id],
        );
        await m.query(
          `INSERT INTO supplier_ledger
              (supplier_id, direction, amount, reference_type,
               reference_id, balance_after, notes, user_id)
           VALUES ($1, 'out', $2, 'purchase_return', $3, $4, $5, $6)`,
          [
            dto.supplier_id,
            totalAmount,
            returnId,
            current_balance,
            `مرتجع مشتريات ${ret.return_no} — رصيد دائن للمورد`,
            userId,
          ],
        );
      } else if (
        settlementType === 'cash_refund'
        || settlementType === 'bank_refund'
      ) {
        await m.query(
          `SELECT fn_record_cashbox_txn(
              $1::uuid, 'in'::text, $2::numeric, 'receipt'::text,
              'purchase_return'::text, $3::uuid, $4::uuid, $5::text
           )`,
          [
            dto.cashbox_id,
            totalAmount,
            returnId,
            userId,
            `استرداد مرتجع مشتريات ${ret.return_no}`,
          ],
        );
      }

      if (settlementType !== 'no_settlement' && this.posting) {
        const res = (await this.posting.postPurchaseReturn(
          returnId,
          userId,
          m,
        )) as any;
        if (res && res.error) {
          throw new BadRequestException(
            `فشل ترحيل المرتجع للحسابات: ${res.error}`,
          );
        }
      }

      return this.getReturn(returnId);
    });
  }

  async cancelReturn(id: string, userId: string) {
    return this.ds.transaction(async (m) => {
      const [ret] = await m.query(
        `SELECT * FROM purchase_returns WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!ret) throw new NotFoundException(`Purchase return ${id} not found`);
      if (ret.status === 'cancelled') {
        throw new BadRequestException('المرتجع ملغى بالفعل');
      }

      const items = await m.query(
        `SELECT variant_id, quantity, unit_cost
           FROM purchase_return_items WHERE purchase_return_id = $1`,
        [id],
      );

      for (const it of items) {
        await m.query(
          `UPDATE stock
              SET quantity_on_hand = quantity_on_hand + $1, updated_at = NOW()
            WHERE variant_id = $2 AND warehouse_id = $3`,
          [it.quantity, it.variant_id, ret.warehouse_id],
        );
        await m.query(
          // PR-PURCHASES-P2.4A-FIX-ENUM: see comment on the create path
          // above. movement_type='adjustment' + direction='in' is the
          // cancel reversal; reference_type='purchase_return' keeps the
          // semantic link for `posting.reverseByReference`.
          `INSERT INTO stock_movements
             (variant_id, warehouse_id, movement_type, direction,
              quantity, unit_cost, reference_type, reference_id, user_id, notes)
           VALUES ($1,$2,'adjustment','in', $3, $4,
                   'purchase_return', $5, $6,
                   'عكس مرتجع مشتريات')`,
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

      const totalAmount = Number(ret.total_amount);
      if (ret.settlement_type === 'supplier_credit') {
        await m.query(
          `UPDATE suppliers
              SET current_balance = current_balance + $1, updated_at = NOW()
            WHERE id = $2`,
          [totalAmount, ret.supplier_id],
        );
        const [{ current_balance }] = await m.query(
          `SELECT current_balance FROM suppliers WHERE id = $1`,
          [ret.supplier_id],
        );
        await m.query(
          `INSERT INTO supplier_ledger
              (supplier_id, direction, amount, reference_type,
               reference_id, balance_after, notes, user_id)
           VALUES ($1, 'in', $2, 'purchase_return', $3, $4, $5, $6)`,
          [
            ret.supplier_id,
            totalAmount,
            id,
            current_balance,
            `عكس مرتجع مشتريات ${ret.return_no}`,
            userId,
          ],
        );
      }

      if (
        (ret.settlement_type === 'cash_refund'
          || ret.settlement_type === 'bank_refund')
        && ret.cashbox_id
        && ret.refund_amount !== null
      ) {
        await m.query(
          `SELECT fn_record_cashbox_txn(
              $1::uuid, 'out'::text, $2::numeric, 'receipt'::text,
              'purchase_return'::text, $3::uuid, $4::uuid, $5::text
           )`,
          [
            ret.cashbox_id,
            Number(ret.refund_amount),
            id,
            userId,
            `عكس استرداد مرتجع مشتريات ${ret.return_no}`,
          ],
        );
      }

      if (ret.settlement_type !== 'no_settlement' && this.posting) {
        const res = (await this.posting.reverseByReference(
          'purchase_return',
          id,
          `إلغاء مرتجع مشتريات ${ret.return_no}`,
          userId,
          m,
        )) as any;
        if (res && res.error) {
          throw new BadRequestException(
            `فشل عكس قيد المرتجع: ${res.error}`,
          );
        }
      }

      await m.query(
        `UPDATE purchase_returns
            SET status = 'cancelled',
                cancelled_at = NOW(),
                cancelled_by = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [id, userId],
      );

      return { cancelled: true, id };
    });
  }

  // --------------------------------------------------------------------------
  //  Purchases P1 — read-only helpers for the purchase invoice page
  //  (PR-PURCHASES-P1).  No mutations, no schema changes — these wrap
  //  existing tables (suppliers, purchases, product_variants, stock,
  //  purchase_items) for the new supplier-context card and product-
  //  search-with-exact-match-priority controls in the create-invoice UI.
  // --------------------------------------------------------------------------

  /**
   * Supplier context for the purchase invoice header. Read-only — wraps
   * the existing suppliers table plus aggregated purchases history into
   * a single payload sized to the purchase page's needs (smaller than
   * `suppliers.summary()`, which targets the full supplier profile).
   *
   * Balance convention:
   *   suppliers.current_balance > 0 → "له"   (we owe the supplier)
   *   suppliers.current_balance < 0 → "علينا" / "credit"  (rare)
   *   suppliers.current_balance = 0 → "صفر"
   */
  async supplierContext(supplierId: string) {
    const [supplier] = await this.ds.query(
      `SELECT id, code, name, supplier_type, current_balance,
              credit_limit, payment_terms_days, payment_day_of_week,
              opening_balance
         FROM suppliers
        WHERE id = $1`,
      [supplierId],
    );
    if (!supplier) {
      throw new NotFoundException('المورد غير موجود');
    }

    const [agg] = await this.ds.query(
      `SELECT COUNT(*)::int                                    AS purchase_count,
              COALESCE(SUM(grand_total), 0)::numeric(14,2)     AS purchases_total,
              COALESCE(SUM(paid_amount), 0)::numeric(14,2)     AS paid_total,
              COALESCE(
                SUM(GREATEST(grand_total - paid_amount, 0))
                  FILTER (WHERE status IN ('received','partial')),
                0
              )::numeric(14,2)                                  AS unpaid_total
         FROM purchases
        WHERE supplier_id = $1
          AND status <> 'cancelled'`,
      [supplierId],
    );

    const [lastPurchase] = await this.ds.query(
      `SELECT id, purchase_no, invoice_date, grand_total, paid_amount,
              status,
              (grand_total - paid_amount)::numeric(14,2) AS remaining
         FROM purchases
        WHERE supplier_id = $1
          AND status <> 'cancelled'
        ORDER BY invoice_date DESC, created_at DESC
        LIMIT 1`,
      [supplierId],
    );

    // Pick a human label for the last invoice's payment posture so the
    // UI can render it directly.  Mirrors the status column without
    // exposing the enum strings.
    let lastInteraction: 'cash' | 'partial' | 'credit' | null = null;
    if (lastPurchase) {
      const remaining = Number(lastPurchase.remaining || 0);
      const paid = Number(lastPurchase.paid_amount || 0);
      if (remaining <= 0.005) lastInteraction = 'cash';
      else if (paid > 0) lastInteraction = 'partial';
      else lastInteraction = 'credit';
    }

    const balance = Number(supplier.current_balance || 0);
    const balanceDirection: 'owed_to_supplier' | 'credit_to_us' | 'zero' =
      balance > 0.005
        ? 'owed_to_supplier'
        : balance < -0.005
          ? 'credit_to_us'
          : 'zero';

    return {
      supplier: {
        id: supplier.id,
        code: supplier.code,
        name: supplier.name,
        supplier_type: supplier.supplier_type,
        current_balance: balance,
        balance_direction: balanceDirection,
        credit_limit: Number(supplier.credit_limit || 0),
        payment_terms_days: Number(supplier.payment_terms_days || 0),
      },
      stats: {
        purchase_count: Number(agg?.purchase_count ?? 0),
        purchases_total: Number(agg?.purchases_total ?? 0),
        paid_total: Number(agg?.paid_total ?? 0),
        unpaid_total: Number(agg?.unpaid_total ?? 0),
      },
      last_purchase: lastPurchase
        ? {
            id: lastPurchase.id,
            purchase_no: lastPurchase.purchase_no,
            invoice_date: lastPurchase.invoice_date,
            grand_total: Number(lastPurchase.grand_total || 0),
            paid_amount: Number(lastPurchase.paid_amount || 0),
            remaining: Number(lastPurchase.remaining || 0),
            status: lastPurchase.status,
            interaction: lastInteraction,
          }
        : null,
    };
  }

  /**
   * Product search tuned for the purchase invoice line entry.  Returns
   * variant-level rows (each one a sellable line target) with optional
   * stock + last-purchase metadata so the operator can see at a glance
   * what they previously paid for this variant.
   *
   * Exact match priority:
   *   rank 1 — variant.barcode exact (case-insensitive)
   *   rank 2 — variant.sku       exact
   *   rank 3 — product.sku_root  exact
   *   rank 4 — fuzzy (name_ar / name_en / color / size ILIKE)
   *
   * Caller signals exact-match wanted by simply typing the code; the
   * response carries `exact_match: true` for any row whose rank is 1-3
   * so the UI can render the "تطابق كامل" badge AND auto-select on
   * Enter when results.length === 1 && results[0].exact_match.
   */
  async productSearch(args: {
    q: string;
    warehouse_id?: string | null;
    limit?: number;
  }) {
    const qRaw = String(args.q ?? '').trim();
    const limit = Math.min(Math.max(Number(args.limit ?? 25), 1), 100);
    if (qRaw.length < 1) {
      return { query: '', results: [] };
    }
    const warehouseId = args.warehouse_id || null;
    const fuzzyLike = `%${qRaw}%`;

    // Single round-trip: rank-scored search + per-row stock lookup +
    // per-row most-recent purchase price via a LATERAL join.
    const rows = await this.ds.query(
      `WITH search_results AS (
         SELECT v.id   AS variant_id, v.sku, v.barcode,
                v.color, v.size, v.cost_price, v.selling_price,
                v.image_url AS variant_image_url,
                p.id   AS product_id, p.sku_root,
                p.name_ar, p.name_en, p.primary_image_url,
                p.base_price,
                CASE
                  WHEN LOWER(v.barcode)   = LOWER($1) THEN 1
                  WHEN LOWER(v.sku)       = LOWER($1) THEN 2
                  WHEN LOWER(p.sku_root)  = LOWER($1) THEN 3
                  ELSE 4
                END AS rank_score
           FROM product_variants v
           JOIN products         p ON p.id = v.product_id
          WHERE v.is_active = TRUE
            AND p.is_active = TRUE
            AND (
              LOWER(v.barcode)  = LOWER($1)
              OR LOWER(v.sku)   = LOWER($1)
              OR LOWER(p.sku_root) = LOWER($1)
              OR p.name_ar  ILIKE $2
              OR p.name_en  ILIKE $2
              OR v.color    ILIKE $2
              OR v.size     ILIKE $2
              OR v.sku      ILIKE $2
              OR v.barcode  ILIKE $2
            )
          ORDER BY rank_score, p.name_ar NULLS LAST, v.sku NULLS LAST
          LIMIT $3
       )
       SELECT r.*,
              COALESCE(s.quantity_on_hand, 0)::int AS available_stock,
              lpp.unit_cost   AS last_purchase_price,
              lpp.invoice_date AS last_purchase_at,
              lpp.supplier_name AS last_supplier_name,
              lpp.supplier_id   AS last_supplier_id
         FROM search_results r
         LEFT JOIN stock s
           ON s.variant_id = r.variant_id
          AND ($4::uuid IS NULL OR s.warehouse_id = $4::uuid)
         LEFT JOIN LATERAL (
           SELECT pi.unit_cost,
                  pu.invoice_date,
                  pu.supplier_id,
                  sup.name AS supplier_name
             FROM purchase_items pi
             JOIN purchases  pu  ON pu.id = pi.purchase_id
             JOIN suppliers  sup ON sup.id = pu.supplier_id
            WHERE pi.variant_id = r.variant_id
              AND pu.status IN ('received','partial','paid')
            ORDER BY pu.invoice_date DESC, pu.created_at DESC
            LIMIT 1
         ) lpp ON TRUE
        ORDER BY r.rank_score, r.name_ar NULLS LAST, r.sku NULLS LAST`,
      [qRaw, fuzzyLike, limit, warehouseId],
    );

    return {
      query: qRaw,
      results: rows.map((r: any) => ({
        product_id: r.product_id,
        sku_root: r.sku_root,
        name_ar: r.name_ar,
        name_en: r.name_en,
        primary_image_url: r.primary_image_url,
        base_price: Number(r.base_price ?? 0),
        variant_id: r.variant_id,
        variant_sku: r.sku,
        variant_barcode: r.barcode,
        variant_image_url: r.variant_image_url,
        color: r.color,
        size: r.size,
        cost_price: Number(r.cost_price ?? 0),
        selling_price: Number(r.selling_price ?? 0),
        available_stock: Number(r.available_stock ?? 0),
        last_purchase_price:
          r.last_purchase_price != null ? Number(r.last_purchase_price) : null,
        last_purchase_at: r.last_purchase_at,
        last_supplier_name: r.last_supplier_name,
        last_supplier_id: r.last_supplier_id,
        exact_match: r.rank_score <= 3,
        rank_score: r.rank_score,
      })),
    };
  }
}
