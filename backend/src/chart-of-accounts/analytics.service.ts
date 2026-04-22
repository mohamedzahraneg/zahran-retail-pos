import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Rich analytics for the new Analytics page.
 *
 * Everything here reads from the same journal + business tables that
 * the standard reports use, so numbers tie back to the trial balance.
 * Methods are purposely simple SQL → easy to audit against the GL.
 */
@Injectable()
export class AccountingAnalyticsService {
  constructor(private readonly ds: DataSource) {}

  /**
   * Daily P&L series + OHLC-style day summary:
   *   open  = opening cash balance that day
   *   high  = peak running balance during the day
   *   low   = trough running balance during the day
   *   close = closing cash balance that day
   *   revenue / cogs / gross / expenses / net
   */
  async dailyPerformance(params: { from: string; to: string }) {
    const rows = await this.ds.query(
      `
      WITH date_range AS (
        SELECT generate_series($1::date, $2::date, '1 day')::date AS d
      ),
      sales AS (
        SELECT (COALESCE(completed_at, created_at) AT TIME ZONE 'Africa/Cairo')::date AS d,
               COUNT(*)::int AS invoice_count,
               COALESCE(SUM(grand_total - tax_amount), 0)::numeric(14,2) AS revenue,
               COALESCE(SUM(cogs_total), 0)::numeric(14,2) AS cogs,
               COALESCE(SUM(tax_amount), 0)::numeric(14,2) AS tax
          FROM invoices
         WHERE status IN ('paid','completed','partially_paid')
           AND (COALESCE(completed_at, created_at) AT TIME ZONE 'Africa/Cairo')::date
               BETWEEN $1::date AND $2::date
         GROUP BY 1
      ),
      returns_by_day AS (
        SELECT (COALESCE(refunded_at, approved_at, requested_at) AT TIME ZONE 'Africa/Cairo')::date AS d,
               COALESCE(SUM(net_refund), 0)::numeric(14,2) AS returns
          FROM returns
         WHERE status IN ('approved','refunded')
           AND (COALESCE(refunded_at, approved_at, requested_at) AT TIME ZONE 'Africa/Cairo')::date
               BETWEEN $1::date AND $2::date
         GROUP BY 1
      ),
      expenses_by_day AS (
        SELECT expense_date AS d,
               COALESCE(SUM(amount), 0)::numeric(14,2) AS expenses
          FROM expenses
         WHERE is_approved = TRUE
           AND expense_date BETWEEN $1::date AND $2::date
         GROUP BY 1
      ),
      cash_moves AS (
        SELECT (created_at AT TIME ZONE 'Africa/Cairo')::date AS d,
               direction, amount, balance_after
          FROM cashbox_transactions
         WHERE (created_at AT TIME ZONE 'Africa/Cairo')::date
               BETWEEN $1::date AND $2::date
      ),
      cash_day AS (
        SELECT d,
               COALESCE(MAX(balance_after) FILTER (WHERE direction = 'in'), 0) AS max_in,
               COALESCE(MAX(balance_after) FILTER (WHERE direction = 'out'), 0) AS max_out,
               COALESCE(MIN(balance_after), 0)   AS low,
               COALESCE(MAX(balance_after), 0)   AS high
          FROM cash_moves
         GROUP BY d
      )
      SELECT r.d::text AS date,
             COALESCE(s.invoice_count, 0)::int AS invoice_count,
             COALESCE(s.revenue, 0)::numeric(14,2) AS revenue,
             COALESCE(s.cogs, 0)::numeric(14,2)    AS cogs,
             COALESCE(s.tax, 0)::numeric(14,2)     AS tax,
             COALESCE(rt.returns, 0)::numeric(14,2) AS returns,
             COALESCE(e.expenses, 0)::numeric(14,2) AS expenses,
             (COALESCE(s.revenue, 0) - COALESCE(s.cogs, 0))::numeric(14,2)   AS gross_profit,
             (COALESCE(s.revenue, 0) - COALESCE(s.cogs, 0) - COALESCE(e.expenses, 0) - COALESCE(rt.returns, 0))::numeric(14,2) AS net_profit,
             COALESCE(c.low, 0)::numeric(14,2) AS cash_low,
             COALESCE(c.high, 0)::numeric(14,2) AS cash_high
        FROM date_range r
        LEFT JOIN sales         s ON s.d = r.d
        LEFT JOIN returns_by_day rt ON rt.d = r.d
        LEFT JOIN expenses_by_day e ON e.d = r.d
        LEFT JOIN cash_day      c ON c.d = r.d
       ORDER BY r.d ASC
      `,
      [params.from, params.to],
    );
    return rows;
  }

