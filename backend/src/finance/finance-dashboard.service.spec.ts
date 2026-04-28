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
