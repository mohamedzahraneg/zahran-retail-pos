import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

/**
 * Public DTO shapes consumed by the controller.  Kept as plain interfaces
 * so the service is decoupled from class-validator metadata (which lives
 * on the controller-side DTO classes that `implements` these interfaces).
 */
export interface CreatePeriodDto {
  period_start: string;
  period_end: string;
  warehouse_id?: string;
  notes?: string;
}

export interface UpdatePeriodDto {
  period_start?: string;
  period_end?: string;
  warehouse_id?: string | null;
  notes?: string | null;
}

export interface AddLineDto {
  expense_id?: string;
  expense_category_id?: string;
  source_amount: number;
  product_id?: string;
  product_category_id?: string;
  warehouse_id?: string;
  allocation_method?: 'manual';
  allocated_amount: number;
  notes?: string;
}

export interface UpdateLineDto {
  source_amount?: number;
  allocated_amount?: number;
  product_id?: string | null;
  product_category_id?: string | null;
  warehouse_id?: string | null;
  expense_id?: string | null;
  expense_category_id?: string | null;
}

/**
 * PR-PHASE2-B3 — preview / compute.
 *
 * READ-ONLY shape consumed by previewAllocation().  The endpoint returns
 * proposed lines but performs zero DB writes.  Saving is handled either
 * by the existing B2 POST /lines (manual only) or a later batch-save PR.
 */
export type PreviewMethod = 'by_revenue' | 'by_units_sold' | 'by_gross_profit';
export type PreviewTargetKind = 'product' | 'category' | 'warehouse';

/**
 * Minimal abstraction over the two ways a service method can issue a
 * query: directly on the global DataSource (read-only paths like
 * previewAllocation), or via an EntityManager scoped to a transaction
 * (write paths like saveAllocationPreview).  Both `DataSource.query`
 * and `EntityManager.query` share this signature.
 */
type Querier = { query(sql: string, params?: any[]): Promise<any[]> };

/**
 * PR-PHASE2-B4 — save-preview DTO.  Same shape as PreviewDto plus an
 * optional `replace_existing` flag.  When false (default) the save
 * refuses to run if the period already has any lines; when true it
 * deletes existing lines inside the same transaction before inserting
 * the recomputed preview.
 */
export interface SavePreviewDto extends PreviewDto {
  replace_existing?: boolean;
}

export interface PreviewDto {
  source: {
    expense_id?: string;
    expense_category_id?: string;
  };
  target_kind: PreviewTargetKind;
  method: PreviewMethod;
}

/**
 * ExpenseAllocationsService — PR-PHASE2-B1 (read) + PR-PHASE2-B2 (mutate).
 *
 * Read paths come from B1 (migration 132).
 * Mutation paths added by B2 cover draft-period CRUD, manual-line CRUD,
 * and the approve/reverse FSM transitions.  Compute/preview methods
 * (by_revenue / by_units_sold / by_gross_profit) are deliberately NOT
 * implemented here — they land in a later PR.
 *
 * Hard constraints (verified by source-grep tests):
 *   * No INSERT / UPDATE / DELETE on expenses / journal_entries /
 *     journal_lines / cashbox_transactions / stock_movements /
 *     product_variants / invoice_items / invoices.
 *   * No FinancialEngine import or call.
 *   * No `accounting_only` escape.
 *   * No touch of backend/src/provisioning.
 *   * All mutations are confined to `expense_allocation_periods` and
 *     `expense_allocation_lines`.
 *
 * Transactional model:
 *   Every mutation runs inside `ds.transaction(em => ...)` with a
 *   `SELECT ... FOR UPDATE` on the parent period row so concurrent
 *   approve/reverse/edit calls serialize predictably.
 */
@Injectable()
export class ExpenseAllocationsService {
  constructor(private readonly ds: DataSource) {}

  // ─── Periods (read) ─────────────────────────────────────────────

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

  // ─── Periods (mutate) ───────────────────────────────────────────

  /**
   * Create a new draft allocation period.
   *
   * Validates `period_end >= period_start` at the application layer so
   * the user sees an Arabic message rather than a Postgres CHECK error.
   * Optional `warehouse_id` (NULL = company-wide).
   *
   * Always created in `status = 'draft'` with `total_allocated = 0`.
   */
  async createPeriod(dto: CreatePeriodDto, userId: string) {
    if (!dto.period_start || !dto.period_end) {
      throw new BadRequestException('تاريخ البداية والنهاية مطلوبان.');
    }
    if (dto.period_end < dto.period_start) {
      throw new BadRequestException(
        'تاريخ النهاية يجب أن يكون أكبر من أو يساوي تاريخ البداية.',
      );
    }

    const [row] = await this.ds.query(
      `
      INSERT INTO expense_allocation_periods
        (period_start, period_end, warehouse_id, notes, status, created_by)
      VALUES ($1::date, $2::date, $3::uuid, $4, 'draft', $5::uuid)
      RETURNING id
      `,
      [
        dto.period_start,
        dto.period_end,
        dto.warehouse_id ?? null,
        dto.notes ?? null,
        userId,
      ],
    );
    return this.getPeriod(row.id);
  }

