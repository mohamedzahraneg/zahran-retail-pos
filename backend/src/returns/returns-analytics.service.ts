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

  async widget() {
    const [row] = await this.ds.query(`SELECT * FROM v_returns_widget`);
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
