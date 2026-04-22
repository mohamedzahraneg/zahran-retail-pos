import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

export type Frequency =
  | 'daily'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual'
  | 'custom_days';

export interface CreateRecurringExpenseDto {
  code: string;
  name_ar: string;
  name_en?: string;
  category_id: string;
  warehouse_id: string;
  cashbox_id?: string;
  amount: number;
  payment_method?: string;
  vendor_name?: string;
  description?: string;
  frequency: Frequency;
  custom_interval_days?: number;
  day_of_month?: number;
  start_date: string;
  end_date?: string;
  auto_post?: boolean;
  auto_paid?: boolean;
  notify_days_before?: number;
  require_approval?: boolean;
}

export interface UpdateRecurringExpenseDto extends Partial<CreateRecurringExpenseDto> {
  status?: 'active' | 'paused' | 'ended';
}

@Injectable()
export class RecurringExpensesService {
  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly posting?: AccountingPostingService,
    @Optional() private readonly engine?: FinancialEngineService,
  ) {}

  async list(opts: {
    status?: string;
    warehouse_id?: string;
    due_only?: boolean;
  } = {}) {
    const params: any[] = [];
    const where: string[] = [];
    if (opts.status) {
      params.push(opts.status);
      where.push(`re.status = $${params.length}`);
    } else {
      where.push(`re.status <> 'ended'`);
    }
    if (opts.warehouse_id) {
      params.push(opts.warehouse_id);
      where.push(`re.warehouse_id = $${params.length}`);
    }
    if (opts.due_only) {
      where.push(`re.next_run_date <= CURRENT_DATE + (re.notify_days_before || ' days')::INTERVAL`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.ds.query(
      `
      SELECT re.*,
             ec.name_ar AS category_name,
             ec.code    AS category_code,
             w.name     AS warehouse_name,
             (CURRENT_DATE - re.next_run_date) AS days_overdue,
             CASE
               WHEN re.next_run_date <= CURRENT_DATE THEN 'due'
               WHEN re.next_run_date <= CURRENT_DATE + (re.notify_days_before || ' days')::INTERVAL THEN 'upcoming'
               ELSE 'scheduled'
             END AS due_status
      FROM recurring_expenses re
      JOIN expense_categories ec ON ec.id = re.category_id
      JOIN warehouses w          ON w.id  = re.warehouse_id
      ${whereSql}
      ORDER BY re.next_run_date ASC NULLS LAST
      `,
      params,
    );
  }

  async get(id: string) {
    const [r] = await this.ds.query(
      `SELECT * FROM recurring_expenses WHERE id = $1`,
      [id],
    );
    if (!r) throw new NotFoundException('Recurring expense not found');
    const runs = await this.ds.query(
      `SELECT r.*, e.expense_no, e.is_approved
       FROM recurring_expense_runs r
       LEFT JOIN expenses e ON e.id = r.expense_id
       WHERE r.recurring_id = $1
       ORDER BY r.scheduled_for DESC
       LIMIT 50`,
      [id],
    );
    return { ...r, runs };
  }

  async create(dto: CreateRecurringExpenseDto, userId: string) {
    this.validateDto(dto);
    const [r] = await this.ds.query(
      `
      INSERT INTO recurring_expenses
        (code, name_ar, name_en, category_id, warehouse_id, cashbox_id,
         amount, payment_method, vendor_name, description,
         frequency, custom_interval_days, day_of_month,
         start_date, end_date, next_run_date,
         auto_post, auto_paid, notify_days_before, require_approval, created_by)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$14,$16,$17,$18,$19,$20)
      RETURNING *
      `,
      [
        dto.code,
        dto.name_ar,
        dto.name_en || null,
        dto.category_id,
        dto.warehouse_id,
        dto.cashbox_id || null,
        dto.amount,
        dto.payment_method || 'cash',
        dto.vendor_name || null,
        dto.description || null,
        dto.frequency,
        dto.custom_interval_days || null,
        dto.day_of_month || null,
        dto.start_date,
        dto.end_date || null,
        dto.auto_post ?? true,
        dto.auto_paid ?? false,
        dto.notify_days_before ?? 3,
        dto.require_approval ?? false,
        userId,
      ],
    );
    return r;
  }

  async update(id: string, dto: UpdateRecurringExpenseDto) {
    const [cur] = await this.ds.query(
      `SELECT * FROM recurring_expenses WHERE id = $1`,
      [id],
    );
    if (!cur) throw new NotFoundException('not found');

    const fields: string[] = [];
    const vals: any[] = [id];
    const push = (col: string, val: any) => {
      if (val === undefined) return;
      vals.push(val);
      fields.push(`${col} = $${vals.length}`);
    };
    push('code', dto.code);
    push('name_ar', dto.name_ar);
    push('name_en', dto.name_en);
    push('category_id', dto.category_id);
    push('warehouse_id', dto.warehouse_id);
    push('cashbox_id', dto.cashbox_id);
    push('amount', dto.amount);
    push('payment_method', dto.payment_method);
    push('vendor_name', dto.vendor_name);
    push('description', dto.description);
    push('frequency', dto.frequency);
    push('custom_interval_days', dto.custom_interval_days);
    push('day_of_month', dto.day_of_month);
    push('start_date', dto.start_date);
    push('end_date', dto.end_date);
    push('auto_post', dto.auto_post);
    push('auto_paid', dto.auto_paid);
    push('notify_days_before', dto.notify_days_before);
    push('require_approval', dto.require_approval);
    push('status', dto.status);

    if (fields.length === 0) return cur;

    const [r] = await this.ds.query(
      `UPDATE recurring_expenses SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      vals,
    );
    return r;
  }

  async remove(id: string) {
    await this.ds.query(
      `UPDATE recurring_expenses SET status = 'ended', updated_at = NOW()
       WHERE id = $1`,
      [id],
    );
    return { success: true };
  }

  async pause(id: string) {
    return this.update(id, { status: 'paused' });
  }
  async resume(id: string) {
    return this.update(id, { status: 'active' });
  }

  /**
   * Generate expenses for a single recurring_expense if it's due.
   * If dryRun=true, returns what would happen without writing to DB.
   */
  async runOne(id: string, userId: string, opts: { dryRun?: boolean } = {}) {
    const [tpl] = await this.ds.query(
      `SELECT * FROM recurring_expenses WHERE id = $1`,
      [id],
    );
    if (!tpl) throw new NotFoundException('not found');
    if (tpl.status !== 'active') {
      throw new BadRequestException(`لا يمكن توليد مصروف لقالب ${tpl.status}`);
    }

    const today = new Date().toISOString().slice(0, 10);
    if (tpl.next_run_date > today) {
      return { generated: false, reason: 'not yet due', next_run_date: tpl.next_run_date };
    }
    if (tpl.end_date && tpl.end_date < today) {
      await this.ds.query(
        `UPDATE recurring_expenses SET status = 'ended' WHERE id = $1`,
        [id],
      );
      return { generated: false, reason: 'past end_date' };
    }

    if (opts.dryRun) {
      return { generated: false, reason: 'dry-run', would_generate_for: tpl.next_run_date };
    }

    // Single transaction: create expense + run log + advance next_run_date
    const result = await this.ds.transaction(async (em) => {
      const scheduledFor = tpl.next_run_date;
      const [catRow] = await em.query(
        `SELECT code FROM expense_categories WHERE id = $1`,
        [tpl.category_id],
      );
      const catCode = catRow?.code || 'GEN';
      const seqNo = `EXP-${new Date().getFullYear()}-${String(Date.now()).slice(-8)}`;

      let expenseId: string | null = null;
      try {
        const [exp] = await em.query(
          `
          INSERT INTO expenses
            (expense_no, warehouse_id, cashbox_id, category_id, amount,
             payment_method, expense_date, description, vendor_name,
             created_by, approved_by, is_approved)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          RETURNING id
          `,
          [
            seqNo,
            tpl.warehouse_id,
            tpl.cashbox_id,
            tpl.category_id,
            tpl.amount,
            tpl.payment_method,
            scheduledFor,
            `${tpl.name_ar} — ${scheduledFor}${tpl.description ? `\n${tpl.description}` : ''}`,
            tpl.vendor_name,
            userId,
            tpl.auto_post ? userId : null,
            tpl.auto_post && !tpl.require_approval,
          ],
        );
        expenseId = exp.id;

        // NOTE: Cash movement is no longer written here. When the
        // recurring template is auto-posted (auto_post=true AND
        // require_approval=false) we route through FinancialEngineService
        // below — it handles cash + GL atomically and idempotently. This
        // eliminates the direct `UPDATE cashboxes` + paired `INSERT
        // cashbox_transactions` pattern, keeping the engine as the
        // single writer of cashbox state.

        await em.query(
          `
          INSERT INTO recurring_expense_runs
            (recurring_id, expense_id, scheduled_for, amount, status, user_id)
          VALUES ($1,$2,$3,$4,'generated',$5)
          `,
          [tpl.id, expenseId, scheduledFor, tpl.amount, userId],
        );
      } catch (err: any) {
        await em.query(
          `
          INSERT INTO recurring_expense_runs
            (recurring_id, expense_id, scheduled_for, amount, status, error_message, user_id)
          VALUES ($1, NULL, $2, $3, 'failed', $4, $5)
          `,
          [tpl.id, scheduledFor, tpl.amount, err.message, userId],
        );
        await em.query(
          `UPDATE recurring_expenses SET last_error = $2, updated_at = NOW() WHERE id = $1`,
          [tpl.id, err.message],
        );
        throw err;
      }

      // advance next_run_date
      const [{ next_d }] = await em.query(
        `SELECT fn_recurring_next_run($1::recurrence_frequency, $2::date, $3::int, $4::int) AS next_d`,
        [tpl.frequency, scheduledFor, tpl.day_of_month, tpl.custom_interval_days],
      );

      await em.query(
        `UPDATE recurring_expenses SET
           last_run_date = $2, next_run_date = $3,
           runs_count = runs_count + 1, last_error = NULL,
           updated_at = NOW()
         WHERE id = $1`,
        [tpl.id, scheduledFor, next_d],
      );

      // Post through the engine when the template is auto-approved.
      // This is the ONE place that moves cash + writes the GL entry
      // for auto-paid recurring expenses. If require_approval=TRUE the
      // expense waits in the approval inbox and ExpenseApprovalService.
      // decide() will eventually drive the same engine call.
      if (expenseId && tpl.auto_post && !tpl.require_approval) {
        const [catRow2] = await em.query(
          `SELECT account_id FROM expense_categories WHERE id = $1`,
          [tpl.category_id],
        );
        if (this.engine) {
          const res = await this.engine.recordExpense({
            expense_id: expenseId,
            expense_no: seqNo,
            amount: Number(tpl.amount),
            category_account_id: catRow2?.account_id ?? null,
            cashbox_id:
              tpl.auto_paid && tpl.payment_method === 'cash'
                ? tpl.cashbox_id
                : null,
            payment_method: tpl.payment_method ?? 'cash',
            user_id: userId,
            entry_date: scheduledFor,
            em,
            description: `مصروف دوري: ${tpl.name_ar}`,
          });
          if (!res.ok) {
            throw new Error(
              `فشل ترحيل المصروف الدوري: ${res.error}`,
            );
          }
        } else if (this.posting) {
          // Legacy fallback — no engine wired.
          await this.posting
            .postExpense(expenseId, userId, em)
            .catch(() => undefined);
        }
      }

      return { generated: true, expense_id: expenseId, next_run_date: next_d };
    });

    return result;
  }

  /**
   * Scheduler entry point — processes all due templates.
   * Designed to be called by a cron job or admin button.
   */
  async processDue(opts: { userId: string; limit?: number } = {} as any) {
    const limit = opts.limit ?? 100;
    const due = await this.ds.query(
      `
      SELECT id FROM recurring_expenses
      WHERE status = 'active'
        AND next_run_date <= CURRENT_DATE
        AND (end_date IS NULL OR end_date >= CURRENT_DATE)
      ORDER BY next_run_date ASC
      LIMIT $1
      `,
      [limit],
    );
    let ok = 0;
    let failed = 0;
    const results: any[] = [];
    for (const row of due) {
      try {
        const r = await this.runOne(row.id, opts.userId);
        results.push({ id: row.id, ...r });
        if (r.generated) ok++;
      } catch (e: any) {
        failed++;
        results.push({ id: row.id, error: e.message });
      }
    }
    return { total: due.length, ok, failed, results };
  }

  async stats() {
    const [row] = await this.ds.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active')                              AS active_templates,
        COUNT(*) FILTER (WHERE status = 'paused')                              AS paused_templates,
        COUNT(*) FILTER (WHERE next_run_date <= CURRENT_DATE AND status = 'active') AS due_now,
        COUNT(*) FILTER (WHERE next_run_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
                          AND status = 'active')                              AS due_next_7_days,
        COALESCE(SUM(amount) FILTER (WHERE status = 'active'), 0)              AS monthly_commitment_estimate,
        COALESCE(SUM(amount) FILTER (WHERE next_run_date <= CURRENT_DATE AND status = 'active'), 0) AS due_amount
      FROM recurring_expenses
    `);
    return row;
  }

  private validateDto(dto: CreateRecurringExpenseDto) {
    if (!dto.code || !dto.name_ar) throw new BadRequestException('code + name_ar مطلوبان');
    if (dto.amount < 0) throw new BadRequestException('amount must be ≥ 0');
    if (dto.frequency === 'custom_days' && !dto.custom_interval_days) {
      throw new BadRequestException('custom_days frequency requires custom_interval_days');
    }
    if (dto.day_of_month != null && (dto.day_of_month < 1 || dto.day_of_month > 31)) {
      throw new BadRequestException('day_of_month must be 1..31');
    }
  }
}
