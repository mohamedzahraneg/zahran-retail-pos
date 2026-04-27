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
});