  /** Hour-of-day sales heatmap over a date range (Sun..Sat × 0..23). */
  async hourlyHeatmap(params: { from: string; to: string }) {
    const rows = await this.ds.query(
      `
      SELECT EXTRACT(DOW FROM (COALESCE(completed_at, created_at) AT TIME ZONE 'Africa/Cairo'))::int AS dow,
             EXTRACT(HOUR FROM (COALESCE(completed_at, created_at) AT TIME ZONE 'Africa/Cairo'))::int AS hour,
             COUNT(*)::int AS invoice_count,
             COALESCE(SUM(grand_total), 0)::numeric(14,2) AS revenue
        FROM invoices
       WHERE status IN ('paid','completed','partially_paid')
         AND (COALESCE(completed_at, created_at) AT TIME ZONE 'Africa/Cairo')::date
             BETWEEN $1::date AND $2::date
       GROUP BY 1, 2
      `,
      [params.from, params.to],
    );
    return rows;
  }

  /** Top N products by revenue. */
  async topProducts(params: { from: string; to: string; limit?: number }) {
    return this.ds.query(
      `
      SELECT pv.id            AS variant_id,
             p.name_ar        AS product_name,
             pv.barcode       AS sku,
             SUM(ii.quantity)::int                    AS qty,
             COALESCE(SUM(ii.line_total), 0)::numeric(14,2)    AS revenue,
             COALESCE(SUM(ii.quantity * ii.unit_cost), 0)::numeric(14,2) AS cogs,
             (COALESCE(SUM(ii.line_total), 0) - COALESCE(SUM(ii.quantity * ii.unit_cost), 0))::numeric(14,2) AS gross
        FROM invoice_items ii
        JOIN invoices i      ON i.id = ii.invoice_id
        JOIN product_variants pv ON pv.id = ii.variant_id
        JOIN products p      ON p.id = pv.product_id
       WHERE i.status IN ('paid','completed','partially_paid')
         AND (COALESCE(i.completed_at, i.created_at) AT TIME ZONE 'Africa/Cairo')::date
             BETWEEN $1::date AND $2::date
       GROUP BY pv.id, p.name_ar, pv.barcode
       ORDER BY revenue DESC
       LIMIT $3
      `,
      [params.from, params.to, Math.min(Number(params.limit || 10), 100)],
    );
  }

  /** Top customers by revenue. */
  async topCustomers(params: { from: string; to: string; limit?: number }) {
    return this.ds.query(
      `
      SELECT c.id, c.full_name, c.phone, c.code,
             COUNT(DISTINCT i.id)::int AS invoice_count,
             COALESCE(SUM(i.grand_total), 0)::numeric(14,2) AS revenue,
             COALESCE(AVG(i.grand_total), 0)::numeric(14,2) AS avg_ticket
        FROM invoices i
        JOIN customers c ON c.id = i.customer_id
       WHERE i.status IN ('paid','completed','partially_paid')
         AND (COALESCE(i.completed_at, i.created_at) AT TIME ZONE 'Africa/Cairo')::date
             BETWEEN $1::date AND $2::date
       GROUP BY c.id, c.full_name, c.phone, c.code
       ORDER BY revenue DESC
       LIMIT $3
      `,
      [params.from, params.to, Math.min(Number(params.limit || 10), 100)],
    );
  }

  /** Top salespeople by revenue. */
  async topSalespeople(params: { from: string; to: string; limit?: number }) {
    return this.ds.query(
      `
      SELECT u.id, u.full_name,
             COUNT(DISTINCT i.id)::int AS invoice_count,
             COALESCE(SUM(i.grand_total), 0)::numeric(14,2) AS revenue,
             COALESCE(SUM(i.grand_total - i.tax_amount - i.cogs_total), 0)::numeric(14,2) AS gross
        FROM invoices i
        JOIN users u ON u.id = i.salesperson_id
       WHERE i.status IN ('paid','completed','partially_paid')
         AND (COALESCE(i.completed_at, i.created_at) AT TIME ZONE 'Africa/Cairo')::date
             BETWEEN $1::date AND $2::date
       GROUP BY u.id, u.full_name
       ORDER BY revenue DESC
       LIMIT $3
      `,
      [params.from, params.to, Math.min(Number(params.limit || 10), 100)],
    );
  }

