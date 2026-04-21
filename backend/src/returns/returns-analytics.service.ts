import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Reads the analytics views from migration 020_returns_analytics.sql
 * to power the Returns Analytics dashboard and the Dashboard widget.
 */
@Injectable()
export class ReturnsAnalyticsService {
  constructor(private readonly ds: DataSource) {}

  async summary() {
    const [row] = await this.ds.query(`SELECT * FROM v_returns_summary`);
    return row || {};
  }

  byReason() {
    return this.ds.query(`SELECT * FROM v_returns_by_reason`);
  }

  topProducts(limit = 20) {
    const l = Math.max(1, Math.min(200, limit));
    return this.ds.query(
      `SELECT * FROM v_returns_top_products LIMIT $1`,
      [l],
    );
  }

  trend(granularity: 'daily' | 'monthly' = 'monthly') {
    if (granularity === 'daily') {
      return this.ds.query(`SELECT * FROM v_returns_trend_daily`);
    }
    return this.ds.query(`SELECT * FROM v_returns_trend_monthly`);
  }

  byCondition() {
    return this.ds.query(`SELECT * FROM v_returns_by_condition`);
  }

  async widget(range?: { from?: string; to?: string }) {
    // If no range supplied, fall back to the legacy 30-day view so existing
    // callers keep working unchanged.
    if (!range?.from || !range?.to) {
      const [row] = await this.ds.query(`SELECT * FROM v_returns_widget`);
      return row || {};
    }

    const [row] = await this.ds.query(
      `
      WITH reasons AS (
        SELECT r.reason::text AS reason, COUNT(*) AS cnt
          FROM returns r
         WHERE r.status IN ('approved','refunded')
           AND (r.requested_at AT TIME ZONE 'Africa/Cairo')::date
               BETWEEN $1::date AND $2::date
         GROUP BY r.reason
         ORDER BY cnt DESC
         LIMIT 3
      ),
      top_products AS (
        SELECT p.name_ar, v.sku, SUM(ri.quantity) AS returned_qty
          FROM return_items ri
          JOIN returns r          ON r.id = ri.return_id
          JOIN product_variants v ON v.id = ri.variant_id
          JOIN products p         ON p.id = v.product_id
         WHERE r.status IN ('approved','refunded')
           AND (r.requested_at AT TIME ZONE 'Africa/Cairo')::date
               BETWEEN $1::date AND $2::date
         GROUP BY p.name_ar, v.sku
         ORDER BY returned_qty DESC
         LIMIT 5
      )
      SELECT
        (SELECT COUNT(*) FROM returns
           WHERE status IN ('approved','refunded')
             AND (requested_at AT TIME ZONE 'Africa/Cairo')::date
                 BETWEEN $1::date AND $2::date)                 AS count_30d,
        (SELECT COALESCE(SUM(net_refund),0) FROM returns
           WHERE status IN ('approved','refunded')
             AND (requested_at AT TIME ZONE 'Africa/Cairo')::date
                 BETWEEN $1::date AND $2::date)                 AS refund_30d,
        (SELECT COUNT(*) FROM returns WHERE status = 'pending') AS pending_count,
        (SELECT COALESCE(json_agg(row_to_json(reasons)), '[]'::json)
           FROM reasons)                                         AS top_reasons,
        (SELECT COALESCE(json_agg(row_to_json(top_products)), '[]'::json)
           FROM top_products)                                    AS top_products
      `,
      [range.from, range.to],
    );
    return row || {};
  }

  async all() {
    const [summary, byReason, top, trendMonthly, trendDaily, byCondition] =
      await Promise.all([
        this.summary(),
        this.byReason(),
        this.topProducts(20),
        this.trend('monthly'),
        this.trend('daily'),
        this.byCondition(),
      ]);
    return {
      summary,
      byReason,
      topProducts: top,
      trendMonthly,
      trendDaily,
      byCondition,
    };
  }
}
