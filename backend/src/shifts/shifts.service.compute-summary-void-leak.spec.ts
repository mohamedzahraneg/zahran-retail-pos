/**
 * shifts.service.compute-summary-void-leak.spec.ts — PR-AUDIT-VOID-LEAK
 *
 * Pins that `ShiftsService.computeSummary()`'s `txRows` query
 * (the per-direction × per-category cashbox-transactions breakdown
 * that feeds `customerReceipts` / `supplierPayments` / `otherCashIn`
 * / `otherCashOut` in the shift summary report) excludes voided
 * cancellation/reversal CT rows.
 *
 * Background:
 *   PR #266 plugged the same bug class in
 *     · accounting.service.cashflow / trialBalance
 *     · analytics.service.cashFlowWaterfall / dailyPerformance
 *   But shifts.service.computeSummary's txRows query was not in PR
 *   #266's audit scope. Without the void filter, voided CT rows
 *   inflated the shift's customerReceipts / supplierPayments /
 *   otherCashIn / otherCashOut buckets in /summary and
 *   /aggregateDetail report endpoints.
 *
 * Note on production coverage: most of these CT category keys
 * (`in_receipt`, `out_payment`, `in_manual`, …) don't match
 * production category vocabulary (verified by
 * PR-AUDIT-SHIFT-ACCOUNTING-INTEGRITY), so the lookup map values
 * usually fall back to 0 even before this fix. The fix is still
 * load-bearing because:
 *   1. Future category vocabulary changes could re-activate the
 *      buckets without re-introducing the leak.
 *   2. The COUNT(*) aggregated alongside the SUM also leaked, and
 *      would have inflated any caller relying on `tx.<key>.count`.
 *
 * Source-shape spec: we mock `DataSource.query` to capture the SQL
 * and assert the void filter is present in the WHERE clause.
 */
import { ShiftsService } from './shifts.service';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function makeSvc() {
  const calls: QueryCall[] = [];
  const ds: any = {
    query: (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      // The shape of the response depends on the SQL — most paths
      // tolerate empty arrays. We only need to capture the txRows
      // query's SQL, so default to [] for everything else.
      if (/SUM\(CASE WHEN i\.status IN/i.test(sql)) {
        return Promise.resolve([
          {
            total_sales: 0,
            total_cancelled: 0,
            invoice_count: 0,
            cancelled_count: 0,
            remaining_receivable: 0,
          },
        ]);
      }
      if (/FROM returns r/i.test(sql)) {
        return Promise.resolve([{ total_returns: 0, return_count: 0 }]);
      }
      return Promise.resolve([]);
    },
    manager: {
      query: (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        return Promise.resolve([]);
      },
    },
  };
  return { svc: new ShiftsService(ds), calls };
}

const SHIFT = {
  id: '00000000-0000-0000-0000-000000000001',
  shift_no: 'SHF-T-VOIDLEAK',
  cashbox_id: '00000000-0000-0000-0000-000000000010',
  warehouse_id: '00000000-0000-0000-0000-000000000020',
  opened_by: '00000000-0000-0000-0000-000000000030',
  opened_at: '2026-05-05T00:00:00Z',
  closed_at: '2026-05-05T08:00:00Z',
  opening_balance: '0',
};

describe('ShiftsService.computeSummary.txRows — PR-AUDIT-VOID-LEAK', () => {
  it('emits `is_void = FALSE` in the WHERE clause of the txRows aggregation', async () => {
    const { svc, calls } = makeSvc();
    await (svc as any).computeSummary({ ...SHIFT });

    // Find the txRows query — the one selecting direction + category
    // SUM(amount) GROUP BY direction, category over cashbox_transactions.
    const tx = calls.find(
      (c) =>
        /FROM cashbox_transactions/i.test(c.sql) &&
        /GROUP BY direction, category/i.test(c.sql),
    );
    expect(tx).toBeDefined();
    if (!tx) return;

    expect(tx.sql).toMatch(/SUM\(amount\)/i);
    // The fix: WHERE … AND is_void = FALSE
    expect(tx.sql).toMatch(/WHERE[\s\S]*?is_void\s*=\s*FALSE/i);
    // Window filter is preserved.
    expect(tx.sql).toMatch(/cashbox_id\s*=\s*\$1/i);
    expect(tx.sql).toMatch(/created_at\s*>=\s*\$2/i);
  });

  it('binds [shift.cashbox_id, shift.opened_at] in the txRows query', async () => {
    const { svc, calls } = makeSvc();
    await (svc as any).computeSummary({ ...SHIFT });
    const tx = calls.find(
      (c) =>
        /FROM cashbox_transactions/i.test(c.sql) &&
        /GROUP BY direction, category/i.test(c.sql),
    );
    expect(tx?.params).toEqual([SHIFT.cashbox_id, SHIFT.opened_at]);
  });

  it('preserves the GROUP BY direction, category breakdown shape (no formula change)', async () => {
    const { svc, calls } = makeSvc();
    await (svc as any).computeSummary({ ...SHIFT });
    const tx = calls.find(
      (c) =>
        /FROM cashbox_transactions/i.test(c.sql) &&
        /GROUP BY direction, category/i.test(c.sql),
    );
    expect(tx).toBeDefined();
    if (!tx) return;
    expect(tx.sql).toMatch(/SELECT direction::text AS direction/i);
    expect(tx.sql).toMatch(/category::text AS category/i);
    expect(tx.sql).toMatch(/COUNT\(\*\)::int AS count/i);
  });

  it('does NOT mutate the database (pure SELECT)', async () => {
    const { svc, calls } = makeSvc();
    await (svc as any).computeSummary({ ...SHIFT });
    const tx = calls.find(
      (c) =>
        /FROM cashbox_transactions/i.test(c.sql) &&
        /GROUP BY direction, category/i.test(c.sql),
    );
    expect(tx?.sql).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i,
    );
  });

  it('does NOT touch JE-based trial balance tables (journal_entries / journal_lines / chart_of_accounts)', async () => {
    // The JE-based TB formula is unchanged by this PR — confirm the
    // txRows fix targets only `cashbox_transactions`.
    const { svc, calls } = makeSvc();
    await (svc as any).computeSummary({ ...SHIFT });
    const tx = calls.find(
      (c) =>
        /FROM cashbox_transactions/i.test(c.sql) &&
        /GROUP BY direction, category/i.test(c.sql),
    );
    expect(tx?.sql).not.toMatch(
      /journal_entries|journal_lines|chart_of_accounts/i,
    );
  });
});
