import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface JournalLineInput {
  account_id: string;
  debit?: number;
  credit?: number;
  description?: string;
  cashbox_id?: string | null;
  warehouse_id?: string | null;
}

export interface CreateJournalEntryDto {
  entry_date: string; // YYYY-MM-DD
  description?: string;
  reference_type?: string;
  reference_id?: string;
  lines: JournalLineInput[];
  post_immediately?: boolean; // default true
}

/**
 * Manual journal entries + automatic posting API for the rest of the app.
 *
 * Key invariants:
 *   - every entry has ≥ 2 lines
 *   - Σ debits = Σ credits (enforced both in JS and via the DB trigger
 *     on is_posted)
 *   - each line is strictly debit XOR credit (DB CHECK constraint)
 *   - posting into a non-leaf account is rejected
 *   - posting into an inactive account is rejected
 *   - void = create a reversing entry with swapped dr/cr, link via
 *     reversal_of, flag the original is_void = TRUE
 */
@Injectable()
export class JournalService {
  constructor(private readonly ds: DataSource) {}

  async create(dto: CreateJournalEntryDto, userId: string) {
    if (!dto.entry_date || !/^\d{4}-\d{2}-\d{2}$/.test(dto.entry_date)) {
      throw new BadRequestException('تاريخ القيد مطلوب بصيغة YYYY-MM-DD');
    }
    if (!Array.isArray(dto.lines) || dto.lines.length < 2) {
      throw new BadRequestException('القيد يحتاج سطرين على الأقل');
    }

    // Normalize + validate each line.
    let totalDebit = 0;
    let totalCredit = 0;
    const cleaned = dto.lines.map((l, i) => {
      const d = Number(l.debit || 0);
      const c = Number(l.credit || 0);
      if ((d > 0 && c > 0) || (d === 0 && c === 0)) {
        throw new BadRequestException(
          `السطر رقم ${i + 1}: يجب أن يكون مدين أو دائن فقط`,
        );
      }
      if (d < 0 || c < 0) {
        throw new BadRequestException(
          `السطر رقم ${i + 1}: القيم السالبة غير مسموح بها`,
        );
      }
      if (!l.account_id) {
        throw new BadRequestException(`السطر رقم ${i + 1}: الحساب مطلوب`);
      }
      totalDebit += d;
      totalCredit += c;
      return {
        account_id: l.account_id,
        debit: d,
        credit: c,
        description: l.description ?? null,
        cashbox_id: l.cashbox_id ?? null,
        warehouse_id: l.warehouse_id ?? null,
      };
    });
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw new BadRequestException(
        `قيد غير متوازن: المدين ${totalDebit} ≠ الدائن ${totalCredit}`,
      );
    }

