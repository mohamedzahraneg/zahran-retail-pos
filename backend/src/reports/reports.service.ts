import { BadRequestException, Injectable } from '@nestjs/common';
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

  // ──────────────────────────────────────────────────────────────────────
  //  PR-PURCHASES-P3.4A — Pricing reports (read-only)
  //
  //  Strictly SELECT-only — never writes to product_variants, prices,
  //  variant_price_history, journal_entries, journal_lines,
  //  cashbox_transactions, stock_movements, supplier_ledger,
  //  purchase_items, or purchases. The static guardrail spec
  //  `reports.service.pricing.spec.ts` enforces this with regex scans.
  //
  //  Formulas (clearly labeled — markup vs margin):
  //    profit     = selling_price - cost_price
  //    markup_pct = (selling_price - cost_price) / cost_price * 100
  //    margin_pct = (selling_price - cost_price) / selling_price * 100
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Report A — Current pricing health per variant.
   *
   * Computes margin / markup / pricing_status for every active
   * variant, joined with the current stock total (across all
   * warehouses), product name, and the min_margin_pct policy
   * threshold (product-level override, falling back to the global
   * setting `smart_pricing.min_margin_pct_default`).
   */
  async pricingHealth(filters: {
    q?: string;
    status?: 'ok' | 'below_min_margin' | 'below_cost' | 'no_price' | 'unknown_cost';
    only_in_stock?: boolean;
    limit?: number;
  } = {}) {
    const params: any[] = [];
    const conds: string[] = ['pv.is_active = TRUE', 'pv.deleted_at IS NULL'];
    if (filters.q) {
      params.push(`%${filters.q.trim()}%`);
      conds.push(
        `(p.name_ar ILIKE $${params.length} OR pv.sku ILIKE $${params.length} OR pv.barcode ILIKE $${params.length})`,
      );
    }
    if (filters.only_in_stock) {
      conds.push(`COALESCE(stock_sum.qty, 0) > 0`);
    }
    const where = `WHERE ${conds.join(' AND ')}`;
    const limit = Math.min(Math.max(1, Number(filters.limit) || 500), 5000);

    const rows = await this.ds.query(
      `
      WITH
      min_margin_default AS (
        SELECT COALESCE(
          (SELECT (value)::text::numeric
             FROM settings
            WHERE key = 'smart_pricing.min_margin_pct_default'
            LIMIT 1),
          15
        ) AS pct
      ),
      stock_sum AS (
        SELECT variant_id, SUM(quantity_on_hand)::int AS qty
          FROM stock
         GROUP BY variant_id
      )
      SELECT
        pv.id                                       AS variant_id,
        pv.sku,
        pv.barcode,
        c.name_ar                                   AS color,
        s.size_label                                AS size,
        p.id                                        AS product_id,
        p.name_ar                                   AS product_name,
        p.product_type,
        pv.cost_price                               AS cost_price,
        COALESCE(NULLIF(pv.selling_price, 0), p.base_price) AS selling_price,
        COALESCE(p.min_margin_pct, (SELECT pct FROM min_margin_default))::numeric(6,2)
                                                    AS min_margin_pct,
        COALESCE(stock_sum.qty, 0)                  AS stock_qty,
        ROUND(COALESCE(stock_sum.qty, 0) * pv.cost_price, 2)
                                                    AS stock_value_at_cost
      FROM product_variants pv
      JOIN products p   ON p.id = pv.product_id
      LEFT JOIN colors c ON c.id = pv.color_id
      LEFT JOIN sizes  s ON s.id = pv.size_id
      LEFT JOIN stock_sum ON stock_sum.variant_id = pv.id
      ${where}
      ORDER BY p.name_ar, pv.sku
      LIMIT ${limit}
      `,
      params,
    );

    // Compute status / margin / markup in JS so the SQL stays portable
    // and the math matches the frontend helper exactly.
    const enriched = rows.map((r: any) => {
      const cost = Number(r.cost_price || 0);
      const sell = Number(r.selling_price || 0);
      const profit = +(sell - cost).toFixed(2);
      const markup_pct =
        cost > 0 ? +((profit / cost) * 100).toFixed(2) : null;
      const margin_pct =
        sell > 0 ? +((profit / sell) * 100).toFixed(2) : null;
      const min_pct = Number(r.min_margin_pct || 0);
      let status: string;
      if (!(cost > 0)) status = 'unknown_cost';
      else if (!(sell > 0)) status = 'no_price';
      else if (sell < cost) status = 'below_cost';
      else if (margin_pct !== null && margin_pct < min_pct)
        status = 'below_min_margin';
      else status = 'ok';
      const qty = Number(r.stock_qty || 0);
      const potential_revenue = +(qty * sell).toFixed(2);
      const potential_profit = +(qty * profit).toFixed(2);
      return {
        variant_id: r.variant_id,
        product_id: r.product_id,
        product_name: r.product_name,
        product_type: r.product_type,
        sku: r.sku,
        barcode: r.barcode,
        color: r.color,
        size: r.size,
        cost_price: cost,
        selling_price: sell,
        profit,
        markup_pct,
        margin_pct,
        min_margin_pct: min_pct,
        status,
        stock_qty: qty,
        stock_value_at_cost: Number(r.stock_value_at_cost || 0),
        potential_revenue,
        potential_profit,
      };
    });

    const filtered = filters.status
      ? enriched.filter((r: any) => r.status === filters.status)
      : enriched;

    const summary = {
      total_variants: filtered.length,
      below_cost: filtered.filter((r: any) => r.status === 'below_cost').length,
      below_min_margin: filtered.filter(
        (r: any) => r.status === 'below_min_margin',
      ).length,
      no_price: filtered.filter((r: any) => r.status === 'no_price').length,
      unknown_cost: filtered.filter((r: any) => r.status === 'unknown_cost')
        .length,
      ok: filtered.filter((r: any) => r.status === 'ok').length,
      stock_value_at_cost: +filtered
        .reduce((s: number, r: any) => s + (r.stock_value_at_cost || 0), 0)
        .toFixed(2),
      potential_revenue: +filtered
        .reduce((s: number, r: any) => s + (r.potential_revenue || 0), 0)
        .toFixed(2),
      potential_profit: +filtered
        .reduce((s: number, r: any) => s + (r.potential_profit || 0), 0)
        .toFixed(2),
    };

    return { summary, items: filtered };
  }

  /**
   * Report B — Loss / below-min-margin products.
   * Convenience filter on top of pricingHealth(), pre-sorted by the
   * largest potential loss.
   */
  async pricingLosses(filters: { only_in_stock?: boolean; limit?: number } = {}) {
    const base = await this.pricingHealth({
      only_in_stock: filters.only_in_stock,
      limit: filters.limit,
    });
    const items = base.items
      .filter((r: any) =>
        ['below_cost', 'below_min_margin'].includes(r.status),
      )
      .map((r: any) => ({
        ...r,
        // Negative profit per piece × stock_qty = total exposure for
        // below-cost items; for below-min-margin we surface the gap
        // between the current margin and the floor as Δ pct.
        loss_exposure:
          r.status === 'below_cost'
            ? +(r.stock_qty * Math.min(0, r.profit)).toFixed(2)
            : 0,
        margin_gap_pct:
          r.status === 'below_min_margin' && r.margin_pct != null
            ? +(r.min_margin_pct - r.margin_pct).toFixed(2)
            : null,
      }))
      .sort((a: any, b: any) => {
        const lossA = a.loss_exposure || 0;
        const lossB = b.loss_exposure || 0;
        if (lossA !== lossB) return lossA - lossB; // most negative first
        const gapA = a.margin_gap_pct ?? 0;
        const gapB = b.margin_gap_pct ?? 0;
        if (gapA !== gapB) return gapB - gapA; // biggest gap first
        return b.stock_qty - a.stock_qty;
      });
    return {
      summary: {
        below_cost: items.filter((r: any) => r.status === 'below_cost').length,
        below_min_margin: items.filter(
          (r: any) => r.status === 'below_min_margin',
        ).length,
        total_loss_exposure: +items
          .reduce(
            (s: number, r: any) => s + (r.loss_exposure || 0),
            0,
          )
          .toFixed(2),
      },
      items,
    };
  }

  /**
   * Report C — Variant price change history (from variant_price_history,
   * introduced in P3.2). Joined with product/variant name + the user
   * who applied the change + the source purchase number when present.
   */
  async pricingHistory(filters: {
    variant_id?: string;
    from?: string;
    to?: string;
    limit?: number;
  } = {}) {
    const params: any[] = [];
    const conds: string[] = ['1=1'];
    if (filters.variant_id) {
      params.push(filters.variant_id);
      conds.push(`vph.variant_id = $${params.length}`);
    }
    if (filters.from) {
      params.push(filters.from);
      conds.push(`vph.changed_at >= $${params.length}::timestamptz`);
    }
    if (filters.to) {
      params.push(filters.to);
      conds.push(
        `vph.changed_at < ($${params.length}::timestamptz + interval '1 day')`,
      );
    }
    const where = `WHERE ${conds.join(' AND ')}`;
    const limit = Math.min(Math.max(1, Number(filters.limit) || 500), 5000);

    const rows = await this.ds.query(
      `
      SELECT
        vph.id,
        vph.variant_id,
        vph.old_selling_price,
        vph.new_selling_price,
        (vph.new_selling_price - vph.old_selling_price)::numeric(14,2)
          AS delta_amount,
        CASE
          WHEN vph.old_selling_price > 0
          THEN ROUND(
            (vph.new_selling_price - vph.old_selling_price)
              / vph.old_selling_price * 100, 2)
          ELSE NULL
        END                                       AS delta_pct,
        vph.source_purchase_id,
        vph.source_purchase_no,
        vph.reason,
        vph.changed_by,
        u.full_name                               AS changed_by_name,
        vph.changed_at,
        pv.sku,
        pv.barcode,
        p.id                                      AS product_id,
        p.name_ar                                 AS product_name
      FROM variant_price_history vph
      JOIN product_variants pv ON pv.id = vph.variant_id
      JOIN products p           ON p.id = pv.product_id
      LEFT JOIN users u         ON u.id = vph.changed_by
      ${where}
      ORDER BY vph.changed_at DESC
      LIMIT ${limit}
      `,
      params,
    );
    return {
      summary: {
        total: rows.length,
        last_change: rows[0]?.changed_at ?? null,
      },
      items: rows,
    };
  }

  /**
   * Report D — Last-purchase landed cost impact per variant.
   *
   * For each variant that has at least one received-purchase line,
   * surfaces the most recent purchase + landed breakdown + the
   * current selling price + the implied margin, so the operator can
   * see "is my current price still healthy after this last cost?".
   */
  async pricingLandedImpact(filters: {
    supplier_id?: string;
    needs_review_only?: boolean;
    limit?: number;
  } = {}) {
    const params: any[] = [];
    const conds: string[] = ['1=1'];
    if (filters.supplier_id) {
      params.push(filters.supplier_id);
      conds.push(`p_last.supplier_id = $${params.length}`);
    }
    const where = `WHERE ${conds.join(' AND ')}`;
    const limit = Math.min(Math.max(1, Number(filters.limit) || 500), 5000);

    const rows = await this.ds.query(
      `
      WITH
      min_margin_default AS (
        SELECT COALESCE(
          (SELECT (value)::text::numeric
             FROM settings
            WHERE key = 'smart_pricing.min_margin_pct_default'
            LIMIT 1),
          15
        ) AS pct
      ),
      last_purchases AS (
        SELECT DISTINCT ON (pi.variant_id)
          pi.variant_id,
          pi.purchase_id,
          pi.quantity,
          pi.base_unit_cost,
          pi.allocated_cost_total,
          pi.allocated_cost_per_unit,
          pi.unit_cost                AS landed_unit_cost,
          pi.manual_allocation
        FROM purchase_items pi
        JOIN purchases pu ON pu.id = pi.purchase_id
        WHERE pu.status IN ('received', 'partial', 'paid')
        ORDER BY pi.variant_id, pu.received_at DESC NULLS LAST,
                 pu.invoice_date DESC, pu.created_at DESC
      )
      SELECT
        pv.id                              AS variant_id,
        pv.sku,
        pv.barcode,
        p.id                               AS product_id,
        p.name_ar                          AS product_name,
        COALESCE(NULLIF(pv.selling_price, 0), p.base_price)
                                           AS selling_price,
        pv.cost_price                      AS current_cost_price,
        lp.base_unit_cost,
        lp.allocated_cost_per_unit,
        lp.landed_unit_cost,
        lp.manual_allocation,
        p_last.id                          AS purchase_id,
        p_last.purchase_no,
        p_last.supplier_id,
        s.name                             AS supplier_name,
        p_last.received_at,
        p_last.invoice_date,
        COALESCE(prod.min_margin_pct, (SELECT pct FROM min_margin_default))::numeric(6,2)
                                           AS min_margin_pct
      FROM last_purchases lp
      JOIN product_variants pv ON pv.id = lp.variant_id
      JOIN products prod        ON prod.id = pv.product_id
      JOIN products p           ON p.id = pv.product_id
      JOIN purchases p_last     ON p_last.id = lp.purchase_id
      LEFT JOIN suppliers s     ON s.id = p_last.supplier_id
      ${where}
      ORDER BY p_last.received_at DESC NULLS LAST, p_last.invoice_date DESC
      LIMIT ${limit}
      `,
      params,
    );

    const items = rows.map((r: any) => {
      const cost = Number(r.landed_unit_cost ?? r.current_cost_price ?? 0);
      const sell = Number(r.selling_price || 0);
      const profit = +(sell - cost).toFixed(2);
      const markup_pct =
        cost > 0 ? +((profit / cost) * 100).toFixed(2) : null;
      const margin_pct =
        sell > 0 ? +((profit / sell) * 100).toFixed(2) : null;
      const min_pct = Number(r.min_margin_pct || 0);
      let needs_review = false;
      let needs_review_reason: string | null = null;
      if (!(sell > 0)) {
        needs_review = true;
        needs_review_reason = 'no_price';
      } else if (sell < cost) {
        needs_review = true;
        needs_review_reason = 'below_cost';
      } else if (margin_pct !== null && margin_pct < min_pct) {
        needs_review = true;
        needs_review_reason = 'below_min_margin';
      }
      return {
        variant_id: r.variant_id,
        product_id: r.product_id,
        product_name: r.product_name,
        sku: r.sku,
        barcode: r.barcode,
        last_purchase: {
          purchase_id: r.purchase_id,
          purchase_no: r.purchase_no,
          supplier_id: r.supplier_id,
          supplier_name: r.supplier_name,
          received_at: r.received_at,
          invoice_date: r.invoice_date,
          manual_allocation: r.manual_allocation,
        },
        base_unit_cost: Number(r.base_unit_cost || 0),
        allocated_cost_per_unit: Number(r.allocated_cost_per_unit || 0),
        landed_unit_cost: cost,
        current_selling_price: sell,
        profit,
        markup_pct,
        margin_pct,
        min_margin_pct: min_pct,
        needs_review,
        needs_review_reason,
      };
    });

    const filtered = filters.needs_review_only
      ? items.filter((r: any) => r.needs_review)
      : items;
    return {
      summary: {
        total: filtered.length,
        needs_review: filtered.filter((r: any) => r.needs_review).length,
      },
      items: filtered,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  //  PR-PURCHASES-P3.4B — Actual sold profit reports (read-only)
  //
  //  Computes gross sold-profit from posted invoice_items joined to
  //  invoices, using:
  //    line_revenue = quantity × unit_price - discount_amount
  //    line_cogs    = quantity × unit_cost       (cost frozen at sale)
  //    gross_profit = line_revenue - line_cogs
  //
  //  Status filter: invoices.status IN ('completed','paid','partially_paid')
  //                 AND NOT invoices.is_return
  //  Returns are SEPARATE invoices with is_return=TRUE — they are
  //  EXCLUDED from the aggregates (gross sales view, matching the
  //  legacy v_product_profit semantics). Net-of-returns is deferred
  //  to P3.4D.
  //
  //  STRICTLY SELECT-only — no writes to product_variants /
  //  variant_price_history / journal_entries / journal_lines /
  //  cashbox_transactions / stock_movements / supplier_ledger /
  //  purchase_items / purchases / settings. The static guardrail
  //  spec asserts this with regex scans.
  // ──────────────────────────────────────────────────────────────────────

  private soldProfitWhere(
    params: any[],
    from?: string,
    to?: string,
  ): string {
    const conds: string[] = [
      `i.status IN ('completed','paid','partially_paid')`,
      `NOT i.is_return`,
    ];
    if (from) {
      params.push(from);
      conds.push(
        `COALESCE(i.completed_at, i.created_at) >= $${params.length}::timestamptz`,
      );
    }
    if (to) {
      params.push(to);
      conds.push(
        `COALESCE(i.completed_at, i.created_at) < ($${params.length}::timestamptz + interval '1 day')`,
      );
    }
    return `WHERE ${conds.join(' AND ')}`;
  }

  /** Report S — sold-profit summary across the date range. */
  async soldProfitSummary(filters: { from?: string; to?: string } = {}) {
    const params: any[] = [];
    const where = this.soldProfitWhere(params, filters.from, filters.to);
    // One round-trip: aggregate totals + counts in a CTE, then
    // pluck the top / worst per-product in two small follow-ups.
    const [agg] = await this.ds.query(
      `
      WITH lines AS (
        SELECT
          ii.invoice_id,
          ii.variant_id,
          pv.product_id,
          ii.quantity::int                                          AS qty,
          (ii.quantity * ii.unit_price - ii.discount_amount)::numeric AS revenue,
          (ii.quantity * ii.unit_cost)::numeric                       AS cogs
        FROM invoice_items ii
        JOIN product_variants pv ON pv.id = ii.variant_id
        JOIN invoices i           ON i.id = ii.invoice_id
        ${where}
      )
      SELECT
        COALESCE(SUM(revenue), 0)::numeric        AS total_revenue,
        COALESCE(SUM(cogs), 0)::numeric           AS total_cogs,
        COALESCE(SUM(revenue) - SUM(cogs), 0)::numeric AS gross_profit,
        COALESCE(SUM(qty), 0)::int                AS total_qty_sold,
        COUNT(DISTINCT invoice_id)::int           AS invoice_count,
        COUNT(DISTINCT product_id)::int           AS product_count,
        COUNT(DISTINCT variant_id)::int           AS variant_count
      FROM lines
      `,
      params,
    );

    const revenue = Number(agg?.total_revenue || 0);
    const cogs = Number(agg?.total_cogs || 0);
    const gross_profit = +(revenue - cogs).toFixed(2);
    const gross_margin_pct =
      revenue > 0 ? +((gross_profit / revenue) * 100).toFixed(2) : null;
    const markup_pct =
      cogs > 0 ? +((gross_profit / cogs) * 100).toFixed(2) : null;
    const qty = Number(agg?.total_qty_sold || 0);
    const avg_profit_per_unit =
      qty > 0 ? +(gross_profit / qty).toFixed(2) : null;

    // Top profit product + worst margin product — two small SELECTs
    // sharing the same WHERE.
    const [top] = await this.ds.query(
      `
      WITH lines AS (
        SELECT
          pv.product_id,
          p.name_ar                                                 AS product_name,
          (ii.quantity * ii.unit_price - ii.discount_amount)::numeric AS revenue,
          (ii.quantity * ii.unit_cost)::numeric                       AS cogs
        FROM invoice_items ii
        JOIN product_variants pv ON pv.id = ii.variant_id
        JOIN products p           ON p.id = pv.product_id
        JOIN invoices i           ON i.id = ii.invoice_id
        ${where}
      )
      SELECT
        product_id,
        product_name,
        SUM(revenue) - SUM(cogs)                  AS gross_profit
      FROM lines
      GROUP BY product_id, product_name
      ORDER BY gross_profit DESC
      LIMIT 1
      `,
      params,
    );
    const [worst] = await this.ds.query(
      `
      WITH lines AS (
        SELECT
          pv.product_id,
          p.name_ar                                                 AS product_name,
          (ii.quantity * ii.unit_price - ii.discount_amount)::numeric AS revenue,
          (ii.quantity * ii.unit_cost)::numeric                       AS cogs
        FROM invoice_items ii
        JOIN product_variants pv ON pv.id = ii.variant_id
        JOIN products p           ON p.id = pv.product_id
        JOIN invoices i           ON i.id = ii.invoice_id
        ${where}
      ),
      agg AS (
        SELECT
          product_id, product_name,
          SUM(revenue) AS revenue,
          SUM(cogs)    AS cogs,
          SUM(revenue) - SUM(cogs) AS gross_profit
        FROM lines
        GROUP BY product_id, product_name
      )
      SELECT
        product_id, product_name, revenue, cogs, gross_profit,
        CASE WHEN revenue > 0
             THEN ROUND(gross_profit / revenue * 100, 2)
             ELSE NULL
        END AS gross_margin_pct
      FROM agg
      WHERE revenue > 0
      ORDER BY (gross_profit / revenue) ASC
      LIMIT 1
      `,
      params,
    );

    return {
      from: filters.from ?? null,
      to: filters.to ?? null,
      total_revenue: +revenue.toFixed(2),
      total_cogs: +cogs.toFixed(2),
      gross_profit,
      gross_margin_pct,
      markup_pct,
      total_qty_sold: qty,
      invoice_count: Number(agg?.invoice_count || 0),
      product_count: Number(agg?.product_count || 0),
      variant_count: Number(agg?.variant_count || 0),
      avg_profit_per_unit,
      top_profit_product: top
        ? {
            product_id: top.product_id,
            product_name: top.product_name,
            gross_profit: +Number(top.gross_profit || 0).toFixed(2),
          }
        : null,
      worst_margin_product: worst
        ? {
            product_id: worst.product_id,
            product_name: worst.product_name,
            gross_profit: +Number(worst.gross_profit || 0).toFixed(2),
            gross_margin_pct:
              worst.gross_margin_pct == null
                ? null
                : Number(worst.gross_margin_pct),
          }
        : null,
    };
  }

  /** Report P — per-variant sold-profit. */
  async soldProfitProducts(filters: {
    q?: string;
    from?: string;
    to?: string;
    status?: 'loss' | 'low_margin' | 'ok' | 'unknown_cost';
    limit?: number;
    sort?:
      | 'gross_profit_desc'
      | 'gross_profit_asc'
      | 'margin_desc'
      | 'margin_asc'
      | 'qty_desc';
  } = {}) {
    const limit = Math.min(Math.max(1, Number(filters.limit) || 500), 5000);
    const minMarginParam = `(SELECT COALESCE(
        (SELECT (value)::text::numeric
           FROM settings
          WHERE key = 'smart_pricing.min_margin_pct_default'
          LIMIT 1),
        15
      ))`;

    // Build the WHERE inline so the optional `q` filter shares the
    // same params array. We can't index ii.* directly,
    // but for catalog-size N the per-row filter is cheap.
    const conds: string[] = [
      `i.status IN ('completed','paid','partially_paid')`,
      `NOT i.is_return`,
    ];
    const params2: any[] = [];
    if (filters.from) {
      params2.push(filters.from);
      conds.push(
        `COALESCE(i.completed_at, i.created_at) >= $${params2.length}::timestamptz`,
      );
    }
    if (filters.to) {
      params2.push(filters.to);
      conds.push(
        `COALESCE(i.completed_at, i.created_at) < ($${params2.length}::timestamptz + interval '1 day')`,
      );
    }
    if (filters.q) {
      params2.push(`%${filters.q.trim()}%`);
      const idx = params2.length;
      conds.push(
        `(p.name_ar ILIKE $${idx} OR pv.sku ILIKE $${idx} OR pv.barcode ILIKE $${idx})`,
      );
    }
    const whereWithQ = `WHERE ${conds.join(' AND ')}`;

    const rows = await this.ds.query(
      `
      WITH lines AS (
        SELECT
          pv.id                                                       AS variant_id,
          pv.product_id,
          p.name_ar                                                   AS product_name,
          pv.sku,
          pv.barcode,
          c.name_ar                                                   AS color,
          s.size_label                                                AS size,
          ii.invoice_id,
          ii.quantity::int                                            AS qty,
          (ii.quantity * ii.unit_price - ii.discount_amount)::numeric AS revenue,
          (ii.quantity * ii.unit_cost)::numeric                       AS cogs,
          ii.unit_price,
          ii.unit_cost,
          COALESCE(i.completed_at, i.created_at)                      AS sold_at
        FROM invoice_items ii
        JOIN product_variants pv ON pv.id = ii.variant_id
        JOIN products p           ON p.id = pv.product_id
        LEFT JOIN colors c        ON c.id = pv.color_id
        LEFT JOIN sizes  s        ON s.id = pv.size_id
        JOIN invoices i           ON i.id = ii.invoice_id
        ${whereWithQ}
      ),
      agg AS (
        -- HOTFIX: previously aggregated the per-variant metadata via
        -- MAX(...). That fails with the Postgres error
        --   function max(uuid) does not exist
        -- for product_id (and defensively for any other id columns).
        -- These fields are functionally dependent on variant_id, so
        -- the correct approach is to include them in GROUP BY —
        -- same result row, no aggregate needed.
        -- sold_at stays as MAX(...) because the per-variant LATEST
        -- sale across multiple invoices IS semantic (last_sold_at).
        SELECT
          variant_id,
          product_id,
          product_name,
          sku,
          barcode,
          color,
          size,
          SUM(qty)::int                            AS qty_sold,
          SUM(revenue)::numeric                    AS revenue,
          SUM(cogs)::numeric                       AS cogs,
          (SUM(revenue) - SUM(cogs))::numeric      AS gross_profit,
          CASE WHEN SUM(qty) > 0
               THEN ROUND(SUM(revenue) / SUM(qty), 2)
               ELSE NULL END                       AS avg_selling_price,
          CASE WHEN SUM(qty) > 0
               THEN ROUND(SUM(cogs) / SUM(qty), 2)
               ELSE NULL END                       AS avg_unit_cost,
          COUNT(DISTINCT invoice_id)::int          AS invoice_count,
          MAX(sold_at)                             AS last_sold_at
        FROM lines
        GROUP BY variant_id, product_id, product_name, sku, barcode, color, size
      )
      SELECT
        agg.*,
        ${minMarginParam} AS min_margin_pct
      FROM agg
      ORDER BY gross_profit DESC NULLS LAST
      LIMIT ${limit}
      `,
      params2,
    );

    const items = rows.map((r: any) => {
      const revenue = Number(r.revenue || 0);
      const cogs = Number(r.cogs || 0);
      const gross_profit = +(revenue - cogs).toFixed(2);
      const gross_margin_pct =
        revenue > 0 ? +((gross_profit / revenue) * 100).toFixed(2) : null;
      const markup_pct =
        cogs > 0 ? +((gross_profit / cogs) * 100).toFixed(2) : null;
      const min_pct = Number(r.min_margin_pct || 15);
      let status: 'loss' | 'low_margin' | 'ok' | 'unknown_cost';
      if (Number(r.avg_unit_cost || 0) === 0 || cogs === 0) {
        status = 'unknown_cost';
      } else if (gross_profit < 0) {
        status = 'loss';
      } else if (
        gross_margin_pct !== null
        && gross_margin_pct < min_pct
      ) {
        status = 'low_margin';
      } else {
        status = 'ok';
      }
      return {
        variant_id: r.variant_id,
        product_id: r.product_id,
        product_name: r.product_name,
        sku: r.sku,
        barcode: r.barcode,
        color: r.color,
        size: r.size,
        qty_sold: Number(r.qty_sold || 0),
        revenue: +revenue.toFixed(2),
        cogs: +cogs.toFixed(2),
        gross_profit,
        gross_margin_pct,
        markup_pct,
        avg_selling_price:
          r.avg_selling_price == null
            ? null
            : Number(r.avg_selling_price),
        avg_unit_cost:
          r.avg_unit_cost == null ? null : Number(r.avg_unit_cost),
        invoice_count: Number(r.invoice_count || 0),
        last_sold_at: r.last_sold_at,
        status,
        min_margin_pct: min_pct,
      };
    });

    const filtered = filters.status
      ? items.filter((r: any) => r.status === filters.status)
      : items;

    // Server-side sort fallback when the caller wants something other
    // than the default gross_profit DESC.
    if (filters.sort) {
      const cmp: Record<string, (a: any, b: any) => number> = {
        gross_profit_desc: (a, b) => b.gross_profit - a.gross_profit,
        gross_profit_asc: (a, b) => a.gross_profit - b.gross_profit,
        margin_desc: (a, b) =>
          (b.gross_margin_pct ?? -Infinity) - (a.gross_margin_pct ?? -Infinity),
        margin_asc: (a, b) =>
          (a.gross_margin_pct ?? Infinity) - (b.gross_margin_pct ?? Infinity),
        qty_desc: (a, b) => b.qty_sold - a.qty_sold,
      };
      if (cmp[filters.sort]) filtered.sort(cmp[filters.sort]);
    }

    return {
      summary: {
        total: filtered.length,
        loss: filtered.filter((r: any) => r.status === 'loss').length,
        low_margin: filtered.filter((r: any) => r.status === 'low_margin')
          .length,
        unknown_cost: filtered.filter(
          (r: any) => r.status === 'unknown_cost',
        ).length,
        ok: filtered.filter((r: any) => r.status === 'ok').length,
      },
      items: filtered,
    };
  }

  /** Report I — per-invoice sold-profit. */
  async soldProfitInvoices(filters: {
    q?: string;
    from?: string;
    to?: string;
    status?: 'loss' | 'low_margin' | 'ok' | 'unknown_cost';
    limit?: number;
  } = {}) {
    const params: any[] = [];
    const conds: string[] = [
      `i.status IN ('completed','paid','partially_paid')`,
      `NOT i.is_return`,
    ];
    if (filters.from) {
      params.push(filters.from);
      conds.push(
        `COALESCE(i.completed_at, i.created_at) >= $${params.length}::timestamptz`,
      );
    }
    if (filters.to) {
      params.push(filters.to);
      conds.push(
        `COALESCE(i.completed_at, i.created_at) < ($${params.length}::timestamptz + interval '1 day')`,
      );
    }
    if (filters.q) {
      params.push(`%${filters.q.trim()}%`);
      conds.push(
        `(i.invoice_no ILIKE $${params.length} OR c.full_name ILIKE $${params.length})`,
      );
    }
    const where = `WHERE ${conds.join(' AND ')}`;
    const limit = Math.min(Math.max(1, Number(filters.limit) || 500), 5000);
    const minMarginParam = `(SELECT COALESCE(
        (SELECT (value)::text::numeric
           FROM settings
          WHERE key = 'smart_pricing.min_margin_pct_default'
          LIMIT 1),
        15
      ))`;

    const rows = await this.ds.query(
      `
      WITH lines AS (
        SELECT
          i.id                                                        AS invoice_id,
          i.invoice_no,
          COALESCE(i.completed_at, i.created_at)                      AS sold_at,
          i.customer_id,
          c.full_name                                                 AS customer_name,
          i.status,
          ii.quantity::int                                            AS qty,
          (ii.quantity * ii.unit_price - ii.discount_amount)::numeric AS revenue,
          (ii.quantity * ii.unit_cost)::numeric                       AS cogs
        FROM invoice_items ii
        JOIN invoices i  ON i.id = ii.invoice_id
        LEFT JOIN customers c ON c.id = i.customer_id
        ${where}
      ),
      agg AS (
        -- HOTFIX: previously aggregated invoice metadata via
        -- MAX(...). That fails with the Postgres error
        --   function max(uuid) does not exist
        -- for customer_id, and is anyway redundant since each
        -- invoice_id maps to exactly one (invoice_no, sold_at,
        -- customer_id, customer_name, status) tuple. Include those
        -- columns in GROUP BY instead — same result, no aggregate.
        SELECT
          invoice_id,
          invoice_no,
          sold_at,
          customer_id,
          customer_name,
          status::text                             AS status,
          SUM(qty)::int                            AS qty_sold,
          COUNT(*)::int                            AS item_count,
          SUM(revenue)::numeric                    AS revenue,
          SUM(cogs)::numeric                       AS cogs,
          (SUM(revenue) - SUM(cogs))::numeric      AS gross_profit
        FROM lines
        GROUP BY invoice_id, invoice_no, sold_at, customer_id, customer_name, status
      )
      SELECT agg.*, ${minMarginParam} AS min_margin_pct
      FROM agg
      ORDER BY sold_at DESC NULLS LAST
      LIMIT ${limit}
      `,
      params,
    );

    const items = rows.map((r: any) => {
      const revenue = Number(r.revenue || 0);
      const cogs = Number(r.cogs || 0);
      const gross_profit = +(revenue - cogs).toFixed(2);
      const gross_margin_pct =
        revenue > 0 ? +((gross_profit / revenue) * 100).toFixed(2) : null;
      const markup_pct =
        cogs > 0 ? +((gross_profit / cogs) * 100).toFixed(2) : null;
      const min_pct = Number(r.min_margin_pct || 15);
      let status: 'loss' | 'low_margin' | 'ok' | 'unknown_cost';
      if (cogs === 0) status = 'unknown_cost';
      else if (gross_profit < 0) status = 'loss';
      else if (
        gross_margin_pct !== null
        && gross_margin_pct < min_pct
      )
        status = 'low_margin';
      else status = 'ok';
      return {
        invoice_id: r.invoice_id,
        invoice_no: r.invoice_no,
        sold_at: r.sold_at,
        customer_id: r.customer_id,
        customer_name: r.customer_name,
        invoice_status: r.status,
        item_count: Number(r.item_count || 0),
        qty_sold: Number(r.qty_sold || 0),
        revenue: +revenue.toFixed(2),
        cogs: +cogs.toFixed(2),
        gross_profit,
        gross_margin_pct,
        markup_pct,
        status,
        min_margin_pct: min_pct,
      };
    });

    const filtered = filters.status
      ? items.filter((r: any) => r.status === filters.status)
      : items;
    return {
      summary: {
        total: filtered.length,
        revenue: +filtered
          .reduce((s: number, r: any) => s + r.revenue, 0)
          .toFixed(2),
        cogs: +filtered
          .reduce((s: number, r: any) => s + r.cogs, 0)
          .toFixed(2),
        gross_profit: +filtered
          .reduce((s: number, r: any) => s + r.gross_profit, 0)
          .toFixed(2),
        loss: filtered.filter((r: any) => r.status === 'loss').length,
        low_margin: filtered.filter((r: any) => r.status === 'low_margin')
          .length,
      },
      items: filtered,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  //  P3.4D — Net-of-returns sold-profit reports (READ-ONLY)
  //
  //  Returns are NOT stored as `is_return=TRUE` invoices in this
  //  codebase. They live in the `returns` + `return_items` tables with
  //  `original_invoice_id` linking back to the sale. Attribution date
  //  for a return is `returns.refunded_at` (when the refund actually
  //  closed) — NOT the original sale date. This matches the operator's
  //  policy: a December return of a November sale is deducted from
  //  December net profit.
  //
  //  Sign convention: `return_items.quantity` is stored POSITIVE
  //  (CHECK quantity > 0). We negate at compute time.
  //
  //  Returned revenue uses `return_items.refund_amount` — the
  //  authoritative per-line refund the system actually issued (already
  //  accounts for partial refunds / restocking handled at the header
  //  level). Returned COGS pulls `unit_cost` from the ORIGINAL
  //  invoice_item via `original_invoice_item_id` so the cost basis
  //  matches what we recognised at the time of sale.
  //
  //  Cancelled / not-yet-refunded returns are excluded:
  //    r.status = 'refunded' AND r.cancelled_at IS NULL
  //
  //  STRICTLY SELECT-only. The static guardrail spec asserts the new
  //  block contains no INSERT/UPDATE/DELETE/ALTER/DROP/CREATE and
  //  zero references to applyVariantPrices, cashbox, journal_entries,
  //  journal_lines, stock_movements, supplier_payments, purchase_items.
  // ──────────────────────────────────────────────────────────────────────

  /** P3.4D — Net-of-returns aggregate summary across the date range. */
  async soldProfitNetSummary(filters: { from?: string; to?: string } = {}) {
    const params: any[] = [];
    const where = this.soldProfitWhere(params, filters.from, filters.to);
    const [sales] = await this.ds.query(
      `
      SELECT
        COALESCE(SUM(ii.quantity * ii.unit_price - ii.discount_amount), 0)::numeric(14,2)
                                                                          AS revenue,
        COALESCE(SUM(ii.quantity * ii.unit_cost), 0)::numeric(14,2)        AS cogs,
        COALESCE(SUM(ii.quantity), 0)::int                                 AS qty_sold,
        COUNT(DISTINCT ii.invoice_id)::int                                 AS invoice_count
      FROM invoice_items ii
      JOIN invoices i ON i.id = ii.invoice_id
      ${where}
      `,
      params,
    );
    // Returns side: separate query against returns + return_items joined
    // back to invoice_items for the cost basis.
    const retParams: any[] = [];
    const retConds: string[] = [
      `r.status = 'refunded'`,
      `r.cancelled_at IS NULL`,
    ];
    if (filters.from) {
      retParams.push(filters.from);
      retConds.push(`r.refunded_at >= $${retParams.length}::timestamptz`);
    }
    if (filters.to) {
      retParams.push(filters.to);
      retConds.push(
        `r.refunded_at < ($${retParams.length}::timestamptz + interval '1 day')`,
      );
    }
    const [returns] = await this.ds.query(
      `
      SELECT
        COALESCE(SUM(ri.refund_amount), 0)::numeric(14,2)                  AS revenue,
        COALESCE(SUM(ri.quantity * COALESCE(ii.unit_cost, 0)), 0)::numeric(14,2)
                                                                          AS cogs,
        COALESCE(SUM(ri.quantity), 0)::int                                 AS qty_returned,
        COUNT(DISTINCT r.id)::int                                          AS return_count
      FROM return_items ri
      JOIN returns r ON r.id = ri.return_id
      LEFT JOIN invoice_items ii ON ii.id = ri.original_invoice_item_id
      WHERE ${retConds.join(' AND ')}
      `,
      retParams,
    );

    const grossRevenue = Number(sales.revenue);
    const grossCogs = Number(sales.cogs);
    const grossProfit = grossRevenue - grossCogs;
    const returnsRevenue = Number(returns.revenue);
    const returnsCogs = Number(returns.cogs);
    const returnsProfit = returnsRevenue - returnsCogs;
    const netRevenue = grossRevenue - returnsRevenue;
    const netCogs = grossCogs - returnsCogs;
    const netProfit = grossProfit - returnsProfit;
    const netMarginPct =
      netRevenue > 0 ? +((netProfit / netRevenue) * 100).toFixed(2) : null;
    const netMarkupPct =
      netCogs > 0 ? +((netProfit / netCogs) * 100).toFixed(2) : null;

    return {
      from: filters.from ?? null,
      to: filters.to ?? null,
      // Gross half (matches existing soldProfitSummary).
      gross_revenue: +grossRevenue.toFixed(2),
      gross_cogs: +grossCogs.toFixed(2),
      gross_profit: +grossProfit.toFixed(2),
      qty_sold: Number(sales.qty_sold),
      invoice_count: Number(sales.invoice_count),
      // Returns half (NEW).
      returns_revenue: +returnsRevenue.toFixed(2),
      returns_cogs: +returnsCogs.toFixed(2),
      returns_profit_reversal: +returnsProfit.toFixed(2),
      qty_returned: Number(returns.qty_returned),
      return_count: Number(returns.return_count),
      // Net (NEW).
      net_revenue: +netRevenue.toFixed(2),
      net_cogs: +netCogs.toFixed(2),
      net_profit: +netProfit.toFixed(2),
      net_margin_pct: netMarginPct,
      net_markup_pct: netMarkupPct,
    };
  }

  /** P3.4D — Per-variant net-of-returns rows. */
  async soldProfitNetProducts(filters: {
    q?: string;
    from?: string;
    to?: string;
    status?: 'loss' | 'low_margin' | 'ok' | 'unknown';
    limit?: number;
  } = {}) {
    const limit = Math.min(Math.max(1, Number(filters.limit) || 500), 5000);
    const minMarginParam = `(SELECT COALESCE(
        (SELECT (value)::text::numeric
           FROM settings
          WHERE key = 'smart_pricing.min_margin_pct_default'
          LIMIT 1),
        15
      ))`;

    // ── Sales aggregate per variant, period-filtered on sale date.
    const salesConds: string[] = [
      `i.status IN ('completed','paid','partially_paid')`,
      `NOT i.is_return`,
    ];
    const salesParams: any[] = [];
    if (filters.from) {
      salesParams.push(filters.from);
      salesConds.push(
        `COALESCE(i.completed_at, i.created_at) >= $${salesParams.length}::timestamptz`,
      );
    }
    if (filters.to) {
      salesParams.push(filters.to);
      salesConds.push(
        `COALESCE(i.completed_at, i.created_at) < ($${salesParams.length}::timestamptz + interval '1 day')`,
      );
    }
    if (filters.q) {
      salesParams.push(`%${filters.q.trim()}%`);
      const idx = salesParams.length;
      salesConds.push(
        `(p.name_ar ILIKE $${idx} OR pv.sku ILIKE $${idx} OR pv.barcode ILIKE $${idx})`,
      );
    }

    // ── Returns aggregate per variant, period-filtered on refunded_at.
    // We deliberately use the SAME param array as sales so the SQL is
    // a single statement with one set of bindings. Returns conds get
    // their own indices.
    const retConds: string[] = [
      `r.status = 'refunded'`,
      `r.cancelled_at IS NULL`,
    ];
    const retParams: any[] = [];
    if (filters.from) {
      retParams.push(filters.from);
      retConds.push(`r.refunded_at >= $${retParams.length}::timestamptz`);
    }
    if (filters.to) {
      retParams.push(filters.to);
      retConds.push(
        `r.refunded_at < ($${retParams.length}::timestamptz + interval '1 day')`,
      );
    }
    if (filters.q) {
      retParams.push(`%${filters.q.trim()}%`);
      const idx = retParams.length;
      retConds.push(
        `(p2.name_ar ILIKE $${idx} OR pv2.sku ILIKE $${idx} OR pv2.barcode ILIKE $${idx})`,
      );
    }

    // Build one combined statement using two CTEs + FULL OUTER JOIN so
    // return-only rows surface even when the original sale fell outside
    // the period.
    const allParams = [...salesParams, ...retParams];
    const retParamOffset = salesParams.length;
    const offsetRetConds = retConds.map((c) =>
      c.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + retParamOffset}`),
    );

    const rows = await this.ds.query(
      `
      WITH sales AS (
        SELECT
          pv.id                                                      AS variant_id,
          pv.product_id,
          p.name_ar                                                  AS product_name,
          pv.sku,
          pv.barcode,
          c.name_ar                                                  AS color,
          s.size_label                                               AS size,
          SUM(ii.quantity)::int                                      AS qty_sold,
          SUM(ii.quantity * ii.unit_price - ii.discount_amount)::numeric(14,2)
                                                                     AS revenue,
          SUM(ii.quantity * ii.unit_cost)::numeric(14,2)             AS cogs,
          COUNT(DISTINCT ii.invoice_id)::int                         AS invoice_count,
          MAX(COALESCE(i.completed_at, i.created_at))                AS last_sold_at
        FROM invoice_items ii
        JOIN product_variants pv ON pv.id = ii.variant_id
        JOIN products p          ON p.id  = pv.product_id
        LEFT JOIN colors c       ON c.id  = pv.color_id
        LEFT JOIN sizes  s       ON s.id  = pv.size_id
        JOIN invoices i          ON i.id  = ii.invoice_id
        WHERE ${salesConds.join(' AND ')}
        GROUP BY pv.id, pv.product_id, p.name_ar, pv.sku, pv.barcode,
                 c.name_ar, s.size_label
      ),
      returns AS (
        SELECT
          pv2.id                                                     AS variant_id,
          pv2.product_id,
          p2.name_ar                                                 AS product_name,
          pv2.sku,
          pv2.barcode,
          c2.name_ar                                                 AS color,
          s2.size_label                                              AS size,
          SUM(ri.quantity)::int                                      AS qty_returned,
          SUM(ri.refund_amount)::numeric(14,2)                       AS revenue,
          SUM(ri.quantity * COALESCE(ii_orig.unit_cost, 0))::numeric(14,2)
                                                                     AS cogs,
          COUNT(DISTINCT r.id)::int                                  AS return_count,
          MAX(r.refunded_at)                                         AS last_returned_at
        FROM return_items ri
        JOIN returns r            ON r.id  = ri.return_id
        JOIN product_variants pv2 ON pv2.id = ri.variant_id
        JOIN products p2          ON p2.id = pv2.product_id
        LEFT JOIN colors c2       ON c2.id = pv2.color_id
        LEFT JOIN sizes  s2       ON s2.id = pv2.size_id
        LEFT JOIN invoice_items ii_orig ON ii_orig.id = ri.original_invoice_item_id
        WHERE ${offsetRetConds.join(' AND ')}
        GROUP BY pv2.id, pv2.product_id, p2.name_ar, pv2.sku, pv2.barcode,
                 c2.name_ar, s2.size_label
      )
      SELECT
        COALESCE(sales.variant_id, returns.variant_id)               AS variant_id,
        COALESCE(sales.product_id, returns.product_id)               AS product_id,
        COALESCE(sales.product_name, returns.product_name)           AS product_name,
        COALESCE(sales.sku, returns.sku)                             AS sku,
        COALESCE(sales.barcode, returns.barcode)                     AS barcode,
        COALESCE(sales.color, returns.color)                         AS color,
        COALESCE(sales.size, returns.size)                           AS size,
        COALESCE(sales.qty_sold, 0)::int                             AS qty_sold,
        COALESCE(returns.qty_returned, 0)::int                       AS qty_returned,
        (COALESCE(sales.qty_sold, 0) - COALESCE(returns.qty_returned, 0))::int
                                                                     AS qty_net,
        COALESCE(sales.revenue, 0)::numeric(14,2)                    AS sales_revenue,
        COALESCE(returns.revenue, 0)::numeric(14,2)                  AS returns_revenue,
        (COALESCE(sales.revenue, 0) - COALESCE(returns.revenue, 0))::numeric(14,2)
                                                                     AS net_revenue,
        COALESCE(sales.cogs, 0)::numeric(14,2)                       AS sales_cogs,
        COALESCE(returns.cogs, 0)::numeric(14,2)                     AS returns_cogs,
        (COALESCE(sales.cogs, 0) - COALESCE(returns.cogs, 0))::numeric(14,2)
                                                                     AS net_cogs,
        COALESCE(sales.invoice_count, 0)::int                        AS invoice_count,
        COALESCE(returns.return_count, 0)::int                       AS return_count,
        sales.last_sold_at,
        returns.last_returned_at,
        ${minMarginParam}::numeric(6,2)                              AS min_margin_pct
      FROM sales
      FULL OUTER JOIN returns ON returns.variant_id = sales.variant_id
      ORDER BY (COALESCE(sales.revenue, 0) - COALESCE(returns.revenue, 0)) DESC
      LIMIT ${limit}
      `,
      allParams,
    );

    // Compute net_profit + status client-side so the formulas stay
    // visible in code review.
    const enriched = (rows as any[]).map((r) => {
      const netRevenue = Number(r.net_revenue || 0);
      const netCogs = Number(r.net_cogs || 0);
      const netProfit = +(netRevenue - netCogs).toFixed(2);
      const netMarginPct =
        netRevenue > 0 ? +((netProfit / netRevenue) * 100).toFixed(2) : null;
      const netMarkupPct =
        netCogs > 0 ? +((netProfit / netCogs) * 100).toFixed(2) : null;
      const minMarginPct = Number(r.min_margin_pct || 0);
      let status: 'loss' | 'low_margin' | 'ok' | 'unknown';
      // Status precedence per P3.4D spec:
      //   1. net_profit < 0           → loss
      //   2. margin known and < min   → low_margin
      //   3. net_revenue ≤ 0 or net_cogs ≤ 0
      //                              → unknown (no basis to evaluate)
      //   4. otherwise                → ok
      if (netProfit < 0) {
        status = 'loss';
      } else if (
        netMarginPct !== null
        && minMarginPct > 0
        && netMarginPct < minMarginPct
      ) {
        status = 'low_margin';
      } else if (netRevenue <= 0 || netCogs <= 0) {
        status = 'unknown';
      } else {
        status = 'ok';
      }
      return {
        ...r,
        qty_sold: Number(r.qty_sold),
        qty_returned: Number(r.qty_returned),
        qty_net: Number(r.qty_net),
        sales_revenue: +Number(r.sales_revenue).toFixed(2),
        returns_revenue: +Number(r.returns_revenue).toFixed(2),
        net_revenue: +netRevenue.toFixed(2),
        sales_cogs: +Number(r.sales_cogs).toFixed(2),
        returns_cogs: +Number(r.returns_cogs).toFixed(2),
        net_cogs: +netCogs.toFixed(2),
        net_profit: netProfit,
        net_margin_pct: netMarginPct,
        net_markup_pct: netMarkupPct,
        min_margin_pct: minMarginPct,
        status,
      };
    });

    const filtered = filters.status
      ? enriched.filter((r) => r.status === filters.status)
      : enriched;

    return {
      from: filters.from ?? null,
      to: filters.to ?? null,
      summary: {
        total: filtered.length,
        net_revenue: +filtered
          .reduce((s, r) => s + Number(r.net_revenue), 0)
          .toFixed(2),
        net_cogs: +filtered
          .reduce((s, r) => s + Number(r.net_cogs), 0)
          .toFixed(2),
        net_profit: +filtered
          .reduce((s, r) => s + Number(r.net_profit), 0)
          .toFixed(2),
        loss: filtered.filter((r) => r.status === 'loss').length,
        low_margin: filtered.filter((r) => r.status === 'low_margin').length,
        unknown: filtered.filter((r) => r.status === 'unknown').length,
        ok: filtered.filter((r) => r.status === 'ok').length,
      },
      items: filtered,
    };
  }

  // ──────────────────────────────────────────────────────────────────────
  //  PR-P8.1 — Fair Price Report (read-only, advisory)
  //
  //  Combines:
  //    · product_variants.cost_price       (landed cost reference)
  //    · operating overhead in the period  (actual_expenses OR
  //                                          recurring_monthly_equivalent)
  //    · invoice_items in the period       (revenue / units sold)
  //    · stock                              (stock-value allocation basis)
  //
  //  Per variant, allocates a share of the period's overhead using one of:
  //    revenue_share | units_share | stock_value_share | flat_per_sku.
  //  Computes break-even (cost + overhead/unit) and a target-margin-
  //  adjusted fair price. ADVISORY ONLY — never writes anywhere.
  //
  //  Hard guarantees pinned by reports.service.fair-price.spec.ts static
  //  guardrail (regex scan of this method):
  //    · No INSERT / UPDATE / DELETE — pure SELECT.
  //    · No `selling_price =` / `cost_price =` writes.
  //    · No journal_entries / journal_lines / cashbox_transactions /
  //      cashbox_balances / stock_movements / supplier_ledger /
  //      supplier_payments references.
  //    · No postPurchase / recordTransaction / financialEngine /
  //      posting.service calls.
  // ──────────────────────────────────────────────────────────────────────
  async fairPrice(filters: {
    from?: string;
    to?: string;
    allocation_basis?:
      | 'revenue_share'
      | 'units_share'
      | 'stock_value_share'
      | 'flat_per_sku';
    overhead_source?: 'actual_expenses' | 'recurring_monthly_equivalent';
    target_margin_pct?: number;
    q?: string;
    only_in_stock?: boolean;
    only_active?: boolean;
    limit?: number;
  } = {}) {
    const ALLOC_BASES = [
      'revenue_share',
      'units_share',
      'stock_value_share',
      'flat_per_sku',
    ] as const;
    const OVERHEAD_SOURCES = [
      'actual_expenses',
      'recurring_monthly_equivalent',
    ] as const;
    const allocation_basis = filters.allocation_basis ?? 'revenue_share';
    if (!ALLOC_BASES.includes(allocation_basis as any)) {
      throw new BadRequestException('طريقة التوزيع غير صالحة');
    }
    const overhead_source =
      filters.overhead_source ?? 'actual_expenses';
    if (!OVERHEAD_SOURCES.includes(overhead_source as any)) {
      throw new BadRequestException('مصدر التكاليف التشغيلية غير صالح');
    }

    // target_margin_pct: explicit → setting → fallback 30.
    let target_margin_pct = filters.target_margin_pct;
    if (target_margin_pct === undefined || target_margin_pct === null) {
      const fromSettings = await this.ds
        .query(
          `SELECT value FROM settings WHERE key = 'smart_pricing.recommended_margin_pct' LIMIT 1`,
        )
        .catch(() => [] as any[]);
      const v = fromSettings?.[0]?.value;
      const parsed =
        typeof v === 'number'
          ? v
          : typeof v === 'string'
            ? Number(v)
            : v && typeof v === 'object' && 'value' in v
              ? Number((v as any).value)
              : NaN;
      target_margin_pct = Number.isFinite(parsed) ? parsed : 30;
    }
    if (!Number.isFinite(target_margin_pct) || target_margin_pct < 0) {
      throw new BadRequestException(
        'نسبة الهامش المستهدف يجب أن تكون رقمًا موجبًا',
      );
    }
    if (target_margin_pct >= 95) {
      throw new BadRequestException(
        'نسبة الهامش المستهدف لا يمكن أن تتجاوز 94%',
      );
    }

    const FAIR_PRICE_LIMIT_DEFAULT = 200;
    const FAIR_PRICE_LIMIT_MAX = 1000;
    const effective_limit = Math.min(
      Math.max(1, Number(filters.limit) || FAIR_PRICE_LIMIT_DEFAULT),
      FAIR_PRICE_LIMIT_MAX,
    );

    // Default period: last 30 days ending today (Cairo).
    const today = this.todayCairoIso();
    const defaultFrom = (() => {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - 30);
      return d.toISOString().slice(0, 10);
    })();
    const fromIso = filters.from ?? defaultFrom;
    const toIso = filters.to ?? today;

    // 1. Overhead total
    let overhead_total = 0;
    if (overhead_source === 'actual_expenses') {
      const [row] = await this.ds.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric(14,2) AS s
           FROM expenses
          WHERE expense_date >= $1::date
            AND expense_date <= $2::date`,
        [fromIso, toIso],
      );
      overhead_total = Number(row?.s ?? 0);
    } else {
      const [periodRow] = await this.ds.query(
        `SELECT ($2::date - $1::date + 1)::int AS days`,
        [fromIso, toIso],
      );
      const periodDays = Math.max(1, Number(periodRow?.days ?? 30));
      const templates = await this.ds.query(
        `SELECT amount::numeric(14,2) AS amount,
                frequency::text AS frequency,
                custom_interval_days
           FROM recurring_expenses
          WHERE status = 'active'`,
      );
      for (const r of templates as any[]) {
        const amt = Number(r.amount ?? 0);
        let daysPerCycle: number;
        switch (r.frequency) {
          case 'daily':
            daysPerCycle = 1;
            break;
          case 'weekly':
            daysPerCycle = 7;
            break;
          case 'biweekly':
            daysPerCycle = 14;
            break;
          case 'monthly':
            daysPerCycle = 30;
            break;
          case 'quarterly':
            daysPerCycle = 91;
            break;
          case 'semiannual':
            daysPerCycle = 182;
            break;
          case 'annual':
            daysPerCycle = 365;
            break;
          case 'custom_days': {
            const custom = Number(r.custom_interval_days);
            daysPerCycle = Number.isFinite(custom) && custom > 0 ? custom : 0;
            break;
          }
          default:
            daysPerCycle = 30;
            break;
        }
        if (daysPerCycle <= 0) continue;
        overhead_total += amt * (periodDays / daysPerCycle);
      }
      overhead_total = +overhead_total.toFixed(2);
    }

    // 2. Variant rows + period revenue/units + stock.
    const params: any[] = [fromIso, toIso];
    const conds: string[] = ['pv.deleted_at IS NULL'];
    if (filters.only_active !== false) {
      conds.push('pv.is_active = TRUE');
    }
    if (filters.q) {
      params.push(`%${filters.q.trim()}%`);
      const idx = params.length;
      conds.push(
        `(p.name_ar ILIKE $${idx}::text OR pv.sku ILIKE $${idx}::text OR pv.barcode ILIKE $${idx}::text)`,
      );
    }
    const stockFilter = filters.only_in_stock
      ? 'AND COALESCE(stock_sum.qty, 0) > 0'
      : '';

    const rows = await this.ds.query(
      `
      WITH sales AS (
        SELECT ii.variant_id,
               SUM(ii.quantity)::int AS units,
               SUM(ii.quantity * ii.unit_price - ii.discount_amount)::numeric(14,2)
                                                                       AS revenue
          FROM invoice_items ii
          JOIN invoices i ON i.id = ii.invoice_id
         WHERE i.status IN ('completed','paid','partially_paid')
           AND i.completed_at >= $1::timestamptz
           AND i.completed_at <  $2::timestamptz + interval '1 day'
         GROUP BY ii.variant_id
      ),
      stock_sum AS (
        SELECT variant_id, SUM(quantity_on_hand)::int AS qty
          FROM stock
         GROUP BY variant_id
      )
      SELECT
        pv.id                                          AS variant_id,
        p.id                                           AS product_id,
        p.name_ar                                      AS product_name,
        pv.sku, pv.barcode,
        cat.name_ar                                    AS category_name,
        pv.cost_price::numeric(14,2)                   AS current_cost_price,
        pv.selling_price::numeric(14,2)                AS current_selling_price,
        COALESCE(sales.units, 0)::int                  AS units_sold_in_period,
        COALESCE(sales.revenue, 0)::numeric(14,2)      AS revenue_in_period,
        COALESCE(stock_sum.qty, 0)::int                AS stock_on_hand
        FROM product_variants pv
        JOIN products p          ON p.id = pv.product_id
        LEFT JOIN categories cat ON cat.id = p.category_id
        LEFT JOIN sales          ON sales.variant_id = pv.id
        LEFT JOIN stock_sum      ON stock_sum.variant_id = pv.id
       WHERE ${conds.join(' AND ')}
       ${stockFilter}
       ORDER BY revenue_in_period DESC NULLS LAST, p.name_ar
       LIMIT ${effective_limit + 1}
      `,
      params,
    );

    const [countRow] = await this.ds.query(
      `
      SELECT COUNT(DISTINCT pv.id)::int AS n
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN (
          SELECT variant_id, SUM(quantity_on_hand)::int AS qty
            FROM stock GROUP BY variant_id
        ) ss ON ss.variant_id = pv.id
       WHERE pv.deleted_at IS NULL
         ${filters.only_active !== false ? 'AND pv.is_active = TRUE' : ''}
         ${filters.only_in_stock ? 'AND COALESCE(ss.qty, 0) > 0' : ''}
      `,
    );
    const total_candidates = Number(countRow?.n ?? 0);
    const rawRows = (rows as any[]).slice(0, effective_limit);
    const truncated = (rows as any[]).length > effective_limit;

    // 3. Total basis (across the *returned* rows — overhead is allocated
    //    across the rows the operator can actually see; allocation
    //    weights sum to 1 within the visible set when total_basis > 0).
    let total_basis = 0;
    switch (allocation_basis) {
      case 'revenue_share':
        total_basis = rawRows.reduce(
          (s, r) => s + Number(r.revenue_in_period || 0),
          0,
        );
        break;
      case 'units_share':
        total_basis = rawRows.reduce(
          (s, r) => s + Number(r.units_sold_in_period || 0),
          0,
        );
        break;
      case 'stock_value_share':
        total_basis = rawRows.reduce(
          (s, r) =>
            s
            + Number(r.stock_on_hand || 0) * Number(r.current_cost_price || 0),
          0,
        );
        break;
      case 'flat_per_sku':
        total_basis = rawRows.length;
        break;
    }

    const items = rawRows.map((r: any) => {
      const current_cost_price = Number(r.current_cost_price || 0);
      const current_selling_price = Number(r.current_selling_price || 0);
      const units_sold_in_period = Number(r.units_sold_in_period || 0);
      const revenue_in_period = Number(r.revenue_in_period || 0);
      const stock_on_hand = Number(r.stock_on_hand || 0);

      let allocation_weight = 0;
      if (total_basis > 0) {
        switch (allocation_basis) {
          case 'revenue_share':
            allocation_weight = revenue_in_period / total_basis;
            break;
          case 'units_share':
            allocation_weight = units_sold_in_period / total_basis;
            break;
          case 'stock_value_share':
            allocation_weight =
              (stock_on_hand * current_cost_price) / total_basis;
            break;
          case 'flat_per_sku':
            allocation_weight = 1 / total_basis;
            break;
        }
      }

      const overhead_share = +(overhead_total * allocation_weight).toFixed(2);
      const noSales = units_sold_in_period === 0;
      const expected_units = Math.max(1, units_sold_in_period);
      const overhead_per_unit = +(overhead_share / expected_units).toFixed(2);
      const break_even_price = +(
        current_cost_price + overhead_per_unit
      ).toFixed(2);
      const fair_price = +(
        break_even_price / (1 - target_margin_pct / 100)
      ).toFixed(2);
      const gap_to_fair = +(fair_price - current_selling_price).toFixed(2);
      const gap_to_fair_pct =
        current_selling_price > 0
          ? +((gap_to_fair / current_selling_price) * 100).toFixed(2)
          : null;
      const current_margin_pct =
        current_selling_price > 0
          ? +(
              ((current_selling_price - current_cost_price)
                / current_selling_price)
              * 100
            ).toFixed(2)
          : null;
      const margin_after_overhead_pct =
        current_selling_price > 0
          ? +(
              ((current_selling_price - break_even_price)
                / current_selling_price)
              * 100
            ).toFixed(2)
          : null;

      let warning: string | null = null;
      if (current_cost_price <= 0) {
        warning = 'cost_zero';
      } else if (noSales) {
        warning = 'no_sales_in_period';
      } else if (
        stock_on_hand === 0
        && allocation_basis === 'stock_value_share'
      ) {
        warning = 'no_stock';
      }

      return {
        variant_id: r.variant_id,
        product_id: r.product_id,
        product_name: r.product_name,
        sku: r.sku,
        barcode: r.barcode,
        category_name: r.category_name,
        current_cost_price,
        current_selling_price,
        units_sold_in_period,
        revenue_in_period,
        stock_on_hand,
        allocation_weight: +allocation_weight.toFixed(6),
        overhead_share,
        overhead_per_unit,
        break_even_price,
        fair_price,
        gap_to_fair,
        gap_to_fair_pct,
        current_margin_pct,
        margin_after_overhead_pct,
        warning,
      };
    });

    const variants_below_fair = items.filter((i) => i.gap_to_fair > 0).length;
    const current_gap_total = +items
      .reduce((s, i) => s + Math.max(0, i.gap_to_fair), 0)
      .toFixed(2);
    const average_overhead_per_unit =
      items.length > 0
        ? +(
            items.reduce((s, i) => s + i.overhead_per_unit, 0) / items.length
          ).toFixed(2)
        : 0;
    const units_total = rawRows.reduce(
      (s, r) => s + Number(r.units_sold_in_period || 0),
      0,
    );
    const revenue_total = +rawRows
      .reduce((s, r) => s + Number(r.revenue_in_period || 0), 0)
      .toFixed(2);

    return {
      items,
      summary: {
        from: fromIso,
        to: toIso,
        allocation_basis,
        overhead_source,
        target_margin_pct,
        overhead_total: +Number(overhead_total).toFixed(2),
        units_total,
        revenue_total,
        total_candidates,
        returned_count: items.length,
        truncated,
        variants_below_fair,
        current_gap_total,
        average_overhead_per_unit,
        message_ar: truncated
          ? `تم عرض أول ${items.length} صنف فقط من ${total_candidates}. ضيّق الفلتر أو زد الحد.`
          : null,
        advisory:
          'تقرير استرشادي فقط — لا يقوم بأي تعديل تلقائي على الأسعار، ولا يحرّك مخزون أو خزنة أو قيود محاسبية.',
      },
    };
  }
}
