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
    // Salesperson performance — last 30d sales attributed to a salesperson.
    const salespersonPerf = await this.ds.query(`
      SELECT sp.id          AS user_id,
             sp.full_name   AS full_name,
             sp.username    AS username,
             COUNT(DISTINCT i.id)::int       AS invoices,
             COALESCE(SUM(i.grand_total), 0) AS revenue,
             COALESCE(SUM(i.gross_profit), 0) AS profit
      FROM users sp
      LEFT JOIN invoices i
             ON i.salesperson_id = sp.id
            AND i.status IN ('paid','completed')
            AND i.completed_at >= NOW() - INTERVAL '30 days'
      WHERE EXISTS (
              SELECT 1 FROM invoices i2 WHERE i2.salesperson_id = sp.id
            )
         OR sp.role_id IN (SELECT id FROM roles WHERE code = 'salesperson')
      GROUP BY sp.id, sp.full_name, sp.username
      ORDER BY revenue DESC
      LIMIT 10
    `);
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
      salespersonPerf,
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

  /**
   * Analytics aggregate for any [from, to] date range (inclusive).
   * Defaults to today if both arguments are omitted.
   */
  async analytics(from?: string, to?: string) {
    const fromDate = from || this.today_iso();
    const toDate = to || this.today_iso();

    const [totals] = await this.ds.query(
      `
      SELECT
        COUNT(*)::int                                 AS invoices,
        COALESCE(SUM(grand_total), 0)::numeric(14,2)  AS revenue,
        COALESCE(SUM(cogs_total), 0)::numeric(14,2)   AS cogs,
        COALESCE(SUM(gross_profit), 0)::numeric(14,2) AS profit,
        COALESCE(SUM(invoice_discount + items_discount_total + coupon_discount), 0)::numeric(14,2) AS discounts
      FROM invoices
      WHERE status IN ('paid','completed','partially_paid')
        AND (COALESCE(completed_at, created_at) AT TIME ZONE 'Africa/Cairo')::date
            BETWEEN $1::date AND $2::date
      `,
      [fromDate, toDate],
    );

    const [expensesRow] = await this.ds.query(
      `
      SELECT COALESCE(SUM(amount), 0)::numeric(14,2) AS expenses
      FROM expenses
      WHERE expense_date BETWEEN $1::date AND $2::date
      `,
      [fromDate, toDate],
    );

    const [returnsRow] = await this.ds.query(
      `
      SELECT
        COUNT(*)::int                                 AS returns_count,
        COALESCE(SUM(net_refund), 0)::numeric(14,2)   AS returns_amount
      FROM returns
      WHERE status IN ('approved','refunded')
        AND (requested_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1::date AND $2::date
      `,
      [fromDate, toDate],
    );

    const revenue = Number(totals.revenue);
    const cogs = Number(totals.cogs);
    const profit = Number(totals.profit);
    const expenses = Number(expensesRow.expenses);
    const returnsAmount = Number(returnsRow.returns_amount);
    const net = profit - expenses - returnsAmount;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

    // Product performance: best + worst + losing (items that sold below cost).
    const productPerf = await this.ds.query(
      `
      SELECT
        p.id                                          AS product_id,
        p.name_ar,
        SUM(ii.quantity)::int                         AS units_sold,
        COALESCE(SUM(ii.line_total), 0)::numeric(14,2) AS revenue,
        COALESCE(SUM(ii.quantity * ii.unit_cost), 0)::numeric(14,2) AS cogs,
        COALESCE(SUM(ii.line_total - (ii.quantity * ii.unit_cost)), 0)::numeric(14,2) AS profit,
        CASE WHEN SUM(ii.line_total) > 0
             THEN ROUND((SUM(ii.line_total - (ii.quantity * ii.unit_cost)) / NULLIF(SUM(ii.line_total),0)) * 100, 2)
             ELSE 0 END                               AS margin_pct
      FROM invoice_items ii
      JOIN invoices i       ON i.id = ii.invoice_id
      JOIN product_variants v ON v.id = ii.variant_id
      JOIN products p       ON p.id = v.product_id
      WHERE i.status IN ('paid','completed','partially_paid')
        AND (COALESCE(i.completed_at, i.created_at) AT TIME ZONE 'Africa/Cairo')::date
            BETWEEN $1::date AND $2::date
      GROUP BY p.id, p.name_ar
      HAVING SUM(ii.quantity) > 0
      `,
      [fromDate, toDate],
    );
    // Best = highest profit, losing = negative profit, worst = smallest margin among profitable.
    const sortedByProfit = [...productPerf].sort(
      (a: any, b: any) => Number(b.profit) - Number(a.profit),
    );
    // "الأفضل ربحاً" must only include products that actually made a profit.
    // A loss-making item showing up here was misleading the user.
    const topProducts = sortedByProfit
      .filter((p: any) => Number(p.profit) > 0)
      .slice(0, 10);
    const losingProducts = productPerf
      .filter((p: any) => Number(p.profit) < 0)
      .sort((a: any, b: any) => Number(a.profit) - Number(b.profit))
      .slice(0, 10);
    const worstProducts = sortedByProfit
      .filter((p: any) => Number(p.profit) > 0)
      .slice(-10)
      .reverse();

    // Share of total profit per product — useful for the "% of profit" column.
    const totalProfit = sortedByProfit.reduce(
      (s: number, p: any) => s + Number(p.profit || 0),
      0,
    );
    const withShare = (list: any[]) =>
      list.map((p) => ({
        ...p,
        profit_share_pct:
          totalProfit > 0
            ? Math.round((Number(p.profit) / totalProfit) * 10000) / 100
            : 0,
      }));

    return {
      range: { from: fromDate, to: toDate },
      totals: {
        invoices: Number(totals.invoices),
        revenue,
        cogs,
        profit,
        margin_pct: Math.round(margin * 100) / 100,
        discounts: Number(totals.discounts),
        expenses,
        returns_count: Number(returnsRow.returns_count),
        returns_amount: returnsAmount,
        net,
      },
      topProducts: withShare(topProducts),
      losingProducts: withShare(losingProducts),
      worstProducts: withShare(worstProducts),
    };
  }

  private today_iso() {
    const d = new Date();
    const cairo = new Date(d.toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${cairo.getFullYear()}-${pad(cairo.getMonth() + 1)}-${pad(cairo.getDate())}`;
  }
}
