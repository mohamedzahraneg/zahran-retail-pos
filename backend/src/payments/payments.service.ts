import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CreatePaymentAccountDto,
  UpdatePaymentAccountDto,
} from './dto/payment-account.dto';
import { PAYMENT_PROVIDERS } from './providers.catalog';

/**
 * PR-PAY-1 — payment_accounts CRUD + provider catalog facade.
 *
 * Validation that lives in the DB triggers (gl code must exist,
 * method/account consistency on invoice_payments) is treated as
 * authoritative — this service translates trigger errors into
 * BadRequestException with a clear Arabic-friendly message.
 */
/**
 * PR-FIN-PAYACCT-4A — service-level rule mapping a payment_method to the
 * cashbox.kind it can be pinned to. Used by `validateCashboxKindMatch()`
 * when the operator passes `cashbox_id` on create/update.
 *
 * Cash methods don't appear in payment_accounts in practice (cash flows
 * directly through the shift's cashbox without a payment_account row),
 * but we still allow `cash → cash` for completeness.
 */
const METHOD_TO_CASHBOX_KIND: Record<string, string> = {
  cash: 'cash',
  card_visa: 'bank',
  card_mastercard: 'bank',
  card_meeza: 'bank',
  bank_transfer: 'bank',
  instapay: 'ewallet',
  wallet: 'ewallet',
  vodafone_cash: 'ewallet',
  orange_cash: 'ewallet',
  // PR-FIN-PAYACCT-4B — cheque accounts route to cashboxes.kind='check'.
  check: 'check',
  // 'credit' and 'other' don't map to a physical cashbox — caller must
  // not pass cashbox_id with them. The validator throws.
};

@Injectable()
export class PaymentsService {
  constructor(private readonly ds: DataSource) {}

  // ── Provider catalog (static) ────────────────────────────────────
  listProviders() {
    return PAYMENT_PROVIDERS;
  }

  /**
   * PR-FIN-PAYACCT-4A — validate that an optional cashbox_id (a) exists,
   * and (b) has a kind that matches the method group. Returns the
   * cashbox row when valid; throws BadRequestException otherwise.
   * Pass `null`/`undefined` to short-circuit (no validation).
   */
  private async validateCashboxKindMatch(
    cashboxId: string | null | undefined,
    method: string,
    em?: { query(sql: string, p?: any[]): Promise<any[]> },
  ): Promise<{ id: string; kind: string } | null> {
    if (!cashboxId) return null;
    const runner = em ?? this.ds;
    const [row] = await runner.query(
      `SELECT id, kind::text AS kind FROM cashboxes WHERE id = $1`,
      [cashboxId],
    );
    if (!row) {
      throw new NotFoundException(
        `الخزنة المرتبطة (cashbox_id = ${cashboxId}) غير موجودة.`,
      );
    }
    const expected = METHOD_TO_CASHBOX_KIND[method];
    if (!expected) {
      throw new BadRequestException(
        `لا يمكن ربط حساب طريقة الدفع "${method}" بخزنة فيزيائية.`,
      );
    }
    if (row.kind !== expected) {
      throw new BadRequestException(
        `الخزنة من نوع "${row.kind}" غير متوافقة مع طريقة الدفع "${method}". ` +
          `المتوقع: نوع "${expected}".`,
      );
    }
    return row;
  }

  // ── Payment accounts ─────────────────────────────────────────────
  async list(filter: { method?: string; active?: string }) {
    const where: string[] = [];
    const args: any[] = [];
    if (filter.method) {
      args.push(filter.method);
      where.push(`method = $${args.length}::payment_method_code`);
    }
    if (typeof filter.active !== 'undefined') {
      args.push(filter.active === 'true' || filter.active === '1');
      where.push(`active = $${args.length}`);
    }
    const sql = `
      SELECT id, method::text AS method, provider_key, display_name, identifier,
             gl_account_code, cashbox_id, is_default, active, sort_order, metadata,
             created_at, updated_at, created_by, updated_by
        FROM payment_accounts
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY method, sort_order, display_name
    `;
    return this.ds.query(sql, args);
  }

