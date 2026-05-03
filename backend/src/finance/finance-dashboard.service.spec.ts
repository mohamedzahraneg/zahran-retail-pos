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

  describe('liquidity — PR-FIN-DASHBOARD-LIQUIDITY-GL', () => {
    // The previous formula summed `cashboxes.current_balance` grouped
    // by `kind` and hardcoded `cards_total = 0`. That had two bugs:
    // (1) non-cash kinds never write CTs so wallets/banks/checks
    // stored 0 forever, (2) even the cash bucket can drift from GL.
    // The new formula sums GL liquid-asset codes (1111/1113/1114/1115)
    // over posted-non-void journal entries — matching the Income
    // Statement and the analytics liquidity tile shipped in PR #251.
    it('aggregates by GL liquid-asset codes (1111/1113/1114/1115)', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) =>
              /FROM journal_lines/.test(s) &&
              /coa\.code IN\s*\(\s*'1111'\s*,\s*'1113'\s*,\s*'1114'\s*,\s*'1115'\s*\)/.test(s),
            rows: [
              { code: '1111', total: '29660.00' }, // cashboxes
              { code: '1113', total: '0.00' },     // banks
              { code: '1114', total: '2190.00' },  // wallets
              { code: '1115', total: '0.00' },     // checks
            ],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(r.liquidity.cashboxes_total).toBe(29660);
      expect(r.liquidity.banks_total).toBe(0);
      expect(r.liquidity.wallets_total).toBe(2190);
      expect(r.liquidity.checks_total).toBe(0);
      expect(r.liquidity.total_cash_equivalents).toBe(31850);
      // The retired field name must be gone from the response shape.
      expect((r.liquidity as any).cards_total).toBeUndefined();
    });

    it('SQL filters posted, non-void journal entries (excludes voids)', async () => {
      const { svc, calls } = buildSvc({
        matchers: [
          {
            test: (s) => /FROM journal_lines/.test(s) && /coa\.code IN/.test(s),
            rows: [],
          },
        ],
      });
      await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      const liquiditySql = calls.find(
        (c) => /FROM journal_lines/.test(c.sql) && /coa\.code IN/.test(c.sql),
      )!;
      expect(liquiditySql).toBeDefined();
      expect(liquiditySql.sql).toMatch(/je\.is_posted\s*=\s*TRUE/);
      expect(liquiditySql.sql).toMatch(/je\.is_void\s*=\s*FALSE/);
    });

    it('SQL: pure SELECT — no INSERT/UPDATE/DELETE on the liquidity path', async () => {
      const { svc, calls } = buildSvc({
        matchers: [{ test: () => true, rows: [] }],
      });
      await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      const liquiditySql = calls.find(
        (c) => /FROM journal_lines/.test(c.sql) && /coa\.code IN/.test(c.sql),
      )!;
      expect(liquiditySql).toBeDefined();
      expect(liquiditySql.sql).toMatch(/^\s*SELECT/i);
      expect(liquiditySql.sql).not.toMatch(/\bINSERT\b/i);
      expect(liquiditySql.sql).not.toMatch(/\bUPDATE\b/i);
      expect(liquiditySql.sql).not.toMatch(/\bDELETE\b/i);
      expect(liquiditySql.sql).not.toMatch(/\bMERGE\b/i);
    });

    it('SQL never SUMs raw cashbox_transactions for liquidity', async () => {
      const { svc, calls } = buildSvc({
        matchers: [{ test: () => true, rows: [] }],
      });
      await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      const liquiditySql = calls.find(
        (c) => /coa\.code IN\s*\(\s*'1111'/.test(c.sql),
      )!;
      expect(liquiditySql).toBeDefined();
      expect(liquiditySql.sql).not.toMatch(/cashbox_transactions/);
      expect(liquiditySql.sql).not.toMatch(/direction\s*=\s*'in'/);
    });

    it('SQL never groups by cashboxes.kind anymore (legacy formula gone)', async () => {
      const { svc, calls } = buildSvc({
        matchers: [{ test: () => true, rows: [] }],
      });
      await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      // None of the emitted SQL on the liquidity path should aggregate
      // `cashboxes` by `kind` — that's the retired pattern.
      const guilty = calls.find(
        (c) => /FROM cashboxes/.test(c.sql) && /GROUP BY\s+kind/i.test(c.sql),
      );
      expect(guilty).toBeUndefined();
    });

    it('production fixture: cash 29,660 + wallet 2,190 = total 31,850 (matches live)', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /FROM journal_lines/.test(s) && /coa\.code IN/.test(s),
            rows: [
              { code: '1111', total: '29660.00' },
              { code: '1114', total: '2190.00' },
              // 1113/1115 absent → resolve to 0 via the COALESCE/sumByCode helper
            ],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(r.liquidity.cashboxes_total).toBe(29660);
      expect(r.liquidity.banks_total).toBe(0);
      expect(r.liquidity.wallets_total).toBe(2190);
      expect(r.liquidity.checks_total).toBe(0);
      expect(r.liquidity.total_cash_equivalents).toBe(31850);
    });

    it('all-empty fixture: every bucket falls back to 0 cleanly (no NaN leak)', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /FROM journal_lines/.test(s) && /coa\.code IN/.test(s),
            rows: [],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(r.liquidity.cashboxes_total).toBe(0);
      expect(r.liquidity.banks_total).toBe(0);
      expect(r.liquidity.wallets_total).toBe(0);
      expect(r.liquidity.checks_total).toBe(0);
      expect(r.liquidity.total_cash_equivalents).toBe(0);
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
      expect(r.daily_expenses.today_total).toBe(0);
      expect(r.daily_expenses.today_largest).toBeNull();
      expect(r.daily_expenses.period_total).toBe(0);
      expect(r.daily_expenses.period_largest).toBeNull();
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
   * PR-FIN-2-HOTFIX-4 — dashboard clarity guards.
   *
   * Three concerns that the previous PR conflated under generic
   * field names. Each test pins one shape so the next contributor
   * can't accidentally collapse them again:
   *   1. health response splits real cashbox-balance drift away
   *      from per-reference labeling drift.
   *   2. health response carries the timestamp of the most recent
   *      bypass alert so the UI can mark counts as "تاريخية".
   *   3. daily_expenses returns BOTH today and period slices so
   *      the operator sees activity even when today is quiet.
   *   4. supplier balances use a 3-source fallback chain and
   *      report which source actually carried data.
   */
  describe('PR-FIN-2-HOTFIX-4 — dashboard clarity', () => {
    it('separates real cashbox balance drift from per-reference label drift', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /cashbox_money_drift AS/.test(s) && /ref_drift AS/.test(s),
            rows: [
              {
                total_debit: '100.00',
                total_credit: '100.00',
                cashbox_balance_drift_count: 0,
                drift_count: 8,
                drift_abs: '1057.98',
                bypass_7d: 22,
                bypass_last_seen: '2026-04-25T14:00:00Z',
                unbalanced_count: 0,
              },
            ],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-28' });
      expect(r.health.cashbox_balance_drift_count).toBe(0);
      expect(r.health.cashbox_drift_count).toBe(8);
      expect(r.health.cashbox_drift_total).toBe(1057.98);
      expect(r.health.engine_bypass_alerts_7d).toBe(22);
      expect(r.health.engine_bypass_alerts_last_seen).toBe(
        '2026-04-25T14:00:00Z',
      );
      // Labeling drift + historical bypass = warning, not critical.
      expect(r.health.overall).toBe('warning');
    });

    it('escalates to critical when REAL cashbox balance drift > 0', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /cashbox_money_drift AS/.test(s) && /ref_drift AS/.test(s),
            rows: [
              {
                total_debit: '100.00',
                total_credit: '100.00',
                cashbox_balance_drift_count: 1,
                drift_count: 0,
                drift_abs: '0',
                bypass_7d: 0,
                bypass_last_seen: null,
                unbalanced_count: 0,
              },
            ],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-28' });
      expect(r.health.cashbox_balance_drift_count).toBe(1);
      // Real money drift is critical, not just a warning.
      expect(r.health.overall).toBe('critical');
    });

    it('returns engine_bypass_alerts_last_seen=null when no recent alerts', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /cashbox_money_drift AS/.test(s),
            rows: [
              {
                total_debit: '0', total_credit: '0',
                cashbox_balance_drift_count: 0,
                drift_count: 0, drift_abs: '0',
                bypass_7d: 0, bypass_last_seen: null,
                unbalanced_count: 0,
              },
            ],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-28' });
      expect(r.health.engine_bypass_alerts_last_seen).toBeNull();
    });

    it('daily_expenses returns both today and period slices', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /today_expenses AS/.test(s) && /period_expenses AS/.test(s),
            rows: [
              {
                today_total: '0',
                today_count: 0,
                today_largest_cat: null,
                today_largest_amt: null,
                period_total: '3821.00',
                period_count: 17,
                period_largest_cat: 'كهرباء ومرافق',
                period_largest_amt: '2000.00',
              },
            ],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-28' });
      expect(r.daily_expenses.today_total).toBe(0);
      expect(r.daily_expenses.today_count).toBe(0);
      expect(r.daily_expenses.today_largest).toBeNull();
      expect(r.daily_expenses.period_total).toBe(3821);
      expect(r.daily_expenses.period_count).toBe(17);
      expect(r.daily_expenses.period_largest).toEqual({
        category: 'كهرباء ومرافق',
        amount: 2000,
      });
    });

    it('supplier balances pick the suppliers_table source when populated', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /sources AS/.test(s) && /effective AS/.test(s) && /coa_211 AS/.test(s),
            rows: [
              {
                total: '500',
                n: 2,
                top_name: 'مصنع النور',
                top_amount: '300',
                has_table: true,
                has_gl: false,
                has_purchase: false,
              },
            ],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-28' });
      expect(r.balances.suppliers.total_due).toBe(500);
      expect(r.balances.suppliers.count).toBe(2);
      expect(r.balances.suppliers.top).toEqual({ name: 'مصنع النور', amount: 300 });
      expect(r.balances.suppliers.effective_source).toBe('suppliers_table');
      expect(r.balances.suppliers.sources_checked).toEqual([
        'suppliers_table', 'gl_211', 'purchases',
      ]);
    });

    it('supplier balances fall through to gl_211 when only GL has data', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /sources AS/.test(s) && /effective AS/.test(s),
            rows: [
              {
                total: '120', n: 1,
                top_name: 'مورد', top_amount: '120',
                has_table: false, has_gl: true, has_purchase: false,
              },
            ],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-28' });
      expect(r.balances.suppliers.effective_source).toBe('gl_211');
    });

    it('supplier balances report effective_source=mixed when multiple sources contribute', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /sources AS/.test(s) && /effective AS/.test(s),
            rows: [
              {
                total: '600', n: 3,
                top_name: 'a', top_amount: '300',
                has_table: true, has_gl: true, has_purchase: false,
              },
            ],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-28' });
      expect(r.balances.suppliers.effective_source).toBe('mixed');
    });

    it('supplier balances report effective_source=none when all three sources agree on zero', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /sources AS/.test(s) && /effective AS/.test(s),
            rows: [
              {
                total: '0', n: 0,
                top_name: null, top_amount: null,
                has_table: false, has_gl: false, has_purchase: false,
              },
            ],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-28' });
      expect(r.balances.suppliers.total_due).toBe(0);
      expect(r.balances.suppliers.count).toBe(0);
      expect(r.balances.suppliers.top).toBeNull();
      expect(r.balances.suppliers.effective_source).toBe('none');
    });
  });

  /**
   * PR-FIN-2-HOTFIX-3 — employee balances column guard.
   *
   * The original PR-FIN-2 SQL used `net_balance` from
   * `v_employee_gl_balance`, but the actual exposed column is
   * `balance`. Postgres threw `42703: column "net_balance" does not
   * exist` on every dashboard request; the surrounding `.catch`
   * swallowed the error and returned zeros. Fixed in HOTFIX-3 by
   * switching to the canonical `balance` column.
   *
   * These tests pin both the wire shape of `balances.employees`
   * and the SQL contract: any future code that reintroduces
   * `net_balance` (or otherwise drifts away from `balance`) fails
   * CI before reaching production.
   */
  describe('PR-FIN-2-HOTFIX-3 — employee balances column', () => {
    it('returns owed_to/owed_by/net from the v_employee_gl_balance.balance column', async () => {
      const { svc } = buildSvc({
        matchers: [
          {
            test: (s) => /v_employee_gl_balance/.test(s),
            // Mirrors the live shape: the SELECT projects three
            // aliases (owed_to / owed_by / net) computed from
            // SUM(CASE … balance …).
            rows: [{ owed_to: '480.00', owed_by: '55.00', net: '425.00' }],
          },
        ],
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-28' });
      expect(r.balances.employees).toEqual({
        total_owed_to: 480,
        total_owed_by: 55,
        net: 425,
      });
    });

    it('SQL never references the non-existent net_balance column', async () => {
      const { svc, calls } = buildSvc();
      await svc.dashboard({ from: '2026-04-01', to: '2026-04-28' });
      const empCall = calls.find((c) => /v_employee_gl_balance/.test(c.sql));
      expect(empCall).toBeDefined();
      expect(empCall!.sql).not.toMatch(/net_balance/);
      expect(empCall!.sql).toMatch(/\bbalance\b/);
    });
  });

  /**
   * PR-FIN-2-HOTFIX-2 — connection-pool exhaustion guard.
   *
   * The original PR-FIN-2 fanned out ~28 concurrent SELECTs via
   * `Promise.all`, exhausting Supabase's session-mode pool
   * (pool_size: 15) on every authenticated dashboard load. The fix
   * is sequential awaits — concurrent queries per request capped
   * at 1.
   *
   * This test instruments `ds.query` to track in-flight count and
   * asserts that **at no point** does the dashboard have more than
   * a small number (≤3) of concurrent queries. If a future
   * contributor reintroduces a `Promise.all` over DB queries this
   * test fails before the change reaches production.
   */
  describe('PR-FIN-2-HOTFIX-2 — concurrency cap', () => {
    it('never has more than 3 DB queries in flight concurrently', async () => {
      let inFlight = 0;
      let peak = 0;
      const ds = {
        query: jest.fn(async (_sql: string, _params?: any[]) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          // Defer resolution by a microtask so any sibling Promise.all
          // would actually overlap. Without this, jest mocks resolve
          // synchronously and we'd never observe parallelism even
          // when it's there.
          await new Promise((r) => setImmediate(r));
          inFlight -= 1;
          return [];
        }),
      };
      const svc = new FinanceDashboardService(ds as any);
      await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(peak).toBeLessThanOrEqual(3);
    });

    it('with sequential awaits, peak in-flight is exactly 1', async () => {
      let inFlight = 0;
      let peak = 0;
      const ds = {
        query: jest.fn(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setImmediate(r));
          inFlight -= 1;
          return [];
        }),
      };
      const svc = new FinanceDashboardService(ds as any);
      await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
      expect(peak).toBe(1);
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

// ─── PR-FIN-DASHBOARD-DRIFT-CANCEL-AWARE ──────────────────────────
// Pins the cancel-aware normalization on the financial-health card.
// The dashboard's `health()` reads `v_cashbox_drift_per_ref` for
// the operator-facing "فروق تصنيف مراجع" KPI. That view splits
// each cancelled return into 3 phantom rows that the legacy
// per-ref grouping can't merge. Operationally the cluster nets to
// zero, so we subtract:
//   • count of phantom rows from cashbox_drift_count
//   • Σ |drift_amount| of phantom rows from cashbox_drift_total
// Same fix the cash-desk gl-drift endpoint applies (PR #246).
describe('FinanceDashboardService.health — cancel-aware drift normalization', () => {
  // The default `buildSvc()` constructs the service WITHOUT the
  // helper to mirror the pre-PR safety contract. We need a variant
  // that injects a fake helper to assert the new subtraction logic.
  function buildSvcWithDriftHelper(
    helperReturns: { rows: number; absTotal: number },
    healthFixture: {
      total_debit?: string;
      total_credit?: string;
      cashbox_balance_drift_count?: number;
      drift_count?: number;
      drift_abs?: number;
      bypass_7d?: number;
      bypass_last_seen?: any;
      unbalanced_count?: number;
    } = {},
    // PR-FIN-DASHBOARD-DRIFT-TAXONOMY-PAIRING — second helper return
    // for the new `taxonomyMismatchGlobalStats()` method. Defaults to
    // {0, 0} so existing specs that only pin cluster-phantom behavior
    // see no taxonomy contribution.
    taxonomyReturns: { rows: number; absTotal: number } = { rows: 0, absTotal: 0 },
  ) {
    const calls: { sql: string; params: any[] }[] = [];
    const ds = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        if (/tb AS/.test(sql)) {
          return [
            {
              total_debit:                 healthFixture.total_debit ?? '100.00',
              total_credit:                healthFixture.total_credit ?? '100.00',
              cashbox_balance_drift_count: healthFixture.cashbox_balance_drift_count ?? 0,
              drift_count:                 healthFixture.drift_count ?? 0,
              drift_abs:                   healthFixture.drift_abs ?? 0,
              bypass_7d:                   healthFixture.bypass_7d ?? 0,
              bypass_last_seen:            healthFixture.bypass_last_seen ?? null,
              unbalanced_count:            healthFixture.unbalanced_count ?? 0,
            },
          ];
        }
        return [];
      }),
    };
    const helper = {
      clusterPhantomGlobalStats:    jest.fn(async () => helperReturns),
      taxonomyMismatchGlobalStats:  jest.fn(async () => taxonomyReturns),
    };
    const svc = new FinanceDashboardService(ds as any, helper as any);
    return { svc, ds, helper, calls };
  }

  it('subtracts phantom rows from cashbox_drift_count', async () => {
    // Production snapshot: raw view shows 25 drift rows; 3 are
    // phantoms from cancelled-return clusters → adjusted count = 22.
    const { svc, helper } = buildSvcWithDriftHelper(
      { rows: 3, absTotal: 1050 },
      { drift_count: 25, drift_abs: 4137.98 },
    );
    const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(helper.clusterPhantomGlobalStats).toHaveBeenCalledTimes(1);
    expect(r.health.cashbox_drift_count).toBe(22);
  });

  it('subtracts |drift_amount| of phantom rows from cashbox_drift_total', async () => {
    // Same snapshot: |drift_abs| 4,137.98 minus phantom 1,050.00 = 3,087.98.
    const { svc } = buildSvcWithDriftHelper(
      { rows: 3, absTotal: 1050 },
      { drift_count: 25, drift_abs: 4137.98 },
    );
    const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(r.health.cashbox_drift_total).toBe(3087.98);
  });

  it('with no phantoms, returns the raw view numbers verbatim', async () => {
    const { svc } = buildSvcWithDriftHelper(
      { rows: 0, absTotal: 0 },
      { drift_count: 25, drift_abs: 4137.98 },
    );
    const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(r.health.cashbox_drift_count).toBe(25);
    expect(r.health.cashbox_drift_total).toBe(4137.98);
  });

  it('clamps to 0 if phantom count would push the result negative (defensive)', async () => {
    // If the helper somehow returns more phantoms than the raw view
    // shows (impossible in practice but cheap to guard), we MUST NOT
    // surface a negative count to the FE.
    const { svc } = buildSvcWithDriftHelper(
      { rows: 100, absTotal: 9999 },
      { drift_count: 5, drift_abs: 200 },
    );
    const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(r.health.cashbox_drift_count).toBe(0);
    expect(r.health.cashbox_drift_total).toBe(0);
  });

  it('falls back to raw numbers when the helper is NOT injected (defensive @Optional path)', async () => {
    // The pre-PR construction path (default `buildSvc`) constructs
    // the service WITHOUT the helper. The service must still return
    // a valid health card — just with the raw view numbers.
    const { svc } = buildSvc({
      matchers: [
        {
          test: (s: string) => /tb AS/.test(s),
          rows: [
            {
              total_debit:  '100.00',
              total_credit: '100.00',
              cashbox_balance_drift_count: 0,
              drift_count:  25,
              drift_abs:    4137.98,
              bypass_7d:    0,
              bypass_last_seen: null,
              unbalanced_count: 0,
            },
          ],
        },
      ],
    });
    const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(r.health.cashbox_drift_count).toBe(25);
    expect(r.health.cashbox_drift_total).toBe(4137.98);
  });

  it('helper SQL is pure SELECT — no INSERT/UPDATE/DELETE on the cancel-aware path', async () => {
    // Spec-level guard: the helper's internal `clusterPhantomGlobalStats`
    // SQL is exercised by its own helper.spec.ts file, but assert here
    // that calling `health()` with the helper present never causes the
    // service to emit any non-SELECT statement either.
    const { svc, calls } = buildSvcWithDriftHelper(
      { rows: 3, absTotal: 1050 },
      { drift_count: 25, drift_abs: 4137.98 },
    );
    await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    for (const c of calls) {
      const sql = c.sql.trim();
      // Allow `WITH` CTEs (every cash query in this file uses them);
      // the actual leaf must still be SELECT.
      expect(sql).not.toMatch(/\bINSERT\b/i);
      expect(sql).not.toMatch(/\bUPDATE\s+\w/i);
      expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
      expect(sql).not.toMatch(/\bMERGE\s+INTO\b/i);
      expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    }
  });

  it('overall=warning when adjusted drift_abs > 0 (not raw)', async () => {
    // Adjusted = 200 (raw 1200 − phantom 1000 = 200) → still warning.
    const { svc } = buildSvcWithDriftHelper(
      { rows: 3, absTotal: 1000 },
      { drift_count: 5, drift_abs: 1200, bypass_7d: 0 },
    );
    const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(r.health.cashbox_drift_total).toBe(200);
    expect(r.health.overall).toBe('warning');
  });

  it('overall=healthy when phantoms eat ALL the raw drift', async () => {
    // Adjusted = 0 (raw 1000 − phantom 1000 = 0) → healthy.
    const { svc } = buildSvcWithDriftHelper(
      { rows: 3, absTotal: 1000 },
      { drift_count: 3, drift_abs: 1000, bypass_7d: 0 },
    );
    const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(r.health.cashbox_drift_total).toBe(0);
    expect(r.health.cashbox_drift_count).toBe(0);
    expect(r.health.overall).toBe('healthy');
  });

  it('helper is invoked exactly once per dashboard request (no fan-out)', async () => {
    const { svc, helper } = buildSvcWithDriftHelper(
      { rows: 3, absTotal: 1050 },
      { drift_count: 25, drift_abs: 4137.98 },
    );
    await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(helper.clusterPhantomGlobalStats).toHaveBeenCalledTimes(1);
  });
});