  /**
   * Update mutable fields on a DRAFT period.  Approved / reversed
   * periods are immutable and return 400 with an Arabic message.
   *
   * Only `period_start`, `period_end`, `warehouse_id`, and `notes` are
   * editable.  Audit columns (`created_by`, `approved_*`, `reversed_*`)
   * are never touched here.
   */
  async updatePeriod(id: string, dto: UpdatePeriodDto) {
    return this.ds.transaction(async (em) => {
      const current = await this.lockPeriod(em, id);
      if (current.status !== 'draft') {
        throw new BadRequestException(
          'يمكن تعديل الفترات في حالة المسودة فقط.',
        );
      }

      // Build the patch — only fields actually present in the DTO are
      // pushed into the UPDATE.  Sending `warehouse_id: null` explicitly
      // clears the scope back to company-wide.
      const sets: string[] = [];
      const params: any[] = [];
      const push = (col: string, val: any, cast = '') => {
        params.push(val);
        sets.push(`${col} = $${params.length}${cast}`);
      };

      const newStart =
        dto.period_start !== undefined ? dto.period_start : current.period_start;
      const newEnd =
        dto.period_end !== undefined ? dto.period_end : current.period_end;
      if (newEnd < newStart) {
        throw new BadRequestException(
          'تاريخ النهاية يجب أن يكون أكبر من أو يساوي تاريخ البداية.',
        );
      }

      if (dto.period_start !== undefined) push('period_start', dto.period_start, '::date');
      if (dto.period_end   !== undefined) push('period_end',   dto.period_end,   '::date');
      if (dto.warehouse_id !== undefined) push('warehouse_id', dto.warehouse_id, '::uuid');
      if (dto.notes        !== undefined) push('notes',        dto.notes);

      if (sets.length === 0) {
        // Nothing to change — return current state, no-op safe.
        return this.getPeriod(id);
      }

      params.push(id);
      await em.query(
        `UPDATE expense_allocation_periods SET ${sets.join(', ')} WHERE id = $${params.length}`,
        params,
      );
      return this.getPeriod(id);
    });
  }

  /**
   * Delete a DRAFT period.  Lines are removed by `ON DELETE CASCADE`.
   * Approved / reversed periods are preserved for audit and return 400.
   */
  async deletePeriod(id: string) {
    return this.ds.transaction(async (em) => {
      const current = await this.lockPeriod(em, id);
      if (current.status !== 'draft') {
        throw new BadRequestException(
          'لا يمكن حذف فترة معتمدة أو معكوسة.',
        );
      }
      await em.query(`DELETE FROM expense_allocation_periods WHERE id = $1`, [id]);
      return { success: true };
    });
  }

  // ─── Lines (mutate) ─────────────────────────────────────────────

  /**
   * Append a MANUAL line to a draft period.
   *
   * PR-PHASE2-B2 only supports `allocation_method = 'manual'`.  The
   * compute/preview methods (`by_revenue`, `by_units_sold`,
   * `by_gross_profit`) land in a subsequent PR.
   *
   * Application-layer validation mirrors the DB CHECK constraints so
   * users see Arabic messages rather than Postgres errors:
   *   * exactly one of product_id / product_category_id / warehouse_id
   *   * at least one of expense_id / expense_category_id
   *   * allocated_amount >= 0
   *   * source_amount    >= 0
   *
   * After insertion, `total_allocated` on the parent period is
   * recomputed as `SUM(allocated_amount)` inside the same transaction.
   */
  async addLine(periodId: string, dto: AddLineDto) {
    const method = dto.allocation_method ?? 'manual';
    if (method !== 'manual') {
      throw new BadRequestException(
        'هذه الواجهة تقبل سطور التوزيع اليدوية فقط.',
      );
    }
    this.validateTargetExactlyOne(dto);
    this.validateSourcePresent(dto);
    this.validateNonNegative(dto.source_amount, 'مبلغ المصدر');
    this.validateNonNegative(dto.allocated_amount, 'المبلغ الموزع');

    return this.ds.transaction(async (em) => {
      const current = await this.lockPeriod(em, periodId);
      if (current.status !== 'draft') {
        throw new BadRequestException(
          'يمكن إضافة سطور في الفترات في حالة المسودة فقط.',
        );
      }

      const [row] = await em.query(
        `
        INSERT INTO expense_allocation_lines
          (period_id, expense_id, expense_category_id, source_amount,
           product_id, product_category_id, warehouse_id,
           allocation_method, allocated_amount)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4,
                $5::uuid, $6::uuid, $7::uuid,
                'manual', $8)
        RETURNING id
        `,
        [
          periodId,
          dto.expense_id ?? null,
          dto.expense_category_id ?? null,
          dto.source_amount,
          dto.product_id ?? null,
          dto.product_category_id ?? null,
          dto.warehouse_id ?? null,
          dto.allocated_amount,
        ],
      );

      await this.recomputeTotal(em, periodId);
      return { id: row.id };
    });
  }

  /**
   * Delete ALL lines on a draft period and reset `total_allocated = 0`.
   * Used by the operator to "start over" without recreating the period.
   * Approved / reversed periods reject with 400.
   */
  async clearLines(periodId: string) {
    return this.ds.transaction(async (em) => {
      const current = await this.lockPeriod(em, periodId);
      if (current.status !== 'draft') {
        throw new BadRequestException(
          'يمكن مسح سطور الفترات في حالة المسودة فقط.',
        );
      }
      await em.query(`DELETE FROM expense_allocation_lines WHERE period_id = $1`, [periodId]);
      await this.recomputeTotal(em, periodId);
      return { success: true };
    });
  }