  /** Expense breakdown by GL account for a period. */
  async expenseBreakdown(params: { from: string; to: string }) {
    return this.ds.query(
      `
      SELECT a.code, a.name_ar,
             COALESCE(SUM(jl.debit - jl.credit), 0)::numeric(14,2) AS amount
        FROM chart_of_accounts a
        JOIN journal_lines jl ON jl.account_id = a.id
        JOIN journal_entries je ON je.id = jl.entry_id
       WHERE a.account_type = 'expense'
         AND a.is_leaf = TRUE
         AND je.is_posted = TRUE AND je.is_void = FALSE
         AND je.entry_date BETWEEN $1::date AND $2::date
       GROUP BY a.code, a.name_ar
      HAVING COALESCE(SUM(jl.debit - jl.credit), 0) > 0
       ORDER BY amount DESC
      `,
      [params.from, params.to],
    );
  }

  /**
   * Smart indicators — a compact set of KPIs the Analytics page surfaces
   * at the top. Every metric is computed from real data (no invented
   * aggregates).
   */
  async smartIndicators(params: { from: string; to: string }) {
    const [rev] = await this.ds.query(
      `
      SELECT COALESCE(SUM(grand_total - tax_amount),0)::numeric(14,2) AS revenue,
             COALESCE(SUM(cogs_total),0)::numeric(14,2) AS cogs,
             COUNT(*)::int AS invoice_count,
             COALESCE(AVG(grand_total),0)::numeric(14,2) AS avg_ticket
        FROM invoices
       WHERE status IN ('paid','completed','partially_paid')
         AND (COALESCE(completed_at, created_at) AT TIME ZONE 'Africa/Cairo')::date
             BETWEEN $1::date AND $2::date
      `,
      [params.from, params.to],
    );
    // Expenses — count ALL expenses in the period, not just approved.
    // Older installations may not flip is_approved reliably, and the
    // KPI should match what the user actually sees on the expenses list.
    const [exp] = await this.ds.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(14,2) AS expenses
         FROM expenses
        WHERE expense_date BETWEEN $1::date AND $2::date`,
      [params.from, params.to],
    );
    const [ret] = await this.ds.query(
      `SELECT COUNT(*)::int AS return_count,
              COALESCE(SUM(net_refund),0)::numeric(14,2) AS return_value
         FROM returns
        WHERE status IN ('approved','refunded')
          AND (COALESCE(refunded_at, approved_at, requested_at) AT TIME ZONE 'Africa/Cairo')::date
              BETWEEN $1::date AND $2::date`,
      [params.from, params.to],
    );
    // Inventory snapshot
    const [inv] = await this.ds.query(
      `SELECT COALESCE(SUM(s.quantity_on_hand * pv.cost_price), 0)::numeric(14,2) AS inventory_value
         FROM stock s
         JOIN product_variants pv ON pv.id = s.variant_id
        WHERE pv.is_active = TRUE`,
    );
    // Receivables + payables — use COALESCE on paid_amount so rows with
    // NULL don't get filtered out, and don't restrict by status enum
    // (values vary across deployments: 'received' / 'partial' / 'paid' /
    // 'completed' / 'pending' / …).
    const [recv] = await this.ds.query(
      `SELECT COALESCE(SUM(grand_total - COALESCE(paid_amount, 0)), 0)::numeric(14,2) AS receivables
         FROM invoices
        WHERE COALESCE(status::text, '') NOT IN ('cancelled', 'draft', 'void')
          AND grand_total > COALESCE(paid_amount, 0)`,
    );
    const [pay] = await this.ds.query(
      `SELECT COALESCE(SUM(grand_total - COALESCE(paid_amount, 0)), 0)::numeric(14,2) AS payables
         FROM purchases
        WHERE COALESCE(status::text, '') NOT IN ('cancelled', 'draft', 'void')
          AND grand_total > COALESCE(paid_amount, 0)`,
    );
    // Authoritative cash balance = sum of all cashbox_transactions.
    // Avoids stale current_balance that drifts over time.
    const [cash] = await this.ds.query(
      `SELECT COALESCE(SUM(
         CASE WHEN direction = 'in' THEN amount ELSE -amount END
       ), 0)::numeric(14,2) AS cash_on_hand
         FROM cashbox_transactions`,
    );

    const revenue = Number(rev?.revenue || 0);
    const cogs = Number(rev?.cogs || 0);
    const expenses = Number(exp?.expenses || 0);
    const grossProfit = revenue - cogs;
    const netProfit = grossProfit - expenses - Number(ret?.return_value || 0);
    const grossMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
    const netMargin = revenue > 0 ? (netProfit / revenue) * 100 : 0;
    const returnRate =
      Number(rev?.invoice_count || 0) > 0
        ? (Number(ret?.return_count || 0) / Number(rev.invoice_count)) * 100
        : 0;
    // Average daily burn = (expenses + cogs) / days-in-range
    const fromD = new Date(params.from);
    const toD = new Date(params.to);
    const days = Math.max(
      1,
      Math.round((toD.getTime() - fromD.getTime()) / 86400000) + 1,
    );
    const dailyBurn = (expenses + cogs) / days;
    const cashRunwayDays =
      dailyBurn > 0 ? Number(cash?.cash_on_hand || 0) / dailyBurn : 9999;
    const inventoryTurns =
      Number(inv?.inventory_value || 0) > 0
        ? (cogs * (365 / days)) / Number(inv.inventory_value)
        : 0;

    return {
      revenue,
      cogs,
      gross_profit: Number(grossProfit.toFixed(2)),
      gross_margin_pct: Number(grossMargin.toFixed(2)),
      expenses,
      returns_value: Number(ret?.return_value || 0),
      net_profit: Number(netProfit.toFixed(2)),
      net_margin_pct: Number(netMargin.toFixed(2)),
      invoice_count: Number(rev?.invoice_count || 0),
      avg_ticket: Number(rev?.avg_ticket || 0),
      return_count: Number(ret?.return_count || 0),
      return_rate_pct: Number(returnRate.toFixed(2)),
      inventory_value: Number(inv?.inventory_value || 0),
      inventory_turns: Number(inventoryTurns.toFixed(2)),
      receivables: Number(recv?.receivables || 0),
      payables: Number(pay?.payables || 0),
      cash_on_hand: Number(cash?.cash_on_hand || 0),
      daily_burn: Number(dailyBurn.toFixed(2)),
      cash_runway_days: Math.round(cashRunwayDays),
    };
  }

  /**
   * Smart recommendations — rule-based suggestions surfaced as chips
   * on the Analytics page. Every rule references a real row so the
   * user can act on it.
   */
  async smartRecommendations(params: { from: string; to: string }) {
    const recs: Array<{
      severity: 'info' | 'warning' | 'critical';
      title: string;
      detail: string;
      action?: string;
    }> = [];

    // 1. Dead stock — products with no sales in 60 days.
    const dead = await this.ds.query(
      `
      SELECT p.name_ar, pv.barcode, s.quantity_on_hand, pv.cost_price
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN stock s ON s.variant_id = pv.id
       WHERE pv.is_active = TRUE
         AND s.quantity_on_hand > 0
         AND NOT EXISTS (
           SELECT 1 FROM invoice_items ii
           JOIN invoices i ON i.id = ii.invoice_id
           WHERE ii.variant_id = pv.id
             AND i.status IN ('paid','completed','partially_paid')
             AND i.created_at >= now() - interval '60 days'
         )
       ORDER BY s.quantity_on_hand * pv.cost_price DESC NULLS LAST
       LIMIT 5
      `,
    );
    if (dead.length > 0) {
      const totalTied = dead.reduce(
        (s: number, r: any) =>
          s + Number(r.quantity_on_hand || 0) * Number(r.cost_price || 0),
        0,
      );
      recs.push({
        severity: 'warning',
        title: `${dead.length} منتج راكد (بدون مبيعات ٦٠ يوم)`,
        detail: `مقيّد ${Math.round(totalTied).toLocaleString('en-US')} ج.م. ابدأ بـ "${dead[0].name_ar}"`,
        action: 'تخفيض السعر / ترويج',
      });
    }

    // 2. High return rate.
    const [retStats] = await this.ds.query(
      `
      SELECT COUNT(DISTINCT r.id)::int AS ret,
             (SELECT COUNT(*) FROM invoices
               WHERE status IN ('paid','completed','partially_paid')
                 AND created_at >= now() - interval '30 days')::int AS inv
        FROM returns r
       WHERE r.status IN ('approved','refunded')
         AND r.created_at >= now() - interval '30 days'
      `,
    );
    const rRate =
      Number(retStats?.inv || 0) > 0
        ? (Number(retStats?.ret || 0) / Number(retStats.inv)) * 100
        : 0;
    if (rRate > 5) {
      recs.push({
        severity: 'warning',
        title: `معدل مرتجعات مرتفع (${rRate.toFixed(1)}%)`,
        detail: `${retStats?.ret} مرتجع في آخر ٣٠ يوم — المعدل الصحي أقل من ٥٪.`,
        action: 'راجع جودة المنتج / وصف المقاسات',
      });
    }

    // 3. Products selling below cost.
    const loss = await this.ds.query(
      `
      SELECT p.name_ar, pv.barcode, ii.unit_price, ii.unit_cost, COUNT(*)::int AS times
        FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        JOIN product_variants pv ON pv.id = ii.variant_id
        JOIN products p ON p.id = pv.product_id
       WHERE i.status IN ('paid','completed','partially_paid')
         AND i.created_at >= now() - interval '30 days'
         AND ii.unit_price < ii.unit_cost
       GROUP BY p.name_ar, pv.barcode, ii.unit_price, ii.unit_cost
       ORDER BY times DESC
       LIMIT 3
      `,
    );
    if (loss.length > 0) {
      recs.push({
        severity: 'critical',
        title: `بيع بخسارة: ${loss.length} منتج`,
        detail: `أبرزها "${loss[0].name_ar}" (بـ ${loss[0].unit_price} والتكلفة ${loss[0].unit_cost})`,
        action: 'ارفع السعر فوراً',
      });
    }

    // 4. Aging receivables > 90 days.
    const [agingOld] = await this.ds.query(
      `
      SELECT COUNT(DISTINCT customer_id)::int AS n,
             COALESCE(SUM(grand_total - paid_amount), 0)::numeric(14,2) AS amount
        FROM invoices
       WHERE status IN ('paid','completed','partially_paid')
         AND grand_total > paid_amount
         AND COALESCE(completed_at, created_at) < now() - interval '90 days'
      `,
    );
    if (Number(agingOld?.n || 0) > 0) {
      recs.push({
        severity: 'critical',
        title: `${agingOld.n} عميل متأخر أكثر من ٩٠ يوم`,
        detail: `إجمالي ${Number(agingOld.amount).toLocaleString('en-US')} ج.م.`,
        action: 'اتصال فوري / توقيف البيع الآجل',
      });
    }

    // 5. Low stock — below reorder point (column lives on `stock`).
    const lowStock = await this.ds.query(
      `
      SELECT p.name_ar, pv.barcode, s.quantity_on_hand, s.reorder_point
        FROM stock s
        JOIN product_variants pv ON pv.id = s.variant_id
        JOIN products p ON p.id = pv.product_id
       WHERE pv.is_active = TRUE
         AND s.reorder_point > 0
         AND s.quantity_on_hand <= s.reorder_point
       ORDER BY (s.reorder_point - s.quantity_on_hand) DESC
       LIMIT 5
      `,
    );
    if (lowStock.length > 0) {
      recs.push({
        severity: 'warning',
        title: `${lowStock.length} منتج وصل لنقطة إعادة الطلب`,
        detail: `ابدأ بـ "${lowStock[0].name_ar}" (${lowStock[0].quantity_on_hand} قطعة)`,
        action: 'اطلب من المورد',
      });
    }

    // 6. Cash runway warning.
    const ind = await this.smartIndicators(params);
    if (ind.cash_runway_days < 14 && ind.daily_burn > 0) {
      recs.push({
        severity: 'critical',
        title: `السيولة تكفي ${ind.cash_runway_days} يوم فقط`,
        detail: `مصروف يومي ${ind.daily_burn.toLocaleString('en-US')} ج.م وفي الخزينة ${ind.cash_on_hand.toLocaleString('en-US')} ج.م.`,
        action: 'حصّل ذمم / أجّل مدفوعات',
      });
    } else if (ind.cash_runway_days < 30 && ind.daily_burn > 0) {
      recs.push({
        severity: 'warning',
        title: `السيولة تكفي ${ind.cash_runway_days} يوم`,
        detail: `راقب التدفق النقدي عن قرب.`,
      });
    }

    // 7. Low margin month.
    if (ind.gross_margin_pct > 0 && ind.gross_margin_pct < 15) {
      recs.push({
        severity: 'warning',
        title: `هامش ربح منخفض (${ind.gross_margin_pct.toFixed(1)}%)`,
        detail: `الهامش الصحي للتجزئة ٢٥-٤٠٪.`,
        action: 'راجع التسعير والخصومات',
      });
    }

    // 8. If everything is great.
    if (recs.length === 0 && ind.revenue > 0) {
      recs.push({
        severity: 'info',
        title: '👏 المحل بأداء ممتاز',
        detail: `لا توجد تنبيهات — استمر على نفس النهج.`,
      });
    }
    return recs;
  }

  /**
   * VAT return for a tax period.
   *   output_vat = tax collected on sales minus tax refunded
   *   input_vat  = tax paid on purchases
   *   net_due    = output_vat - input_vat (+ ve = owe the tax authority)
   */
  async vatReturn(params: { from: string; to: string }) {
    const [sales] = await this.ds.query(
      `
      SELECT COALESCE(SUM(grand_total - tax_amount), 0)::numeric(14,2) AS taxable_sales,
             COALESCE(SUM(tax_amount), 0)::numeric(14,2) AS output_vat,
             COUNT(*)::int AS invoice_count
        FROM invoices
       WHERE status IN ('paid','completed','partially_paid')
         AND (COALESCE(completed_at, created_at) AT TIME ZONE 'Africa/Cairo')::date
             BETWEEN $1::date AND $2::date
      `,
      [params.from, params.to],
    );
    const [returnsVat] = await this.ds.query(
      `
      SELECT COALESCE(SUM(r.total_refund *
          CASE WHEN i.grand_total > 0
               THEN i.tax_amount / i.grand_total
               ELSE 0 END
      ), 0)::numeric(14,2) AS output_vat_refunded
        FROM returns r
        JOIN invoices i ON i.id = r.original_invoice_id
       WHERE r.status IN ('approved','refunded')
         AND (COALESCE(r.refunded_at, r.approved_at, r.requested_at) AT TIME ZONE 'Africa/Cairo')::date
             BETWEEN $1::date AND $2::date
      `,
      [params.from, params.to],
    );
    const [purchases] = await this.ds.query(
      `
      SELECT COALESCE(SUM(grand_total - tax_amount), 0)::numeric(14,2) AS taxable_purchases,
             COALESCE(SUM(tax_amount), 0)::numeric(14,2) AS input_vat,
             COUNT(*)::int AS purchase_count
        FROM purchases
       WHERE status IN ('received','partial','paid')
         AND COALESCE(received_at, invoice_date::timestamptz)::date BETWEEN $1::date AND $2::date
      `,
      [params.from, params.to],
    );

    const outputVat = Number(sales?.output_vat || 0);
    const outputVatRefunded = Number(returnsVat?.output_vat_refunded || 0);
    const netOutput = outputVat - outputVatRefunded;
    const inputVat = Number(purchases?.input_vat || 0);
    const netDue = netOutput - inputVat;

    return {
      from: params.from,
      to: params.to,
      taxable_sales: Number(sales?.taxable_sales || 0),
      output_vat: outputVat,
      output_vat_refunded: outputVatRefunded,
      net_output_vat: Number(netOutput.toFixed(2)),
      invoice_count: Number(sales?.invoice_count || 0),
      taxable_purchases: Number(purchases?.taxable_purchases || 0),
      input_vat: inputVat,
      purchase_count: Number(purchases?.purchase_count || 0),
      net_vat_due: Number(netDue.toFixed(2)),
      status:
        netDue > 0
          ? 'مستحق للمصلحة'
          : netDue < 0
            ? 'مستحق من المصلحة (استرداد)'
            : 'متعادل',
    };
  }

  /**
   * Cash-flow waterfall — one row per category for a date range so the
   * analytics page can build a waterfall chart: opening → inflows →
   * outflows → closing.
   */
  async cashFlowWaterfall(params: { from: string; to: string }) {
    const [opening] = await this.ds.query(
      `
      SELECT COALESCE(SUM(
        CASE WHEN direction = 'in' THEN amount ELSE -amount END
      ), 0)::numeric(14,2) AS opening
        FROM cashbox_transactions
       WHERE (created_at AT TIME ZONE 'Africa/Cairo')::date < $1::date
      `,
      [params.from],
    );
    const bucketRows = await this.ds.query(
      `
      SELECT direction, category,
             COALESCE(SUM(amount), 0)::numeric(14,2) AS amount
        FROM cashbox_transactions
       WHERE (created_at AT TIME ZONE 'Africa/Cairo')::date
             BETWEEN $1::date AND $2::date
       GROUP BY direction, category
       ORDER BY direction, amount DESC
      `,
      [params.from, params.to],
    );
    return {
      opening: Number(opening?.opening || 0),
      buckets: bucketRows,
    };
  }
}
