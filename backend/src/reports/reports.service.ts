import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

export type ReportRow = Record<string, any>;

@Injectable()
export class ReportsService {
  constructor(private readonly ds: DataSource) {}

  // ── Sales ──────────────────────────────────────────────────────────────

  async salesByPeriod(from?: string, to?: string, groupBy: 'day' | 'week' | 'month' = 'day') {
    const trunc =
      groupBy === 'month' ? 'month' : groupBy === 'week' ? 'week' : 'day';
    const params: any[] = [];
    const conds: string[] = [`status IN ('completed','paid','partially_paid')`];
    if (from) {
      params.push(from);
      conds.push(`completed_at >= $${params.length}::timestamptz`);
    }
    if (to) {
      params.push(to);
      conds.push(`completed_at < ($${params.length}::timestamptz + interval '1 day')`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const rows = await this.ds.query(
      `
      SELECT
        date_trunc('${trunc}', completed_at) AS period,
        COUNT(*)::int AS invoices_count,
        COALESCE(SUM(grand_total), 0)::numeric AS revenue,
        COALESCE(SUM(paid_amount), 0)::numeric AS collected,
        COALESCE(SUM(discount_amount), 0)::numeric AS discounts,
        COALESCE(AVG(grand_total), 0)::numeric AS avg_ticket
      FROM invoices
      ${where}
      GROUP BY period
      ORDER BY period DESC
      LIMIT 366
      `,
      params,
    );
    return rows;
  }

  async salesPerUser(from?: string, to?: string) {
    const params: any[] = [];
    const conds: string[] = [`i.status IN ('completed','paid','partially_paid')`];
    if (from) {
      params.push(from);
      conds.push(`i.completed_at >= $${params.length}::timestamptz`);
    }
    if (to) {
      params.push(to);
      conds.push(
        `i.completed_at < ($${params.length}::timestamptz + interval '1 day')`,
      );
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    return this.ds.query(
      `
      SELECT
        u.id, u.full_name, u.username,
        COUNT(i.id)::int AS invoices_count,
        COALESCE(SUM(i.grand_total), 0)::numeric AS revenue,
        COALESCE(AVG(i.grand_total), 0)::numeric AS avg_ticket,
        COALESCE(SUM(i.discount_amount), 0)::numeric AS discounts
      FROM users u
      LEFT JOIN invoices i ON i.created_by = u.id
      ${where}
      GROUP BY u.id
      HAVING COUNT(i.id) > 0
      ORDER BY revenue DESC
      `,
      params,
    );
  }

  // ── Profit ─────────────────────────────────────────────────────────────

  async profitByPeriod(from?: string, to?: string) {
    const params: any[] = [];
    const dateCond: string[] = [];
    if (from) {
      params.push(from);
      dateCond.push(`d >= $${params.length}::date`);
    }
    if (to) {
      params.push(to);
      dateCond.push(`d <= $${params.length}::date`);
    }
    const where = dateCond.length ? `WHERE ${dateCond.join(' AND ')}` : '';

    // Sales + COGS from invoices, minus returns + refunds on the same day.
    // Keeps the daily granularity the UI expects.
    return this.ds.query(
      `WITH sales AS (
         SELECT date(i.completed_at)       AS d,
                i.warehouse_id,
                SUM(i.grand_total)::numeric AS revenue,
                SUM(i.cogs_total)::numeric  AS cogs,
                SUM(i.gross_profit)::numeric AS gross_profit
           FROM invoices i
          WHERE i.status IN ('completed','paid','partially_paid')
            AND COALESCE(i.is_return, false) = false
          GROUP BY 1,2
       ),
       rets AS (
         SELECT date(r.requested_at)                AS d,
                r.warehouse_id,
                SUM(r.net_refund)::numeric          AS refund_amount
           FROM returns r
          WHERE r.status IN ('approved','refunded')
          GROUP BY 1,2
       ),
       exp AS (
         SELECT e.expense_date AS d, e.warehouse_id,
                SUM(e.amount)::numeric AS allocated_expenses
           FROM expenses e
           JOIN expense_categories c ON c.id = e.category_id
          WHERE c.allocate_to_cogs = true AND e.is_approved = true
          GROUP BY 1,2
       )
       SELECT s.d AS day, s.warehouse_id,
              s.revenue,
              COALESCE(r.refund_amount,0) AS returns,
              (s.revenue - COALESCE(r.refund_amount,0)) AS net_revenue,
              s.cogs,
              (s.gross_profit - COALESCE(r.refund_amount,0)) AS gross_profit,
              COALESCE(e.allocated_expenses,0) AS allocated_expenses,
              (s.gross_profit - COALESCE(r.refund_amount,0)
                - COALESCE(e.allocated_expenses,0)) AS net_profit
         FROM sales s
         LEFT JOIN rets r ON r.d = s.d AND r.warehouse_id = s.warehouse_id
         LEFT JOIN exp  e ON e.d = s.d AND e.warehouse_id = s.warehouse_id
         ${where.replace(/\bd\b/g, 's.d')}
         ORDER BY s.d DESC
         LIMIT 366`,
      params,
    );
  }

  topProducts(from?: string, to?: string, limit = 50) {
    const params: any[] = [];
    const conds: string[] = [`i.status IN ('completed','paid','partially_paid')`];
    if (from) {
      params.push(from);
      conds.push(`i.completed_at >= $${params.length}::timestamptz`);
    }
    if (to) {
      params.push(to);
      conds.push(
        `i.completed_at < ($${params.length}::timestamptz + interval '1 day')`,
      );
    }
    params.push(limit);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    return this.ds.query(
      `
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        p.sku_root,
        COALESCE(SUM(ii.quantity), 0)::int AS units_sold,
        COALESCE(SUM(ii.line_total), 0)::numeric AS revenue,
        COALESCE(SUM(ii.cost_total), 0)::numeric AS cogs,
        (COALESCE(SUM(ii.line_total), 0) - COALESCE(SUM(ii.cost_total), 0))::numeric AS profit
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      JOIN product_variants pv ON pv.id = ii.variant_id
      JOIN products p ON p.id = pv.product_id
      ${where}
      GROUP BY p.id, p.name, p.sku_root
      ORDER BY units_sold DESC
      LIMIT $${params.length}
      `,
      params,
    );
  }

  // ── Inventory ──────────────────────────────────────────────────────────

  stockValuation() {
    return this.ds.query(
      `
      SELECT
        w.name AS warehouse_name,
        COUNT(DISTINCT pv.id)::int AS variants_count,
        COALESCE(SUM(s.quantity), 0)::int AS total_units,
        COALESCE(SUM(s.quantity * pv.cost_price), 0)::numeric AS total_cost,
        COALESCE(SUM(s.quantity * COALESCE(pv.price_override, p.base_price)), 0)::numeric AS total_retail
      FROM warehouses w
      LEFT JOIN stock s ON s.warehouse_id = w.id AND s.quantity > 0
      LEFT JOIN product_variants pv ON pv.id = s.variant_id
      LEFT JOIN products p ON p.id = pv.product_id
      WHERE w.is_active = true
      GROUP BY w.id, w.name
      ORDER BY total_cost DESC
      `,
    );
  }

  lowStock() {
    return this.ds.query(`SELECT * FROM v_dashboard_low_stock LIMIT 500`);
  }

  // ── Returns ────────────────────────────────────────────────────────────

  returnsReport(from?: string, to?: string) {
    const params: any[] = [];
    const conds: string[] = [];
    if (from) {
      params.push(from);
      conds.push(`r.requested_at >= $${params.length}::timestamptz`);
    }
    if (to) {
      params.push(to);
      conds.push(
        `r.requested_at < ($${params.length}::timestamptz + interval '1 day')`,
      );
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    return this.ds.query(
      `
      SELECT
        r.id, r.return_no, r.status, r.reason,
        r.total_refund::numeric, r.net_refund::numeric,
        r.requested_at, r.refunded_at,
        i.invoice_no,
        c.full_name AS customer_name
      FROM returns r
      LEFT JOIN invoices i ON i.id = r.original_invoice_id
      LEFT JOIN customers c ON c.id = r.customer_id
      ${where}
      ORDER BY r.requested_at DESC
      LIMIT 500
      `,
      params,
    );
  }

  // ── Customers / Suppliers ─────────────────────────────────────────────

  customersOutstanding() {
    return this.ds.query(
      `SELECT
         c.id                              AS customer_id,
         c.id                              AS id,
         c.customer_no,
         c.full_name,
         c.phone,
         COALESCE(c.current_balance, 0)    AS current_balance,
         COALESCE(c.current_balance, 0)    AS outstanding,
         COALESCE(c.credit_limit, 0)       AS credit_limit,
         GREATEST(COALESCE(c.credit_limit,0) - COALESCE(c.current_balance,0), 0)
                                           AS available_credit
       FROM customers c
       WHERE c.deleted_at IS NULL
         AND COALESCE(c.current_balance, 0) > 0
       ORDER BY COALESCE(c.current_balance, 0) DESC
       LIMIT 500`,
    );
  }

  suppliersOutstanding() {
    return this.ds.query(
      `SELECT
         s.id                              AS supplier_id,
         s.id                              AS id,
         s.supplier_no,
         s.name,
         s.phone,
         COALESCE(s.current_balance, 0)    AS current_balance,
         COALESCE(s.current_balance, 0)    AS outstanding,
         COALESCE(s.credit_limit, 0)       AS credit_limit
       FROM suppliers s
       WHERE s.deleted_at IS NULL
         AND COALESCE(s.current_balance, 0) > 0
       ORDER BY COALESCE(s.current_balance, 0) DESC
       LIMIT 500`,
    );
  }

  // ── Export helpers ────────────────────────────────────────────────────

  async toXlsx(rows: ReportRow[], sheetName = 'Report'): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheetName, {
      views: [{ rightToLeft: true }],
    });
    if (rows.length === 0) {
      ws.addRow(['لا توجد بيانات']);
    } else {
      const headers = Object.keys(rows[0]);
      ws.addRow(headers);
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E7FF' },
      };
      for (const r of rows) {
        ws.addRow(headers.map((h) => r[h]));
      }
      headers.forEach((h, idx) => {
        const col = ws.getColumn(idx + 1);
        col.width = Math.max(12, Math.min(32, h.length + 4));
      });
    }
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  async toPdf(
    title: string,
    rows: ReportRow[],
    metadata?: Record<string, any>,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 36 });
        const chunks: Buffer[] = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        doc.fontSize(18).text(title, { align: 'right' });
        doc.moveDown(0.5);
        doc.fontSize(9).fillColor('#6b7280');
        doc.text(`Generated: ${new Date().toISOString()}`, { align: 'right' });
        if (metadata) {
          for (const [k, v] of Object.entries(metadata)) {
            doc.text(`${k}: ${v}`, { align: 'right' });
          }
        }
        doc.moveDown();
        doc.fillColor('#111');

        if (rows.length === 0) {
          doc.text('No data', { align: 'center' });
        } else {
          const headers = Object.keys(rows[0]);
          const colWidth =
            (doc.page.width - doc.page.margins.left - doc.page.margins.right) /
            headers.length;

          // header
          doc.fontSize(10).font('Helvetica-Bold');
          headers.forEach((h, i) => {
            doc.text(h, doc.page.margins.left + i * colWidth, doc.y, {
              width: colWidth,
              continued: i < headers.length - 1,
              align: 'left',
            });
          });
          doc.moveDown(0.2);
          doc
            .moveTo(doc.page.margins.left, doc.y)
            .lineTo(doc.page.width - doc.page.margins.right, doc.y)
            .stroke();
          doc.moveDown(0.3);
          doc.font('Helvetica').fontSize(9);

          // rows
          const startX = doc.page.margins.left;
          for (const r of rows.slice(0, 500)) {
            const y = doc.y;
            headers.forEach((h, i) => {
              const v = r[h];
              const t = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
              doc.text(t.slice(0, 40), startX + i * colWidth, y, {
                width: colWidth,
                continued: false,
                align: 'left',
              });
            });
            doc.moveDown(0.5);
            if (doc.y > doc.page.height - 60) {
              doc.addPage({ size: 'A4', margin: 36 });
            }
          }
        }

        doc.end();
      } catch (e) {
        reject(e);
      }
    });
  }

  // ── Advanced reports ─────────────────────────────────────────────────
  /** Profit margin per product (all-time). */
  profitMargin(limit = 100) {
    return this.ds.query(
      `SELECT * FROM v_profit_margin_per_product
        ORDER BY gross_profit DESC NULLS LAST
        LIMIT $1`,
      [limit],
    );
  }

  /** Slow-moving / dead stock (no sales in 90 days, still in stock). */
  deadStock(limit = 200) {
    return this.ds.query(
      `SELECT * FROM v_dead_stock
        ORDER BY tied_up_capital DESC NULLS LAST
        LIMIT $1`,
      [limit],
    );
  }

  /**
   * Period comparison (current vs previous same-length window).
   * Returns totals for both periods plus percentage change per metric.
   */
  async comparePeriods(fromA: string, toA: string, fromB: string, toB: string) {
    const [a] = await this.ds.query(
      `SELECT
          COALESCE(SUM(grand_total), 0)::numeric AS gross,
          COALESCE(SUM(grand_total - tax_amount), 0)::numeric AS net,
          COUNT(*)::int AS invoices
         FROM invoices
        WHERE status = 'paid'
          AND completed_at >= $1::timestamptz
          AND completed_at <  ($2::timestamptz + interval '1 day')`,
      [fromA, toA],
    );
    const [b] = await this.ds.query(
      `SELECT
          COALESCE(SUM(grand_total), 0)::numeric AS gross,
          COALESCE(SUM(grand_total - tax_amount), 0)::numeric AS net,
          COUNT(*)::int AS invoices
         FROM invoices
        WHERE status = 'paid'
          AND completed_at >= $1::timestamptz
          AND completed_at <  ($2::timestamptz + interval '1 day')`,
      [fromB, toB],
    );

    const pct = (cur: number, prev: number) =>
      prev === 0 ? null : Number((((cur - prev) / prev) * 100).toFixed(2));

    return {
      period_a: { from: fromA, to: toA, ...a },
      period_b: { from: fromB, to: toB, ...b },
      change: {
        gross_pct: pct(Number(a.gross), Number(b.gross)),
        net_pct: pct(Number(a.net), Number(b.net)),
        invoices_pct: pct(a.invoices, b.invoices),
      },
    };
  }

  /** Daily sales series for charting. */
  salesDaily(from: string, to: string) {
    return this.ds.query(
      `SELECT * FROM v_sales_daily
        WHERE day >= $1::date AND day <= $2::date
        ORDER BY day`,
      [from, to],
    );
  }

  // ── Payment channels (PR-REPORTS-2) ───────────────────────────────────
  /**
   * Same per-method + per-account roll-up as
   * `DashboardService.paymentChannels`, but extended with cashbox /
   * cashier / shift-status filters so the /shift-reports
   * payment-channel report can match the all-shifts report exactly.
   *
   * Reads only — no writes, no migrations. The dashboard widget keeps
   * calling its own date-only endpoint so its behaviour is unchanged.
   *
   * Cashbox + status filters reach the invoice via its `shift_id`
   * (LEFT JOIN, so invoices without a shift are still counted by the
   * date-only path). User filter goes straight to `i.cashier_id` since
   * every paid invoice has one.
   */
  async paymentChannels(opts: {
    from?: string;
    to?: string;
    cashbox_id?: string;
    user_id?: string;
    /** Shift status: 'open' | 'closed' | 'pending_close' | 'all' */
    status?: string;
  }) {
    const fromDate = opts.from || this.todayCairoIso();
    const toDate = opts.to || this.todayCairoIso();

    const params: any[] = [fromDate, toDate];
    const extraJoinNeeded = !!(opts.cashbox_id || (opts.status && opts.status !== 'all'));
    const conds: string[] = [
      `i.status IN ('paid','completed','partially_paid')`,
      `(COALESCE(i.completed_at, i.created_at) AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1::date AND $2::date`,
    ];

    if (opts.cashbox_id) {
      params.push(opts.cashbox_id);
      conds.push(`s.cashbox_id = $${params.length}`);
    }
    if (opts.user_id) {
      params.push(opts.user_id);
      conds.push(`i.cashier_id = $${params.length}`);
    }
    if (opts.status && opts.status !== 'all') {
      params.push(opts.status);
      conds.push(`s.status = $${params.length}`);
    }

    // Cashbox + shift status need the shift row; cashbox-filtered rows
    // also implicitly require a shift_id (no shift → no cashbox), so an
    // INNER JOIN there is correct. For status-only we still INNER-join
    // because invoices without a shift have no status. Otherwise we
    // skip the join entirely so the date-only path matches the
    // dashboard widget byte-for-byte.
    const shiftJoin = extraJoinNeeded
      ? `JOIN shifts s ON s.id = i.shift_id`
      : '';

    const rows = await this.ds.query(
      `
      SELECT ip.payment_method::text                AS method,
             ip.payment_account_id,
             pa.display_name                        AS live_display_name,
             pa.identifier                          AS live_identifier,
             pa.provider_key                        AS live_provider_key,
             ip.payment_account_snapshot            AS snap,
             COALESCE(SUM(ip.amount),0)::numeric(18,2) AS amount,
             COUNT(*)::int                              AS payment_count,
             COUNT(DISTINCT ip.invoice_id)::int         AS invoice_count
        FROM invoice_payments ip
        JOIN invoices i        ON i.id = ip.invoice_id
        ${shiftJoin}
   LEFT JOIN payment_accounts pa ON pa.id = ip.payment_account_id
       WHERE ${conds.join(' AND ')}
       GROUP BY ip.payment_method, ip.payment_account_id, pa.display_name,
                pa.identifier, pa.provider_key, ip.payment_account_snapshot
      `,
      params,
    );

    const METHOD_LABEL_AR: Record<string, string> = {
      cash: 'كاش',
      card_visa: 'فيزا',
      card_mastercard: 'ماستركارد',
      card_meeza: 'ميزة',
      instapay: 'إنستا باي',
      vodafone_cash: 'فودافون كاش',
      orange_cash: 'أورانج كاش',
      wallet: 'محفظة إلكترونية',
      bank_transfer: 'تحويل بنكي',
      credit: 'آجل',
      other: 'أخرى',
    };

    type AccountRow = {
      payment_account_id: string | null;
      display_name: string | null;
      identifier: string | null;
      provider_key: string | null;
      total_amount: number;
      invoice_count: number;
      payment_count: number;
    };
    type MethodRow = {
      method: string;
      method_label_ar: string;
      total_amount: number;
      invoice_count: number;
      payment_count: number;
      accounts: AccountRow[];
    };

    const methodMap = new Map<string, MethodRow>();
    for (const r of rows) {
      const method = r.method as string;
      let bucket = methodMap.get(method);
      if (!bucket) {
        bucket = {
          method,
          method_label_ar: METHOD_LABEL_AR[method] || method,
          total_amount: 0,
          invoice_count: 0,
          payment_count: 0,
          accounts: [],
        };
        methodMap.set(method, bucket);
      }
      const amt = Number(r.amount);
      const invs = Number(r.invoice_count);
      const pays = Number(r.payment_count);
      bucket.total_amount += amt;
      bucket.invoice_count += invs;
      bucket.payment_count += pays;

      const snap = r.snap || null;
      const display = r.live_display_name ?? snap?.display_name ?? null;
      const identifier = r.live_identifier ?? snap?.identifier ?? null;
      const provider = r.live_provider_key ?? snap?.provider_key ?? null;
      bucket.accounts.push({
        payment_account_id: r.payment_account_id ?? null,
        display_name: display,
        identifier,
        provider_key: provider,
        total_amount: amt,
        invoice_count: invs,
        payment_count: pays,
      });
    }
    for (const m of methodMap.values()) {
      m.accounts.sort((a, b) => b.total_amount - a.total_amount);
    }
    const channels = Array.from(methodMap.values()).sort(
      (a, b) => b.total_amount - a.total_amount,
    );

    const cashTotal = channels
      .filter((m) => m.method === 'cash')
      .reduce((s, m) => s + m.total_amount, 0);
    const nonCashTotal = channels
      .filter((m) => m.method !== 'cash')
      .reduce((s, m) => s + m.total_amount, 0);
    const grandTotal = cashTotal + nonCashTotal;

    const pct = (n: number) =>
      grandTotal > 0 ? Math.round((n / grandTotal) * 10000) / 100 : 0;

    const channelsWithShare = channels.map((m) => ({
      ...m,
      share_pct: pct(m.total_amount),
      accounts: m.accounts.map((a) => ({
        ...a,
        share_pct: pct(a.total_amount),
      })),
    }));

    return {
      range: { from: fromDate, to: toDate },
      filters: {
        cashbox_id: opts.cashbox_id ?? null,
        user_id: opts.user_id ?? null,
        status: opts.status ?? null,
      },
      cash_total: cashTotal,
      non_cash_total: nonCashTotal,
      grand_total: grandTotal,
      channels: channelsWithShare,
    };
  }

  private todayCairoIso(): string {
    const d = new Date();
    const cairo = new Date(d.toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${cairo.getFullYear()}-${pad(cairo.getMonth() + 1)}-${pad(cairo.getDate())}`;
  }
}