  /**
   * Update an existing manual line.  Permitted fields:
   *   * allocated_amount / source_amount (numeric, >= 0)
   *   * target swap (product_id / product_category_id / warehouse_id)
   *   * source swap (expense_id / expense_category_id)
   *
   * The exactly-one-target and source-present invariants are re-checked
   * against the patched row.  After the UPDATE, the period's
   * `total_allocated` is recomputed in the same transaction.
   */
  async updateLine(periodId: string, lineId: string, dto: UpdateLineDto) {
    return this.ds.transaction(async (em) => {
      const current = await this.lockPeriod(em, periodId);
      if (current.status !== 'draft') {
        throw new BadRequestException(
          'يمكن تعديل سطور الفترات في حالة المسودة فقط.',
        );
      }

      const [line] = await em.query(
        `SELECT * FROM expense_allocation_lines WHERE id = $1 AND period_id = $2`,
        [lineId, periodId],
      );
      if (!line) throw new NotFoundException('سطر التوزيع غير موجود.');
      if (line.allocation_method !== 'manual') {
        throw new BadRequestException(
          'هذه الواجهة تقبل سطور التوزيع اليدوية فقط.',
        );
      }

      // Apply patch in memory so we can re-validate the resulting row.
      const merged = {
        expense_id:
          dto.expense_id !== undefined ? dto.expense_id : line.expense_id,
        expense_category_id:
          dto.expense_category_id !== undefined
            ? dto.expense_category_id
            : line.expense_category_id,
        product_id:
          dto.product_id !== undefined ? dto.product_id : line.product_id,
        product_category_id:
          dto.product_category_id !== undefined
            ? dto.product_category_id
            : line.product_category_id,
        warehouse_id:
          dto.warehouse_id !== undefined ? dto.warehouse_id : line.warehouse_id,
        source_amount:
          dto.source_amount !== undefined
            ? dto.source_amount
            : Number(line.source_amount),
        allocated_amount:
          dto.allocated_amount !== undefined
            ? dto.allocated_amount
            : Number(line.allocated_amount),
      };

      this.validateTargetExactlyOne(merged);
      this.validateSourcePresent(merged);
      this.validateNonNegative(merged.source_amount, 'مبلغ المصدر');
      this.validateNonNegative(merged.allocated_amount, 'المبلغ الموزع');

      const sets: string[] = [];
      const params: any[] = [];
      const push = (col: string, val: any, cast = '') => {
        params.push(val);
        sets.push(`${col} = $${params.length}${cast}`);
      };
      if (dto.expense_id          !== undefined) push('expense_id',          dto.expense_id,          '::uuid');
      if (dto.expense_category_id !== undefined) push('expense_category_id', dto.expense_category_id, '::uuid');
      if (dto.product_id          !== undefined) push('product_id',          dto.product_id,          '::uuid');
      if (dto.product_category_id !== undefined) push('product_category_id', dto.product_category_id, '::uuid');
      if (dto.warehouse_id        !== undefined) push('warehouse_id',        dto.warehouse_id,        '::uuid');
      if (dto.source_amount       !== undefined) push('source_amount',       dto.source_amount);
      if (dto.allocated_amount    !== undefined) push('allocated_amount',    dto.allocated_amount);

      if (sets.length > 0) {
        params.push(lineId);
        await em.query(
          `UPDATE expense_allocation_lines SET ${sets.join(', ')} WHERE id = $${params.length}`,
          params,
        );
        await this.recomputeTotal(em, periodId);
      }
      return { id: lineId };
    });
  }

  // ─── FSM transitions ────────────────────────────────────────────

  /**
   * `draft → approved`.  Requires at least one line.  Sets
   * `approved_by` / `approved_at = NOW()`.  `total_allocated` is
   * snapshotted as `SUM(allocated_amount)` for the period.
   *
   * Approved periods are immutable — subsequent attempts to add / edit
   * lines or update header fields will return 400.
   */
  async approvePeriod(id: string, userId: string) {
    return this.ds.transaction(async (em) => {
      const current = await this.lockPeriod(em, id);
      if (current.status !== 'draft') {
        throw new BadRequestException(
          'يمكن اعتماد الفترات في حالة المسودة فقط.',
        );
      }
      const [{ count }] = await em.query(
        `SELECT COUNT(*)::int AS count FROM expense_allocation_lines WHERE period_id = $1`,
        [id],
      );
      if (count < 1) {
        throw new BadRequestException(
          'لا يمكن اعتماد فترة بدون سطور توزيع.',
        );
      }
      await em.query(
        `
        UPDATE expense_allocation_periods
        SET status      = 'approved',
            approved_by = $1::uuid,
            approved_at = NOW(),
            total_allocated = (
              SELECT COALESCE(SUM(allocated_amount), 0)
              FROM expense_allocation_lines
              WHERE period_id = $2
            )
        WHERE id = $2
        `,
        [userId, id],
      );
      return this.getPeriod(id);
    });
  }

