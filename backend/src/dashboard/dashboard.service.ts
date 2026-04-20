import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Reads the 13 views built in migration 015_dashboard_views.sql
 */
@Injectable()
export class DashboardService {
  constructor(private readonly ds: DataSource) {}

  async overview() {
    const [rawToday] = await this.ds.query(`SELECT * FROM v_dashboard_today`);
    const [cashflow] = await this.ds.query(
      `SELECT * FROM v_dashboard_cashflow_today`,
    );
    const revenue30 = await this.ds.query(
      `SELECT * FROM v_dashboard_revenue_30d ORDER BY day ASC`,
    );
    const paymentMix = await this.ds.query(
      `SELECT * FROM v_dashboard_payment_mix_30d`,
    );
    const topProducts = await this.ds.query(
      `SELECT * FROM v_dashboard_top_products_30d LIMIT 10`,
    );
    const topCustomers = await this.ds.query(
      `SELECT * FROM v_dashboard_top_customers_90d LIMIT 10`,
    );
    const cashierPerf = await this.ds.query(
      `SELECT * FROM v_dashboard_cashier_performance`,
    );
    const lowStock = await this.ds.query(
      `SELECT * FROM v_dashboard_low_stock LIMIT 20`,
    );
    const reservations = await this.ds.query(
      `SELECT * FROM v_dashboard_reservations_expiring LIMIT 20`,
    );
    const alerts = await this.ds.query(
      `SELECT * FROM v_dashboard_alerts_feed LIMIT 20`,
    );

    // New customers today (UI metric)
    const [{ c: newCustomers }] = await this.ds.query(
      `SELECT COUNT(*)::int AS c FROM customers
        WHERE (created_at AT TIME ZONE 'Africa/Cairo')::date
              = (now() AT TIME ZONE 'Africa/Cairo')::date`,
    );

    const invoiceCount = Number(rawToday?.invoices_today || 0);
    const revenueToday = Number(rawToday?.revenue_today || 0);

    // Expose BOTH the original DB field names and friendly aliases
    // the UI expects (revenue, invoice_count, items_sold, avg_invoice, new_customers).
    const today = {
      ...rawToday,
      revenue: revenueToday,
      profit: Number(rawToday?.profit_today || 0),
      invoice_count: invoiceCount,
      items_sold: Number(rawToday?.units_sold_today || 0),
      new_customers: Number(newCustomers || 0),
      avg_invoice: invoiceCount > 0 ? revenueToday / invoiceCount : 0,
      expenses: Number(rawToday?.expenses_today || 0),
      cashbox_balance: Number(rawToday?.cashboxes_balance || 0),
      receivables: Number(rawToday?.customers_receivable || 0),
      payables: Number(rawToday?.suppliers_payable || 0),
    };

    return {
      today,
      cashflow,
      revenue30,
      paymentMix,
      topProducts,
      topCustomers,
      cashierPerf,
      lowStock,
      reservations,
      alerts,
    };
  }

  smart() {
    return Promise.all([
      this.ds.query(
        `SELECT * FROM v_smart_reorder_suggestions ORDER BY urgency DESC LIMIT 50`,
      ),
      this.ds.query(
        `SELECT * FROM v_smart_dead_stock ORDER BY days_since_last_sale DESC LIMIT 50`,
      ),
      this.ds.query(
        `SELECT * FROM v_smart_loss_warnings ORDER BY loss_amount DESC LIMIT 50`,
      ),
    ]).then(([reorder, dead, loss]) => ({ reorder, dead, loss }));
  }

  revenue(days: number = 30) {
    const d = Math.max(1, Math.min(365, days));
    return this.ds.query(
      `SELECT * FROM v_dashboard_revenue_30d WHERE day >= (now() AT TIME ZONE 'Africa/Cairo')::date - ($1::int - 1) ORDER BY day ASC`,
      [d],
    );
  }

  today() {
    return this.ds.query(`SELECT * FROM v_dashboard_today`);
  }

  alerts(limit = 50) {
    return this.ds.query(
      `SELECT * FROM v_dashboard_alerts_feed LIMIT $1`,
      [limit],
    );
  }
}
