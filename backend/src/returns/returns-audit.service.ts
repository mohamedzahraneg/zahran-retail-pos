/**
 * ReturnsAuditService — read-only audit history for returns + exchanges.
 *
 * PR-FIN-RETURNS-EXCHANGES-AUDIT — Phase 1.
 *
 * Composes a single per-document history from three sources:
 *   1. `audit_logs` rows for the document (returns / exchanges)        — DB-trigger row diffs.
 *   2. `audit_logs` rows for the document's items (return_items /
 *                                                  exchange_items)     — DB-trigger row diffs.
 *   3. `activity_logs` rows for the document                            — high-level user actions
 *                                                                         (`create`, `void`, etc).
 *   4. Amendments (placeholder)                                         — populated in Phase 4 once
 *                                                                         `return_amendments` /
 *                                                                         `exchange_amendments` exist.
 *
 * Strict guarantees:
 *   · ZERO mutations.  Only `SELECT` queries.  No INSERT / UPDATE /
 *     DELETE / TRUNCATE / DROP.
 *   · Returns the same source-of-truth columns as
 *     `AuditService.listChanges` / `listActivity` so the FE renderer
 *     can reuse existing types.
 *   · The amendments field is an empty array until Phase 4 ships
 *     `return_amendments` / `exchange_amendments` tables.  Including
 *     it now keeps the FE response shape stable across phases.
 *
 * The audit_logs trigger coverage for `returns` / `return_items` /
 * `exchanges` / `exchange_items` lands in migration
 * 124_pr_returns_exchanges_audit_triggers.sql.  This service works
 * before AND after that migration: pre-trigger documents return an
 * empty `document_changes` + `item_changes`; activity_logs (which has
 * always been there) still flows through.
 */
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export type AuditEntity = 'return' | 'exchange';

export interface AuditChangeRow {
  id: string;
  table_name: string;
  record_id: string;
  operation: 'I' | 'U' | 'D';
  changed_by: string | null;
  changed_by_username: string | null;
  changed_by_name: string | null;
  old_data: any;
  new_data: any;
  changed_at: string;
}

export interface AuditActivityRow {
  id: string;
  user_id: string | null;
  username: string | null;
  full_name: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  summary: string | null;
  metadata: any;
  ip_address: string | null;
  created_at: string;
}

/**
 * Future-stable Phase-4 placeholder.  See `return_amendments` /
 * `exchange_amendments` design in the PR-FIN-RETURNS-EXCHANGES-EDIT
 * proposal.  Returning `[]` today means FE code that reads
 * `result.amendments` doesn't break when Phase 4 lands.
 */
export interface AuditAmendmentRow {
  id: string;
  amendment_no: string;
  amendment_kind: string;
  reason_text: string;
  delta_summary: any;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}

export interface DocumentAuditResult {
  document_type: AuditEntity;
  document_id: string;
  document_changes: AuditChangeRow[];
  item_changes: AuditChangeRow[];
  activity: AuditActivityRow[];
  amendments: AuditAmendmentRow[];
}

@Injectable()
export class ReturnsAuditService {
  constructor(private readonly ds: DataSource) {}

  async getReturnAudit(returnId: string): Promise<DocumentAuditResult> {
    return this.getAudit('return', returnId);
  }

  async getExchangeAudit(exchangeId: string): Promise<DocumentAuditResult> {
    return this.getAudit('exchange', exchangeId);
  }

  private async getAudit(
    entity: AuditEntity,
    documentId: string,
  ): Promise<DocumentAuditResult> {
    const docTable = entity === 'return' ? 'returns' : 'exchanges';
    const itemsTable =
      entity === 'return' ? 'return_items' : 'exchange_items';
    const itemsFk = entity === 'return' ? 'return_id' : 'exchange_id';

    // ── 1. Row-diffs on the document ───────────────────────────────
    const document_changes: AuditChangeRow[] = await this.ds.query(
      `
      SELECT ad.id::text, ad.table_name, ad.record_id, ad.operation,
             ad.changed_by::text, u.username AS changed_by_username,
             u.full_name AS changed_by_name,
             ad.old_data, ad.new_data, ad.changed_at::text
        FROM audit_logs ad
        LEFT JOIN users u ON u.id = ad.changed_by
       WHERE ad.table_name = $1
         AND ad.record_id = $2
       ORDER BY ad.changed_at DESC
      `,
      [docTable, documentId],
    );

    // ── 2. Row-diffs on the document's items ───────────────────────
    // We resolve the item ids via the items table itself so the lookup
    // is correct for ALL items belonging to this document, including
    // items that have since been deleted (their audit_logs rows still
    // carry the original record_id).  We additionally union via a
    // JSONB key match against `<itemsFk>` so trigger-recorded
    // DELETE/INSERT rows (whose item id may not be in the live table
    // anymore) still surface.
    const item_changes: AuditChangeRow[] = await this.ds.query(
      `
      SELECT ad.id::text, ad.table_name, ad.record_id, ad.operation,
             ad.changed_by::text, u.username AS changed_by_username,
             u.full_name AS changed_by_name,
             ad.old_data, ad.new_data, ad.changed_at::text
        FROM audit_logs ad
        LEFT JOIN users u ON u.id = ad.changed_by
       WHERE ad.table_name = $1
         AND (
              ad.record_id IN (SELECT id::text FROM ${itemsTable} WHERE ${itemsFk} = $2)
           OR (ad.new_data ->> $3) = $2
           OR (ad.old_data ->> $3) = $2
         )
       ORDER BY ad.changed_at DESC
      `,
      [itemsTable, documentId, itemsFk],
    );

    // ── 3. Activity log ────────────────────────────────────────────
    const activity: AuditActivityRow[] = await this.ds.query(
      `
      SELECT a.id::text, a.user_id::text, u.username, u.full_name,
             a.action::text AS action, a.entity::text AS entity,
             a.entity_id::text, a.summary, a.metadata,
             a.ip_address::text, a.created_at::text
        FROM activity_logs a
        LEFT JOIN users u ON u.id = a.user_id
       WHERE a.entity = $1::entity_type
         AND a.entity_id = $2
       ORDER BY a.created_at DESC
      `,
      [entity, documentId],
    );

    // ── 4. Amendments — Phase 4 placeholder ────────────────────────
    // Returning [] keeps the response shape stable so the FE doesn't
    // need a follow-up release once `return_amendments` /
    // `exchange_amendments` ship.  When those tables exist, swap this
    // for the real query.
    const amendments: AuditAmendmentRow[] = [];

    return {
      document_type: entity,
      document_id: documentId,
      document_changes,
      item_changes,
      activity,
      amendments,
    };
  }
}
