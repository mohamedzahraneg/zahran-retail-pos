import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinancialEngineService } from './financial-engine.service';
import { AccountingPostingService } from './posting.service';

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
  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly engine?: FinancialEngineService,
    @Optional() private readonly posting?: AccountingPostingService,
  ) {}

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

    // Phase 2.5: manual-entry posting now flows through the engine.
    // Pre-flight validation (leaf / active / exists) stays here — it
    // produces user-friendly Arabic error messages and guards against
    // the class of mistakes unique to this endpoint (posting to a
    // parent account, etc.). The actual INSERT happens in
    // FinancialEngineService.recordTransaction under the canonical
    // engine:* context, which is silent under fn_engine_write_allowed.
    if (!this.engine) {
      throw new BadRequestException(
        'FinancialEngineService غير متاح — لا يمكن إنشاء قيد يدوي بدون المحرك المحاسبي',
      );
    }

    // post_immediately=false is a legacy draft-only path; the engine
    // always posts (it's atomic — an unposted row is an intermediate
    // state, not a caller-visible return). We refuse the draft mode
    // explicitly rather than silently up-converting it, so any caller
    // relying on drafts hears about the change.
    if (dto.post_immediately === false) {
      throw new BadRequestException(
        'الترحيل المؤجَّل لم يعد مدعوماً — القيد يُرحَّل تلقائياً عند الإنشاء',
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

      // Derive the engine reference. Manual entries accept a caller-
      // supplied reference_type/reference_id; otherwise we mint a
      // deterministic one so the engine's idempotency key stays stable.
      const referenceType = dto.reference_type ?? 'manual';
      const referenceId =
        dto.reference_id ??
        (await em.query(`SELECT gen_random_uuid() AS id`))[0].id;

      const res = await this.engine!.recordTransaction({
        kind: 'manual_adjustment',
        reference_type: referenceType,
        reference_id: referenceId,
        entry_date: dto.entry_date,
        description: dto.description ?? 'قيد يدوي',
        gl_lines: cleaned.map((l) => ({
          account_id: l.account_id,
          debit: l.debit,
          credit: l.credit,
          description: l.description ?? dto.description ?? undefined,
          cashbox_id: l.cashbox_id ?? undefined,
          warehouse_id: l.warehouse_id ?? undefined,
        })),
        // Manual entries do not move physical cash — cashbox dimensions
        // on the lines are for GL reporting only, not for fn_record_cashbox_txn.
        cash_movements: [],
        user_id: userId,
        em,
      });

      if (!res.ok) {
        throw new BadRequestException(
          `فشل ترحيل القيد اليدوي: ${res.error}`,
        );
      }
      return this.fetchFull(em, (res as any).entry_id);
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

  /**
   * Reverse a posted entry — Phase 2.5: delegates to
   * AccountingPostingService.reverseByReference, which now routes the
   * whole operation through the engine (reversing JE with
   * `reversal_of` link + reversed cashbox rows + void of the original).
   *
   * A non-posted draft is still just deleted — no ledger effect to
   * reverse.
   */
  async void(id: string, userId: string, reason: string) {
    if (!reason?.trim()) {
      throw new BadRequestException('سبب الإلغاء مطلوب');
    }
    const [je] = await this.ds.query(
      `SELECT id, entry_no, reference_type, reference_id, is_void, is_posted
         FROM journal_entries WHERE id = $1`,
      [id],
    );
    if (!je) throw new NotFoundException('القيد غير موجود');
    if (je.is_void) {
      throw new BadRequestException('القيد ملغى بالفعل');
    }
    if (!je.is_posted) {
      // Non-posted entries have no ledger effect yet — just delete.
      // The manual-create path no longer allows drafts so in practice
      // this branch only fires for legacy rows created before Phase 2.5.
      await this.ds.query(`DELETE FROM journal_entries WHERE id = $1`, [id]);
      return { deleted: true };
    }

    if (!this.posting) {
      throw new BadRequestException(
        'AccountingPostingService غير متاح — لا يمكن عكس القيد',
      );
    }

    // Reverse via the engine-backed posting service. It re-reads the
    // original entry's lines + paired cashbox rows, swaps them, and
    // hands them to the engine with reversal_of = <this entry's id>.
    return this.ds.transaction(async (em) => {
      const result = await this.posting!.reverseByReference(
        je.reference_type,
        je.reference_id,
        reason,
        userId,
        em,
      );
      if (result && (result as any).error) {
        throw new BadRequestException(
          `فشل عكس القيد: ${(result as any).error}`,
        );
      }
      if (!result || !(result as any).entry_id) {
        throw new NotFoundException('القيد الأصلي غير موجود للعكس');
      }
      return this.fetchFull(em, (result as any).entry_id);
    });
  }
}
