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
