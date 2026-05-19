/**
 * ReturnEditRequestsService — request + review + apply workflow for
 * returns and exchanges.
 *
 * Phase 1 (PR-FIN-RETURNS-EXCHANGES-EDIT-REQUESTS):
 *   · CREATE a pending edit request capturing before_snapshot + the
 *     requested payload.  Approve/reject change ONLY the request
 *     row's status + reviewer fields.  No parent / item / financial /
 *     stock writes.
 *
 * Phase 2A (PR-FIN-RETURNS-EXCHANGES-EDIT-REQUESTS-APPLY):
 *   · APPLY an approved request to a RETURN: mutate return_items +
 *     return totals atomically, plus (when the return is already
 *     refunded) reverse-and-replay the JE/CT via the canonical
 *     posting service primitives and reverse-and-replay the
 *     back_to_stock stock movements.  Single transaction.  Idempotent
 *     via `applied_at IS NULL` SELECT-FOR-UPDATE check (migration 126).
 *   · APPLY for exchanges is intentionally out-of-scope — the
 *     controller endpoint returns 501 Not Implemented for Phase 2A.
 *
 * Hard guarantees (code-level, not hopes):
 *   · No raw INSERT / UPDATE / DELETE on `journal_entries`,
 *     `journal_lines`, or `cashbox_transactions`.  Every JE/CT touch
 *     goes through `AccountingPostingService.reverseByReference` or
 *     `AccountingPostingService.postReturn`, which themselves go
 *     through `FinancialEngineService.recordTransaction`.
 *   · No `UPDATE stock_movements` — only INSERTs of new SM rows
 *     (mirror of the cancel pattern).  The reversal of the OLD effect
 *     is a NEW SM row tagged adjustment_out, not an UPDATE on the
 *     historical SM.
 *   · No `accounting_only`.  No `engine_context = 'on'` (the engine
 *     sets that itself).
 *   · No engine-error swallowing.  If `reverseByReference` returns
 *     `{ error: ... }` or `postReturn` returns `{ ok: false }`, we
 *     throw `BadRequestException` with the engine's message — same
 *     behaviour as the cancel path.
 *   · State machine: pending → approved → applied (status remains
 *     'approved' but `applied_at` becomes NOT NULL); pending →
 *     rejected; pending → cancelled.  Apply is allowed iff
 *     `status='approved' AND applied_at IS NULL`.
 *   · Activity log: one row per create / approve / reject / apply via
 *     `AuditService.writeActivity` (`extra.kind` discriminator).
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  NotImplementedException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

export type EditRequestEntity = 'return' | 'exchange';

export type RequestedAction =
  | 'update_header'
  | 'update_item'
  | 'remove_item'
  | 'replace_item'
  | 'price_change'
  | 'quantity_change'
  | 'reason_change';

const ALLOWED_ACTIONS: RequestedAction[] = [
  'update_header',
  'update_item',
  'remove_item',
  'replace_item',
  'price_change',
  'quantity_change',
  'reason_change',
];

// PR-FIX-EDIT-REQUEST-APPLY-VARIANT-UUID — defense-in-depth guard.
// Every variant_id reaching SQL must be a UUID-shaped string before
// it touches a uuid column on `return_items.variant_id` or the
// `product_variants` FK lookup.  The FE already enforces this via
// the productLookup component, but a tampered direct API call (or a
// future regression) could otherwise crash with the raw Postgres
// "invalid input syntax for type uuid: <bad>" error.  We instead
// throw a clean Arabic `BadRequestException` BEFORE any SQL fires.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VARIANT_ID_INVALID_MSG =
  'معرّف المنتج غير صالح — يجب اختيار منتج من نتائج البحث';

export type RequestStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled';

export interface CreateEditRequestInput {
  entity: EditRequestEntity;
  parent_id: string;
  requested_action: string;
  requested_payload: Record<string, unknown>;
  reason_text: string;
  user_id: string;
  idempotency_key?: string | null;
}

export interface ReviewInput {
  entity: EditRequestEntity;
  request_id: string;
  user_id: string;
  review_notes?: string | null;
}

export interface EditRequestRow {
  id: string;
  parent_id: string;
  document_no: string | null;
  requested_action: RequestedAction;
  requested_payload: Record<string, unknown>;
  before_snapshot: Record<string, unknown>;
  after_preview: Record<string, unknown> | null;
  reason_text: string;
  status: RequestStatus;
  requested_by: string;
  requested_by_name?: string | null;
  requested_at: string;
  reviewed_by: string | null;
  reviewed_by_name?: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApplyInput {
  entity: EditRequestEntity;
  parent_id: string;
  request_id: string;
  user_id: string;
  cashbox_id?: string | null;
  shift_id?: string | null;
  notes?: string | null;
}

export interface ApplyResult extends EditRequestRow {
  applied_at: string | null;
  applied_by: string | null;
  apply_journal_entry_ids: string[];
  apply_cashbox_transaction_ids: string[];
  apply_stock_movement_ids: string[];
  apply_summary: Record<string, unknown> | null;
}

@Injectable()
export class ReturnEditRequestsService {
  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly posting?: AccountingPostingService,
    // PR-FIX-RETURNS-EXCHANGES-EDIT-REQUEST-APPLY-PHASE-2B — exchange
    // apply uses `engine.recordCashOnlyMovement` directly for the
    // cash leg of the price difference (creation also uses this
    // primitive at returns.service.ts:1504).  No JE is posted at
    // exchange time, so `posting.reverseByReference` cannot reverse
    // the cash-only CT — we route reverse + replay through the same
    // engine primitive with `category='reversal_refund'` for
    // reversals, mirroring the convention `posting.reverseByReference`
    // uses for paired CTs of reversed JEs.
    @Optional()
    private readonly engine?: FinancialEngineService,
  ) {}

  // ─── public API ───────────────────────────────────────────────

  async list(
    entity: EditRequestEntity,
    parentId: string,
  ): Promise<EditRequestRow[]> {
    const { table, fk } = this.tableFor(entity);
    const rows: any[] = await this.ds.query(
      `
      SELECT er.*,
             u_req.full_name AS requested_by_name,
             u_rev.full_name AS reviewed_by_name
        FROM ${table} er
        LEFT JOIN users u_req ON u_req.id = er.requested_by
        LEFT JOIN users u_rev ON u_rev.id = er.reviewed_by
       WHERE er.${fk} = $1
       ORDER BY er.requested_at DESC
      `,
      [parentId],
    );
    return rows.map((r) => this.toRow(r, fk));
  }

  async create(input: CreateEditRequestInput): Promise<EditRequestRow> {
    this.validateRequestedAction(input.requested_action);
    this.validateReason(input.reason_text);
    this.validatePayload(input.requested_payload);

    const { table, fk, docCol } = this.tableFor(input.entity);

    return this.ds.transaction(async (em) => {
      // 1. Build before_snapshot from the live document + its items.
      //    Uses dynamic table names from the entity discriminator —
      //    safe because the discriminator is allowlisted to one of
      //    two literals at the entry of every public method.
      const before = await this.buildBeforeSnapshot(em, input.entity, input.parent_id);
      if (!before) {
        throw new NotFoundException(
          input.entity === 'return'
            ? 'المرتجع غير موجود'
            : 'الاستبدال غير موجود',
        );
      }

      // 2. Insert the pending request row.  No mutation of the parent
      //    document or its items.
      const [created] = await em.query(
        `
        INSERT INTO ${table}
          (${fk}, ${docCol}, requested_action, requested_payload,
           before_snapshot, reason_text, status,
           requested_by, idempotency_key)
        VALUES
          ($1, $2, $3, $4::jsonb, $5::jsonb, $6, 'pending', $7, $8)
        RETURNING *
        `,
        [
          input.parent_id,
          before.document_no,
          input.requested_action,
          JSON.stringify(input.requested_payload),
          JSON.stringify(before.snapshot),
          input.reason_text,
          input.user_id,
          input.idempotency_key ?? null,
        ],
      );

      // 3. Activity log (best-effort).
      if (this.audit) {
        try {
          await this.audit.writeActivity({
            user_id: input.user_id,
            action: 'create',
            entity: input.entity,
            entity_id: input.parent_id,
            summary: `طلب تعديل ${input.entity === 'return' ? 'مرتجع' : 'استبدال'} ${before.document_no ?? ''}: ${input.reason_text}`.trim(),
            extra: {
              kind: 'edit_request_create',
              edit_request_id: created.id,
              requested_action: input.requested_action,
              status_after: 'pending',
              document_no: before.document_no,
              reason: input.reason_text,
            },
          });
        } catch {
          /* swallowed — audit is best-effort */
        }
      }

      return this.toRow(created, fk);
    });
  }

  async approve(input: ReviewInput): Promise<EditRequestRow> {
    return this.review(input, 'approved', 'approve', 'edit_request_approve');
  }

  async reject(input: ReviewInput): Promise<EditRequestRow> {
    if (!input.review_notes || input.review_notes.trim().length < 5) {
      throw new BadRequestException(
        'ملاحظات الرفض مطلوبة (٥ أحرف على الأقل)',
      );
    }
    return this.review(input, 'rejected', 'reject', 'edit_request_reject');
  }

  // ─── apply (Phase 2A) ─────────────────────────────────────────
  //
  // Reverse-and-replay strategy mirroring `returns.service.ts::cancel`:
  //   1. Lock edit_request + parent return; validate.
  //   2. If return.status='refunded': reverse JE+CT via posting,
  //      reverse back_to_stock SMs inline (new adjustment_out rows).
  //   3. Mutate return_items per payload (update / remove / insert).
  //   4. Recompute return totals.
  //   5. If we reversed in step 2: re-call `posting.postReturn` so a
  //      fresh balanced JE+CT is posted against the new totals.
  //      Engine idempotency now passes because the original entry was
  //      voided in step 2.
  //   6. Stamp the request as applied + capture artifact ids.
  //   7. Activity log.
  //
  // Anything that fails throws → outer transaction rolls back ALL
  // writes.  The engine's lockdown / balance / Guard-A checks fail
  // fast inside `recordTransaction`.

  async applyApprovedReturn(input: ApplyInput): Promise<ApplyResult> {
    if (input.entity !== 'return') {
      // PR-FIX-RETURNS-EXCHANGES-EDIT-REQUEST-APPLY-PHASE-2B — this
      // method handles RETURNs only; the exchange variant is
      // implemented separately in `applyApprovedExchange()`.  The
      // controller routes to the correct method by URL, so reaching
      // this guard is a developer error rather than an end-user
      // request.  Throwing 400 keeps the message honest (the feature
      // exists; you just called the wrong method).
      throw new BadRequestException(
        'هذه الدالة مخصصة للمرتجعات — استخدم applyApprovedExchange للاستبدال',
      );
    }
    if (!this.posting) {
      throw new BadRequestException(
        'AccountingPostingService غير متاح — لا يمكن تطبيق طلب التعديل',
      );
    }

    return this.ds.transaction(async (em) => {
      // ── 1. Lock the edit request row and validate state. ─────────
      const [er] = await em.query(
        `SELECT *
           FROM return_edit_requests
          WHERE id = $1 AND return_id = $2
          FOR UPDATE`,
        [input.request_id, input.parent_id],
      );
      if (!er) {
        throw new NotFoundException('طلب التعديل غير موجود');
      }
      if (er.status !== 'approved') {
        throw new ConflictException(
          `لا يمكن تطبيق الطلب لأن حالته "${er.status}" — التطبيق يتطلب حالة approved`,
        );
      }
      if (er.applied_at) {
        throw new ConflictException(
          'تم تطبيق هذا الطلب بالفعل — لا يمكن تطبيقه مرة أخرى',
        );
      }

      const payload = (er.requested_payload ?? {}) as Record<string, any>;
      if (payload?.kind !== 'line_changes') {
        throw new BadRequestException(
          'نوع طلب التعديل غير مدعوم للتطبيق — يجب أن يكون kind="line_changes"',
        );
      }

      // ── 2. Lock the parent return row and validate. ─────────────
      const [ret] = await em.query(
        `SELECT id, return_no, status, refund_method,
                total_refund, restocking_fee, net_refund,
                cashbox_id, warehouse_id
           FROM returns
          WHERE id = $1
          FOR UPDATE`,
        [input.parent_id],
      );
      if (!ret) {
        throw new NotFoundException('المرتجع غير موجود');
      }
      if (ret.status === 'cancelled' || ret.status === 'rejected') {
        throw new ConflictException(
          `لا يمكن تطبيق التعديل لأن حالة المرتجع "${ret.status}"`,
        );
      }
      const wasRefunded = ret.status === 'refunded';

      // ── 3. Capture before-state. ───────────────────────────────
      const beforeItems: any[] = await em.query(
        `SELECT * FROM return_items WHERE return_id = $1 ORDER BY id`,
        [input.parent_id],
      );
      const beforeItemIds = new Set(beforeItems.map((it) => String(it.id)));
      const oldTotalRefund = Number(ret.total_refund || 0);
      const oldNetRefund = Number(ret.net_refund || 0);
      const restockingFee = Number(ret.restocking_fee || 0);

      // ── 4. Validate payload — added rows MUST have a real
      //       variant_id; quantities / prices in legal range.
      const updatedLines: any[] = Array.isArray(payload?.lines?.updated)
        ? payload.lines.updated
        : [];
      const removedLines: any[] = Array.isArray(payload?.lines?.removed)
        ? payload.lines.removed
        : [];
      const addedLines: any[] = Array.isArray(payload?.lines?.added)
        ? payload.lines.added
        : [];

      for (const a of addedLines) {
        const vid = String(a?.variant_id ?? '').trim();
        if (vid.length === 0) {
          throw new BadRequestException(
            'لا يمكن إضافة بند بدون variant_id حقيقي',
          );
        }
        // PR-FIX-EDIT-REQUEST-APPLY-VARIANT-UUID — UUID-shape gate
        // BEFORE the product_variants SELECT (and BEFORE any other
        // SQL).  A non-UUID value (typed SKU, code, anything else)
        // gets a clean Arabic error instead of crashing inside pg.
        if (!UUID_RE.test(vid)) {
          throw new BadRequestException(VARIANT_ID_INVALID_MSG);
        }
        // PR-FIX-EDIT-REQUEST-APPLY-NUMERIC-CAST — finite-number guard
        // (NaN / Infinity slip past `> 0` and `>= 0`).
        const qty = Number(a?.quantity ?? 0);
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new BadRequestException(
            'الكمية يجب أن تكون أكبر من صفر للبنود المضافة',
          );
        }
        const price = Number(a?.unit_price ?? 0);
        if (!Number.isFinite(price) || price < 0) {
          throw new BadRequestException(
            'سعر البند المضاف لا يمكن أن يكون سالباً',
          );
        }
        // Confirm the variant actually exists — defense in depth so
        // a stale FE payload can't slip through to an FK violation.
        const [v] = await em.query(
          `SELECT id FROM product_variants WHERE id = $1`,
          [vid],
        );
        if (!v) {
          throw new BadRequestException(
            `variant_id غير موجود في قاعدة البيانات: ${vid}`,
          );
        }
      }
      for (const u of updatedLines) {
        const itemId = String(u?.item_id ?? '');
        if (!beforeItemIds.has(itemId)) {
          throw new BadRequestException(
            `بند غير موجود في المرتجع: ${itemId}`,
          );
        }
        // PR-FIX-EDIT-REQUEST-APPLY-VARIANT-UUID — when an updated
        // line carries an `after.variant_id`, validate it as a UUID
        // BEFORE the mutation step writes it to a uuid column.  An
        // empty / missing after.variant_id means "keep the current
        // variant" (handled later in the mutation block).
        const afterVid = u?.after?.variant_id;
        if (
          afterVid !== undefined &&
          afterVid !== null &&
          String(afterVid).trim().length > 0 &&
          !UUID_RE.test(String(afterVid).trim())
        ) {
          throw new BadRequestException(VARIANT_ID_INVALID_MSG);
        }
        // PR-FIX-EDIT-REQUEST-APPLY-NUMERIC-CAST — `> 0` / `>= 0` alone
        // accept Infinity, so we explicitly require a finite number
        // before either the SQL multiplication or the BE arithmetic
        // touches the value.  NaN / Infinity / -Infinity all fail
        // Number.isFinite and throw with a clean Arabic message.
        const newQty = Number(u?.after?.quantity ?? 0);
        if (!Number.isFinite(newQty) || newQty <= 0) {
          throw new BadRequestException(
            'الكمية يجب أن تكون أكبر من صفر للبنود المعدلة',
          );
        }
        const newPrice = Number(u?.after?.unit_price ?? 0);
        if (!Number.isFinite(newPrice) || newPrice < 0) {
          throw new BadRequestException(
            'السعر لا يمكن أن يكون سالباً',
          );
        }
      }

      const reversalJeIds: string[] = [];
      const newJeIds: string[] = [];
      const ctIds: string[] = [];
      const reversedSmIds: string[] = [];
      const newSmIds: string[] = [];

      // ── 5. If refunded, reverse the existing financial + stock
      //       effects via canonical primitives.
      if (wasRefunded) {
        // 5a. Reverse JE + paired CTs.  reverseByReference is the
        //     ONLY path that touches journal_entries / journal_lines /
        //     cashbox_transactions for this kind of correction.
        const reverseRes: any = await this.posting!.reverseByReference(
          'return',
          input.parent_id,
          `تطبيق طلب تعديل ${ret.return_no}: ${(input.notes ?? er.reason_text ?? '').toString().trim()}`,
          input.user_id,
          em,
        );
        if (reverseRes && typeof reverseRes === 'object') {
          if (reverseRes.error) {
            // Engine error — never swallow.  Throwing aborts the
            // outer transaction, rolling back any prior writes.
            throw new BadRequestException(
              `فشل عكس قيد المرتجع: ${reverseRes.error}`,
            );
          }
          if (reverseRes.entry_id) {
            reversalJeIds.push(String(reverseRes.entry_id));
          }
        }

        // 5b. Capture the paired reversal CTs (cash refunds only —
        //     the engine uses reference_type='other' on reversals).
        if (reversalJeIds.length > 0 && ret.refund_method === 'cash') {
          const ctRows: any[] = await em.query(
            `SELECT id::text AS id
               FROM cashbox_transactions
              WHERE reference_type::text = 'other'
                AND reference_id::text = $1
                AND is_void = FALSE
                AND category LIKE 'reversal_%'`,
            [reversalJeIds[0]],
          );
          for (const r of ctRows) {
            if (r?.id) ctIds.push(String(r.id));
          }
        }

        // 5c. Reverse stock for back_to_stock items in the BEFORE
        //     state.  INSERT stock_movements only; the AFTER INSERT
        //     trigger `trg_apply_stock_movement` updates `stock`
        //     automatically (PR-FIX-INVENTORY-DOUBLE-WRITE).
        //     reference_type='return', reference_id=<return_id>,
        //     notes prefix 'edit_request_apply_stock_reversal:'.
        for (const it of beforeItems) {
          if (!it.back_to_stock) continue;
          const qty = Number(it.quantity);
          if (!(qty > 0)) continue;
          const [costRow] = await em.query(
            `SELECT COALESCE(
                ii.unit_cost,
                (SELECT cost_price FROM product_variants WHERE id = $1),
                0
              )::numeric(14,2) AS cost
              FROM return_items ri
              LEFT JOIN invoice_items ii ON ii.id = ri.original_invoice_item_id
              WHERE ri.id = $2`,
            [it.variant_id, it.id],
          );
          const unitCost = Number(costRow?.cost ?? 0);

          // PR-FIX-INVENTORY-DOUBLE-WRITE — the AFTER INSERT trigger
          // `trg_apply_stock_movement` (migration 011) applies the
          // `direction='out'` delta to `stock.quantity_on_hand`
          // automatically. The previous explicit `UPDATE stock`
          // immediately before this INSERT was double-debiting every
          // return-edit reversal. The INSERT is now the single
          // mutation source.
          const [smRow] = await em.query(
            `INSERT INTO stock_movements
                (variant_id, warehouse_id, movement_type, direction,
                 quantity, unit_cost, reference_type, reference_id,
                 notes, user_id)
             VALUES ($1, $2,
                     'adjustment_out'::stock_movement_type,
                     'out'::txn_direction,
                     $3, $4,
                     'return'::entity_type, $5, $6, $7)
             RETURNING id`,
            [
              it.variant_id,
              ret.warehouse_id,
              qty,
              unitCost,
              input.parent_id,
              `edit_request_apply_stock_reversal:${ret.return_no}`,
              input.user_id,
            ],
          );
          reversedSmIds.push(String(smRow.id));
        }
      }

      // ── 6. Mutate return_items per payload. ─────────────────────
      let updatedCount = 0;
      let removedCount = 0;
      let addedCount = 0;

      // 6a. UPDATE existing lines.
      for (const u of updatedLines) {
        const itemId = String(u.item_id);
        const after = u.after ?? {};
        const newQty = Number(after.quantity || 0);
        const newPrice = Number(after.unit_price || 0);
        const newNotes = after.notes == null ? null : String(after.notes);
        // Only swap variant_id if the payload supplied a non-empty
        // one.  Otherwise keep whatever the row currently has.
        const newVariantId =
          after.variant_id && String(after.variant_id).trim().length > 0
            ? String(after.variant_id)
            : null;
        // PR-FIX-EDIT-REQUEST-APPLY-NUMERIC-CAST — all parameters fed
        // into a Postgres `*` expression are explicitly cast to
        // ::numeric.  Without these casts pg sends JS numbers as
        // `unknown` and Postgres can't pick between int*int / numeric*
        // numeric / etc., raising "operator is not unique: unknown *
        // unknown" (observed on the live RET-2026-000006 apply).
        if (newVariantId) {
          await em.query(
            `UPDATE return_items
                SET variant_id    = $2,
                    quantity      = $3::int,
                    unit_price    = $4::numeric,
                    refund_amount = ($3::numeric * $4::numeric)::numeric(14,2),
                    notes         = $5
              WHERE id = $1 AND return_id = $6`,
            [itemId, newVariantId, newQty, newPrice, newNotes, input.parent_id],
          );
        } else {
          await em.query(
            `UPDATE return_items
                SET quantity      = $2::int,
                    unit_price    = $3::numeric,
                    refund_amount = ($2::numeric * $3::numeric)::numeric(14,2),
                    notes         = $4
              WHERE id = $1 AND return_id = $5`,
            [itemId, newQty, newPrice, newNotes, input.parent_id],
          );
        }
        updatedCount++;
      }

      // 6b. DELETE removed lines.  (audit_logs DB trigger from
      //     migration 124 captures the row diff automatically; the
      //     before_snapshot on the edit_request also preserves the
      //     original row.)
      for (const r of removedLines) {
        const itemId = String(r.item_id);
        if (!beforeItemIds.has(itemId)) continue;
        await em.query(
          `DELETE FROM return_items WHERE id = $1 AND return_id = $2`,
          [itemId, input.parent_id],
        );
        removedCount++;
      }

      // 6c. INSERT added lines.  Defaults: condition='resellable',
      //     back_to_stock=TRUE (column defaults).  No
      //     original_invoice_item_id since added lines are not part
      //     of the original invoice — column allows NULL.
      for (const a of addedLines) {
        const variantId = String(a.variant_id);
        const qty = Number(a.quantity || 0);
        const price = Number(a.unit_price || 0);
        const notes = a.notes == null ? null : String(a.notes);
        // Same `::numeric` casts as the UPDATE branches above —
        // see PR-FIX-EDIT-REQUEST-APPLY-NUMERIC-CAST.
        await em.query(
          `INSERT INTO return_items
              (return_id, variant_id, quantity, unit_price, refund_amount, notes)
           VALUES
              ($1, $2, $3::int, $4::numeric,
               ($3::numeric * $4::numeric)::numeric(14,2), $5)`,
          [input.parent_id, variantId, qty, price, notes],
        );
        addedCount++;
      }

      // ── 7. Recompute return totals from the (now-mutated) items. ─
      const [tot] = await em.query(
        `SELECT COALESCE(SUM(refund_amount), 0)::numeric(14,2) AS total_refund
           FROM return_items
          WHERE return_id = $1`,
        [input.parent_id],
      );
      const newTotalRefund = Number(tot?.total_refund ?? 0);
      const newNetRefund = Math.max(0, newTotalRefund - restockingFee);
      await em.query(
        `UPDATE returns
            SET total_refund = $2,
                net_refund   = $3,
                updated_at   = NOW()
          WHERE id = $1`,
        [input.parent_id, newTotalRefund, newNetRefund],
      );

      // ── 8. If we reversed earlier, re-post a fresh balanced JE+CT
      //       against the new totals.  postReturn re-reads the live
      //       returns row (including refund_method + cashbox_id), so
      //       the new entry uses the same dimensions.
      if (wasRefunded) {
        const postRes: any = await this.posting!.postReturn(
          input.parent_id,
          input.user_id,
          em,
        );
        // postReturn returns null only when the return is missing or
        // not in approved/refunded state — neither possible here
        // because the row is locked and we already validated.  An
        // engine failure surfaces as { ok: false, error }.
        if (postRes && typeof postRes === 'object') {
          if (postRes.ok === false || postRes.error) {
            throw new BadRequestException(
              `فشل قيد المرتجع بعد التطبيق: ${postRes.error ?? 'unknown'}`,
            );
          }
          if (postRes.entry_id) {
            newJeIds.push(String(postRes.entry_id));
          }
        }

        // Capture the new paired CT for cash refunds.
        if (newJeIds.length > 0 && ret.refund_method === 'cash') {
          const ctRows: any[] = await em.query(
            `SELECT id::text AS id
               FROM cashbox_transactions
              WHERE reference_type::text = 'return'
                AND reference_id::text = $1
                AND is_void = FALSE
              ORDER BY id DESC
              LIMIT 1`,
            [input.parent_id],
          );
          for (const r of ctRows) {
            if (r?.id) ctIds.push(String(r.id));
          }
        }

        // Re-record stock movements for the NEW back_to_stock items.
        // Using the live (post-mutation) return_items.
        const afterItems: any[] = await em.query(
          `SELECT ri.id, ri.variant_id, ri.quantity, ri.back_to_stock,
                  COALESCE(
                    ii.unit_cost,
                    (SELECT cost_price FROM product_variants WHERE id = ri.variant_id),
                    0
                  )::numeric(14,2) AS unit_cost
             FROM return_items ri
             LEFT JOIN invoice_items ii ON ii.id = ri.original_invoice_item_id
            WHERE ri.return_id = $1
              AND ri.back_to_stock = TRUE`,
          [input.parent_id],
        );
        for (const it of afterItems) {
          const qty = Number(it.quantity);
          if (!(qty > 0)) continue;
          // PR-FIX-INVENTORY-DOUBLE-WRITE — the AFTER INSERT trigger
          // `trg_apply_stock_movement` will UPSERT `stock` with the
          // `direction='in'` delta automatically (its own ON CONFLICT
          // path mirrors what this manual UPSERT did). The previous
          // explicit UPSERT immediately before this INSERT was
          // double-crediting every return-edit replay. The INSERT is
          // now the single mutation source.
          const [smRow] = await em.query(
            `INSERT INTO stock_movements
                (variant_id, warehouse_id, movement_type, direction,
                 quantity, unit_cost, reference_type, reference_id,
                 notes, user_id)
             VALUES ($1, $2,
                     'adjustment_in'::stock_movement_type,
                     'in'::txn_direction,
                     $3, $4,
                     'return'::entity_type, $5, $6, $7)
             RETURNING id`,
            [
              it.variant_id,
              ret.warehouse_id,
              qty,
              Number(it.unit_cost),
              input.parent_id,
              `edit_request_apply_stock:${ret.return_no}`,
              input.user_id,
            ],
          );
          newSmIds.push(String(smRow.id));
        }
      }

      // ── 9. Stamp the request as applied + capture artifact ids. ─
      const allJeIds = [...reversalJeIds, ...newJeIds];
      const allSmIds = [...reversedSmIds, ...newSmIds];
      const summary = {
        status_at_apply: ret.status,
        was_refunded: wasRefunded,
        old_total_refund: oldTotalRefund,
        new_total_refund: newTotalRefund,
        old_net_refund: oldNetRefund,
        new_net_refund: newNetRefund,
        delta_total_refund: Number(
          (newTotalRefund - oldTotalRefund).toFixed(2),
        ),
        delta_net_refund: Number((newNetRefund - oldNetRefund).toFixed(2)),
        lines_updated: updatedCount,
        lines_removed: removedCount,
        lines_added: addedCount,
        notes: input.notes ?? null,
      };

      // The WHERE applied_at IS NULL clause is the second layer of
      // double-apply protection (FOR UPDATE was the first).  If
      // someone races us, RETURNING comes back empty → throw.
      //
      // PR-FIX-EDIT-REQUEST-APPLY-SM-IDS-COLUMN-TYPE — migration 127
      // changed `apply_stock_movement_ids` from uuid[] to bigint[]
      // (stock_movements.id is bigint).  The cast on $5 must match.
      // Same shape as `apply_cashbox_transaction_ids bigint[]` since
      // mig 126.  The id values were already captured as strings via
      // `String(smRow.id)`; pg accepts numeric-string array elements
      // for ::bigint[] coercion.
      const [stamped] = await em.query(
        `UPDATE return_edit_requests
            SET applied_at                    = NOW(),
                applied_by                    = $2,
                apply_journal_entry_ids       = $3::uuid[],
                apply_cashbox_transaction_ids = $4::bigint[],
                apply_stock_movement_ids      = $5::bigint[],
                apply_summary                 = $6::jsonb,
                updated_at                    = NOW()
          WHERE id = $1
            AND applied_at IS NULL
            AND status = 'approved'
          RETURNING *`,
        [
          input.request_id,
          input.user_id,
          allJeIds,
          ctIds.map((s) => Number(s)),
          allSmIds,
          JSON.stringify(summary),
        ],
      );
      if (!stamped) {
        throw new ConflictException(
          'تعذّر ختم طلب التعديل كمُطبَّق — قد يكون تم تطبيقه بالتزامن',
        );
      }

      // ── 10. Activity log (best-effort, non-throwing).  We use the
      //       existing 'update' action because `ActivityEntry.action`
      //       is a strict closed enum (and a matching DB CHECK
      //       constraint).  The semantic discriminator that the audit
      //       panel reads is `extra.kind='edit_request_apply'` — same
      //       convention as `edit_request_create / approve / reject`.
      if (this.audit) {
        try {
          await this.audit.writeActivity({
            user_id: input.user_id,
            action: 'update',
            entity: 'return',
            entity_id: input.parent_id,
            summary: `تم تطبيق طلب تعديل مرتجع ${ret.return_no}`,
            extra: {
              kind: 'edit_request_apply',
              edit_request_id: input.request_id,
              ...summary,
              journal_entry_ids: allJeIds,
              cashbox_transaction_ids: ctIds,
              stock_movement_ids: allSmIds,
            },
          });
        } catch {
          /* swallowed — audit is best-effort */
        }
      }

      return this.toApplyResult(stamped, 'return_id');
    });
  }

  /**
   * Phase 2B — apply an approved exchange edit request.
   *
   * Reverse-and-replay strategy mirroring `applyApprovedReturn`, with
   * three structural differences specific to exchanges:
   *
   *   1. Exchanges post NO journal_entries at creation time (only a
   *      cash-only CT for the price-difference cash leg, via
   *      `engine.recordCashOnlyMovement`).  So `apply_journal_entry_ids`
   *      is always [].  We do NOT call `posting.reverseByReference` —
   *      it short-circuits when no JE exists for the reference and
   *      would not touch the cash CT anyway.
   *   2. Stock effects flow through `fn_adjust_stock` at creation
   *      (with `notes='exchange:<exc_no>'`); we follow the same
   *      INSERT-only `stock_movements` pattern as `applyApprovedReturn`
   *      for reverse + replay.
   *   3. Phase 2B SCOPE: returned-side items only.  Modifications to
   *      `kind='new'` lines are rejected with a Phase-2C marker —
   *      editing those would require cascading into the linked sales
   *      invoice's `invoice_items` + `invoice_payments` + the
   *      invoice's stock + GL flow, which is a separate PR.
   *
   * Hard guarantees:
   *   · No raw INSERT/UPDATE/DELETE on journal_entries / journal_lines /
   *     cashbox_transactions.
   *   · No UPDATE/DELETE on stock_movements; new SM rows only.
   *   · Cash-leg reversal goes through `engine.recordCashOnlyMovement`
   *     with `category='reversal_refund'` and `reference_type='other'`,
   *     `reference_id=<orig_CT_id>` — the established convention used
   *     by `posting.reverseByReference` for paired-CT reversals.
   *   · Idempotency: SELECT FOR UPDATE on the request + parent +
   *     `WHERE applied_at IS NULL` clause on the stamping UPDATE.
   *     The route is also wrapped by `IdempotencyInterceptor`.
   *   · No `accounting_only`, no engine-error swallowing.
   */
  async applyApprovedExchange(input: ApplyInput): Promise<ApplyResult> {
    if (input.entity !== 'exchange') {
      throw new BadRequestException(
        'هذه الدالة مخصصة للاستبدال — استخدم applyApprovedReturn للمرتجع',
      );
    }
    if (!this.engine) {
      // The cash-leg reverse + replay needs the engine.  Without it
      // we'd have to write CTs directly — explicitly forbidden.
      throw new BadRequestException(
        'FinancialEngineService غير متاح — لا يمكن تطبيق طلب التعديل',
      );
    }

    return this.ds.transaction(async (em) => {
      // ── 1. Lock the edit request row and validate state. ─────────
      const [er] = await em.query(
        `SELECT *
           FROM exchange_edit_requests
          WHERE id = $1 AND exchange_id = $2
          FOR UPDATE`,
        [input.request_id, input.parent_id],
      );
      if (!er) {
        throw new NotFoundException('طلب التعديل غير موجود');
      }
      if (er.status !== 'approved') {
        throw new ConflictException(
          `لا يمكن تطبيق الطلب لأن حالته "${er.status}" — التطبيق يتطلب حالة approved`,
        );
      }
      if (er.applied_at) {
        throw new ConflictException(
          'تم تطبيق هذا الطلب بالفعل — لا يمكن تطبيقه مرة أخرى',
        );
      }

      const payload = (er.requested_payload ?? {}) as Record<string, any>;
      if (payload?.kind !== 'line_changes') {
        throw new BadRequestException(
          'نوع طلب التعديل غير مدعوم للتطبيق — يجب أن يكون kind="line_changes"',
        );
      }

      const updatedLines: any[] = Array.isArray(payload?.lines?.updated)
        ? payload.lines.updated
        : [];
      const removedLines: any[] = Array.isArray(payload?.lines?.removed)
        ? payload.lines.removed
        : [];
      const addedLines: any[] = Array.isArray(payload?.lines?.added)
        ? payload.lines.added
        : [];

      if (
        updatedLines.length === 0 &&
        removedLines.length === 0 &&
        addedLines.length === 0
      ) {
        throw new BadRequestException(
          'payload فارغ — لا توجد تغييرات للتطبيق',
        );
      }

      // ── 2. Lock the parent exchange row and validate. ─────────────
      const [exc] = await em.query(
        `SELECT id, exchange_no, status,
                returned_value, new_items_value, price_difference,
                payment_method, refund_method,
                cashbox_id, shift_id, warehouse_id
           FROM exchanges
          WHERE id = $1
          FOR UPDATE`,
        [input.parent_id],
      );
      if (!exc) {
        throw new NotFoundException('الاستبدال غير موجود');
      }
      if (exc.status === 'cancelled' || exc.status === 'rejected') {
        throw new ConflictException(
          `لا يمكن تطبيق التعديل لأن حالة الاستبدال "${exc.status}"`,
        );
      }

      // ── 3. Capture before-state. ──────────────────────────────────
      const beforeItems: any[] = await em.query(
        `SELECT * FROM exchange_items WHERE exchange_id = $1 ORDER BY id`,
        [input.parent_id],
      );
      const beforeReturnedItems = beforeItems.filter(
        (it) => it.kind === 'returned',
      );
      const beforeItemsById = new Map<string, any>(
        beforeItems.map((it) => [String(it.id), it]),
      );
      const oldReturnedValue = Number(exc.returned_value || 0);
      const oldNewItemsValue = Number(exc.new_items_value || 0);
      const oldPriceDiff = Number(exc.price_difference || 0);

      // ── 4. PHASE 2B SCOPE GUARD — reject any payload that touches
      //       a `kind='new'` line.  Editing the new side requires
      //       cascading into the linked sales invoice and is out of
      //       scope (Phase 2C).
      const ensureReturnedLine = (itemId: string) => {
        const row = beforeItemsById.get(itemId);
        if (!row) {
          throw new BadRequestException(
            `بند غير موجود في الاستبدال: ${itemId}`,
          );
        }
        if (row.kind !== 'returned') {
          throw new BadRequestException(
            'تعديل البنود الجديدة في الاستبدال غير مدعوم في هذه المرحلة — Phase 2C',
          );
        }
      };
      for (const u of updatedLines) {
        ensureReturnedLine(String(u?.item_id ?? ''));
      }
      for (const r of removedLines) {
        ensureReturnedLine(String(r?.item_id ?? ''));
      }

      // ── 5. Validate payload — same UUID + finite-number guards as
      //       the return-apply path so a tampered payload can't reach
      //       SQL.
      for (const a of addedLines) {
        const vid = String(a?.variant_id ?? '').trim();
        if (vid.length === 0) {
          throw new BadRequestException(
            'لا يمكن إضافة بند بدون variant_id حقيقي',
          );
        }
        if (!UUID_RE.test(vid)) {
          throw new BadRequestException(VARIANT_ID_INVALID_MSG);
        }
        const qty = Number(a?.quantity ?? 0);
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new BadRequestException(
            'الكمية يجب أن تكون أكبر من صفر للبنود المضافة',
          );
        }
        const price = Number(a?.unit_price ?? 0);
        if (!Number.isFinite(price) || price < 0) {
          throw new BadRequestException(
            'سعر البند المضاف لا يمكن أن يكون سالباً',
          );
        }
        const [v] = await em.query(
          `SELECT id FROM product_variants WHERE id = $1`,
          [vid],
        );
        if (!v) {
          throw new BadRequestException(
            `variant_id غير موجود في قاعدة البيانات: ${vid}`,
          );
        }
      }
      for (const u of updatedLines) {
        const afterVid = u?.after?.variant_id;
        if (
          afterVid !== undefined &&
          afterVid !== null &&
          String(afterVid).trim().length > 0 &&
          !UUID_RE.test(String(afterVid).trim())
        ) {
          throw new BadRequestException(VARIANT_ID_INVALID_MSG);
        }
        const newQty = Number(u?.after?.quantity ?? 0);
        if (!Number.isFinite(newQty) || newQty <= 0) {
          throw new BadRequestException(
            'الكمية يجب أن تكون أكبر من صفر للبنود المعدلة',
          );
        }
        const newPrice = Number(u?.after?.unit_price ?? 0);
        if (!Number.isFinite(newPrice) || newPrice < 0) {
          throw new BadRequestException(
            'السعر لا يمكن أن يكون سالباً',
          );
        }
      }

      const ctIds: string[] = [];
      const reversedSmIds: string[] = [];
      const newSmIds: string[] = [];

      // ── 6. Reverse the OLD cash leg (if any).  Locate the active
      //       cash CT keyed off (reference_type='exchange',
      //       reference_id=exchange_id), then post a counter-direction
      //       CT through the engine with `category='reversal_refund'`
      //       and `reference_type='other'` / `reference_id=<orig_CT_id>`.
      //       This mirrors the convention `posting.reverseByReference`
      //       uses for paired-CT reversals (lines 1117-1123 of
      //       posting.service.ts) so the audit panel can pair the rows.
      const [origCt] = await em.query(
        `SELECT id::text AS id, cashbox_id::text AS cashbox_id,
                direction::text AS direction, amount, category::text AS category,
                notes
           FROM cashbox_transactions
          WHERE reference_type::text = 'exchange'
            AND reference_id::text   = $1
            AND is_void = FALSE
          ORDER BY id DESC
          LIMIT 1`,
        [input.parent_id],
      );
      if (origCt) {
        const reverseDirection: 'in' | 'out' =
          origCt.direction === 'in' ? 'out' : 'in';
        const reverseRes = await this.engine!.recordCashOnlyMovement({
          cashbox_id: String(origCt.cashbox_id),
          direction: reverseDirection,
          amount: Number(origCt.amount),
          category: 'reversal_refund',
          reference_type: 'other',
          reference_id: String(origCt.id),
          user_id: input.user_id,
          notes: `عكس فرق استبدال — ${exc.exchange_no} (تطبيق طلب تعديل)`,
          em,
        });
        if (!reverseRes.ok) {
          throw new BadRequestException(
            `فشل عكس فرق الاستبدال نقدياً: ${reverseRes.error}`,
          );
        }
        if ((reverseRes as any).cashbox_transaction_id) {
          ctIds.push(String((reverseRes as any).cashbox_transaction_id));
        }
      }

      // ── 7. Reverse stock for resellable RETURNED items in the
      //       BEFORE state.  Mirror of return-apply: inline UPDATE
      //       stock + INSERT stock_movements with
      //       reference_type='exchange', reference_id=<exchange_id>,
      //       notes prefix 'edit_request_apply_stock_reversal:'.
      for (const it of beforeReturnedItems) {
        if (it.condition !== 'resellable') continue;
        const qty = Number(it.quantity);
        if (!(qty > 0)) continue;
        const [costRow] = await em.query(
          `SELECT cost_price FROM product_variants WHERE id = $1`,
          [it.variant_id],
        );
        const unitCost = Number(costRow?.cost_price ?? 0);

        // PR-FIX-INVENTORY-DOUBLE-WRITE — the AFTER INSERT trigger
        // `trg_apply_stock_movement` applies the `direction='out'`
        // delta automatically. The previous explicit `UPDATE stock`
        // immediately before this INSERT was double-debiting every
        // exchange-edit reversal. The INSERT is now the single
        // mutation source.
        const [smRow] = await em.query(
          `INSERT INTO stock_movements
              (variant_id, warehouse_id, movement_type, direction,
               quantity, unit_cost, reference_type, reference_id,
               notes, user_id)
           VALUES ($1, $2,
                   'adjustment_out'::stock_movement_type,
                   'out'::txn_direction,
                   $3, $4,
                   'exchange'::entity_type, $5, $6, $7)
           RETURNING id`,
          [
            it.variant_id,
            exc.warehouse_id,
            qty,
            unitCost,
            input.parent_id,
            `edit_request_apply_stock_reversal:${exc.exchange_no}`,
            input.user_id,
          ],
        );
        reversedSmIds.push(String(smRow.id));
      }

      // ── 8. Mutate exchange_items per payload (returned-side only).
      let updatedCount = 0;
      let removedCount = 0;
      let addedCount = 0;

      for (const u of updatedLines) {
        const itemId = String(u.item_id);
        const after = u.after ?? {};
        const newQty = Number(after.quantity || 0);
        const newPrice = Number(after.unit_price || 0);
        const newNotes = after.notes == null ? null : String(after.notes);
        const newVariantId =
          after.variant_id && String(after.variant_id).trim().length > 0
            ? String(after.variant_id)
            : null;
        // Same `::numeric` casts as return-apply to avoid the live
        // "operator is not unique: unknown * unknown" pg error.
        if (newVariantId) {
          await em.query(
            `UPDATE exchange_items
                SET variant_id = $2,
                    quantity   = $3::int,
                    unit_price = $4::numeric,
                    line_total = ($3::numeric * $4::numeric)::numeric(14,2),
                    notes      = $5
              WHERE id = $1 AND exchange_id = $6 AND kind = 'returned'`,
            [itemId, newVariantId, newQty, newPrice, newNotes, input.parent_id],
          );
        } else {
          await em.query(
            `UPDATE exchange_items
                SET quantity   = $2::int,
                    unit_price = $3::numeric,
                    line_total = ($2::numeric * $3::numeric)::numeric(14,2),
                    notes      = $4
              WHERE id = $1 AND exchange_id = $5 AND kind = 'returned'`,
            [itemId, newQty, newPrice, newNotes, input.parent_id],
          );
        }
        updatedCount++;
      }

      for (const r of removedLines) {
        const itemId = String(r.item_id);
        if (!beforeItemsById.has(itemId)) continue;
        await em.query(
          `DELETE FROM exchange_items
            WHERE id = $1 AND exchange_id = $2 AND kind = 'returned'`,
          [itemId, input.parent_id],
        );
        removedCount++;
      }

      for (const a of addedLines) {
        const variantId = String(a.variant_id);
        const qty = Number(a.quantity || 0);
        const price = Number(a.unit_price || 0);
        const notes = a.notes == null ? null : String(a.notes);
        await em.query(
          `INSERT INTO exchange_items
              (exchange_id, variant_id, kind, quantity, unit_price,
               line_total, condition, notes)
           VALUES ($1, $2, 'returned',
                   $3::int, $4::numeric,
                   ($3::numeric * $4::numeric)::numeric(14,2),
                   'resellable', $5)`,
          [input.parent_id, variantId, qty, price, notes],
        );
        addedCount++;
      }

      // ── 9. Recompute exchange totals + price_difference.
      const [tot] = await em.query(
        `SELECT
           COALESCE(SUM(CASE WHEN kind='returned' THEN line_total END), 0)::numeric(14,2) AS rv,
           COALESCE(SUM(CASE WHEN kind='new'      THEN line_total END), 0)::numeric(14,2) AS nv
         FROM exchange_items
         WHERE exchange_id = $1`,
        [input.parent_id],
      );
      const newReturnedValue = Number(tot?.rv ?? 0);
      const newNewItemsValue = Number(tot?.nv ?? 0);
      const newPriceDiff = Number(
        (newNewItemsValue - newReturnedValue).toFixed(2),
      );
      await em.query(
        `UPDATE exchanges
            SET returned_value   = $2::numeric,
                new_items_value  = $3::numeric,
                price_difference = $4::numeric,
                updated_at       = NOW()
          WHERE id = $1`,
        [
          input.parent_id,
          newReturnedValue,
          newNewItemsValue,
          newPriceDiff,
        ],
      );

      // ── 10. Replay stock for resellable RETURNED items in the
      //        AFTER state.
      const afterReturnedItems: any[] = await em.query(
        `SELECT ei.id, ei.variant_id, ei.quantity, ei.condition,
                COALESCE(
                  (SELECT cost_price FROM product_variants WHERE id = ei.variant_id),
                  0
                )::numeric(14,2) AS unit_cost
           FROM exchange_items ei
          WHERE ei.exchange_id = $1
            AND ei.kind = 'returned'
            AND ei.condition = 'resellable'`,
        [input.parent_id],
      );
      for (const it of afterReturnedItems) {
        const qty = Number(it.quantity);
        if (!(qty > 0)) continue;
        // PR-FIX-INVENTORY-DOUBLE-WRITE — the AFTER INSERT trigger
        // `trg_apply_stock_movement` will UPSERT `stock` with the
        // `direction='in'` delta automatically. The previous explicit
        // UPSERT immediately before this INSERT was double-crediting
        // every exchange-edit replay. The INSERT is now the single
        // mutation source.
        const [smRow] = await em.query(
          `INSERT INTO stock_movements
              (variant_id, warehouse_id, movement_type, direction,
               quantity, unit_cost, reference_type, reference_id,
               notes, user_id)
           VALUES ($1, $2,
                   'adjustment_in'::stock_movement_type,
                   'in'::txn_direction,
                   $3, $4,
                   'exchange'::entity_type, $5, $6, $7)
           RETURNING id`,
          [
            it.variant_id,
            exc.warehouse_id,
            qty,
            Number(it.unit_cost),
            input.parent_id,
            `edit_request_apply_stock:${exc.exchange_no}`,
            input.user_id,
          ],
        );
        newSmIds.push(String(smRow.id));
      }

      // ── 11. Replay the cash leg for the NEW price difference.
      //        Direction follows the same rule as createExchange:
      //          newPriceDiff > 0  → customer owes more → IN
      //          newPriceDiff < 0  → store owes customer → OUT
      //        Method is read from the exchange row (set at creation).
      const newCashIn  = newPriceDiff > 0 && exc.payment_method === 'cash';
      const newCashOut = newPriceDiff < 0 && exc.refund_method  === 'cash';
      let cashLegReplayed = false;
      if (newCashIn || newCashOut) {
        if (!exc.cashbox_id) {
          throw new BadRequestException(
            'تعذر تطبيق فرق الاستبدال نقدياً — الخزنة غير محددة على عملية الاستبدال',
          );
        }
        const direction: 'in' | 'out' = newCashOut ? 'out' : 'in';
        const replayRes = await this.engine!.recordCashOnlyMovement({
          cashbox_id: String(exc.cashbox_id),
          direction,
          amount: Math.abs(newPriceDiff),
          category: 'refund',
          reference_type: 'exchange',
          reference_id: input.parent_id,
          user_id: input.user_id,
          notes:
            `${direction === 'out' ? 'صرف' : 'تحصيل'} فرق استبدال — ${exc.exchange_no} (تطبيق طلب تعديل)`,
          em,
        });
        if (!replayRes.ok) {
          throw new BadRequestException(
            `فشل تسجيل فرق الاستبدال نقدياً: ${replayRes.error}`,
          );
        }
        if ((replayRes as any).cashbox_transaction_id) {
          ctIds.push(String((replayRes as any).cashbox_transaction_id));
        }
        cashLegReplayed = true;
      }

      // ── 12. Stamp the request as applied.  Layered idempotency:
      //         · SELECT FOR UPDATE in step 1 holds the row lock.
      //         · The WHERE applied_at IS NULL clause below races
      //           cleanly: a concurrent stamp returns empty.
      const allSmIds = [...reversedSmIds, ...newSmIds];
      const summary = {
        status_at_apply: exc.status,
        was_completed: exc.status === 'completed',
        old_returned_value: oldReturnedValue,
        new_returned_value: newReturnedValue,
        delta_returned_value: Number(
          (newReturnedValue - oldReturnedValue).toFixed(2),
        ),
        old_new_items_value: oldNewItemsValue,
        new_new_items_value: newNewItemsValue,
        delta_new_items_value: Number(
          (newNewItemsValue - oldNewItemsValue).toFixed(2),
        ),
        old_price_difference: oldPriceDiff,
        new_price_difference: newPriceDiff,
        delta_price_difference: Number(
          (newPriceDiff - oldPriceDiff).toFixed(2),
        ),
        lines_updated: updatedCount,
        lines_removed: removedCount,
        lines_added: addedCount,
        cash_leg_reversed: Boolean(origCt),
        cash_leg_replayed: cashLegReplayed,
        notes: input.notes ?? null,
      };
      const [stamped] = await em.query(
        `UPDATE exchange_edit_requests
            SET applied_at                    = NOW(),
                applied_by                    = $2,
                apply_journal_entry_ids       = $3::uuid[],
                apply_cashbox_transaction_ids = $4::bigint[],
                apply_stock_movement_ids      = $5::bigint[],
                apply_summary                 = $6::jsonb,
                updated_at                    = NOW()
          WHERE id = $1
            AND applied_at IS NULL
            AND status = 'approved'
          RETURNING *`,
        [
          input.request_id,
          input.user_id,
          [],                              // exchanges post no JE
          ctIds.map((s) => Number(s)),
          allSmIds,
          JSON.stringify(summary),
        ],
      );
      if (!stamped) {
        throw new ConflictException(
          'تعذّر ختم طلب التعديل كمُطبَّق — قد يكون تم تطبيقه بالتزامن',
        );
      }

      // ── 13. Activity log (best-effort).
      if (this.audit) {
        try {
          await this.audit.writeActivity({
            user_id: input.user_id,
            action: 'update',
            entity: 'exchange',
            entity_id: input.parent_id,
            summary: `تم تطبيق طلب تعديل استبدال ${exc.exchange_no}`,
            extra: {
              kind: 'edit_request_apply',
              edit_request_id: input.request_id,
              ...summary,
              journal_entry_ids: [],
              cashbox_transaction_ids: ctIds,
              stock_movement_ids: allSmIds,
            },
          });
        } catch {
          /* swallowed — audit is best-effort */
        }
      }

      return this.toApplyResult(stamped, 'exchange_id');
    });
  }

  // ─── private helpers ──────────────────────────────────────────

  private tableFor(entity: EditRequestEntity): {
    table: string;
    fk: string;
    docCol: string;
    parentTable: string;
    parentItemsTable: string;
    parentItemsFk: string;
    parentDocCol: string;
  } {
    return entity === 'return'
      ? {
          table: 'return_edit_requests',
          fk: 'return_id',
          docCol: 'return_no',
          parentTable: 'returns',
          parentItemsTable: 'return_items',
          parentItemsFk: 'return_id',
          parentDocCol: 'return_no',
        }
      : {
          table: 'exchange_edit_requests',
          fk: 'exchange_id',
          docCol: 'exchange_no',
          parentTable: 'exchanges',
          parentItemsTable: 'exchange_items',
          parentItemsFk: 'exchange_id',
          parentDocCol: 'exchange_no',
        };
  }

  private async buildBeforeSnapshot(
    em: any,
    entity: EditRequestEntity,
    parentId: string,
  ): Promise<{ snapshot: Record<string, unknown>; document_no: string | null } | null> {
    const cfg = this.tableFor(entity);
    const [doc] = await em.query(
      `SELECT * FROM ${cfg.parentTable} WHERE id = $1`,
      [parentId],
    );
    if (!doc) return null;
    const items = await em.query(
      `SELECT * FROM ${cfg.parentItemsTable} WHERE ${cfg.parentItemsFk} = $1
        ORDER BY created_at NULLS LAST, id`,
      [parentId],
    );
    return {
      document_no: (doc[cfg.parentDocCol] as string | null) ?? null,
      snapshot: { document: doc, items },
    };
  }

  private async review(
    input: ReviewInput,
    target: 'approved' | 'rejected',
    action: 'approve' | 'reject',
    kind: string,
  ): Promise<EditRequestRow> {
    const { table, fk } = this.tableFor(input.entity);
    return this.ds.transaction(async (em) => {
      const [existing] = await em.query(
        `SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`,
        [input.request_id],
      );
      if (!existing) {
        throw new NotFoundException('طلب التعديل غير موجود');
      }
      if (existing.status !== 'pending') {
        throw new ConflictException(
          `لا يمكن مراجعة طلب التعديل لأن حالته "${existing.status}" — لا تسمح إلا بـ pending`,
        );
      }
      const [updated] = await em.query(
        `
        UPDATE ${table}
           SET status        = $2,
               reviewed_by   = $3,
               reviewed_at   = now(),
               review_notes  = $4,
               updated_at    = now()
         WHERE id = $1
         RETURNING *
        `,
        [
          input.request_id,
          target,
          input.user_id,
          input.review_notes ?? null,
        ],
      );

      if (this.audit) {
        try {
          await this.audit.writeActivity({
            user_id: input.user_id,
            action,
            entity: input.entity,
            entity_id: existing[fk],
            summary: `${target === 'approved' ? 'اعتماد' : 'رفض'} طلب تعديل ${input.entity === 'return' ? 'مرتجع' : 'استبدال'}`,
            extra: {
              kind,
              edit_request_id: input.request_id,
              status_before: 'pending',
              status_after: target,
              review_notes: input.review_notes ?? null,
            },
          });
        } catch {
          /* swallowed — audit is best-effort */
        }
      }
      return this.toRow(updated, fk);
    });
  }

  private validateRequestedAction(action: string): asserts action is RequestedAction {
    if (!ALLOWED_ACTIONS.includes(action as RequestedAction)) {
      throw new BadRequestException(
        `requested_action غير مسموح. القيم المسموحة: ${ALLOWED_ACTIONS.join(', ')}`,
      );
    }
  }

  private validateReason(reason: string): void {
    if (typeof reason !== 'string' || reason.trim().length < 5) {
      throw new BadRequestException(
        'سبب التعديل مطلوب (٥ أحرف على الأقل)',
      );
    }
  }

  private validatePayload(payload: unknown): void {
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      throw new BadRequestException(
        'requested_payload يجب أن يكون كائنًا (JSON object)',
      );
    }
  }

  private toApplyResult(raw: any, fk: string): ApplyResult {
    const base = this.toRow(raw, fk);
    return {
      ...base,
      applied_at: !raw.applied_at
        ? null
        : typeof raw.applied_at === 'string'
          ? raw.applied_at
          : raw.applied_at.toISOString?.() ?? null,
      applied_by: raw.applied_by ?? null,
      apply_journal_entry_ids: Array.isArray(raw.apply_journal_entry_ids)
        ? raw.apply_journal_entry_ids.map((x: any) => String(x))
        : [],
      apply_cashbox_transaction_ids: Array.isArray(
        raw.apply_cashbox_transaction_ids,
      )
        ? raw.apply_cashbox_transaction_ids.map((x: any) => String(x))
        : [],
      apply_stock_movement_ids: Array.isArray(raw.apply_stock_movement_ids)
        ? raw.apply_stock_movement_ids.map((x: any) => String(x))
        : [],
      apply_summary: raw.apply_summary ?? null,
    };
  }

  private toRow(raw: any, fk: string): EditRequestRow {
    return {
      id: String(raw.id),
      parent_id: String(raw[fk]),
      document_no: raw.return_no ?? raw.exchange_no ?? null,
      requested_action: raw.requested_action,
      requested_payload: raw.requested_payload ?? {},
      before_snapshot: raw.before_snapshot ?? {},
      after_preview: raw.after_preview ?? null,
      reason_text: raw.reason_text,
      status: raw.status,
      requested_by: raw.requested_by,
      requested_by_name: raw.requested_by_name ?? null,
      requested_at: typeof raw.requested_at === 'string'
        ? raw.requested_at
        : raw.requested_at?.toISOString?.() ?? null,
      reviewed_by: raw.reviewed_by ?? null,
      reviewed_by_name: raw.reviewed_by_name ?? null,
      reviewed_at: !raw.reviewed_at
        ? null
        : typeof raw.reviewed_at === 'string'
          ? raw.reviewed_at
          : raw.reviewed_at.toISOString?.() ?? null,
      review_notes: raw.review_notes ?? null,
      idempotency_key: raw.idempotency_key ?? null,
      created_at: typeof raw.created_at === 'string'
        ? raw.created_at
        : raw.created_at?.toISOString?.() ?? null,
      updated_at: typeof raw.updated_at === 'string'
        ? raw.updated_at
        : raw.updated_at?.toISOString?.() ?? null,
    };
  }
}
