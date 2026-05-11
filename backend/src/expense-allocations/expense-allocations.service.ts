import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * ExpenseAllocationsService — PR-PHASE2-B1 (read-only foundation).
 *
 * Provides ONLY the read paths for the operational-expense allocation
 * overlay introduced by migration 132.  Write paths (create / approve /
 * reverse / compute / lines mutate) land in subsequent PRs.
 *
 * Hard constraints (verified by source-grep tests):
 *   * No INSERT / UPDATE / DELETE on expenses / journal_entries /
 *     journal_lines / cashbox_transactions / stock_movements /
 *     product_variants / invoice_items / invoices.
 *   * No FinancialEngine import or call.
 *   * No `accounting_only` escape.
 *   * No touch of backend/src/provisioning.
 *   * All SQL is SELECT-only.
 */
@Injectable()
export class ExpenseAllocationsService {
  constructor(private readonly ds: DataSource) {}

  // ─── Periods ────────────────────────────────────────────────────

  /**
   * List allocation periods.
   *
   * @param filters.from         Inclusive lower bound on period_start
   * @param filters.to           Inclusive upper bound on period_end
   * @param filters.status       'draft' | 'approved' | 'reversed'
   * @param filters.warehouse_id Restrict to a specific warehouse
   *
   * Empty result is returned cleanly when no rows match — no exception,
   * no special-case shape.
   */
  async listPeriods(filters: {
    from?: string;
    to?: string;
    status?: string;
    warehouse_id?: string;
  } = {}) {
    const params: any[] = [];
    const where: string[] = [];
    if (filters.from) {
      params.push(filters.from);
      where.push(`p.period_end >= $${params.length}::date`);
    }
    if (filters.to) {
      params.push(filters.to);
      where.push(`p.period_start <= $${params.length}::date`);
    }
    if (filters.status) {
      if (!['draft', 'approved', 'reversed'].includes(filters.status)) {
        throw new BadRequestException('حالة غير صالحة.');
      }
      params.push(filters.status);
      where.push(`p.status = $${params.length}::expense_allocation_period_status`);
    }
    if (filters.warehouse_id) {
      params.push(filters.warehouse_id);
      where.push(`p.warehouse_id = $${params.length}::uuid`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    return this.ds.query(
      `
      SELECT
        p.id,
        p.period_start,
        p.period_end,
        p.warehouse_id,
        w.name_ar             AS warehouse_name,
        p.status,
        p.total_allocated,
        p.notes,
        p.created_by,
        cu.full_name          AS created_by_name,
        p.approved_by,
        au.full_name          AS approved_by_name,
        p.approved_at,
        p.reversed_by,
        ru.full_name          AS reversed_by_name,
        p.reversed_at,
        p.reversed_reason,
        p.created_at,
        p.updated_at,
        (SELECT COUNT(*) FROM expense_allocation_lines l WHERE l.period_id = p.id) AS lines_count
      FROM expense_allocation_periods p
      LEFT JOIN warehouses w ON w.id = p.warehouse_id
      LEFT JOIN users     cu ON cu.id = p.created_by
      LEFT JOIN users     au ON au.id = p.approved_by
      LEFT JOIN users     ru ON ru.id = p.reversed_by
      ${whereSql}
      ORDER BY p.period_start DESC, p.created_at DESC
      LIMIT 500
      `,
      params,
    );
  }

  /**
   * Fetch a single period with its lines.  Returns `{...periodFields, lines: [...]}`.
   * Throws NotFoundException when the id doesn't exist.
   */
  async getPeriod(id: string) {
    const [period] = await this.ds.query(
      `
      SELECT
        p.id,
        p.period_start,
        p.period_end,
        p.warehouse_id,
        w.name_ar             AS warehouse_name,
        p.status,
        p.total_allocated,
        p.notes,
        p.created_by,
        cu.full_name          AS created_by_name,
        p.approved_by,
        au.full_name          AS approved_by_name,
        p.approved_at,
        p.reversed_by,
        ru.full_name          AS reversed_by_name,
        p.reversed_at,
        p.reversed_reason,
        p.created_at,
        p.updated_at
      FROM expense_allocation_periods p
      LEFT JOIN warehouses w ON w.id = p.warehouse_id
      LEFT JOIN users     cu ON cu.id = p.created_by
      LEFT JOIN users     au ON au.id = p.approved_by
      LEFT JOIN users     ru ON ru.id = p.reversed_by
      WHERE p.id = $1
      `,
      [id],
    );
    if (!period) throw new NotFoundException('فترة التوزيع غير موجودة.');

    const lines = await this.ds.query(
      `
      SELECT
        l.id,
        l.period_id,
        l.expense_id,
        e.expense_no                                                AS expense_no,
        l.expense_category_id,
        ec.code                                                     AS expense_category_code,
        ec.name_ar                                                  AS expense_category_name,
        l.source_amount,
        l.product_id,
        pr.name_ar                                                  AS product_name,
        l.product_category_id,
        c.name_ar                                                   AS product_category_name,
        l.warehouse_id,
        w.name_ar                                                   AS target_warehouse_name,
        l.allocation_method,
        l.allocated_amount,
        l.weight_basis_value,
        l.weight_basis_total,
        l.created_at
      FROM expense_allocation_lines l
      LEFT JOIN expenses           e  ON e.id  = l.expense_id
      LEFT JOIN expense_categories ec ON ec.id = l.expense_category_id
      LEFT JOIN products           pr ON pr.id = l.product_id
      LEFT JOIN categories         c  ON c.id  = l.product_category_id
      LEFT JOIN warehouses         w  ON w.id  = l.warehouse_id
      WHERE l.period_id = $1
      ORDER BY l.created_at ASC
      `,
      [id],
    );

    return { ...period, lines };
  }

  // ─── Reports ────────────────────────────────────────────────────

  /**
   * Product profit with overhead allocated from approved periods.
   *
   * Reads the base view `v_product_profit_with_overhead` (which already
   * folds in approved-only overhead).  When `from`/`to` are supplied, we
   * wrap a date-scoped aggregation over `expense_allocation_lines` so
   * the overhead reflects only periods whose dates fall inside the
   * requested window; otherwise we use the base view's all-time number.
   *
   * @param filters.from         Optional inclusive date filter
   * @param filters.to           Optional inclusive date filter
   * @param filters.warehouse_id Reserved for future use; currently
   *                              ignored because v_product_profit
   *                              aggregates across all warehouses.
   *                              Passing it is accepted for forward
   *                              compatibility but has no effect today.
   */
  async profitWithOverhead(filters: {
    from?: string;
    to?: string;
    warehouse_id?: string;
  } = {}) {
    const params: any[] = [];
    let overheadSubquery: string;

    if (filters.from && filters.to) {
      // Date-scoped overhead: only approved periods whose date range
      // intersects the requested window contribute.
      params.push(filters.from, filters.to);
      overheadSubquery = `
        SELECT
          l.product_id,
          SUM(l.allocated_amount) AS overhead_allocated
        FROM expense_allocation_lines l
        JOIN expense_allocation_periods p ON p.id = l.period_id
        WHERE p.status = 'approved'
          AND l.product_id IS NOT NULL
          AND p.period_end   >= $1::date
          AND p.period_start <= $2::date
        GROUP BY l.product_id
      `;
    } else {
      // All-time: identical math to v_product_profit_with_overhead's
      // own subquery — we read the view directly via a fresh aggregation
      // for symmetry with the date-scoped branch.
      overheadSubquery = `
        SELECT
          l.product_id,
          SUM(l.allocated_amount) AS overhead_allocated
        FROM expense_allocation_lines l
        JOIN expense_allocation_periods p ON p.id = l.period_id
        WHERE p.status = 'approved'
          AND l.product_id IS NOT NULL
        GROUP BY l.product_id
      `;
    }

    return this.ds.query(
      `
      SELECT
        pp.product_id,
        pp.product_name,
        pp.product_type,
        pp.units_sold,
        pp.revenue,
        pp.cogs,
        pp.gross_profit,
        pp.roi_pct,
        COALESCE(o.overhead_allocated, 0)::NUMERIC(14,2)             AS overhead_allocated,
        (pp.gross_profit - COALESCE(o.overhead_allocated, 0))::NUMERIC AS net_profit_after_overhead
      FROM v_product_profit pp
      LEFT JOIN (${overheadSubquery}) o ON o.product_id = pp.product_id
      ORDER BY pp.gross_profit DESC NULLS LAST
      LIMIT 1000
      `,
      params,
    );
  }

  /**
   * Approved expenses NOT covered by any approved allocation line.
   *
   * Reads the base view `v_unallocated_expenses`.  When `from`/`to`
   * are supplied, narrows the result by `expense_date`.
   */
  async unallocatedExpenses(filters: {
    from?: string;
    to?: string;
    warehouse_id?: string;
  } = {}) {
    const params: any[] = [];
    const where: string[] = [];
    if (filters.from) {
      params.push(filters.from);
      where.push(`u.expense_date >= $${params.length}::date`);
    }
    if (filters.to) {
      params.push(filters.to);
      where.push(`u.expense_date <= $${params.length}::date`);
    }
    if (filters.warehouse_id) {
      params.push(filters.warehouse_id);
      where.push(`u.warehouse_id = $${params.length}::uuid`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    return this.ds.query(
      `
      SELECT
        u.id,
        u.expense_no,
        u.amount,
        u.expense_date,
        u.category_id,
        u.category_code,
        u.category_name,
        u.warehouse_id,
        u.warehouse_name
      FROM v_unallocated_expenses u
      ${whereSql}
      ORDER BY u.expense_date DESC, u.amount DESC
      LIMIT 1000
      `,
      params,
    );
  }
}
