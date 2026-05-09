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
      // Defense-in-depth: this method is return-only.  Phase 2B will
      // ship the exchange variant in a separate PR.
      throw new NotImplementedException(
        'تطبيق طلب تعديل الاستبدال غير متاح بعد — قيد الإعداد',
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
        //     state.  Mirror of cancel: inline UPDATE stock + INSERT
        //     stock_movements with reference_type='return',
        //     reference_id=<return_id>, notes prefix
        //     'edit_request_apply_stock_reversal:'.
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

          await em.query(
            `UPDATE stock
                SET quantity_on_hand = quantity_on_hand - $1,
                    updated_at = NOW()
              WHERE variant_id = $2 AND warehouse_id = $3`,
            [qty, it.variant_id, ret.warehouse_id],
          );
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
          await em.query(
            `INSERT INTO stock (variant_id, warehouse_id, quantity_on_hand)
             VALUES ($1, $2, $3)
             ON CONFLICT (variant_id, warehouse_id)
             DO UPDATE SET quantity_on_hand = stock.quantity_on_hand + EXCLUDED.quantity_on_hand,
                           updated_at = NOW()`,
            [it.variant_id, ret.warehouse_id, qty],
          );
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
   * Phase 2A scope guard — the controller calls this for the
   * exchange apply endpoint.  Always 501.  When Phase 2B lands the
   * implementation will replace the throw.  `async` so the throw
   * surfaces as a rejected promise (Nest converts it into the
   * proper HTTP exception on the controller boundary).
   */
  async applyApprovedExchange(_input: ApplyInput): Promise<ApplyResult> {
    throw new NotImplementedException(
      'تطبيق طلب تعديل الاستبدال غير متاح بعد — قيد الإعداد',
    );
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