  /**
   * `approved → reversed` (terminal).  Requires a non-empty reason.
   * Lines are preserved (audit), but the reports views filter them out
   * because they only consider `status = 'approved'`.
   *
   * Reversed is terminal: there is no path back to draft.  Operators
   * who need to redo the allocation create a fresh draft period.
   */
  async reversePeriod(id: string, userId: string, reason: string) {
    if (!reason || !reason.trim()) {
      throw new BadRequestException('سبب العكس مطلوب.');
    }
    return this.ds.transaction(async (em) => {
      const current = await this.lockPeriod(em, id);
      if (current.status !== 'approved') {
        throw new BadRequestException(
          'يمكن عكس الفترات المعتمدة فقط.',
        );
      }
      await em.query(
        `
        UPDATE expense_allocation_periods
        SET status          = 'reversed',
            reversed_by     = $1::uuid,
            reversed_at     = NOW(),
            reversed_reason = $2
        WHERE id = $3
        `,
        [userId, reason.trim(), id],
      );
      return this.getPeriod(id);
    });
  }

  // ─── Preview / compute (PR-PHASE2-B3, read-only) ────────────────

  /**
   * Compute a proposed allocation across product / category / warehouse
   * targets, weighted by revenue / units sold / gross profit observed in
   * the parent period's date range.  Returns the proposed lines — does
   * NOT save them.  Saving remains via the B2 POST /lines endpoint (one
   * manual line at a time) or a future batch-save PR.
   *
   * Allowed on periods of ANY status (read-only operation).  Computes
   * basis fresh from invoice_items + invoices (the existing
   * v_product_profit view is all-time and cannot be re-used here).
   *
   * Hard constraints (preserved by source-grep guards):
   *   * Zero writes — pure SELECT over invoice_items / invoices /
   *     product_variants / products / categories / warehouses / expenses
   *   * No FinancialEngine call
   *   * No mutation of expenses
   */
  async previewAllocation(periodId: string, dto: PreviewDto) {
    // 1. Validate DTO shape
    const { source, target_kind, method } = dto ?? ({} as PreviewDto);
    if (!source) {
      throw new BadRequestException('مصدر التوزيع مطلوب.');
    }
    const hasExp = Boolean(source.expense_id);
    const hasCat = Boolean(source.expense_category_id);
    if (hasExp && hasCat) {
      throw new BadRequestException('حدد مصدراً واحداً فقط: مصروف معيّن أو فئة مصروفات.');
    }
    if (!hasExp && !hasCat) {
      throw new BadRequestException('يجب تحديد مصدر التوزيع: مصروف معيّن أو فئة مصروفات.');
    }
    if (!['product', 'category', 'warehouse'].includes(target_kind)) {
      throw new BadRequestException('نوع الهدف غير صالح.');
    }
    if (!['by_revenue', 'by_units_sold', 'by_gross_profit'].includes(method)) {
      throw new BadRequestException('طريقة التوزيع غير صالحة.');
    }

    // 2. Look up the period (read-only, no FOR UPDATE).
    const [period] = await this.ds.query(
      `SELECT id, period_start, period_end, warehouse_id, status
         FROM expense_allocation_periods
         WHERE id = $1`,
      [periodId],
    );
    if (!period) throw new NotFoundException('فترة التوزيع غير موجودة.');

    // 3. Resolve source amount.
    const sourceAmount = await this.resolveSourceAmount(this.ds, period, source);

    // 4. Aggregate basis per target_kind.
    const rawCandidates = await this.aggregateBasis(this.ds, period, target_kind);

    // 5. Pick the basis value per the chosen method; for by_gross_profit
    //    exclude targets with non-positive GP (cannot bear overhead).
    const valued = rawCandidates.map((c: any) => ({
      target_id: c.target_id,
      target_name: c.target_name,
      basis_units: Number(c.basis_units_sold ?? 0),
      basis_revenue: Number(c.basis_revenue ?? 0),
      basis_gross_profit: Number(c.basis_gross_profit ?? 0),
    }));
    const basisOf = (c: typeof valued[number]) =>
      method === 'by_revenue'
        ? c.basis_revenue
        : method === 'by_units_sold'
          ? c.basis_units
          : c.basis_gross_profit;

    let counted: typeof valued = valued;
    let excluded = 0;
    if (method === 'by_gross_profit') {
      counted = valued.filter((c) => basisOf(c) > 0);
      excluded = valued.length - counted.length;
    }

    const totalBasis = counted.reduce((s, c) => s + basisOf(c), 0);

    // 6. Zero-basis early return — no proposed lines, contextual warning.
    if (sourceAmount === 0 || totalBasis <= 0 || counted.length === 0) {
      return this.buildPreviewPayload(period, dto, sourceAmount, valued.length, excluded, 0, [], 0, null,
        this.zeroBasisWarning(method, sourceAmount, totalBasis, counted.length, valued.length));
    }

    // 7. Compute proposed amounts (rounded to 2dp).
    const lines = counted.map((c) => {
      const basis = basisOf(c);
      const rawShare = (sourceAmount * basis) / totalBasis;
      return {
        target_kind,
        target_id: c.target_id,
        target_name: c.target_name,
        basis_value: this.fmt6(basis),
        weight_basis_total: this.fmt6(totalBasis),
        weight_pct: this.fmt4((basis / totalBasis) * 100),
        proposed_amount: this.round2(rawShare),
        _rawBasis: basis,
      };
    });

    // 8. Apply rounding residual to the line with the largest basis
    //    (deterministic tie-break by lexicographically smallest target_id).
    const sumRounded = lines.reduce((s, l) => s + Number(l.proposed_amount), 0);
    const residual = this.round2(sourceAmount - sumRounded);
    let residualTargetId: string | null = null;
    if (residual !== 0 && lines.length > 0) {
      const sorted = [...lines].sort((a, b) => {
        if (b._rawBasis !== a._rawBasis) return b._rawBasis - a._rawBasis;
        return a.target_id.localeCompare(b.target_id);
      });
      const winner = sorted[0];
      winner.proposed_amount = this.round2(Number(winner.proposed_amount) + residual);
      residualTargetId = winner.target_id;
    }

    // 9. Strip internal-only fields and format proposed_amount as
    //    `numeric(14,2)`-style string for response stability.
    const proposed_lines = lines.map((l) => ({
      target_kind: l.target_kind,
      target_id: l.target_id,
      target_name: l.target_name,
      basis_value: l.basis_value,
      weight_basis_total: l.weight_basis_total,
      weight_pct: l.weight_pct,
      proposed_amount: this.fmt2(Number(l.proposed_amount)),
    }));

    return this.buildPreviewPayload(
      period, dto, sourceAmount,
      valued.length, excluded, totalBasis,
      proposed_lines, residual, residualTargetId, null,
    );
  }

