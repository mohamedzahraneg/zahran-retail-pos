/**
 * ReturnEditRequestsService — request-only edit workflow for returns
 * and exchanges.  PR-FIN-RETURNS-EXCHANGES-EDIT-REQUESTS — Phase 1.
 *
 * Strict scope (Phase 1):
 *   · CREATE a pending edit request capturing before_snapshot + the
 *     requested payload.  The original return / exchange + items are
 *     NOT modified.
 *   · APPROVE / REJECT change ONLY the request row's status +
 *     reviewer fields.  The approved payload is NOT applied; that's
 *     a later phase.
 *   · LIST returns the request rows for one document.
 *
 * Hard guarantees (each is a code-level constraint, not a hope):
 *   · ZERO writes to returns / return_items / exchanges /
 *     exchange_items / journal_entries / journal_lines /
 *     cashbox_transactions / stock_movements.
 *   · ZERO calls to AccountingPostingService / FinancialEngineService
 *     / postReturn / recordTransaction / recordCashOnlyMovement /
 *     reverseByReference.
 *   · Direct SQL is limited to two tables: `return_edit_requests` and
 *     `exchange_edit_requests`.
 *   · Side effect: one `activity_logs` row per create/approve/reject
 *     via `AuditService.writeActivity`, mirroring the existing
 *     lifecycle convention (action + extra.kind disambiguation).
 *   · State machine: pending → approved / rejected / cancelled.
 *     approved/rejected/cancelled are terminal — re-review throws.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';

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

@Injectable()
export class ReturnEditRequestsService {
  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly audit?: AuditService,
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
