import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface BudgetLineInput {
  account_id: string;
  month: number; // 1..12
  amount: number;
}

export interface CreateBudgetDto {
  name_ar: string;
  fiscal_year: number;
  lines?: BudgetLineInput[];
}

/**
 * Annual budgets + monthly variance (budget vs actual) reporting.
 *
 * Data model:
 *   budgets       — one row per budget version (you can keep last year's
 *                   budget archived alongside this year's)
 *   budget_lines  — one row per (account, month) pair with the budgeted
 *                   amount. Unset months default to zero.
 *
 * Variance = actual − budget. Positive variance on an expense = over
 * budget (bad); positive variance on revenue = beat target (good).
 */
@Injectable()
export class BudgetsService {
  constructor(private readonly ds: DataSource) {}

  async list() {
    // Migration 052 may not be applied yet on legacy installs.
    const [exists] = await this.ds.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_name='budgets') AS present`,
    );
    if (!exists?.present) return [];
    return this.ds.query(
      `
      SELECT b.*, u.full_name AS created_by_name,
             (SELECT COUNT(*)::int FROM budget_lines WHERE budget_id = b.id) AS line_count,
             (SELECT COALESCE(SUM(amount),0)::numeric(14,2) FROM budget_lines WHERE budget_id = b.id) AS total_annual
        FROM budgets b
        LEFT JOIN users u ON u.id = b.created_by
       ORDER BY b.is_active DESC, b.fiscal_year DESC, b.created_at DESC
      `,
    );
  }

  async get(id: string) {
    const [b] = await this.ds.query(`SELECT * FROM budgets WHERE id = $1`, [
      id,
    ]);
    if (!b) throw new NotFoundException('الموازنة غير موجودة');
    const lines = await this.ds.query(
      `
      SELECT bl.*, a.code AS account_code, a.name_ar AS account_name,
             a.account_type
        FROM budget_lines bl
        JOIN chart_of_accounts a ON a.id = bl.account_id
       WHERE bl.budget_id = $1
       ORDER BY a.code, bl.month
      `,
      [id],
    );
    return { ...b, lines };
  }

  async create(dto: CreateBudgetDto, userId: string) {
    if (!dto.name_ar?.trim()) throw new BadRequestException('اسم الموازنة مطلوب');
    if (!(dto.fiscal_year > 2000 && dto.fiscal_year < 2100)) {
      throw new BadRequestException('سنة مالية غير صحيحة');
    }
    return this.ds.transaction(async (em) => {
      const [b] = await em.query(
        `INSERT INTO budgets (name_ar, fiscal_year, created_by)
         VALUES ($1, $2, $3) RETURNING *`,
        [dto.name_ar.trim(), dto.fiscal_year, userId],
      );
      if (dto.lines?.length) {
        for (const l of dto.lines) {
          if (l.month < 1 || l.month > 12) continue;
          await em.query(
            `INSERT INTO budget_lines (budget_id, account_id, month, amount)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (budget_id, account_id, month)
             DO UPDATE SET amount = EXCLUDED.amount`,
            [b.id, l.account_id, l.month, Number(l.amount) || 0],
          );
        }
      }
      return this.get(b.id);
    });
  }

  async update(
    id: string,
    dto: { name_ar?: string; is_active?: boolean; lines?: BudgetLineInput[] },
  ) {
    return this.ds.transaction(async (em) => {
      const [b] = await em.query(`SELECT id FROM budgets WHERE id = $1`, [id]);
      if (!b) throw new NotFoundException('الموازنة غير موجودة');
      const sets: string[] = [];
      const args: any[] = [];
      if (dto.name_ar !== undefined) {
        args.push(dto.name_ar);
        sets.push(`name_ar = $${args.length}`);
      }
      if (dto.is_active !== undefined) {
        args.push(dto.is_active);
        sets.push(`is_active = $${args.length}`);
      }
      if (sets.length) {
        sets.push('updated_at = NOW()');
        args.push(id);
        await em.query(
          `UPDATE budgets SET ${sets.join(', ')} WHERE id = $${args.length}`,
          args,
        );
      }
      if (dto.lines) {
        for (const l of dto.lines) {
          if (l.month < 1 || l.month > 12) continue;
          await em.query(
            `INSERT INTO budget_lines (budget_id, account_id, month, amount)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (budget_id, account_id, month)
             DO UPDATE SET amount = EXCLUDED.amount`,
            [id, l.account_id, l.month, Number(l.amount) || 0],
          );
        }
      }
      return this.get(id);
    });
  }

  async removeLine(budgetId: string, lineId: string) {
    await this.ds.query(
      `DELETE FROM budget_lines WHERE id = $1 AND budget_id = $2`,
      [lineId, budgetId],
    );
    return { deleted: true };
  }

  async remove(id: string) {
    await this.ds.query(`DELETE FROM budgets WHERE id = $1`, [id]);
    return { deleted: true };
  }

  /**
   * Variance report — budget vs actual per account per month for a
   * given fiscal year. Actual is summed from posted, non-void journal
   * entries on leaf accounts.
   */
  async variance(budgetId: string, opts: { cost_center_id?: string } = {}) {
    const [b] = await this.ds.query(`SELECT * FROM budgets WHERE id = $1`, [
      budgetId,
    ]);
    if (!b) throw new NotFoundException('الموازنة غير موجودة');
    const fy = Number(b.fiscal_year);

    // Fetch budget lines.
    const lines = await this.ds.query(
      `
      SELECT bl.account_id, bl.month, bl.amount,
             a.code, a.name_ar, a.account_type, a.normal_balance
        FROM budget_lines bl
        JOIN chart_of_accounts a ON a.id = bl.account_id
       WHERE bl.budget_id = $1
       ORDER BY a.code, bl.month
      `,
      [budgetId],
    );

    // Fetch actuals by (account, month) for the fiscal year.
    const ccCond = opts.cost_center_id ? `AND jl.cost_center_id = $3` : '';
    const ccArgs = opts.cost_center_id ? [opts.cost_center_id] : [];
    const actuals = await this.ds.query(
      `
      SELECT jl.account_id,
             EXTRACT(MONTH FROM je.entry_date)::int AS month,
             CASE a.normal_balance
               WHEN 'debit' THEN COALESCE(SUM(jl.debit - jl.credit), 0)
               ELSE              COALESCE(SUM(jl.credit - jl.debit), 0)
             END::numeric(14,2) AS actual
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN chart_of_accounts a ON a.id = jl.account_id
       WHERE je.is_posted = TRUE AND je.is_void = FALSE
         AND EXTRACT(YEAR FROM je.entry_date)::int = $1
         AND jl.account_id = ANY($2::uuid[])
         ${ccCond}
       GROUP BY jl.account_id, EXTRACT(MONTH FROM je.entry_date), a.normal_balance
      `,
      [
        fy,
        [...new Set(lines.map((l: any) => l.account_id))],
        ...ccArgs,
      ],
    );
    // Build {account_id -> {month -> actual}}
    const actualMap: Record<string, Record<number, number>> = {};
    for (const a of actuals) {
      (actualMap[a.account_id] ||= {})[Number(a.month)] = Number(a.actual);
    }

    // Group by account, roll up per month + annual.
    const byAccount: Record<string, any> = {};
    for (const l of lines) {
      const key = l.account_id;
      if (!byAccount[key]) {
        byAccount[key] = {
          account_id: l.account_id,
          code: l.code,
          name_ar: l.name_ar,
          account_type: l.account_type,
          months: {} as Record<number, { budget: number; actual: number }>,
          budget_total: 0,
          actual_total: 0,
        };
      }
      const bud = Number(l.amount);
      const act = actualMap[key]?.[l.month] ?? 0;
      byAccount[key].months[l.month] = { budget: bud, actual: act };
      byAccount[key].budget_total += bud;
      byAccount[key].actual_total += act;
    }
    const rows = Object.values(byAccount).map((r: any) => {
      const variance = r.actual_total - r.budget_total;
      const pct =
        r.budget_total > 0 ? (variance / r.budget_total) * 100 : null;
      return {
        ...r,
        variance: Number(variance.toFixed(2)),
        variance_pct: pct !== null ? Number(pct.toFixed(2)) : null,
      };
    });

    const totals = rows.reduce(
      (acc: any, r: any) => {
        acc.budget += r.budget_total;
        acc.actual += r.actual_total;
        return acc;
      },
      { budget: 0, actual: 0 },
    );

    return {
      budget: b,
      cost_center_id: opts.cost_center_id || null,
      rows,
      totals: {
        budget: Number(totals.budget.toFixed(2)),
        actual: Number(totals.actual.toFixed(2)),
        variance: Number((totals.actual - totals.budget).toFixed(2)),
      },
    };
  }
}