// ─── PR-FIN-DASHBOARD-DRIFT-TAXONOMY-PAIRING ──────────────────────
// Pins the second normalization on the financial-health card.
// Composes with PR #254's cluster-phantom adjustment: BOTH phantom
// classes are subtracted on every dashboard request.
//
// Phantom class 1 (PR #254): cancelled-return clusters — 3 rows per
// cancelled return tagged with different reference_type, all with
// the cluster summing to zero.
//
// Phantom class 2 (THIS PR): taxonomy mismatches — CT side and JE
// side use DIFFERENT reference_type for the SAME reference_id (e.g.
// CT='other', JE='employee_settlement'). The per-ref view emits two
// one-sided rows that pair to zero by reference_id alone. Each pair
// contributes COUNT*1 + Σ |drift| to the false-positive KPI.
//
// The two phantom sets do not overlap by construction (the taxonomy
// helper EXCLUDES cluster_refs from its query). Rows that survive
// BOTH adjustments are genuine one-sided cashbox-vs-GL drift that
// an operator should investigate.
describe('FinanceDashboardService.health — taxonomy-pairing normalization', () => {
  // Reuse the buildSvcWithDriftHelper from the cancel-aware describe
  // block by re-defining a thin local copy that omits the cluster-
  // phantom default (so each spec's intent is explicit).
  function buildSvcBoth(
    cluster: { rows: number; absTotal: number },
    taxonomy: { rows: number; absTotal: number },
    healthFixture: {
      total_debit?: string;
      total_credit?: string;
      drift_count?: number;
      drift_abs?: number;
      bypass_7d?: number;
      unbalanced_count?: number;
      cashbox_balance_drift_count?: number;
    } = {},
  ) {
    const calls: { sql: string; params: any[] }[] = [];
    const ds = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        if (/tb AS/.test(sql)) {
          return [
            {
              total_debit:                 healthFixture.total_debit ?? '100.00',
              total_credit:                healthFixture.total_credit ?? '100.00',
              cashbox_balance_drift_count: healthFixture.cashbox_balance_drift_count ?? 0,
              drift_count:                 healthFixture.drift_count ?? 0,
              drift_abs:                   healthFixture.drift_abs ?? 0,
              bypass_7d:                   healthFixture.bypass_7d ?? 0,
              bypass_last_seen:            null,
              unbalanced_count:            healthFixture.unbalanced_count ?? 0,
            },
          ];
        }
        return [];
      }),
    };
    const helper = {
      clusterPhantomGlobalStats:   jest.fn(async () => cluster),
      taxonomyMismatchGlobalStats: jest.fn(async () => taxonomy),
    };
    const svc = new FinanceDashboardService(ds as any, helper as any);
    return { svc, helper, calls };
  }

  it('subtracts BOTH cluster phantoms AND taxonomy mismatches from cashbox_drift_count', async () => {
    // Production snapshot: raw 25, cluster 3, taxonomy 22 → adjusted 0.
    const { svc, helper } = buildSvcBoth(
      { rows: 3, absTotal: 1050 },         // PR #254 cluster phantoms
      { rows: 22, absTotal: 3087.98 },     // THIS PR taxonomy phantoms
      { drift_count: 25, drift_abs: 4137.98 },
    );
    const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(helper.clusterPhantomGlobalStats).toHaveBeenCalledTimes(1);
    expect(helper.taxonomyMismatchGlobalStats).toHaveBeenCalledTimes(1);
    expect(r.health.cashbox_drift_count).toBe(0);
    expect(r.health.cashbox_drift_total).toBe(0);
  });

  it('production snapshot end-to-end: 25/4,137.98 → 0/0.00', async () => {
    const { svc } = buildSvcBoth(
      { rows: 3,  absTotal: 1050 },
      { rows: 22, absTotal: 3087.98 },
      { drift_count: 25, drift_abs: 4137.98 },
    );
    const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(r.health.cashbox_drift_count).toBe(0);
    expect(r.health.cashbox_drift_total).toBe(0);
    expect(r.health.overall).toBe('healthy');
  });

  it('legitimate unpaired drift survives both adjustments', async () => {
    // Suppose 30 raw rows: 3 cluster phantoms + 22 taxonomy + 5 real
    // one-sided drifts (e.g. raw 30, raw_abs 5,000 incl. 1,050+3,088+862).
    const { svc } = buildSvcBoth(
      { rows: 3,  absTotal: 1050 },
      { rows: 22, absTotal: 3087.98 },
      { drift_count: 30, drift_abs: 5000 },
    );
    const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(r.health.cashbox_drift_count).toBe(5);            // 30 - 3 - 22
    expect(r.health.cashbox_drift_total).toBe(862.02);       // 5000 - 1050 - 3087.98
    expect(r.health.overall).toBe('warning');
  });

  it('cancelled-return phantom adjustment alone (no taxonomy phantoms) — preserves PR #254 behaviour', async () => {
    const { svc } = buildSvcBoth(
      { rows: 3, absTotal: 1050 },
      { rows: 0, absTotal: 0 },          // no taxonomy phantoms
      { drift_count: 25, drift_abs: 4137.98 },
    );
    const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(r.health.cashbox_drift_count).toBe(22);           // 25 - 3 - 0
    expect(r.health.cashbox_drift_total).toBe(3087.98);      // 4137.98 - 1050 - 0
  });

  it('taxonomy phantom adjustment alone (no cluster phantoms) — symmetric behaviour', async () => {
    const { svc } = buildSvcBoth(
      { rows: 0, absTotal: 0 },          // no cluster phantoms
      { rows: 22, absTotal: 3087.98 },
      { drift_count: 22, drift_abs: 3087.98 },
    );
    const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(r.health.cashbox_drift_count).toBe(0);            // 22 - 0 - 22
    expect(r.health.cashbox_drift_total).toBe(0);            // 3087.98 - 0 - 3087.98
  });

  it('clamps to 0 if BOTH phantom classes overshoot the raw view (defensive)', async () => {
    // Impossible in practice (phantoms are subset of raw rows), but
    // the dashboard MUST NOT surface a negative count to the FE.
    const { svc } = buildSvcBoth(
      { rows: 100, absTotal: 9999 },
      { rows: 100, absTotal: 9999 },
      { drift_count: 5, drift_abs: 200 },
    );
    const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(r.health.cashbox_drift_count).toBe(0);
    expect(r.health.cashbox_drift_total).toBe(0);
  });

  it('both helper methods invoked exactly once per dashboard request (no fan-out)', async () => {
    const { svc, helper } = buildSvcBoth(
      { rows: 3, absTotal: 1050 },
      { rows: 22, absTotal: 3087.98 },
      { drift_count: 25, drift_abs: 4137.98 },
    );
    await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(helper.clusterPhantomGlobalStats).toHaveBeenCalledTimes(1);
    expect(helper.taxonomyMismatchGlobalStats).toHaveBeenCalledTimes(1);
  });

  it('overall=healthy when phantoms (both classes combined) eat ALL the raw drift', async () => {
    const { svc } = buildSvcBoth(
      { rows: 3,  absTotal: 1050 },
      { rows: 22, absTotal: 3087.98 },
      { drift_count: 25, drift_abs: 4137.98, bypass_7d: 0 },
    );
    const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(r.health.cashbox_drift_total).toBe(0);
    expect(r.health.overall).toBe('healthy');
  });

  it('overall=warning when adjusted drift > 0 after BOTH subtractions', async () => {
    // Adjusted = 200 (raw 1,200 − cluster 500 − taxonomy 500 = 200).
    const { svc } = buildSvcBoth(
      { rows: 1, absTotal: 500 },
      { rows: 2, absTotal: 500 },
      { drift_count: 5, drift_abs: 1200, bypass_7d: 0 },
    );
    const r = await svc.dashboard({ from: '2026-04-01', to: '2026-04-30' });
    expect(r.health.cashbox_drift_total).toBe(200);
    expect(r.health.overall).toBe('warning');
  });
});

