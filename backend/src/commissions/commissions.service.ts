import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Salesperson Commissions
 *
 * Uses the `users.commission_rate` (%) column + `invoice_items.salesperson_id`
 * (falls back to `invoices.salesperson_id` for the whole invoice) to compute
 * commission earned per salesperson over a time window.
 *
 * commission = sum(line_total) * rate / 100
 *   restricted to invoices with sales-eligible status —
 *   ('completed', 'paid', 'partially_paid'). Excludes draft / cancelled
 *   / refunded. The earlier filter `status = 'completed'` returned ZERO
 *   rows in production because POS finalises invoices straight to
 *   'paid' (Overview dashboard regression — fixed 2026-04-26).
 */
@Injectable()
export class CommissionsService {
  constructor(private readonly ds: DataSource) {}

  async summary(params: { from: string; to: string }) {
    if (!params.from || !params.to) {
      throw new BadRequestException('from and to are required (YYYY-MM-DD)');
    }
    return this.ds.query(
      `
      WITH line_commissions AS (
        SELECT
          COALESCE(ii.salesperson_id, inv.salesperson_id) AS sp_id,
          ii.line_total,
          inv.id AS invoice_id,
          inv.completed_at
          FROM invoice_items ii
          JOIN invoices inv ON inv.id = ii.invoice_id
         WHERE inv.status::text IN ('completed', 'paid', 'partially_paid')
           AND inv.completed_at::date BETWEEN $1::date AND $2::date
           AND COALESCE(ii.salesperson_id, inv.salesperson_id) IS NOT NULL
      )
      SELECT
          u.id AS user_id,
          u.full_name,
          u.username,
          u.commission_rate,
          COUNT(DISTINCT lc.invoice_id) AS invoices_count,
          COALESCE(SUM(lc.line_total), 0) AS eligible_sales,
          ROUND(COALESCE(SUM(lc.line_total), 0) * u.commission_rate / 100.0, 2)
              AS commission_amount
        FROM users u
        LEFT JOIN line_commissions lc ON lc.sp_id = u.id
       WHERE u.is_active = true
         AND (u.commission_rate > 0 OR EXISTS (SELECT 1 FROM line_commissions x WHERE x.sp_id = u.id))
       GROUP BY u.id, u.full_name, u.username, u.commission_rate
       ORDER BY commission_amount DESC, u.full_name ASC
      `,
      [params.from, params.to],
    );
  }

  async detail(userId: string, params: { from: string; to: string }) {
    if (!params.from || !params.to) {
      throw new BadRequestException('from and to are required');
    }
    return this.ds.query(
      `
      SELECT
          inv.id AS invoice_id,
          inv.invoice_no,
          inv.completed_at,
          c.full_name AS customer_name,
          SUM(ii.line_total) AS eligible_total,
          inv.grand_total,
          inv.paid_total,
          u.commission_rate,
          ROUND(SUM(ii.line_total) * u.commission_rate / 100.0, 2) AS commission
        FROM invoices inv
        JOIN invoice_items ii
          ON ii.invoice_id = inv.id
         AND COALESCE(ii.salesperson_id, inv.salesperson_id) = $1
        JOIN users u ON u.id = $1
        LEFT JOIN customers c ON c.id = inv.customer_id
       WHERE inv.status::text IN ('completed', 'paid', 'partially_paid')
         AND inv.completed_at::date BETWEEN $2::date AND $3::date
       GROUP BY inv.id, inv.invoice_no, inv.completed_at, c.full_name, inv.grand_total, inv.paid_total, u.commission_rate
       ORDER BY inv.completed_at DESC
       LIMIT 500
      `,
      [userId, params.from, params.to],
    );
  }

  /**
   * Sales-by-category roll-up per salesperson for a date window.
   *
   * Joins `invoice_items` → `product_variants` → `products` → `categories`,
   * groups by category, returns one row per category that contributed to
   * the salesperson's eligible sales in the window. Items whose product
   * has `category_id IS NULL` are bucketed under category_id = NULL with
   * label "غير مصنّف" so the operator can still see the volume of
   * unclassified sales.
   *
   * Read-only. No accounting writes. Used by the Overview tab's
   * "توزيع المبيعات حسب الفئة" donut panel. Returns an empty array
   * when the salesperson had no items in the window — the frontend
   * renders an honest empty state.
   */
  async categoryBreakdown(
    userId: string,
    params: { from: string; to: string },
  ) {
    if (!params.from || !params.to) {
      throw new BadRequestException('from and to are required');
    }
    return this.ds.query(
      `
      SELECT
          c.id                              AS category_id,
          COALESCE(c.name_ar, 'غير مصنّف') AS category_name,
          COUNT(DISTINCT inv.id)            AS invoices_count,
          SUM(ii.line_total)::numeric(18,2) AS total
        FROM invoices inv
        JOIN invoice_items ii
          ON ii.invoice_id = inv.id
         AND COALESCE(ii.salesperson_id, inv.salesperson_id) = $1
        LEFT JOIN product_variants pv ON pv.id = ii.variant_id
        LEFT JOIN products         p  ON p.id  = pv.product_id
        LEFT JOIN categories       c  ON c.id  = p.category_id
       WHERE inv.status::text IN ('completed', 'paid', 'partially_paid')
         AND inv.completed_at::date BETWEEN $2::date AND $3::date
       GROUP BY c.id, c.name_ar
       ORDER BY total DESC
      `,
      [userId, params.from, params.to],
    );
  }

  async updateRate(userId: string, rate: number) {
    if (rate < 0 || rate > 100) {
      throw new BadRequestException('commission_rate must be between 0 and 100');
    }
    await this.ds.query(
      `UPDATE users SET commission_rate = $1, updated_at = NOW() WHERE id = $2`,
      [rate, userId],
    );
    return { user_id: userId, commission_rate: rate };
  }

