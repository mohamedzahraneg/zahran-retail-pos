/**
 * finance-dashboard.service.spec.ts — PR-FIN-2
 *
 * Unit tests for `FinanceDashboardService`. We don't hit a real DB —
 * `ds.query` is a Jest mock that returns canned shapes per query.
 *
 * Coverage:
 *   1. Default range (current Cairo month, day 1 → today) when filters
 *      are omitted.
 *   2. Echo of explicit filters into `filters_applied`.
 *   3. Health composition (trial balance imbalance vs zero, drift count).
 *   4. Liquidity totals — cards forced to 0 (Q4 of the plan).
 *   5. Profit composition — confidence tier derivation, pct delta math.
 *   6. Empty data → zeros, never crashes.
 *   7. Quick reports static map shape.
 *   8. **No-write invariant**: the service never issues anything other
 *      than SELECT statements.
 */

import { FinanceDashboardService } from './finance-dashboard.service';

interface QueryStubs {
  default?: any;
  matchers?: Array<{ test: (sql: string) => boolean; rows: any }>;
}

function buildSvc(stubs: QueryStubs = {}) {
  const calls: { sql: string; params: any[] }[] = [];
  const ds = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const matched = stubs.matchers?.find((m) => m.test(sql));
      if (matched) return matched.rows;
      return stubs.default ?? [];
    }),
  };
  const svc = new FinanceDashboardService(ds as any);
  return { svc, ds, calls };
}