  /**
   * PR-FIN-PAYACCT-4B — list each payment_account with its running
   * balance from `v_payment_account_balance` (mig 121 of PR-4A). Used
   * by the new admin page's KPI cards + per-row balance column +
   * bottom summary chart. Read-only.
   *
   * Returns one row per ACTIVE payment_account by default. Pass
   * `?active=false` to include deactivated accounts (the view itself
   * filters to active=TRUE — for inactive rows we fall through to a
   * left-join so the FE can still display them with `je_count=0`).
   */
  /**
   * PR-FIN-PAYACCT-4D — read-only wrapper over `v_dashboard_payment_mix_30d`.
   *
   * The view ships per-method usage for the trailing 30 days
   * (transactions / total_amount / pct). The FE renders this on the
   * unified treasury page's "أكثر الطرق استخدامًا آخر 30 يوم" card.
   *
   * Today the view's window is hard-coded at 30 days (see migration
   * that created it); the `days` query param is accepted for forward
   * compatibility but ignored when not 30 — we surface the view as-is
   * without trying to re-aggregate (which would fork the source of
   * truth). If `days != 30` is passed, we still return the 30-day mix;
   * the caller can show "آخر 30 يوم" copy regardless.
   */
  async methodMix(_days = 30) {
    const sql = `
      SELECT payment_method::text       AS payment_method,
             COALESCE(transactions, 0)  AS transactions,
             COALESCE(total_amount, 0)::numeric AS total_amount,
             COALESCE(pct, 0)::numeric  AS pct
        FROM v_dashboard_payment_mix_30d
       ORDER BY total_amount DESC NULLS LAST, payment_method
    `;
    return this.ds.query(sql);
  }

  async listBalances(filter: { method?: string; active?: string } = {}) {
    const where: string[] = [];
    const args: any[] = [];
    if (filter.method) {
      args.push(filter.method);
      where.push(`pa.method = $${args.length}::payment_method_code`);
    }
    if (typeof filter.active !== 'undefined') {
      args.push(filter.active === 'true' || filter.active === '1');
      where.push(`pa.active = $${args.length}`);
    }
    // Compose by joining payment_accounts → v_payment_account_balance.
    // The view restricts itself to active rows, so for inactive
    // accounts we LEFT JOIN and return 0/0/0/null for the balance
    // columns — gives the FE a single shape regardless of `active`.
    const sql = `
      SELECT pa.id::text                        AS payment_account_id,
             pa.method::text                    AS method,
             pa.provider_key,
             pa.display_name,
             pa.identifier,
             pa.gl_account_code,
             pa.cashbox_id::text                AS cashbox_id,
             pa.is_default,
             pa.active,
             pa.sort_order,
             pa.metadata,
             coa.name_ar                        AS gl_name_ar,
             coa.normal_balance,
             COALESCE(b.total_in, 0)::numeric   AS total_in,
             COALESCE(b.total_out, 0)::numeric  AS total_out,
             COALESCE(b.net_debit, 0)::numeric  AS net_debit,
             COALESCE(b.je_count, 0)::int       AS je_count,
             b.last_movement
        FROM payment_accounts pa
        LEFT JOIN chart_of_accounts coa ON coa.code = pa.gl_account_code
        LEFT JOIN v_payment_account_balance b ON b.payment_account_id = pa.id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY pa.method, pa.sort_order, pa.display_name
    `;
    return this.ds.query(sql, args);
  }