  /**
   * PR-T4.6 — read the full seller settings row for the EditProfile
   * modal. Returns all 8 commission/target fields in one round-trip
   * so the form can pre-fill without sequencing multiple queries.
   * Defaults applied for null values:
   *   commission_mode       NULL → 'general' (back-compat)
   *   sales_target_period   NULL → 'none'
   *   is_salesperson        NULL → null (UI infers from sales linkage)
   */
  async getSellerSettings(userId: string) {
    const [row] = await this.ds.query(
      `SELECT id AS user_id,
              COALESCE(is_salesperson, NULL)              AS is_salesperson,
              COALESCE(commission_rate, 0)::numeric       AS commission_rate,
              COALESCE(commission_mode, 'general')        AS commission_mode,
              COALESCE(sales_target_period, 'none')       AS sales_target_period,
              commission_target_amount                    AS sales_target_amount,
              commission_after_target_rate                AS commission_after_target_rate,
              over_target_commission_rate                 AS over_target_commission_rate,
              commission_settings_effective_from          AS effective_from
         FROM users
        WHERE id = $1`,
      [userId],
    );
    if (!row) throw new BadRequestException('user not found');
    return row;
  }

  /**
   * PR-T4.6 — atomic update of all seller settings. Each field
   * independently optional (undefined = leave unchanged, null =
   * clear). Validation:
   *   commission_rate                  ∈ [0, 100]
   *   commission_mode                  ∈ {general,after_target,
   *                                       over_target,general_plus_over_target}
   *   sales_target_period              ∈ {none,daily,weekly,monthly}
   *   sales_target_amount              ≥ 0  or null
   *   commission_after_target_rate     ∈ [0, 100]  or null
   *   over_target_commission_rate      ∈ [0, 100]  or null
   *   effective_from                   ISO date string  or null
   *
   * Cross-field guard: when sales_target_period == 'none' OR null,
   * sales_target_amount is forced to null (target system off).
   */
  async updateSellerSettings(
    userId: string,
    patch: {
      is_salesperson?: boolean | null;
      commission_rate?: number;
      commission_mode?: string;
      sales_target_period?: string;
      sales_target_amount?: number | null;
      commission_after_target_rate?: number | null;
      over_target_commission_rate?: number | null;
      effective_from?: string | null;
    },
  ) {
    const validModes = new Set([
      'general', 'after_target', 'over_target', 'general_plus_over_target',
    ]);
    const validPeriods = new Set(['none', 'daily', 'weekly', 'monthly']);

    if (
      patch.commission_rate !== undefined &&
      (patch.commission_rate < 0 || patch.commission_rate > 100)
    ) {
      throw new BadRequestException('commission_rate must be between 0 and 100');
    }
    if (
      patch.commission_mode !== undefined &&
      !validModes.has(patch.commission_mode)
    ) {
      throw new BadRequestException(
        `commission_mode must be one of ${[...validModes].join(', ')}`,
      );
    }
    if (
      patch.sales_target_period !== undefined &&
      !validPeriods.has(patch.sales_target_period)
    ) {
      throw new BadRequestException(
        `sales_target_period must be one of ${[...validPeriods].join(', ')}`,
      );
    }
    if (
      patch.sales_target_amount !== undefined &&
      patch.sales_target_amount !== null &&
      patch.sales_target_amount < 0
    ) {
      throw new BadRequestException('sales_target_amount must be >= 0 or null');
    }
    for (const k of [
      'commission_after_target_rate',
      'over_target_commission_rate',
    ] as const) {
      const v = patch[k];
      if (v !== undefined && v !== null && (v < 0 || v > 100)) {
        throw new BadRequestException(`${k} must be between 0 and 100 or null`);
      }
    }

    // Cross-field: target_period 'none' implies target_amount = null.
    let effectiveTargetAmount = patch.sales_target_amount;
    if (
      patch.sales_target_period === 'none' &&
      effectiveTargetAmount === undefined
    ) {
      effectiveTargetAmount = null;
    }

    const sets: string[] = [];
    const params: any[] = [userId];
    const push = (col: string, val: any) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (patch.is_salesperson !== undefined) push('is_salesperson', patch.is_salesperson);
    if (patch.commission_rate !== undefined) push('commission_rate', patch.commission_rate);
    if (patch.commission_mode !== undefined) push('commission_mode', patch.commission_mode);
    if (patch.sales_target_period !== undefined) push('sales_target_period', patch.sales_target_period);
    if (effectiveTargetAmount !== undefined) push('commission_target_amount', effectiveTargetAmount);
    if (patch.commission_after_target_rate !== undefined)
      push('commission_after_target_rate', patch.commission_after_target_rate);
    if (patch.over_target_commission_rate !== undefined)
      push('over_target_commission_rate', patch.over_target_commission_rate);
    if (patch.effective_from !== undefined)
      push('commission_settings_effective_from', patch.effective_from);

    if (sets.length === 0) {
      return this.getSellerSettings(userId);
    }
    sets.push(`updated_at = NOW()`);
    await this.ds.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1`,
      params,
    );
    return this.getSellerSettings(userId);
  }

  async listSalespeople() {
    return this.ds.query(
      `
      SELECT u.id, u.username, u.full_name, u.commission_rate, u.is_active,
             r.code AS role_code, r.name_ar AS role_name
        FROM users u
        JOIN roles r ON r.id = u.role_id
       WHERE u.is_active = true
       ORDER BY u.full_name ASC
      `,
    );
  }
}