/**
 * PR-FIN-DASHBOARD-EXPENSES-CASH-BASIS-REVERT — reverts PR #257.
 *
 * Business rule (clarified by user after PR #257 shipped): the
 * dashboard's expenses card represents CASH that left the cash drawer
 * for an operating purpose during the range. Advances ARE included
 * because the cash physically left the drawer. Wage accruals are NOT
 * added to the headline because they would double-count the same
 * wage event the advance pre-pays.
 *
 * These specs lock the cash-basis formula at all three sites:
 *   · `dailyExpensesTodayAndPeriod` — headline + breakdown
 *   · `profitTotals.expense_total`   — profit summary expenses
 *   · `profitTrendDaily`             — per-day net-profit subtraction
 * AND assert PR #257's wage_accrual machinery is fully gone (no
 * `today_wage_accruals` / `period_wage_accruals` / `today_combined`
 * / `period_combined` CTEs, no `employee_wage_accrual` filter on
 * any of the three paths).
 */
describe('FinanceDashboardService — expenses card: cash-basis revert (PR-FIN-DASHBOARD-EXPENSES-CASH-BASIS-REVERT)', () => {
  function buildSvc(stubs: {
    dailyExpenses?: any;
    expenseTotal?: number;
    perDayRows?: Array<{ d: string; total: string }>;
  } = {}) {
    const calls: { sql: string; params: any[] }[] = [];
    const ds = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        // dailyExpensesTodayAndPeriod — match by the breakdown fields
        // unique to the cash-basis revert (period_advances_total).
        if (/period_advances_total/.test(sql)) {
          return [stubs.dailyExpenses ?? {
            today_total: '0', today_count: 0,
            today_largest_cat: null, today_largest_amt: null,
            period_total: '0', period_count: 0,
            period_largest_cat: null, period_largest_amt: null,
            period_advances_total: '0', period_advances_count: 0,
            period_non_advances_total: '0', period_non_advances_count: 0,
          }];
        }
        // profitTotals — match `expense_total AS (` shape
        if (/expense_total AS/.test(sql) && /agg AS/.test(sql)) {
          return [{
            sales: '0', cogs: '0', gross: '0',
            expenses: String(stubs.expenseTotal ?? 0),
            high_lines: 0, medium_lines: 0, low_lines: 0,
          }];
        }
        // profitTrendDaily — bare per-day expenses lookup (no CTE name)
        if (/SELECT expense_date AS d/.test(sql) && /FROM expenses/.test(sql)) {
          return stubs.perDayRows ?? [];
        }
        return [];
      }),
    };
    const svc = new FinanceDashboardService(ds as any);
    return { svc, calls };
  }

  // ── SQL-shape guards on dailyExpensesTodayAndPeriod ──────────────
  describe('dailyExpensesTodayAndPeriod — cash-basis SQL shape', () => {
    it('today_expenses CTE INCLUDES advances — no is_advance filter', async () => {
      const { svc, calls } = buildSvc();
      await svc.dashboard({ from: '2026-04-01', to: '2026-05-03' });
      const sql = calls.find((c) => /period_advances_total/.test(c.sql))?.sql ?? '';
      expect(sql).toMatch(/today_expenses AS \(/);
      // No advance filter on today_expenses — every row counted.
      const todayCte = sql.slice(
        sql.indexOf('today_expenses AS ('),
        sql.indexOf('period_expenses AS ('),
      );
      expect(todayCte).not.toMatch(/is_advance/);
    });

    it('period_expenses CTE INCLUDES advances — no is_advance filter on the CTE itself', async () => {
      const { svc, calls } = buildSvc();
      await svc.dashboard({ from: '2026-04-01', to: '2026-05-03' });
      const sql = calls.find((c) => /period_advances_total/.test(c.sql))?.sql ?? '';
      const periodCte = sql.slice(
        sql.indexOf('period_expenses AS ('),
        sql.indexOf('today_largest AS ('),
      );
      // The CTE preserves is_advance as a column for the breakdown but
      // does NOT filter rows out of the headline.
      expect(periodCte).toMatch(/e\.is_advance/);
      expect(periodCte).not.toMatch(/WHERE[\s\S]*COALESCE\(e\.is_advance/);
    });

    it('PR #257 wage_accrual CTEs are GONE (no today_wage_accruals / period_wage_accruals / today_combined / period_combined)', async () => {
      const { svc, calls } = buildSvc();
      await svc.dashboard({ from: '2026-04-01', to: '2026-05-03' });
      const sql = calls.find((c) => /period_advances_total/.test(c.sql))?.sql ?? '';
      expect(sql).not.toMatch(/today_wage_accruals/);
      expect(sql).not.toMatch(/period_wage_accruals/);
      expect(sql).not.toMatch(/today_combined/);
      expect(sql).not.toMatch(/period_combined/);
      expect(sql).not.toMatch(/employee_wage_accrual/);
    });

    it('headline totals/counts read from the bare expenses CTEs (cash basis)', async () => {
      const { svc, calls } = buildSvc();
      await svc.dashboard({ from: '2026-04-01', to: '2026-05-03' });
      const sql = calls.find((c) => /period_advances_total/.test(c.sql))?.sql ?? '';
      expect(sql).toMatch(/SUM\(amount\),\s*0\)\s*FROM today_expenses\)/);
      expect(sql).toMatch(/COUNT\(\*\)\s*FROM today_expenses\)/);
      expect(sql).toMatch(/SUM\(amount\),\s*0\)\s*FROM period_expenses\)/);
      expect(sql).toMatch(/COUNT\(\*\)\s*FROM period_expenses\)/);
    });

    it('emits the period_advances + period_non_advances breakdown SUMs/COUNTs', async () => {
      const { svc, calls } = buildSvc();
      await svc.dashboard({ from: '2026-04-01', to: '2026-05-03' });
      const sql = calls.find((c) => /period_advances_total/.test(c.sql))?.sql ?? '';
      // Both branches of the breakdown must be present.
      expect(sql).toMatch(/COALESCE\(is_advance,\s*FALSE\)\s*=\s*TRUE\)\s*AS period_advances_total/);
      expect(sql).toMatch(/COALESCE\(is_advance,\s*FALSE\)\s*=\s*TRUE\)\s*AS period_advances_count/);
      expect(sql).toMatch(/COALESCE\(is_advance,\s*FALSE\)\s*=\s*FALSE\)\s*AS period_non_advances_total/);
      expect(sql).toMatch(/COALESCE\(is_advance,\s*FALSE\)\s*=\s*FALSE\)\s*AS period_non_advances_count/);
    });
  });

  // ── End-to-end fixtures pinning the user's reported numbers ──────
  describe('dailyExpensesTodayAndPeriod — production fixture (range 2026-04-01..05-03)', () => {
    it('headline period_total = 7,796 with advances 4,051 + non-advances 3,745 (sums exactly)', async () => {
      const { svc } = buildSvc({
        dailyExpenses: {
          today_total: '70.00', today_count: 1,
          today_largest_cat: 'سلف الموظفين', today_largest_amt: '70.00',
          period_total: '7796.00', period_count: 30,
          period_largest_cat: 'سلف الموظفين', period_largest_amt: '2000.00',
          period_advances_total: '4051.00', period_advances_count: 15,
          period_non_advances_total: '3745.00', period_non_advances_count: 15,
        },
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-05-03' });
      expect(r.daily_expenses.period_total).toBe(7796);
      expect(r.daily_expenses.period_count).toBe(30);
      expect(r.daily_expenses.period_advances_total).toBe(4051);
      expect(r.daily_expenses.period_non_advances_total).toBe(3745);
      // Breakdown sums to headline exactly — no overlap, no missing rows.
      expect(
        r.daily_expenses.period_advances_total +
          r.daily_expenses.period_non_advances_total,
      ).toBe(r.daily_expenses.period_total);
      expect(
        r.daily_expenses.period_advances_count +
          r.daily_expenses.period_non_advances_count,
      ).toBe(r.daily_expenses.period_count);
    });

    it('today=70/1 — the EXP-46 advance is restored to the headline (cash left the drawer)', async () => {
      const { svc } = buildSvc({
        dailyExpenses: {
          today_total: '70.00', today_count: 1,
          today_largest_cat: 'سلف الموظفين', today_largest_amt: '70.00',
          period_total: '7796.00', period_count: 30,
          period_largest_cat: 'سلف الموظفين', period_largest_amt: '2000.00',
          period_advances_total: '4051.00', period_advances_count: 15,
          period_non_advances_total: '3745.00', period_non_advances_count: 15,
        },
      });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-05-03' });
      expect(r.daily_expenses.today_total).toBe(70);
      expect(r.daily_expenses.today_count).toBe(1);
      expect(r.daily_expenses.today_largest).toEqual({
        category: 'سلف الموظفين',
        amount: 70,
      });
    });

    it('all-zero fixture stays zero, no NaN/undefined leaks on breakdown fields', async () => {
      const { svc } = buildSvc();
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-05-03' });
      expect(r.daily_expenses.today_total).toBe(0);
      expect(r.daily_expenses.period_total).toBe(0);
      expect(r.daily_expenses.period_advances_total).toBe(0);
      expect(r.daily_expenses.period_advances_count).toBe(0);
      expect(r.daily_expenses.period_non_advances_total).toBe(0);
      expect(r.daily_expenses.period_non_advances_count).toBe(0);
      expect(Number.isNaN(r.daily_expenses.period_advances_total)).toBe(false);
    });
  });

  // ── profitTotals: expenses sub-figure (cash-basis revert) ────────
  describe('profitTotals — expense_total composition', () => {
    it('SQL is the bare cash-basis expenses SUM — no is_advance filter, no wage_accrual UNION', async () => {
      const { svc, calls } = buildSvc();
      await svc.dashboard({ from: '2026-04-01', to: '2026-05-03' });
      const sql = calls.find((c) => /expense_total AS/.test(c.sql))?.sql ?? '';
      const cte = sql.slice(sql.indexOf('expense_total AS ('), sql.indexOf('agg AS ('));
      // No PR #257 advance filter inside the expense_total CTE.
      expect(cte).not.toMatch(/is_advance/);
      // No wage_accrual UNION/subquery inside the expense_total CTE.
      expect(cte).not.toMatch(/employee_wage_accrual/);
      expect(cte).not.toMatch(/jl\.debit/);
      // Just the bare expenses-table SUM gated by the date range.
      expect(cte).toMatch(/SELECT COALESCE\(SUM\(amount\),\s*0\)\s*AS total/);
      expect(cte).toMatch(/FROM expenses/);
      expect(cte).toMatch(/expense_date\s*>=\s*\$1::date/);
      expect(cte).toMatch(/expense_date\s*<=\s*\$2::date/);
    });

    it('cashbox filter still tightens the expenses-table SUM (preserved from pre-PR #257)', async () => {
      const { svc, calls } = buildSvc();
      await svc.dashboard({
        from: '2026-04-01', to: '2026-05-03',
        cashbox_id: 'cb-test',
      });
      const sql = calls.find((c) => /expense_total AS/.test(c.sql))?.sql ?? '';
      const cte = sql.slice(sql.indexOf('expense_total AS ('), sql.indexOf('agg AS ('));
      expect(cte).toMatch(/cashbox_id\s*=\s*\$/);
      // Still no wage_accrual leakage when cashbox filter is active.
      expect(cte).not.toMatch(/employee_wage_accrual/);
    });

    it('production fixture: profit.expenses_total = 7,796 for the bridge range', async () => {
      const { svc } = buildSvc({ expenseTotal: 7796 });
      const r = await svc.dashboard({ from: '2026-04-01', to: '2026-05-03' });
      expect(r.profit.expenses_total).toBe(7796);
    });
  });

  // ── profitTrendDaily: per-day expense lookup (cash-basis revert) ──
  describe('profitTrendDaily — per-day expense lookup', () => {
    it('SQL is the bare per-day expenses SUM — no per_day CTE, no wage_accrual UNION', async () => {
      const { svc, calls } = buildSvc();
      await svc.dashboard({ from: '2026-04-01', to: '2026-05-03' });
      const sql = calls.find((c) =>
        /SELECT expense_date AS d/.test(c.sql) && /FROM expenses/.test(c.sql),
      )?.sql ?? '';
      expect(sql).toBeTruthy();
      // No per_day CTE wrapper, no wage_accrual stream.
      expect(sql).not.toMatch(/per_day AS/);
      expect(sql).not.toMatch(/UNION ALL/);
      expect(sql).not.toMatch(/employee_wage_accrual/);
      expect(sql).not.toMatch(/COALESCE\(is_advance/);
      // Bare shape: SELECT expense_date AS d, SUM(amount) FROM expenses GROUP BY 1
      expect(sql).toMatch(/SELECT expense_date AS d,\s*COALESCE\(SUM\(amount\),\s*0\)/);
    });
  });

  // ── No-write invariant on the cash-basis paths ───────────────────
  describe('no-write invariant on cash-basis revert paths', () => {
    it('every issued query is pure SELECT — no INSERT/UPDATE/DELETE/TRUNCATE on any of the three sites', async () => {
      const { svc, calls } = buildSvc();
      await svc.dashboard({ from: '2026-04-01', to: '2026-05-03' });
      const sites = calls.filter((c) =>
        /period_advances_total/.test(c.sql) ||
        /expense_total AS/.test(c.sql) ||
        (/SELECT expense_date AS d/.test(c.sql) && /FROM expenses/.test(c.sql)),
      );
      expect(sites.length).toBeGreaterThanOrEqual(3);
      for (const c of sites) {
        const upper = c.sql.toUpperCase();
        expect(upper).not.toMatch(/\bINSERT\s+INTO\b/);
        expect(upper).not.toMatch(/\bUPDATE\b/);
        expect(upper).not.toMatch(/\bDELETE\s+FROM\b/);
        expect(upper).not.toMatch(/\bTRUNCATE\b/);
      }
    });
  });
});