  // PR-PAY-2 hotfix — `getById` accepts an optional EntityManager so
  // callers running inside a transaction (create / setDefault) can
  // read their own uncommitted writes. Without it the reader runs on
  // a different pooled connection that doesn't see the in-flight
  // INSERT/UPDATE → returns null → NotFoundException → transaction
  // rolls back → the operator sees "payment_account not found" AND
  // the row never persists.
  async getById(
    id: string,
    em?: { query(sql: string, p?: any[]): Promise<any[]> },
  ) {
    const runner = em ?? this.ds;
    const [row] = await runner.query(
      `SELECT id, method::text AS method, provider_key, display_name, identifier,
              gl_account_code, is_default, active, sort_order, metadata,
              created_at, updated_at, created_by, updated_by
         FROM payment_accounts WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('payment_account not found');
    return row;
  }

  async create(dto: CreatePaymentAccountDto, userId: string) {
    if (!dto.display_name?.trim()) {
      throw new BadRequestException('اسم العرض مطلوب.');
    }
    // is_default + active=false combination is invalid (the partial unique
    // index guards live rows; a defaulted-but-inactive account is dead
    // weight. Catch up front for a clear Arabic error.)
    if (dto.is_default && dto.active === false) {
      throw new BadRequestException(
        'لا يمكن تعيين حساب غير مفعل كافتراضي. فعّل الحساب أولاً.',
      );
    }
    return this.ds.transaction(async (em) => {
      // PR-FIN-PAYACCT-4A: validate optional cashbox pin BEFORE the
      // INSERT so we don't leave a half-rolled-back row.
      await this.validateCashboxKindMatch(dto.cashbox_id, dto.method, em);

      // is_default uniqueness is enforced by the partial unique index
      // (method) WHERE is_default AND active. We let Postgres raise on
      // conflict and translate it.
      try {
        const [row] = await em.query(
          `INSERT INTO payment_accounts
             (method, provider_key, display_name, identifier, gl_account_code,
              cashbox_id, is_default, active, sort_order, metadata,
              created_by, updated_by)
           VALUES ($1::payment_method_code, $2, $3, $4, $5,
                   $6,
                   COALESCE($7,false), COALESCE($8,true), COALESCE($9,0),
                   COALESCE($10,'{}'::jsonb), $11, $11)
           RETURNING id`,
          [
            dto.method,
            dto.provider_key ?? null,
            dto.display_name,
            dto.identifier ?? null,
            dto.gl_account_code,
            dto.cashbox_id ?? null,
            dto.is_default ?? false,
            dto.active ?? true,
            dto.sort_order ?? 0,
            dto.metadata ? JSON.stringify(dto.metadata) : '{}',
            userId,
          ],
        );
        // Read through the same EntityManager so we see the row we
        // just inserted (read-committed isolation hides uncommitted
        // writes from other connections).
        return this.getById(row.id, em);
      } catch (err: any) {
        if (
          /ux_payment_accounts_default_per_method/.test(err?.detail || '') ||
          /ux_payment_accounts_default_per_method/.test(err?.message || '')
        ) {
          throw new ConflictException(
            'يوجد حساب افتراضي مفعل آخر لنفس وسيلة الدفع. ' +
              'قم بإلغاء افتراضيته أو ألغِ الافتراضي عن هذا الحساب.',
          );
        }
        if (/gl_account_code/.test(err?.message || '')) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
    });
  }

  async update(id: string, dto: UpdatePaymentAccountDto, userId: string) {
    if (dto.display_name !== undefined && !dto.display_name.trim()) {
      throw new BadRequestException('اسم العرض لا يمكن أن يكون فارغاً.');
    }
    return this.ds.transaction(async (em) => {
      // If cashbox_id is being set (not just cleared with null), validate
      // it against the account's CURRENT method. We re-read the row to
      // get the method since the DTO doesn't carry it on update.
      if (dto.cashbox_id) {
        const [existing] = await em.query(
          `SELECT method::text AS method FROM payment_accounts WHERE id = $1`,
          [id],
        );
        if (!existing) throw new NotFoundException('payment_account not found');
        await this.validateCashboxKindMatch(dto.cashbox_id, existing.method, em);
      }

      const fields: string[] = [];
      const args: any[] = [];
      const push = (col: string, val: unknown) => {
        args.push(val);
        fields.push(`${col} = $${args.length}`);
      };
      if (dto.display_name !== undefined) push('display_name', dto.display_name);
      if (dto.identifier !== undefined) push('identifier', dto.identifier);
      if (dto.gl_account_code !== undefined)
        push('gl_account_code', dto.gl_account_code);
      if (dto.provider_key !== undefined) push('provider_key', dto.provider_key);
      if (dto.sort_order !== undefined) push('sort_order', dto.sort_order);
      if (dto.metadata !== undefined)
        push('metadata', JSON.stringify(dto.metadata));
      // PR-FIN-PAYACCT-4A: explicit `null` clears the pin; `undefined`
      // (field omitted) leaves it untouched.
      if (dto.cashbox_id !== undefined) push('cashbox_id', dto.cashbox_id);
      if (!fields.length) return this.getById(id, em);

      args.push(userId);
      fields.push(`updated_by = $${args.length}`);
      args.push(id);

      try {
        await em.query(
          `UPDATE payment_accounts SET ${fields.join(', ')}
            WHERE id = $${args.length}`,
          args,
        );
      } catch (err: any) {
        if (/gl_account_code/.test(err?.message || '')) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
      return this.getById(id, em);
    });
  }

  async deactivate(id: string, userId: string) {
    await this.ds.query(
      `UPDATE payment_accounts
          SET active = FALSE, is_default = FALSE, updated_by = $2
        WHERE id = $1`,
      [id, userId],
    );
    return this.getById(id);
  }

  /**
   * PR-FIN-PAYACCT-4A — symmetric flip on the `active` flag. When
   * activating, leaves `is_default` alone (operator must call
   * `setDefault` explicitly to promote). When deactivating, force-clears
   * `is_default` so the partial unique index doesn't trip the next time
   * a new default is set on the same method.
   *
   * Idempotent: re-toggling produces a no-op semantic (just flips again).
   */
  async toggleActive(id: string, userId: string) {
    return this.ds.transaction(async (em) => {
      const [row] = await em.query(
        `SELECT active FROM payment_accounts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!row) throw new NotFoundException('payment_account not found');
      const nextActive = !row.active;
      if (nextActive) {
        await em.query(
          `UPDATE payment_accounts
              SET active = TRUE, updated_by = $2
            WHERE id = $1`,
          [id, userId],
        );
      } else {
        await em.query(
          `UPDATE payment_accounts
              SET active = FALSE, is_default = FALSE, updated_by = $2
            WHERE id = $1`,
          [id, userId],
        );
      }
      return this.getById(id, em);
    });
  }

  /**
   * PR-FIN-PAYACCT-4A — safe delete with use-detection.
   *
   * If the account is referenced by any non-void invoice_payments,
   * customer_payments, or supplier_payments row, we fall back to a soft
   * delete (UPDATE active=FALSE, is_default=FALSE) so historical JEs +
   * snapshots stay readable. The FK on those tables is `ON DELETE SET
   * NULL`, but soft-delete preserves the explicit link AND the audit
   * trail.
   *
   * If the account is unused, we hard-delete the row.
   *
   * Returns `{ id, mode: 'soft' | 'hard' }` so the FE can render the
   * right Arabic message.
   */
  async deleteAccount(
    id: string,
    userId: string,
  ): Promise<{ id: string; mode: 'soft' | 'hard' }> {
    return this.ds.transaction(async (em) => {
      const [row] = await em.query(
        `SELECT id FROM payment_accounts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!row) throw new NotFoundException('payment_account not found');

      // The three reference paths.
      const [{ usage_count }] = await em.query(
        `SELECT (
            (SELECT count(*) FROM invoice_payments  WHERE payment_account_id = $1)
          + (SELECT count(*) FROM customer_payments WHERE payment_account_id = $1)
          + (SELECT count(*) FROM supplier_payments WHERE payment_account_id = $1)
         )::int AS usage_count`,
        [id],
      );

      if (usage_count > 0) {
        // soft-delete: deactivate + clear default. The FE may need to
        // confirm with the operator before this branch — but the
        // service is idempotent, so a re-call is harmless.
        await em.query(
          `UPDATE payment_accounts
              SET active = FALSE, is_default = FALSE, updated_by = $2
            WHERE id = $1`,
          [id, userId],
        );
        return { id, mode: 'soft' as const };
      }

      // hard-delete: row has never been used, no historical state to
      // preserve. The metadata + sort_order live with the row, so a
      // delete is clean.
      await em.query(`DELETE FROM payment_accounts WHERE id = $1`, [id]);
      return { id, mode: 'hard' as const };
    });
  }

  async setDefault(id: string, userId: string) {
    return this.ds.transaction(async (em) => {
      const [row] = await em.query(
        `SELECT method, active FROM payment_accounts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!row) throw new NotFoundException('payment_account not found');
      if (!row.active) {
        throw new BadRequestException(
          'لا يمكن جعل حساب غير مفعل افتراضياً. قم بتفعيله أولاً.',
        );
      }
      // Clear any prior default on this method, then promote `id`.
      await em.query(
        `UPDATE payment_accounts
            SET is_default = FALSE, updated_by = $2
          WHERE method = $1 AND is_default = TRUE AND id <> $3`,
        [row.method, userId, id],
      );
      await em.query(
        `UPDATE payment_accounts
            SET is_default = TRUE, updated_by = $2
          WHERE id = $1`,
        [id, userId],
      );
      // Same hotfix as create(): read inside the same transaction so
      // the just-flipped is_default is visible.
      return this.getById(id, em);
    });
  }

  /**
   * Resolve an account for posting. Returns null if the account_id is
   * absent (caller falls back to method default) or if the account
   * was hard-deleted (shouldn't happen — we deactivate, not delete).
   */
  async resolveForPosting(
    accountId: string | null | undefined,
    em?: { query(sql: string, p?: any[]): Promise<any[]> },
  ): Promise<{
    id: string;
    method: string;
    display_name: string;
    provider_key: string | null;
    identifier: string | null;
    gl_account_code: string;
    /**
     * PR-FIN-PAYACCT-4A — optional pin to a physical cashbox so the
     * customer/supplier payment posting (PR-FIN-PAYACCT-4C) can tag
     * the cash leg of the JE on this cashbox even when the account
     * lives on a shared GL code.
     */
    cashbox_id: string | null;
    /** PR-PAY-7 — operator-uploaded data URL or pasted URL, frozen
     *  into the snapshot so receipts render the right brand offline. */
    metadata: Record<string, unknown> | null;
  } | null> {
    if (!accountId) return null;
    const runner = em ?? this.ds;
    const [row] = await runner.query(
      `SELECT id, method::text AS method, provider_key, display_name,
              identifier, gl_account_code, cashbox_id, metadata
         FROM payment_accounts WHERE id = $1`,
      [accountId],
    );
    return row ?? null;
  }
}