    return this.ds.transaction(async (em) => {
      // Validate every referenced account — must exist, be active, be a leaf.
      const ids = Array.from(new Set(cleaned.map((l) => l.account_id)));
      const accounts = await em.query(
        `SELECT id, is_leaf, is_active, name_ar
           FROM chart_of_accounts
          WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      if (accounts.length !== ids.length) {
        throw new NotFoundException('أحد الحسابات غير موجود');
      }
      for (const a of accounts) {
        if (!a.is_active) {
          throw new BadRequestException(`حساب معطّل: ${a.name_ar}`);
        }
        if (!a.is_leaf) {
          throw new BadRequestException(
            `لا يمكن الترحيل على حساب مجمَّع: ${a.name_ar}`,
          );
        }
      }

      const [{ seq }] = await em.query(
        `SELECT nextval('seq_journal_entry_no') AS seq`,
      );
      const year = dto.entry_date.slice(0, 4);
      const entryNo = `JE-${year}-${String(seq).padStart(6, '0')}`;

      // Manual-entry endpoint — raise engine-context so migration 058
      // lets us INSERT. This is a legitimate admin-only path (POST
      // /accounts/journal) where the user supplies a balanced entry
      // by hand. The balance trigger fn_je_enforce_balance still
      // validates before the entry gets marked posted.
      await em.query(`SET LOCAL app.engine_context = 'on'`);

      const [entry] = await em.query(
        `
        INSERT INTO journal_entries
          (entry_no, entry_date, description, reference_type, reference_id, created_by)
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING *
        `,
        [
          entryNo,
          dto.entry_date,
          dto.description ?? null,
          dto.reference_type ?? 'manual',
          dto.reference_id ?? null,
          userId,
        ],
      );

      // Lines
      let n = 1;
      for (const l of cleaned) {
        await em.query(
          `
          INSERT INTO journal_lines
            (entry_id, line_no, account_id, debit, credit, description,
             cashbox_id, warehouse_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          `,
          [
            entry.id,
            n++,
            l.account_id,
            l.debit,
            l.credit,
            l.description,
            l.cashbox_id,
            l.warehouse_id,
          ],
        );
      }

      // Post immediately unless explicitly deferred.
      const shouldPost = dto.post_immediately !== false;
      if (shouldPost) {
        await em.query(
          `UPDATE journal_entries SET is_posted = TRUE, posted_by = $2, posted_at = NOW()
             WHERE id = $1`,
          [entry.id, userId],
        );
      }

      return this.fetchFull(em, entry.id);
    });
  }

  /** List entries with filters. Lightweight — lines fetched on demand via get(). */
  list(params: {
    from?: string;
    to?: string;
    is_posted?: boolean;
    is_void?: boolean;
    reference_type?: string;
    account_id?: string;
    limit?: number;
    offset?: number;
  }) {
    const conds: string[] = [];
    const args: any[] = [];
    if (params.from) {
      args.push(params.from);
      conds.push(`je.entry_date >= $${args.length}::date`);
    }
    if (params.to) {
      args.push(params.to);
      conds.push(`je.entry_date <= $${args.length}::date`);
    }
    if (params.is_posted !== undefined) {
      args.push(params.is_posted);
      conds.push(`je.is_posted = $${args.length}`);
    }
    if (params.is_void !== undefined) {
      args.push(params.is_void);
      conds.push(`je.is_void = $${args.length}`);
    }
    if (params.reference_type) {
      args.push(params.reference_type);
      conds.push(`je.reference_type = $${args.length}`);
    }
    if (params.account_id) {
      args.push(params.account_id);
      conds.push(
        `EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.entry_id = je.id AND jl.account_id = $${args.length})`,
      );
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    args.push(Math.min(Number(params.limit ?? 100), 500));
    args.push(Math.max(Number(params.offset ?? 0), 0));
    return this.ds.query(
      `
      SELECT je.id, je.entry_no, je.entry_date, je.description, je.reference_type,
             je.reference_id, je.is_posted, je.is_void, je.posted_at, je.voided_at,
             (SELECT COALESCE(SUM(debit), 0) FROM journal_lines jl WHERE jl.entry_id = je.id)::numeric(14,2) AS total_debit,
             (SELECT COALESCE(SUM(credit),0) FROM journal_lines jl WHERE jl.entry_id = je.id)::numeric(14,2) AS total_credit,
             u.full_name AS created_by_name
        FROM journal_entries je
        LEFT JOIN users u ON u.id = je.created_by
        ${where}
       ORDER BY je.entry_date DESC, je.entry_no DESC
       LIMIT $${args.length - 1} OFFSET $${args.length}
      `,
      args,
    );
  }

  async get(id: string) {
    return this.fetchFull(this.ds, id);
  }

  private async fetchFull(em: { query: any }, id: string) {
    const [entry] = await em.query(
      `
      SELECT je.*, u.full_name AS created_by_name,
             up.full_name      AS posted_by_name,
             uv.full_name      AS voided_by_name
        FROM journal_entries je
        LEFT JOIN users u  ON u.id  = je.created_by
        LEFT JOIN users up ON up.id = je.posted_by
        LEFT JOIN users uv ON uv.id = je.voided_by
       WHERE je.id = $1
      `,
      [id],
    );
    if (!entry) throw new NotFoundException('القيد غير موجود');
    const lines = await em.query(
      `
      SELECT jl.*, a.code AS account_code, a.name_ar AS account_name,
             cb.name_ar AS cashbox_name, w.name_ar AS warehouse_name
        FROM journal_lines jl
        LEFT JOIN chart_of_accounts a ON a.id = jl.account_id
        LEFT JOIN cashboxes cb        ON cb.id = jl.cashbox_id
        LEFT JOIN warehouses w        ON w.id = jl.warehouse_id
       WHERE jl.entry_id = $1
       ORDER BY jl.line_no
      `,
      [id],
    );
    return { ...entry, lines };
  }

  /** Reverse a posted entry with a new offsetting entry. */
  async void(id: string, userId: string, reason: string) {
    if (!reason?.trim()) {
      throw new BadRequestException('سبب الإلغاء مطلوب');
    }
    const [je] = await this.ds.query(
      `SELECT * FROM journal_entries WHERE id = $1`,
      [id],
    );
    if (!je) throw new NotFoundException('القيد غير موجود');
    if (je.is_void) {
      throw new BadRequestException('القيد ملغى بالفعل');
    }
    if (!je.is_posted) {
      // Non-posted entries can just be deleted.
      await this.ds.query(`DELETE FROM journal_entries WHERE id = $1`, [id]);
      return { deleted: true };
    }
    const lines = await this.ds.query(
      `SELECT * FROM journal_lines WHERE entry_id = $1 ORDER BY line_no`,
      [id],
    );

    return this.ds.transaction(async (em) => {
      // Raise engine-context so migration 058 lets us void + create
      // the reversing entry. Same rationale as createJournal above.
      await em.query(`SET LOCAL app.engine_context = 'on'`);

      // Mark original as void.
      await em.query(
        `UPDATE journal_entries
            SET is_void = TRUE, void_reason = $2,
                voided_by = $3, voided_at = NOW()
          WHERE id = $1`,
        [id, reason, userId],
      );

      // Create the reversing entry with dr/cr swapped.
      const [{ seq }] = await em.query(
        `SELECT nextval('seq_journal_entry_no') AS seq`,
      );
      const year = new Date().toISOString().slice(0, 4);
      const revNo = `JE-${year}-${String(seq).padStart(6, '0')}`;
      const [rev] = await em.query(
        `
        INSERT INTO journal_entries
          (entry_no, entry_date, description, reference_type, reference_id,
           reversal_of, is_posted, posted_by, posted_at, created_by)
        VALUES ($1,(now() AT TIME ZONE 'Africa/Cairo')::date,
                $2, 'reversal', $3, $3, TRUE, $4, NOW(), $4)
        RETURNING *
        `,
        [revNo, `عكس قيد ${je.entry_no}: ${reason}`, id, userId],
      );
      let n = 1;
      for (const l of lines) {
        await em.query(
          `
          INSERT INTO journal_lines
            (entry_id, line_no, account_id, debit, credit, description,
             cashbox_id, warehouse_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          `,
          [
            rev.id,
            n++,
            l.account_id,
            Number(l.credit) || 0, // swap
            Number(l.debit) || 0, // swap
            l.description,
            l.cashbox_id,
            l.warehouse_id,
          ],
        );
      }
      return this.fetchFull(em, rev.id);
    });
  }
}
