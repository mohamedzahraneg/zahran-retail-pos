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
@Injectable()
export class PaymentsService {
  constructor(private readonly ds: DataSource) {}

  // ── Provider catalog (static) ────────────────────────────────────
  listProviders() {
    return PAYMENT_PROVIDERS;
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
             gl_account_code, is_default, active, sort_order, metadata,
             created_at, updated_at, created_by, updated_by
        FROM payment_accounts
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY method, sort_order, display_name
    `;
    return this.ds.query(sql, args);
  }

  async getById(id: string) {
    const [row] = await this.ds.query(
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
    return this.ds.transaction(async (em) => {
      // is_default uniqueness is enforced by the partial unique index
      // (method) WHERE is_default AND active. We let Postgres raise on
      // conflict and translate it.
      try {
        const [row] = await em.query(
          `INSERT INTO payment_accounts
             (method, provider_key, display_name, identifier, gl_account_code,
              is_default, active, sort_order, metadata, created_by, updated_by)
           VALUES ($1::payment_method_code, $2, $3, $4, $5,
                   COALESCE($6,false), COALESCE($7,true), COALESCE($8,0),
                   COALESCE($9,'{}'::jsonb), $10, $10)
           RETURNING id`,
          [
            dto.method,
            dto.provider_key ?? null,
            dto.display_name,
            dto.identifier ?? null,
            dto.gl_account_code,
            dto.is_default ?? false,
            dto.active ?? true,
            dto.sort_order ?? 0,
            dto.metadata ? JSON.stringify(dto.metadata) : '{}',
            userId,
          ],
        );
        return this.getById(row.id);
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
    if (!fields.length) return this.getById(id);

    args.push(userId);
    fields.push(`updated_by = $${args.length}`);
    args.push(id);

    try {
      await this.ds.query(
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
    return this.getById(id);
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
      return this.getById(id);
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
  } | null> {
    if (!accountId) return null;
    const runner = em ?? this.ds;
    const [row] = await runner.query(
      `SELECT id, method::text AS method, provider_key, display_name,
              identifier, gl_account_code
         FROM payment_accounts WHERE id = $1`,
      [accountId],
    );
    return row ?? null;
  }
}