describe('FinanceDashboardService — PR-FIN-2', () => {
  describe('range resolution', () => {
    it('uses caller-supplied from/to when both provided', async () => {
      const { svc } = buildSvc();
      const r = await svc.dashboard({ from: '2026-01-01', to: '2026-01-31' });
      expect(r.range).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    });

    it('falls back to current Cairo month when filters are omitted', async () => {
      const { svc } = buildSvc();
      const r = await svc.dashboard({});
      expect(r.range.from).toMatch(/^\d{4}-\d{2}-01$/);
      expect(r.range.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('filters_applied', () => {
    it('only echoes optional dimension filters, not from/to', async () => {
      const { svc } = buildSvc();
      const r = await svc.dashboard({
        from: '2026-04-01',
        to: '2026-04-30',
        cashbox_id: 'cb-1',
        user_id: 'u-1',
      });
      expect(r.filters_applied).toEqual({ cashbox_id: 'cb-1', user_id: 'u-1' });
    });
  });

  describe('health', () => {
    it('reports overall=healthy when DR=CR and no drift/alerts/unbalanced', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /tb AS/.test(s) && /drift AS/.test(s),
            rows: [
              {
                total_debit: '100.00',
                total_credit: '100.00',
                drift_count: 0,
                drift_abs: 0,
                bypass_7d: 0,
                unbalanced_count: 0,
              },
            ],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(r.health.trial_balance_imbalance).toBe(0);
      expect(r.health.overall).toBe('healthy');
    });

    it('reports overall=warning when bypass alerts present', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /tb AS/.test(s) && /drift AS/.test(s),
            rows: [
              {
                total_debit: '100.00',
                total_credit: '100.00',
                drift_count: 0,
                drift_abs: 0,
                bypass_7d: 22,
                unbalanced_count: 0,
              },
            ],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(r.health.engine_bypass_alerts_7d).toBe(22);
      expect(r.health.overall).toBe('warning');
    });

    it('reports overall=critical when DR≠CR or unbalanced > 0', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /tb AS/.test(s),
            rows: [
              {
                total_debit: '100.00',
                total_credit: '99.00',
                drift_count: 0,
                drift_abs: 0,
                bypass_7d: 0,
                unbalanced_count: 0,
              },
            ],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(r.health.trial_balance_imbalance).toBe(1);
      expect(r.health.overall).toBe('critical');
    });
  });

  describe('liquidity', () => {
    it('aggregates by cashbox kind; cards forced to 0', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /FROM cashboxes/.test(s) && /GROUP BY kind/.test(s),
            rows: [
              { kind: 'cash',    total: '100.00' },
              { kind: 'bank',    total: '500.00' },
              { kind: 'ewallet', total: '50.00' },
            ],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(r.liquidity.cashboxes_total).toBe(100);
      expect(r.liquidity.banks_total).toBe(500);
      expect(r.liquidity.wallets_total).toBe(50);
      expect(r.liquidity.cards_total).toBe(0);
      expect(r.liquidity.total_cash_equivalents).toBe(650);
    });
  });

  describe('profit composition', () => {
    it('confidence tier = High when only cost_total lines exist', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /WITH inv AS/.test(s) && /confidence/.test(s) === false && /high_lines/.test(s),
            rows: [
              {
                sales: '1000',
                cogs: '600',
                gross: '400',
                expenses: '100',
                high_lines: 50,
                medium_lines: 0,
                low_lines: 0,
              },
            ],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(r.profit.confidence).toBe('High');
      expect(r.profit.gross_profit).toBe(400);
      expect(r.profit.net_profit).toBe(300);
      expect(r.profit.margin_pct).toBe(40);
    });

    it('confidence tier = Low when any low line present', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /high_lines/.test(s) && /low_lines/.test(s),
            rows: [
              {
                sales: '0', cogs: '0', gross: '0', expenses: '0',
                high_lines: 10, medium_lines: 5, low_lines: 2,
              },
            ],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(r.profit.confidence).toBe('Low');
    });

    it('confidence tier = N/A when zero lines aggregated', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /high_lines/.test(s) && /low_lines/.test(s),
            rows: [
              {
                sales: '0', cogs: '0', gross: '0', expenses: '0',
                high_lines: 0, medium_lines: 0, low_lines: 0,
              },
            ],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(r.profit.confidence).toBe('N/A');
    });
  });

  describe('best_customer / best_supplier / best_product', () => {
    /**
     * Stubs the three aggregate queries (top products, profit_by_customer,
     * profit_by_supplier) so we can assert the row-0 picking logic.
     */
    function buildSvcWithBests(
      bests: { customer?: any[]; supplier?: any[]; product?: any[] } = {},
      profit: any = {
        sales: '0', cogs: '0', gross: '0', expenses: '0',
        high_lines: 0, medium_lines: 0, low_lines: 0,
      },
    ) {
      return buildSvc({
        matchers: [
          // Profit totals (so confidence = N/A path is fine)
          {
            test: (s) => /high_lines/.test(s) && /low_lines/.test(s) && /WITH inv AS/.test(s),
            rows: [profit],
          },
          // Top products (used for best_product)
          {
            test: (s) => /FROM invoice_lines il/.test(s) && /LEFT JOIN products p/.test(s) && /GROUP BY p\.id/.test(s),
            rows: bests.product ?? [],
          },
          // Profit by customer
          {
            test: (s) => /JOIN customers c/.test(s) && /GROUP BY c\.id/.test(s),
            rows: bests.customer ?? [],
          },
          // Profit by supplier
          {
            test: (s) => /JOIN suppliers s/.test(s) && /GROUP BY s\.id/.test(s),
            rows: bests.supplier ?? [],
          },
        ],
      });
    }

    it('populates best_* from row 0 when aggregates have positive-profit rows', async () => {
      const { svc } = buildSvcWithBests({
        customer: [
          { customer_id: 'c1', name_ar: 'مؤسسة النور', sales: '500', gross: '120', invoices_count: 3 },
          { customer_id: 'c2', name_ar: 'شركة س', sales: '200', gross: '40', invoices_count: 1 },
        ],
        supplier: [
          { supplier_id: 's1', name_ar: 'شركة الخليج', sales: '300', cost: '200', gross: '90' },
        ],
        product: [
          { product_id: 'p1', name_ar: 'لاب توب ديل', sales: '650', gross: '180' },
          { product_id: 'p2', name_ar: 'هاتف',       sales: '300', gross: '50' },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(r.profit.best_customer).toEqual({ name: 'مؤسسة النور', profit: 120 });
      expect(r.profit.best_supplier).toEqual({ name: 'شركة الخليج', profit: 90 });
      expect(r.profit.best_product).toEqual({ name: 'لاب توب ديل', profit: 180 });
    });

    it('returns null when aggregate is empty', async () => {
      const { svc } = buildSvcWithBests({}); // all empty
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(r.profit.best_customer).toBeNull();
      expect(r.profit.best_supplier).toBeNull();
      expect(r.profit.best_product).toBeNull();
    });

    it('returns null when row 0 has zero or negative profit (no misleading "best")', async () => {
      const { svc } = buildSvcWithBests({
        customer: [{ customer_id: 'c1', name_ar: 'عميل', sales: '100', gross: '0', invoices_count: 1 }],
        supplier: [{ supplier_id: 's1', name_ar: 'مورد', sales: '100', cost: '120', gross: '-20' }],
        product:  [{ product_id: 'p1', name_ar: 'صنف', sales: '50',  gross: '0' }],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(r.profit.best_customer).toBeNull();
      expect(r.profit.best_supplier).toBeNull();
      expect(r.profit.best_product).toBeNull();
    });

    it('rounds the surfaced profit to 2 decimals', async () => {
      const { svc } = buildSvcWithBests({
        customer: [
          { customer_id: 'c1', name_ar: 'عميل', sales: '100', gross: '12.345', invoices_count: 1 },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(r.profit.best_customer).toEqual({ name: 'عميل', profit: 12.35 });
    });
  });

  describe('empty data', () => {
    it('returns zeros (not crashes) when every query returns []', async () => {
      const { svc } = buildSvc({ default: [] });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(r.health.overall).toBe('healthy');
      expect(r.liquidity.total_cash_equivalents).toBe(0);
      expect(r.profit.sales_total).toBe(0);
      expect(r.profit.gross_profit).toBe(0);
      expect(r.profit.confidence).toBe('N/A');
      expect(r.daily_expenses.total).toBe(0);
      expect(r.daily_expenses.largest).toBeNull();
      expect(r.balances.customers.top).toBeNull();
      expect(r.balances.suppliers.top).toBeNull();
      expect(Array.isArray(r.profit_trend)).toBe(true);
      expect(Array.isArray(r.payment_channels)).toBe(true);
      expect(Array.isArray(r.alerts)).toBe(true);
    });
  });

  describe('quick reports', () => {
    it('returns the 16 reports with stable keys + Arabic labels exactly as in image', async () => {
      const { svc } = buildSvc();
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(r.quick_reports).toHaveLength(16);
      const labels = r.quick_reports.map((q) => q.label_ar);
      // Verify every Arabic title from the dashboard image is present.
      expect(labels).toEqual(
        expect.arrayContaining([
          'كشف عميل',
          'كشف محفظة',
          'كشف بنك',
          'كشف خزنة',
          'كشف موظف',
          'كشف مورد',
          'تقرير المصروفات',
          'تقرير الإيرادات',
          'تقرير المركز المالي',
          'التدفقات النقدية',
          'تقرير الزكاة',
          'تقرير الجرد',
          'تقرير المرتجعات',
          'تقرير الخصومات',
          'تقرير الأرباح',
          'Audit Trail',
        ]),
      );
    });
  });

  describe('no-write invariant', () => {
    it('never issues INSERT/UPDATE/DELETE on any financial table', async () => {
      const { svc, calls } = buildSvc();
      await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      for (const c of calls) {
        const upper = c.sql.toUpperCase();
        expect(upper).not.toMatch(/\bINSERT\s+INTO\b/);
        expect(upper).not.toMatch(/\bUPDATE\b/);
        expect(upper).not.toMatch(/\bDELETE\s+FROM\b/);
        expect(upper).not.toMatch(/\bTRUNCATE\b/);
      }
    });
  });

  /**
   * PR-FIN-2-HOTFIX-1 — regression guard.
   *
   * The original PR-FIN-2 SQL used `i.status NOT IN ('voided','cancelled')`
   * which threw at runtime because the Postgres `invoice_status` enum
   * doesn't have a 'voided' value. The valid enum values today are
   * {draft, completed, partially_paid, paid, refunded, cancelled}.
   * "Voided" on `invoices` is represented by `voided_at IS NOT NULL`.
   *
   * This test scans every SQL issued during a full dashboard call
   * and asserts:
   *   1. No comparison against the literal 'voided' on `i.status`.
   *   2. Where invoices are filtered out by status, the canonical
   *      `voided_at IS NULL` predicate is paired with the
   *      `status <> 'cancelled'` filter.
   * If a future contributor reintroduces the bad pattern, this test
   * fails before it reaches production.
   */
  describe('PR-FIN-2-HOTFIX-1 — invoice_status enum guard', () => {
    it('never compares i.status to the literal \'voided\'', async () => {
      const { svc, calls } = buildSvc();
      await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      for (const c of calls) {
        // Match any pattern like   i.status ... 'voided'   or
        // status IN ('voided', ...) — case-insensitive, allow whitespace.
        expect(c.sql).not.toMatch(/i\.status[^']*'voided'/i);
        expect(c.sql).not.toMatch(/'voided'\s*,\s*'cancelled'/i);
      }
    });

    it('every invoice query that filters cancelled also filters voided_at', async () => {
      const { svc, calls } = buildSvc();
      await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      for (const c of calls) {
        if (/i\.status\s*<>\s*'cancelled'/i.test(c.sql)) {
          expect(c.sql).toMatch(/i\.voided_at\s+IS\s+NULL/i);
        }
      }
    });
  });
});