  /**
   * PR-PHASE2-B4 — materialise a preview computation into real
   * `expense_allocation_lines` rows for a draft period.
   *
   * The server recomputes the preview internally — clients do NOT
   * submit precomputed amounts.  This avoids a trust-boundary problem
   * (an operator could fabricate basis values otherwise) and a
   * stale-snapshot problem (data may have shifted between preview and
   * save).
   *
   * Hard contract (mirrors B2 mutations + B3 read-only invariants):
   *   * Period must be `draft`.  Approved/reversed reject with 400.
   *   * `replace_existing = false` (default) → reject 400 if any line
   *     already exists.  `true` → DELETE existing lines first, then
   *     INSERT the new set, all inside the same transaction.
   *   * Zero-basis (source=0 OR no candidates OR all GP excluded) →
   *     reject 400.  We refuse to save an empty allocation.
   *   * `weight_basis_value` / `weight_basis_total` persisted on every
   *     row for auditor recomputation.
   *   * Single `ds.transaction(em => …)` with `SELECT … FOR UPDATE` on
   *     the parent period: any concurrent approve / addLine / save will
   *     serialise behind us.
   *   * After INSERT, `expense_allocation_periods.total_allocated` is
   *     recomputed from `SUM(allocated_amount)` in the same txn.
   *
   * No call to FinancialEngine.  No write to journal_entries /
   * cashbox_transactions / stock_movements / product_variants /
   * invoice_items / invoices / expenses.  Source-grep guards in the
   * spec pin this; writes are confined to the two allocation tables.
   */
  async saveAllocationPreview(periodId: string, dto: SavePreviewDto) {
    // 1. DTO validation (same gates as preview, ahead of any IO).
    if (!dto?.source) {
      throw new BadRequestException('مصدر التوزيع مطلوب.');
    }
    const hasExp = Boolean(dto.source.expense_id);
    const hasCat = Boolean(dto.source.expense_category_id);
    if (hasExp && hasCat) {
      throw new BadRequestException('حدد مصدراً واحداً فقط: مصروف معيّن أو فئة مصروفات.');
    }
    if (!hasExp && !hasCat) {
      throw new BadRequestException('يجب تحديد مصدر التوزيع: مصروف معيّن أو فئة مصروفات.');
    }
    if (!['product', 'category', 'warehouse'].includes(dto.target_kind)) {
      throw new BadRequestException('نوع الهدف غير صالح.');
    }
    if (!['by_revenue', 'by_units_sold', 'by_gross_profit'].includes(dto.method)) {
      throw new BadRequestException('طريقة التوزيع غير صالحة.');
    }

    return this.ds.transaction(async (em) => {
      // 2. Lock parent period (FSM safety against concurrent transitions).
      const period = await this.lockPeriod(em, periodId);
      if (period.status !== 'draft') {
        throw new BadRequestException(
          'يمكن حفظ المعاينة في حالة المسودة فقط.',
        );
      }

      // 3. Compute the preview inside this transaction so the snapshot
      //    used to compose the saved rows is the same one the post-edit
      //    state will reflect.
      const fullPeriod = period as any;
      const sourceAmount = await this.resolveSourceAmount(
        em,
        { period_start: fullPeriod.period_start, period_end: fullPeriod.period_end, warehouse_id: fullPeriod.warehouse_id ?? null },
        dto.source,
      );

      const rawCandidates = await this.aggregateBasis(
        em,
        { period_start: fullPeriod.period_start, period_end: fullPeriod.period_end, warehouse_id: fullPeriod.warehouse_id ?? null },
        dto.target_kind,
      );

      const valued = rawCandidates.map((c: any) => ({
        target_id: c.target_id as string,
        target_name: c.target_name as string,
        basis_units: Number(c.basis_units_sold ?? 0),
        basis_revenue: Number(c.basis_revenue ?? 0),
        basis_gross_profit: Number(c.basis_gross_profit ?? 0),
      }));
      const basisOf = (c: typeof valued[number]) =>
        dto.method === 'by_revenue'
          ? c.basis_revenue
          : dto.method === 'by_units_sold'
            ? c.basis_units
            : c.basis_gross_profit;

      let counted = valued;
      let excluded = 0;
      if (dto.method === 'by_gross_profit') {
        counted = valued.filter((c) => basisOf(c) > 0);
        excluded = valued.length - counted.length;
      }
      const totalBasis = counted.reduce((s, c) => s + basisOf(c), 0);

      // 4. Zero-basis reject (save MUST produce ≥ 1 line; otherwise the
      //    operator should pick a different source / method / scope).
      if (sourceAmount === 0 || totalBasis <= 0 || counted.length === 0) {
        throw new BadRequestException(
          this.zeroBasisWarning(dto.method, sourceAmount, totalBasis, counted.length, valued.length),
        );
      }

      // 5. Pre-existing lines policy.  Default: refuse.
      const [{ count: existingCount }] = await em.query(
        `SELECT COUNT(*)::int AS count FROM expense_allocation_lines WHERE period_id = $1`,
        [periodId],
      );
      if (existingCount > 0) {
        if (!dto.replace_existing) {
          throw new BadRequestException(
            'الفترة تحتوي على سطور بالفعل. امسحها أولاً أو استخدم replace_existing=true.',
          );
        }
        await em.query(
          `DELETE FROM expense_allocation_lines WHERE period_id = $1`,
          [periodId],
        );
      }

      // 6. Build the to-be-inserted rows.  Mirror the preview's residual
      //    rule: largest-basis target absorbs the rounding tail; tie-break
      //    by lexicographically smallest target_id.
      type LineDraft = {
        target_id: string;
        target_name: string;
        basis_value: number;
        proposed_amount: number;
      };
      const drafts: LineDraft[] = counted.map((c) => ({
        target_id: c.target_id,
        target_name: c.target_name,
        basis_value: basisOf(c),
        proposed_amount: this.round2((sourceAmount * basisOf(c)) / totalBasis),
      }));
      const sumRounded = drafts.reduce((s, l) => s + l.proposed_amount, 0);
      const residual = this.round2(sourceAmount - sumRounded);
      let residualTargetId: string | null = null;
      if (residual !== 0 && drafts.length > 0) {
        const sorted = [...drafts].sort((a, b) => {
          if (b.basis_value !== a.basis_value) return b.basis_value - a.basis_value;
          return a.target_id.localeCompare(b.target_id);
        });
        const winner = sorted[0];
        // mutate the original drafts entry (sort copied references, so
        // winner.proposed_amount mutation propagates).
        winner.proposed_amount = this.round2(winner.proposed_amount + residual);
        residualTargetId = winner.target_id;
      }

      // 7. Bulk INSERT.  Build a parameterised VALUES list to avoid
      //    string-quoting pitfalls.  9 placeholders per row.
      const expense_id = dto.source.expense_id ?? null;
      const expense_category_id = dto.source.expense_category_id ?? null;
      const placeholders: string[] = [];
      const params: any[] = [];
      let p = 1;
      const slot = () => `$${p++}`;
      for (const d of drafts) {
        // Match column order in the INSERT statement below exactly.
        params.push(periodId);
        params.push(expense_id);
        params.push(expense_category_id);
        params.push(d.proposed_amount);                                    // source_amount
        params.push(dto.target_kind === 'product'   ? d.target_id : null); // product_id
        params.push(dto.target_kind === 'category'  ? d.target_id : null); // product_category_id
        params.push(dto.target_kind === 'warehouse' ? d.target_id : null); // warehouse_id
        params.push(dto.method);
        params.push(d.proposed_amount);                                    // allocated_amount
        params.push(d.basis_value);
        params.push(totalBasis);
        placeholders.push(
          `(${slot()}::uuid, ${slot()}::uuid, ${slot()}::uuid, ${slot()}, ` +
          `${slot()}::uuid, ${slot()}::uuid, ${slot()}::uuid, ` +
          `${slot()}, ${slot()}, ${slot()}, ${slot()})`,
        );
      }
      const inserted = await em.query(
        `
        INSERT INTO expense_allocation_lines
          (period_id, expense_id, expense_category_id, source_amount,
           product_id, product_category_id, warehouse_id,
           allocation_method, allocated_amount,
           weight_basis_value, weight_basis_total)
        VALUES ${placeholders.join(', ')}
        RETURNING id, product_id, product_category_id, warehouse_id, allocated_amount, weight_basis_value, weight_basis_total
        `,
        params,
      );

      // 8. Recompute period.total_allocated atomically.
      await this.recomputeTotal(em, periodId);

      // 9. Map inserted rows back to drafts so we can surface
      //    weight_pct + the residual-line id deterministically.
      const idByTargetId = new Map<string, string>();
      for (const row of inserted) {
        const tid = row.product_id || row.product_category_id || row.warehouse_id;
        if (tid) idByTargetId.set(tid, row.id);
      }
      const residualLineId = residualTargetId ? idByTargetId.get(residualTargetId) ?? null : null;

      const lines = drafts.map((d) => ({
        id: idByTargetId.get(d.target_id) ?? null,
        target_kind: dto.target_kind,
        target_id: d.target_id,
        target_name: d.target_name,
        basis_value: this.fmt6(d.basis_value),
        weight_basis_total: this.fmt6(totalBasis),
        weight_pct: this.fmt4((d.basis_value / totalBasis) * 100),
        source_amount: this.fmt2(d.proposed_amount),
        allocated_amount: this.fmt2(d.proposed_amount),
      }));

      return {
        period_id: periodId,
        method: dto.method,
        target_kind: dto.target_kind,
        source: {
          expense_id,
          expense_category_id,
          amount: this.fmt2(sourceAmount),
        },
        period_scope: {
          from: this.dateOnly(fullPeriod.period_start),
          to: this.dateOnly(fullPeriod.period_end),
          warehouse_id: fullPeriod.warehouse_id ?? null,
        },
        saved_count: lines.length,
        candidates_total: valued.length,
        candidates_excluded: excluded,
        total_basis: this.fmt6(totalBasis),
        total_allocated: this.fmt2(sourceAmount),
        rounding_residual: this.fmt2(residual),
        rounding_residual_absorbed_into_target_id: residualTargetId,
        rounding_residual_absorbed_into_line_id: residualLineId,
        replace_existing: Boolean(dto.replace_existing),
        existing_lines_deleted: existingCount > 0 && dto.replace_existing ? existingCount : 0,
        lines,
      };
    });
  }

