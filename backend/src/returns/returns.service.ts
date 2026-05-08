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
  CancelReturnDto,
  CreateExchangeDto,
  CreateReturnDto,
  ListReturnsQueryDto,
  RefundReturnDto,
  RejectReturnDto,
} from './dto/return.dto';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class ReturnsService {
  constructor(
    @InjectRepository(ReturnEntity)
    private readonly repo: Repository<ReturnEntity>,
    private readonly ds: DataSource,
    @Optional() private readonly posting?: AccountingPostingService,
    @Optional() private readonly engine?: FinancialEngineService,
    @Optional() private readonly audit?: AuditService,
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
   *
   * PR-FIX-RETURN-JE-AT-REFUND — historically `approve()` also posted
   * the return GL via `posting.postReturn`, but `r.cashbox_id` is only
   * populated by `refund()`. After PR #260's cashbox/GL alignment guard
   * (2026-05-03), the cash leg's `cashbox_id=NULL` started failing the
   * engine's invariant for blind returns (no `original_invoice_id`) and
   * the failure was silently swallowed by a `.catch(() => undefined)`,
   * leaving CT-without-JE state (observed: RET-2026-000005). The GL
   * post has moved into `refund()` where `cashbox_id` is known.
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

      // GL posting moved to refund() — see header comment above.

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
  async refund(
    id: string,
    dto: RefundReturnDto,
    userId: string,
    userPermissions: string[] = [],
  ) {
    const ret = await this.mustBeStatus(id, ['approved']);

    // PR-R1 — explicit cash source. For cash refunds the caller MUST
    // pick either an open/pending shift (shift_id) or a direct cashbox
    // (cashbox_id with no shift_id). Direct cashbox is gated by
    // `returns.refund.direct_cashbox` because it intentionally bypasses
    // shift visibility — a cashier can no longer drain a drawer outside
    // their own shift unless they have explicit authorization.
    const isCash = dto.refund_method === 'cash';
    let resolvedShiftId: string | null = null;
    let resolvedCashboxId: string | null = null;

    if (isCash) {
      if (!dto.shift_id && !dto.cashbox_id) {
        throw new BadRequestException(
          'يجب اختيار وردية مفتوحة أو خزنة مباشرة لصرف المرتجع نقدياً',
        );
      }
      if (dto.shift_id) {
        const [shiftRow] = await this.ds.query(
          `SELECT id, cashbox_id, status::text AS status
             FROM shifts WHERE id = $1`,
          [dto.shift_id],
        );
        if (!shiftRow) {
          throw new NotFoundException('الوردية المختارة غير موجودة');
        }
        if (shiftRow.status !== 'open' && shiftRow.status !== 'pending_close') {
          throw new BadRequestException(
            'الوردية المختارة ليست مفتوحة — اختر وردية مفتوحة أو خزنة مباشرة',
          );
        }
        if (
          dto.cashbox_id &&
          dto.cashbox_id !== shiftRow.cashbox_id
        ) {
          throw new BadRequestException(
            'الخزنة المختارة لا تطابق خزنة الوردية',
          );
        }
        resolvedShiftId = shiftRow.id;
        resolvedCashboxId = shiftRow.cashbox_id;
      } else {
        // Direct cashbox branch — requires explicit permission.
        const hasPerm =
          userPermissions.includes('*') ||
          userPermissions.includes('returns.*') ||
          userPermissions.includes('returns.refund.direct_cashbox');
        if (!hasPerm) {
          throw new BadRequestException(
            'الصرف من خزنة مباشرة يتطلب صلاحية returns.refund.direct_cashbox',
          );
        }
        const [cb] = await this.ds.query(
          `SELECT id FROM cashboxes WHERE id = $1 AND is_active = TRUE`,
          [dto.cashbox_id],
        );
        if (!cb) {
          throw new NotFoundException('الخزنة المختارة غير موجودة أو غير نشطة');
        }
        resolvedShiftId = null;
        resolvedCashboxId = cb.id;
      }
    }

    return this.ds.transaction(async (em) => {
      // Persist refund method + linkage on the return row FIRST so the
      // GL post (next step) sees the cashbox_id on the row.
      await em.query(
        `
        UPDATE returns
           SET status        = 'refunded',
               refunded_at   = now(),
               refunded_by   = $2,
               refund_method = $3,
               shift_id      = $4,
               cashbox_id    = $5
         WHERE id = $1
        `,
        [id, userId, dto.refund_method, resolvedShiftId, resolvedCashboxId],
      );

      // PR-FIX-RETURN-JE-AT-REFUND — post the GL inside this same
      // transaction, AFTER cashbox_id is on the row but BEFORE the
      // cashbox_transactions row is written. This way the cash leg
      // carries the cashbox_id (the alignment guard added in PR #260
      // requires it) and a JE failure rolls back the refund instead
      // of leaving CT-without-JE. Idempotency: postReturn's `safe()`
      // wrapper short-circuits on an existing live JE for the same
      // (reference_type='return', reference_id) — retries do not
      // double-post.
      if (!this.posting) {
        throw new BadRequestException(
          'AccountingPostingService غير متاح — لا يمكن قيد المرتجع محاسبياً',
        );
      }
      const postResult: any = await this.posting.postReturn(id, userId, em);
      if (postResult && postResult.error) {
        throw new BadRequestException(
          `فشل قيد المرتجع محاسبياً: ${postResult.error}`,
        );
      }

      // Cash refund → deduct from the resolved cashbox via the engine.
      if (isCash && resolvedCashboxId) {
        // This call writes the physical cashbox_transactions row +
        // updates cashboxes.current_balance under the canonical
        // `engine:cashOnlyMovement` context — no bypass alert, no
        // direct fn_record_cashbox_txn call. The GL side (DR 49 Sales
        // Returns · CR Cash, plus inventory/COGS reversal when
        // back_to_stock) was already written above by `postReturn`.
        if (!this.engine) {
          throw new BadRequestException(
            'FinancialEngineService غير متاح — لا يمكن صرف المرتجع نقدياً',
          );
        }
        const res = await this.engine.recordCashOnlyMovement({
          cashbox_id: resolvedCashboxId,
          direction: 'out',
          amount: Number(ret.net_refund),
          category: 'refund',
          reference_type: 'return',
          reference_id: id,
          user_id: userId,
          notes: resolvedShiftId
            ? `استرداد نقدي — مرتجع ${ret.return_no} (مرتبط بوردية)`
            : `استرداد نقدي — مرتجع ${ret.return_no} (خزنة مباشرة)`,
          em,
        });
        if (!res.ok) {
          throw new BadRequestException(
            `فشل صرف المرتجع نقدياً: ${res.error}`,
          );
        }
      }

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
  //  CANCEL  (admin-only — PR-FIN-RETURNS-UX-1C)
  // ==========================================================================
  /**
   * Admin-only cancellation of an `approved` or `refunded` return. Runs
   * everything in a single DB transaction:
   *
   *   1. Lock the return row (`SELECT … FOR UPDATE`) and re-check status.
   *   2. Validate the typed confirmation token `CANCEL_RETURN_<return_no>`.
   *   3. Reject non-cash refunded returns with the spec's diagnostic —
   *      `returns` has no `payment_account_id` linkage yet, so we cannot
   *      safely reverse a card / instapay / bank_transfer refund.
   *   4. Reverse the GL via `posting.reverseByReference('return', id, …)`
   *      — the canonical engine primitive that swaps DR/CR, preserves
   *      every dimension (cashbox_id, party tags, warehouse_id),
   *      reverses the paired cashbox transactions automatically (cash
   *      refunds), and is idempotent on the original entry id. The
   *      original journal_lines debit/credit values are NOT edited; the
   *      original entry header is flipped to `is_void=TRUE` by the
   *      engine — accepted behavior per PR 1C decision.
   *   5. Reverse stock for every back_to_stock=TRUE return_item with an
   *      inline UPDATE + INSERT … RETURNING id, capturing the new
   *      `stock_movements.id` for the linkage table. We use
   *      `movement_type='adjustment_out'`, `direction='out'`,
   *      `reference_type='return'`, `reference_id=<return_id>`, and a
   *      `notes` prefix `return_cancel_stock_reversal:<return_no>` so
   *      the audit trail joins cleanly without changing
   *      `fn_adjust_stock`.
   *   6. Stamp `returns.status='cancelled'` plus the audit fields and
   *      the reversal entry/CT id linkages added in mig 122.
   *   7. Best-effort activity-log write (`action='void'`, `entity='return'`)
   *      via `AuditService` — never throws.
   *
   * Idempotency: a second cancel attempt fails fast at step 1 because
   * `mustBeStatus` (called via the FOR-UPDATE re-check below) sees
   * `status='cancelled'` and throws `ConflictException` (HTTP 409). The
   * row lock guarantees exactly-once semantics under concurrent calls.
   */
  async cancel(id: string, dto: CancelReturnDto, userId: string) {
    const posting = this.posting;
    if (!posting) {
      throw new BadRequestException(
        'AccountingPostingService غير متاح — لا يمكن إلغاء المرتجع',
      );
    }
    const reasonTrimmed = (dto.reason ?? '').trim();
    if (reasonTrimmed.length === 0) {
      throw new BadRequestException('سبب الإلغاء مطلوب');
    }

    return this.ds.transaction(async (em) => {
      // 1. Lock the row and load the fields we need.
      const [ret] = await em.query(
        `SELECT id, return_no, status, refund_method,
                net_refund, cashbox_id, warehouse_id
           FROM returns
          WHERE id = $1
          FOR UPDATE`,
        [id],
      );
      if (!ret) {
        throw new NotFoundException(`Return ${id} not found`);
      }
      // 2. Status guard. ConflictException (HTTP 409) on already-cancelled
      //    or any non-eligible state — same shape `mustBeStatus` uses for
      //    the other transitions.
      if (ret.status === 'cancelled') {
        throw new ConflictException('المرتجع ملغى بالفعل');
      }
      if (ret.status !== 'approved' && ret.status !== 'refunded') {
        throw new ConflictException(
          `المرتجع حالته "${ret.status}" — الإلغاء مسموح فقط للحالات: approved, refunded`,
        );
      }

      // 3. Confirmation token must match exactly.
      const expectedConfirm = `CANCEL_RETURN_${ret.return_no}`;
      if (dto.confirm !== expectedConfirm) {
        throw new BadRequestException(
          `يجب كتابة رمز التأكيد بالضبط: ${expectedConfirm}`,
        );
      }

      // 4. Non-cash refund guard — reject with the spec's diagnostic
      //    (HTTP 422). returns has no payment_account_id yet, so we
      //    cannot safely identify the payment account to reverse.
      if (
        ret.status === 'refunded' &&
        ret.refund_method &&
        ret.refund_method !== 'cash'
      ) {
        throw new BadRequestException(
          'إلغاء مرتجع غير نقدي يحتاج ربط حساب دفع غير متاح حالياً',
        );
      }

      // 5. Reverse the GL via the canonical engine primitive. This also
      //    reverses the paired cashbox_transactions when the refund was
      //    cash. Idempotent on the original entry id.
      const reverseRes: any = await posting.reverseByReference(
        'return',
        id,
        `إلغاء مرتجع ${ret.return_no}: ${reasonTrimmed}`,
        userId,
        em,
      );
      let cancellationEntryId: string | null = null;
      if (reverseRes && typeof reverseRes === 'object') {
        if (reverseRes.error) {
          throw new BadRequestException(
            `فشل عكس قيد المرتجع: ${reverseRes.error}`,
          );
        }
        cancellationEntryId = reverseRes.entry_id ?? null;
      }
      // reverseRes === null → no live JE existed for this return (rare
      // but possible for a return that was approved without GL post).
      // Proceed with stock + row update; cancellation_entry_id stays NULL.

      // 6. Capture the reversal CT id for cash refunds.
      //    PR-FIN-RETURNS-SHIFT-CANCEL-AWARE — original PR-1C lookup
      //    queried by `reference_type='return', reference_id=<return_id>`,
      //    but the engine's `recordTransaction` runs the cash leg
      //    through `mapToEntityType('reversal')` which yields 'other',
      //    and uses `reference_id=<reversal JE id>`. So the CT lives at
      //    ('other', <reversal JE id>) — the old query never matched
      //    and `cancellation_cashbox_transaction_id` was always NULL.
      //
      //    The corrected lookup walks the reversal-JE bridge:
      //      reversal_ct.reference_id = reversal_je.id
      //      reversal_je.reversal_of  = original_je.id
      //      original_je.reference_id = <return_id>
      let cancellationCtId: string | null = null;
      if (ret.refund_method === 'cash' && cancellationEntryId) {
        const [ctRow] = await em.query(
          `SELECT id::text AS id
             FROM cashbox_transactions
            WHERE reference_type::text = 'other'
              AND reference_id::text = $1
              AND direction = 'in'
              AND is_void = FALSE
              AND category LIKE 'reversal_%'
            ORDER BY id DESC
            LIMIT 1`,
          [cancellationEntryId],
        );
        cancellationCtId = ctRow?.id ?? null;
      }

      // 7. Reverse stock for back_to_stock items. Inline UPDATE + INSERT
      //    so we can capture `stock_movements.id` from RETURNING and
      //    populate the linkage table. We re-derive unit_cost the same
      //    way `postReturn` does so the cost side stays consistent.
      const items = await em.query(
        `SELECT ri.id, ri.variant_id, ri.quantity, ri.back_to_stock,
                ri.condition,
                COALESCE(
                  ii.unit_cost,
                  (SELECT cost_price FROM product_variants WHERE id = ri.variant_id),
                  0
                )::numeric(14,2) AS unit_cost
           FROM return_items ri
           LEFT JOIN invoice_items ii ON ii.id = ri.original_invoice_item_id
          WHERE ri.return_id = $1
            AND ri.back_to_stock = TRUE`,
        [id],
      );

      const reversedMovementIds: string[] = [];
      for (const it of items) {
        const qty = Number(it.quantity);
        if (!(qty > 0)) continue;

        // Deduct stock atomically. We don't insert if the row doesn't
        // exist (it must exist — approve created it).
        await em.query(
          `UPDATE stock
              SET quantity_on_hand = quantity_on_hand - $1,
                  updated_at = NOW()
            WHERE variant_id = $2 AND warehouse_id = $3`,
          [qty, it.variant_id, ret.warehouse_id],
        );

        // Insert reversal stock_movement; capture id via RETURNING.
        const [smRow] = await em.query(
          `INSERT INTO stock_movements
              (variant_id, warehouse_id, movement_type, direction,
               quantity, unit_cost, reference_type, reference_id,
               notes, user_id)
           VALUES
              ($1, $2,
               'adjustment_out'::stock_movement_type,
               'out'::txn_direction,
               $3, $4,
               'return'::entity_type, $5,
               $6, $7)
           RETURNING id`,
          [
            it.variant_id,
            ret.warehouse_id,
            qty,
            Number(it.unit_cost),
            id,
            `return_cancel_stock_reversal:${ret.return_no}`,
            userId,
          ],
        );
        const smId = String(smRow.id);
        reversedMovementIds.push(smId);

        // 7b. Linkage row — unique(return_id, stock_movement_id) makes
        //     ON CONFLICT a no-op on retry (the outer status guard would
        //     already have blocked re-entry, but keep the safety net).
        await em.query(
          `INSERT INTO return_cancellation_stock_movements
             (return_id, stock_movement_id)
           VALUES ($1, $2)
           ON CONFLICT (return_id, stock_movement_id) DO NOTHING`,
          [id, smId],
        );
      }

      // 8. Stamp the cancellation audit fields on the return row.
      await em.query(
        `UPDATE returns
            SET status                              = 'cancelled',
                cancelled_at                        = NOW(),
                cancelled_by                        = $2,
                cancel_reason                       = $3,
                cancellation_entry_id               = $4,
                cancellation_cashbox_transaction_id = $5
          WHERE id = $1`,
        [
          id,
          userId,
          reasonTrimmed,
          cancellationEntryId,
          cancellationCtId,
        ],
      );

      // 9. Best-effort activity log. AuditService.writeActivity never
      //    throws (it catches internally) — wrap anyway in case the
      //    service is unavailable in tests.
      if (this.audit) {
        try {
          await this.audit.writeActivity({
            user_id: userId,
            action: 'void',
            entity: 'return',
            entity_id: id,
            summary: `إلغاء مرتجع ${ret.return_no}: ${reasonTrimmed}`,
            extra: {
              kind: 'cancel_return',
              return_no: ret.return_no,
              reason: reasonTrimmed,
              cancellation_entry_id: cancellationEntryId,
              cancellation_cashbox_transaction_id: cancellationCtId,
              stock_movements_reversed: reversedMovementIds,
            },
          });
        } catch {
          /* swallowed — audit is best-effort */
        }
      }

      return this.findOne(id);
    });
  }

  // ==========================================================================
  //  LIST / GET
  // ==========================================================================

  /**
   * PR-FIN-RETURNS-UX-1A — read enrichment.
   *
   * The list endpoint now joins the operator names, the linked cashbox,
   * the active journal entry, the refund cashbox_transaction, and a
   * computed `accounting_status` / `inventory_status` so the FE can
   * render operator + timestamp + diagnostic badges per row without
   * needing a separate per-row fetch. All joins are LEFT and the new
   * fields are nullable — existing callers that only read the prior
   * shape are unaffected.
   *
   * Filter additions: `date_from`, `date_to`, `refund_method`,
   * `accounting_status` (computed via the same CASE expression that
   * builds the column, wrapped in a sub-CTE so the WHERE can reference
   * it). All optional and backwards compatible.
   *
   * Read-only. No side effects. No write paths touched.
   */
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
    if (q.date_from) {
      params.push(q.date_from);
      where.push(`r.requested_at >= $${params.length}::date`);
    }
    if (q.date_to) {
      // Inclusive upper bound on the day (`<` next day) so callers can
      // pass `2026-05-02` and match every event on that date.
      params.push(q.date_to);
      where.push(
        `r.requested_at < ($${params.length}::date + INTERVAL '1 day')`,
      );
    }
    if (q.refund_method) {
      params.push(q.refund_method);
      where.push(`r.refund_method = $${params.length}`);
    }

    // accounting_status filter is applied AFTER the SELECT computes the
    // column. PR-FIN-RETURNS-SHIFT-ACCOUNTING-FILTER-FIX — the prior
    // implementation tried to reference the SELECT-list alias
    // `accounting_status` directly in the same query's WHERE clause,
    // which Postgres rejects with `column "accounting_status" does not
    // exist` (aliases are not visible in WHERE; only ORDER BY/HAVING
    // see them). The fix below wraps the alias-producing layer in a
    // second CTE (`enriched`) so the filter can target a real column
    // of the outermost SELECT.
    const accountingFilter = q.accounting_status
      ? (() => {
          params.push(q.accounting_status);
          return `WHERE accounting_status = $${params.length}`;
        })()
      : '';

    const limit = Math.min(
      Math.max(parseInt(q.limit ?? '50', 10) || 50, 1),
      200,
    );
    const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0);
    params.push(limit, offset);

    return this.ds.query(
      `
      WITH base AS (
        SELECT
          r.id, r.return_no, r.status, r.reason,
          r.total_refund, r.restocking_fee, r.net_refund, r.refund_method,
          r.requested_at, r.approved_at, r.refunded_at, r.rejected_at,
          r.created_at, r.updated_at,
          r.original_invoice_id, i.invoice_no,
          r.customer_id, c.full_name AS customer_name, c.phone AS customer_phone,
          r.cashbox_id, cb.name_ar AS cashbox_name,
          r.requested_by, u1.full_name AS requested_by_name,
          r.approved_by,  u2.full_name AS approved_by_name,
          r.refunded_by,  u3.full_name AS refunded_by_name,
          (SELECT COUNT(*)::int FROM return_items ri
            WHERE ri.return_id = r.id)                                AS items_count,
          (SELECT COALESCE(SUM(quantity),0)::int FROM return_items ri
            WHERE ri.return_id = r.id)                                AS units_count,
          -- Inventory diagnostic: do we expect any items to have been
          -- restocked? (back_to_stock=true AND condition='resellable')
          (SELECT COUNT(*)::int FROM return_items ri
            WHERE ri.return_id = r.id
              AND ri.back_to_stock = true
              AND ri.condition = 'resellable')                        AS restock_eligible_items,
          -- Active JE for this return.
          (SELECT je.id        FROM journal_entries je
            WHERE je.reference_type='return' AND je.reference_id = r.id
              AND je.is_posted=true AND je.is_void=false LIMIT 1)     AS journal_entry_id,
          (SELECT je.entry_no  FROM journal_entries je
            WHERE je.reference_type='return' AND je.reference_id = r.id
              AND je.is_posted=true AND je.is_void=false LIMIT 1)     AS journal_entry_no,
          (SELECT je.posted_at FROM journal_entries je
            WHERE je.reference_type='return' AND je.reference_id = r.id
              AND je.is_posted=true AND je.is_void=false LIMIT 1)     AS journal_entry_posted_at,
          -- Refund cashbox_transaction for this return.
          (SELECT ct.id FROM cashbox_transactions ct
            WHERE ct.reference_type='return' AND ct.reference_id = r.id
              AND ct.category='refund' AND ct.is_void=false LIMIT 1)  AS refund_cashbox_transaction_id,
          -- Cash leg JL.cashbox_id NULL diagnostic (the bug PR #225 fixed).
          (SELECT BOOL_OR(jl.cashbox_id IS NULL)
             FROM journal_entries je
             JOIN journal_lines  jl ON jl.entry_id = je.id
             JOIN chart_of_accounts coa ON coa.id = jl.account_id
            WHERE je.reference_type='return' AND je.reference_id = r.id
              AND je.is_posted=true AND je.is_void=false
              AND coa.code LIKE '111_'
              AND jl.credit > 0)                                      AS has_unlinked_cash_leg
        FROM returns r
        LEFT JOIN invoices   i  ON i.id  = r.original_invoice_id
        LEFT JOIN customers  c  ON c.id  = r.customer_id
        LEFT JOIN cashboxes  cb ON cb.id = r.cashbox_id
        LEFT JOIN users      u1 ON u1.id = r.requested_by
        LEFT JOIN users      u2 ON u2.id = r.approved_by
        LEFT JOIN users      u3 ON u3.id = r.refunded_by
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ),
      enriched AS (
        SELECT
          b.*,
          -- Computed accounting_status:
          --   not_applicable: pending/rejected (no JE expected)
          --   je_missing:     approved/refunded but no active JE
          --   cashbox_not_linked: JE exists but cash leg cashbox_id NULL
          --   matched:        JE present + (no unlinked cash leg) + (refund CT present iff cash refund)
          --   needs_review:   anything else
          CASE
            WHEN b.status IN ('pending','rejected') THEN 'not_applicable'
            WHEN b.journal_entry_id IS NULL THEN 'je_missing'
            WHEN b.has_unlinked_cash_leg = true THEN 'cashbox_not_linked'
            WHEN b.refund_method = 'cash'
              AND b.status = 'refunded'
              AND b.refund_cashbox_transaction_id IS NULL THEN 'needs_review'
            ELSE 'matched'
          END AS accounting_status,
          -- Computed inventory_status:
          --   not_applicable: no restock-eligible items OR pending/rejected
          --   restored:       approved/refunded with restock-eligible items
          --                   (the approve flow restocks symmetrically; we
          --                   don't yet match against stock_movements at
          --                   the row level — that's a 1B/1C concern)
          CASE
            WHEN b.status IN ('pending','rejected') THEN 'not_applicable'
            WHEN b.restock_eligible_items = 0       THEN 'not_applicable'
            ELSE 'restored'
          END AS inventory_status,
          -- Match status: top-line operational badge for the row.
          CASE
            WHEN b.status IN ('pending','rejected') THEN 'pending'
            WHEN b.journal_entry_id IS NULL THEN 'needs_review'
            WHEN b.has_unlinked_cash_leg = true THEN 'needs_review'
            ELSE 'matched'
          END AS match_status
        FROM base b
      )
      -- PR-FIN-RETURNS-SHIFT-ACCOUNTING-FILTER-FIX — the WHERE on the
      -- outermost SELECT can safely reference accounting_status
      -- because it is a real column of the enriched CTE (not a
      -- SELECT-list alias of the current query).
      SELECT *
      FROM enriched
      ${accountingFilter}
      ORDER BY requested_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params,
    );
  }

  async findOne(id: string) {
    // PR-FIN-RETURNS-UX-1A: detail response inherits the same enriched
    // shape as list() — operator names (already present), cashbox name,
    // active JE id+entry_no+posted_at, refund CT id, computed
    // accounting/inventory/match statuses. No write side-effects.
    const [header] = await this.ds.query(
      `
      WITH base AS (
        SELECT
          r.*,
          i.invoice_no, i.completed_at AS invoice_date,
          c.full_name AS customer_name, c.phone AS customer_phone,
          w.name AS warehouse_name,
          cb.name_ar AS cashbox_name,
          u1.full_name AS requested_by_name,
          u2.full_name AS approved_by_name,
          u3.full_name AS refunded_by_name,
          (SELECT COUNT(*)::int FROM return_items ri
            WHERE ri.return_id = r.id
              AND ri.back_to_stock = true
              AND ri.condition = 'resellable')                        AS restock_eligible_items,
          (SELECT je.id        FROM journal_entries je
            WHERE je.reference_type='return' AND je.reference_id = r.id
              AND je.is_posted=true AND je.is_void=false LIMIT 1)     AS journal_entry_id,
          (SELECT je.entry_no  FROM journal_entries je
            WHERE je.reference_type='return' AND je.reference_id = r.id
              AND je.is_posted=true AND je.is_void=false LIMIT 1)     AS journal_entry_no,
          (SELECT je.posted_at FROM journal_entries je
            WHERE je.reference_type='return' AND je.reference_id = r.id
              AND je.is_posted=true AND je.is_void=false LIMIT 1)     AS journal_entry_posted_at,
          (SELECT ct.id FROM cashbox_transactions ct
            WHERE ct.reference_type='return' AND ct.reference_id = r.id
              AND ct.category='refund' AND ct.is_void=false LIMIT 1)  AS refund_cashbox_transaction_id,
          (SELECT BOOL_OR(jl.cashbox_id IS NULL)
             FROM journal_entries je
             JOIN journal_lines  jl ON jl.entry_id = je.id
             JOIN chart_of_accounts coa ON coa.id = jl.account_id
            WHERE je.reference_type='return' AND je.reference_id = r.id
              AND je.is_posted=true AND je.is_void=false
              AND coa.code LIKE '111_'
              AND jl.credit > 0)                                      AS has_unlinked_cash_leg
        FROM returns r
        LEFT JOIN invoices  i ON i.id  = r.original_invoice_id
        LEFT JOIN customers c ON c.id  = r.customer_id
        LEFT JOIN warehouses w ON w.id = r.warehouse_id
        LEFT JOIN cashboxes  cb ON cb.id = r.cashbox_id
        LEFT JOIN users    u1 ON u1.id = r.requested_by
        LEFT JOIN users    u2 ON u2.id = r.approved_by
        LEFT JOIN users    u3 ON u3.id = r.refunded_by
        WHERE r.id = $1
      )
      SELECT
        b.*,
        CASE
          WHEN b.status IN ('pending','rejected') THEN 'not_applicable'
          WHEN b.journal_entry_id IS NULL THEN 'je_missing'
          WHEN b.has_unlinked_cash_leg = true THEN 'cashbox_not_linked'
          WHEN b.refund_method = 'cash'
            AND b.status = 'refunded'
            AND b.refund_cashbox_transaction_id IS NULL THEN 'needs_review'
          ELSE 'matched'
        END AS accounting_status,
        CASE
          WHEN b.status IN ('pending','rejected') THEN 'not_applicable'
          WHEN b.restock_eligible_items = 0       THEN 'not_applicable'
          ELSE 'restored'
        END AS inventory_status,
        CASE
          WHEN b.status IN ('pending','rejected') THEN 'pending'
          WHEN b.journal_entry_id IS NULL THEN 'needs_review'
          WHEN b.has_unlinked_cash_leg = true THEN 'needs_review'
          ELSE 'matched'
        END AS match_status
      FROM base b
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
  async createExchange(
    dto: CreateExchangeDto,
    userId: string,
    userPermissions: string[] = [],
  ) {
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

    // PR-R1 — explicit cash source for the cash leg of the exchange.
    // A cash difference (in either direction) MUST come with shift_id
    // OR cashbox_id. Equal exchanges and non-cash differences ignore
    // both. The OUT direction (refund to customer) additionally
    // requires returns.refund.direct_cashbox for the direct branch.
    const cashOut = price_difference < 0 && dto.refund_method === 'cash';
    const cashIn  = price_difference > 0 && dto.payment_method === 'cash';
    const needsCashSource = cashOut || cashIn;
    let resolvedShiftId: string | null = null;
    let resolvedCashboxId: string | null = null;

    if (needsCashSource) {
      if (!dto.shift_id && !dto.cashbox_id) {
        throw new BadRequestException(
          'يجب اختيار وردية مفتوحة أو خزنة مباشرة لتسجيل الفرق النقدي',
        );
      }
      if (dto.shift_id) {
        const [shiftRow] = await this.ds.query(
          `SELECT id, cashbox_id, status::text AS status
             FROM shifts WHERE id = $1`,
          [dto.shift_id],
        );
        if (!shiftRow) {
          throw new NotFoundException('الوردية المختارة غير موجودة');
        }
        if (shiftRow.status !== 'open' && shiftRow.status !== 'pending_close') {
          throw new BadRequestException(
            'الوردية المختارة ليست مفتوحة — اختر وردية مفتوحة أو خزنة مباشرة',
          );
        }
        if (dto.cashbox_id && dto.cashbox_id !== shiftRow.cashbox_id) {
          throw new BadRequestException(
            'الخزنة المختارة لا تطابق خزنة الوردية',
          );
        }
        resolvedShiftId = shiftRow.id;
        resolvedCashboxId = shiftRow.cashbox_id;
      } else {
        if (cashOut) {
          const hasPerm =
            userPermissions.includes('*') ||
            userPermissions.includes('returns.*') ||
            userPermissions.includes('returns.refund.direct_cashbox');
          if (!hasPerm) {
            throw new BadRequestException(
              'صرف الفرق من خزنة مباشرة يتطلب صلاحية returns.refund.direct_cashbox',
            );
          }
        }
        const [cb] = await this.ds.query(
          `SELECT id FROM cashboxes WHERE id = $1 AND is_active = TRUE`,
          [dto.cashbox_id],
        );
        if (!cb) {
          throw new NotFoundException('الخزنة المختارة غير موجودة أو غير نشطة');
        }
        resolvedShiftId = null;
        resolvedCashboxId = cb.id;
      }
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
           handled_by, notes,
           shift_id, cashbox_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'completed',$8,$9,$10,$11,$12,$13)
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
          resolvedShiftId,
          resolvedCashboxId,
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

      // 6) PR-R1 — physical drawer movement for the cash leg of the
      //    exchange. Goes through engine.recordCashOnlyMovement so the
      //    cashbox + GL stay in sync (no manual cashbox.current_balance
      //    edit, no direct journal_lines write). Equal exchanges and
      //    non-cash differences write nothing here.
      if ((cashOut || cashIn) && resolvedCashboxId) {
        if (!this.engine) {
          throw new BadRequestException(
            'FinancialEngineService غير متاح — لا يمكن تسجيل فرق الاستبدال نقدياً',
          );
        }
        const direction: 'in' | 'out' = cashOut ? 'out' : 'in';
        const amount = Math.abs(price_difference);
        const res = await this.engine.recordCashOnlyMovement({
          cashbox_id: resolvedCashboxId,
          direction,
          amount,
          category: 'refund', // shared bucket with returns; reference_type tells them apart
          reference_type: 'exchange',
          reference_id: exc.id,
          user_id: userId,
          notes: resolvedShiftId
            ? `${direction === 'out' ? 'صرف' : 'تحصيل'} فرق استبدال — ${exc.exchange_no} (مرتبط بوردية)`
            : `${direction === 'out' ? 'صرف' : 'تحصيل'} فرق استبدال — ${exc.exchange_no} (خزنة مباشرة)`,
          em,
        });
        if (!res.ok) {
          throw new BadRequestException(
            `فشل تسجيل فرق الاستبدال نقدياً: ${res.error}`,
          );
        }
      }

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

  // PR-FIN-RETURNS-UX-1B widened the underlying enum to include
  // 'cancelled'. The signature here is widened to accept that bucket
  // so PR 1C's cancel endpoint can write `mustBeStatus(id, ['approved',
  // 'refunded'])` and reject an already-cancelled row. Existing
  // callers (approve / refund / reject) keep their original allowed
  // lists — no behavior change in this PR.
  private async mustBeStatus(
    id: string,
    allowed: Array<'pending' | 'approved' | 'refunded' | 'rejected' | 'cancelled'>,
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
