import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  AddPurchasePaymentDto,
  CreatePurchaseDto,
  ListPurchasesDto,
} from './dto/purchase.dto';
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
  async create(dto: CreatePurchaseDto, userId: string) {
    if (!dto.items?.length) {
      throw new BadRequestException('يجب إضافة صنف واحد على الأقل');
    }

    // PR-PURCHASES-P2.1 — run the landed-cost allocator BEFORE the
    // transaction opens. The DTO's `unit_cost` is treated as the BASE
    // (raw) price; the allocator turns it into the landed `unit_cost`
    // that gets written to `purchase_items` and (via receive()) into
    // `product_variants.cost_price`.
    const allocation = this.runAllocatorOrThrow(dto);

    return this.ds.transaction(async (m) => {
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

      // Auto-post inventory capitalization to the GL.
      await this.posting?.postPurchase(id, userId, m).catch(() => undefined);

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
   *      trigger `trg_supplier_alloc_recompute` updates
   *      purchases.paid_amount/status
   *   3. Await `postSupplierPayment` → GL: DR 211 · CR Cash
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

      // Allocate this payment against the specific purchase so the
      // purchases row reflects it via trg_supplier_alloc_recompute.
      await m.query(
        `INSERT INTO supplier_payment_allocations
           (payment_id, purchase_id, amount)
         VALUES ($1, $2, $3)`,
        [sp.id, id, dto.amount],
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
   * landed-cost allocator and rewrites items + extras. Replaces the
   * pre-P2.3 path which silently dropped `extra_costs` and inserted
   * `purchase_items` without the `base_unit_cost NOT NULL` column
   * (P2.1 migration 133).
   *
   * RECEIVED / PARTIAL / PAID: legacy void-and-recreate flow, kept
   * for purchases that don't carry landed-cost extras. When either
   * the existing purchase OR the incoming DTO references extras, the
   * call is blocked with the canonical Arabic message — operators
   * must create a manual adjustment instead.
   *
   * NOTE: the existing GL-reversal leak on the void path (cancel()
   * calls reverseByReference, edit() does not) is INTENTIONALLY left
   * untouched in P2.3A. It will be fixed alongside the proper delta
   * engine in P2.3B.
   */
  async edit(
    id: string,
    dto: CreatePurchaseDto & { edit_reason?: string },
    userId: string,
    reason: string,
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

    // ── RECEIVED / PARTIAL / PAID — block when extras are involved
    // before touching fn_void_purchase. P2.3A defers received/paid
    // landed-cost edits to a future delta engine (P2.3B).
    const [hasExisting] = await this.ds.query(
      `SELECT 1 AS has FROM purchase_extra_costs WHERE purchase_id = $1 LIMIT 1`,
      [id],
    );
    const dtoHasExtras = (dto.extra_costs ?? []).length > 0;
    if (hasExisting || dtoHasExtras) {
      throw new BadRequestException(
        'لا يمكن تعديل مصاريف فاتورة مشتريات مستلمة أو مدفوعة حاليًا. أنشئ تسوية مخصصة أو تواصل مع المدير.',
      );
    }

    // Legacy non-extras path: void via SP, then create a new purchase.
    await this.ds.query(`SELECT fn_void_purchase($1, $2, $3)`, [
      id,
      userId,
      reason,
    ]);
    const tagged = {
      ...dto,
      notes: [dto.notes, `تعديل لفاتورة المشتريات رقم ${id}`]
        .filter(Boolean)
        .join(' — '),
    };
    const created = await this.create(tagged, userId);
    return { replaced: id, purchase: created };
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