  /**
   * Build the canonical preview response.  Single place to format the
   * shape — keeps zero-basis and happy-path branches consistent.
   */
  private buildPreviewPayload(
    period: any,
    dto: PreviewDto,
    sourceAmount: number,
    candidatesTotal: number,
    candidatesExcluded: number,
    totalBasis: number,
    proposed_lines: any[],
    residual: number,
    residualTargetId: string | null,
    zeroWarning: string | null,
  ) {
    return {
      period_id: period.id,
      method: dto.method,
      target_kind: dto.target_kind,
      source: {
        expense_id: dto.source.expense_id ?? null,
        expense_category_id: dto.source.expense_category_id ?? null,
        amount: this.fmt2(sourceAmount),
      },
      period_scope: {
        from: this.dateOnly(period.period_start),
        to: this.dateOnly(period.period_end),
        warehouse_id: period.warehouse_id ?? null,
      },
      candidates_total: candidatesTotal,
      candidates_excluded: candidatesExcluded,
      total_basis: this.fmt6(totalBasis),
      rounding_residual: this.fmt2(residual),
      rounding_residual_absorbed_into_target_id: residualTargetId,
      zero_basis_warning: zeroWarning,
      proposed_lines,
    };
  }

  /**
   * Resolve the source amount being allocated.
   *
   *   * expense_id: the row's `amount`, REQUIRED to be approved.
   *   * expense_category_id: SUM of approved expenses in that category
   *     whose expense_date falls inside the period range (and matches
   *     the period's warehouse if scoped).
   */
  private async resolveSourceAmount(
    runner: Querier,
    period: { period_start: any; period_end: any; warehouse_id: string | null },
    source: { expense_id?: string; expense_category_id?: string },
  ): Promise<number> {
    if (source.expense_id) {
      const [row] = await runner.query(
        `SELECT amount, is_approved FROM expenses WHERE id = $1`,
        [source.expense_id],
      );
      if (!row) throw new NotFoundException('المصروف المصدر غير موجود.');
      if (row.is_approved !== true) {
        throw new BadRequestException('المصروف المصدر يجب أن يكون معتمداً.');
      }
      return Number(row.amount ?? 0);
    }
    // expense_category_id branch
    const rows = await runner.query(
      `
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM expenses
      WHERE category_id = $1::uuid
        AND is_approved = TRUE
        AND expense_date >= $2::date
        AND expense_date <= $3::date
        AND ($4::uuid IS NULL OR warehouse_id = $4::uuid)
      `,
      [
        source.expense_category_id,
        period.period_start,
        period.period_end,
        period.warehouse_id ?? null,
      ],
    );
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * Aggregate basis values (units_sold, revenue, gross_profit) per
   * target.  Period-scoped (filters invoices.completed_at).  Respects
   * the parent period's warehouse_id when set.  Mirrors v_product_profit's
   * canonical sales-status filter for consistency with other reports.
   */
  private async aggregateBasis(
    runner: Querier,
    period: { period_start: any; period_end: any; warehouse_id: string | null },
    target_kind: PreviewTargetKind,
  ): Promise<any[]> {
    const commonWhere = `
        i.status IN ('completed','paid','partially_paid')
        AND NOT i.is_return
        AND i.completed_at IS NOT NULL
        AND i.completed_at >= $1::date
        AND i.completed_at <  ($2::date + INTERVAL '1 day')
        AND ($3::uuid IS NULL OR i.warehouse_id = $3::uuid)
    `;
    const itemMath = `
        SUM(ii.quantity)::bigint                                                AS basis_units_sold,
        SUM(ii.quantity::numeric * ii.unit_price - ii.discount_amount)          AS basis_revenue,
        SUM(ii.quantity::numeric * ii.unit_price - ii.discount_amount
            - ii.quantity::numeric * ii.unit_cost)                              AS basis_gross_profit
    `;
    const params = [period.period_start, period.period_end, period.warehouse_id ?? null];

    if (target_kind === 'product') {
      return runner.query(
        `
        SELECT
          p.id      AS target_id,
          p.name_ar AS target_name,
          ${itemMath}
        FROM invoice_items ii
        JOIN product_variants pv ON pv.id = ii.variant_id
        JOIN products p          ON p.id  = pv.product_id
        JOIN invoices i          ON i.id  = ii.invoice_id
        WHERE ${commonWhere}
        GROUP BY p.id, p.name_ar
        `,
        params,
      );
    }

    if (target_kind === 'category') {
      return runner.query(
        `
        SELECT
          c.id      AS target_id,
          c.name_ar AS target_name,
          ${itemMath}
        FROM invoice_items ii
        JOIN product_variants pv ON pv.id = ii.variant_id
        JOIN products p          ON p.id  = pv.product_id
        JOIN categories c        ON c.id  = p.category_id
        JOIN invoices i          ON i.id  = ii.invoice_id
        WHERE ${commonWhere}
        GROUP BY c.id, c.name_ar
        `,
        params,
      );
    }

    // target_kind === 'warehouse'
    return runner.query(
      `
      SELECT
        w.id      AS target_id,
        w.name_ar AS target_name,
        ${itemMath}
      FROM invoice_items ii
      JOIN invoices i  ON i.id = ii.invoice_id
      JOIN warehouses w ON w.id = i.warehouse_id
      WHERE ${commonWhere}
      GROUP BY w.id, w.name_ar
      `,
      params,
    );
  }

  private zeroBasisWarning(
    method: PreviewMethod,
    sourceAmount: number,
    totalBasis: number,
    countedLen: number,
    rawLen: number,
  ): string {
    if (sourceAmount === 0) return 'مبلغ المصدر صفر.';
    if (rawLen === 0) return 'لا توجد مبيعات معتمدة في هذه الفترة.';
    if (method === 'by_gross_profit' && countedLen === 0) {
      return 'لا توجد أهداف ذات ربح موجب في هذه الفترة.';
    }
    if (totalBasis <= 0) return 'إجمالي قاعدة التوزيع صفر أو سالب.';
    return 'لا يمكن حساب توزيع.';
  }

  // Rounding helpers — explicit half-away-from-zero for positive values
  // (matches PostgreSQL ROUND() default).  All amounts in this codebase
  // are non-negative, so the sign caveat doesn't arise.
  private round2(n: number): number {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }
  private fmt2(n: number): string {
    return this.round2(n).toFixed(2);
  }
  private fmt4(n: number): string {
    return (Math.round((Number(n) + Number.EPSILON) * 10000) / 10000).toFixed(4);
  }
  private fmt6(n: number): string {
    return (Math.round((Number(n) + Number.EPSILON) * 1_000_000) / 1_000_000).toFixed(6);
  }
  private dateOnly(d: any): string | null {
    if (!d) return null;
    if (typeof d === 'string') return d.slice(0, 10);
    try { return new Date(d).toISOString().slice(0, 10); } catch { return String(d); }
  }

  // ─── Reports (read) ─────────────────────────────────────────────

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

  // ─── Internal helpers ───────────────────────────────────────────

  /**
   * Lock the period row for the duration of the transaction so concurrent
   * approve / reverse / edit calls serialize.  Throws NotFound if the id
   * doesn't resolve.
   */
  private async lockPeriod(em: EntityManager, id: string) {
    const [row] = await em.query(
      `SELECT id, status, period_start, period_end
         FROM expense_allocation_periods
         WHERE id = $1
         FOR UPDATE`,
      [id],
    );
    if (!row) throw new NotFoundException('فترة التوزيع غير موجودة.');
    return row;
  }

  /**
   * Recompute `total_allocated` as `SUM(allocated_amount)` over the
   * period's lines.  Called after every mutation that affects lines.
   */
  private async recomputeTotal(em: EntityManager, periodId: string) {
    await em.query(
      `
      UPDATE expense_allocation_periods
      SET total_allocated = (
        SELECT COALESCE(SUM(allocated_amount), 0)
        FROM expense_allocation_lines
        WHERE period_id = $1
      )
      WHERE id = $1
      `,
      [periodId],
    );
  }

  private validateTargetExactlyOne(t: {
    product_id?: any;
    product_category_id?: any;
    warehouse_id?: any;
  }) {
    const count =
      (t.product_id          ? 1 : 0) +
      (t.product_category_id ? 1 : 0) +
      (t.warehouse_id        ? 1 : 0);
    if (count !== 1) {
      throw new BadRequestException(
        'يجب تحديد هدف واحد فقط: منتج أو فئة منتج أو مخزن.',
      );
    }
  }

  private validateSourcePresent(t: {
    expense_id?: any;
    expense_category_id?: any;
  }) {
    if (!t.expense_id && !t.expense_category_id) {
      throw new BadRequestException(
        'يجب تحديد مصدر التوزيع: مصروف معيّن أو فئة مصروفات.',
      );
    }
  }

  private validateNonNegative(n: number | undefined | null, label: string) {
    if (n === undefined || n === null || Number.isNaN(Number(n)) || Number(n) < 0) {
      throw new BadRequestException(`${label} يجب أن يكون رقمًا غير سالب.`);
    }
  }
}
