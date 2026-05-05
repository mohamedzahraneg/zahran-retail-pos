/**
 * cash-desk.service.void-leak.spec.ts — PR-AUDIT-VOID-LEAK
 *
 * Pins that `CashDeskService.cashflowToday()` excludes voided
 * `cashbox_transactions` rows from its KPI tile aggregations
 * (cash_in_today, cash_out_today, inflows_total, outflows_total,
 * transactions_today).
 *
 * Background:
 *   PR #266 plugged the same bug class in
 *   `accounting.cashflow` / `accounting.trialBalance` and
 *   `analytics.cashFlowWaterfall` / `analytics.dailyPerformance`.
 *   `cash-desk.cashflowToday()` was missed by that audit and was
 *   still summing voided cancellation/reversal CT rows into the
 *   dashboard tiles.
 *
 * Fix shape (mirrors trialBalance):
 *   The void filter goes on the LEFT JOIN's ON clause (NOT in WHERE)
 *   so cashboxes with zero active CTs still appear in the result
 *   with 0/0/0/0/0. WHERE-side filtering would silently drop them.
 *
 * The spec is source-shape only: we mock `DataSource.query` to
 * capture the SQL string and assert the void filter is in the
 * correct position. No SQL execution. No DB side-effects.
 */
import { CashDeskService } from './cash-desk.service';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function makeService() {
  const calls: QueryCall[] = [];
  const ds: any = {
    query: (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return Promise.resolve([]);
    },
    manager: {
      query: (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        return Promise.resolve([]);
      },
    },
    transaction: jest.fn(async (cb: any) => cb({ query: ds.query })),
  };
  // Most CashDeskService deps are optional. Pass undefined for the
  // ones we don't exercise here; only `ds` matters for cashflowToday.
  const svc = new (CashDeskService as any)(
    ds,
    undefined, // posting
    undefined, // engine
    undefined, // notifications
    undefined, // dataSource second arg, if any
  );
  return { svc: svc as CashDeskService, calls, ds };
}

describe('CashDeskService.cashflowToday — PR-AUDIT-VOID-LEAK', () => {
  it('puts `ct.is_void = FALSE` on the LEFT JOIN ON clause (NOT in the SELECT-level WHERE)', async () => {
    const { svc, calls } = makeService();
    await svc.cashflowToday();
    expect(calls).toHaveLength(1);
    const sql = calls[0].sql;

    // The JOIN ON clause must include the void filter, sandwiched
    // between `ON ct.cashbox_id = cb.id` and the SELECT-level WHERE.
    expect(sql).toMatch(
      /LEFT JOIN cashbox_transactions ct[\s\S]*?ON ct\.cashbox_id\s*=\s*cb\.id[\s\S]*?AND ct\.is_void\s*=\s*FALSE[\s\S]*?WHERE cb\.is_active/i,
    );

    // The SELECT-level WHERE clause (which filters by `cb.is_active`)
    // must NOT contain the void filter — putting it there would drop
    // cashboxes with zero active CTs from the result, the trap the
    // trialBalance fix specifically avoided.
    const selectWhereMatch = sql.match(
      /WHERE\s+cb\.is_active[\s\S]*?(?=GROUP BY)/i,
    );
    expect(selectWhereMatch).toBeTruthy();
    if (selectWhereMatch) {
      expect(selectWhereMatch[0]).not.toMatch(/is_void/i);
    }
  });

  it('still selects all 5 KPI tile fields (cash_in/out_today, inflows/outflows_total, transactions_today)', async () => {
    const { svc, calls } = makeService();
    await svc.cashflowToday();
    const sql = calls[0].sql;

    expect(sql).toMatch(/AS cash_in_today/);
    expect(sql).toMatch(/AS cash_out_today/);
    expect(sql).toMatch(/AS inflows_total/);
    expect(sql).toMatch(/AS outflows_total/);
    expect(sql).toMatch(/AS transactions_today/);
  });

  it('preserves the existing operational-cash-out exclusions (edit_reversal / reversal_* / transfer_out / shift_variance)', async () => {
    // PR-AUDIT-VOID-LEAK only adds the void filter — the previously
    // documented category exclusions for the OUT side must stay
    // intact (the comment block above the query enumerates them).
    const { svc, calls } = makeService();
    await svc.cashflowToday();
    const sql = calls[0].sql;

    expect(sql).toMatch(/ct\.category\s*<>\s*'edit_reversal'/);
    expect(sql).toMatch(/ct\.category\s*NOT\s+LIKE\s+E'reversal\\_%'/);
    expect(sql).toMatch(/ct\.category\s*<>\s*'transfer_out'/);
    expect(sql).toMatch(/ct\.category\s*<>\s*'shift_variance'/);
  });

  it('does NOT mutate the database (pure SELECT, no INSERT/UPDATE/DELETE)', async () => {
    const { svc, calls } = makeService();
    await svc.cashflowToday();
    const sql = calls[0].sql;
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
    // Begins with SELECT (after whitespace).
    expect(sql.trim()).toMatch(/^SELECT/i);
  });

  it('keeps cashboxes with zero active CTs in the result by leaving the LEFT JOIN intact (no INNER JOIN regression)', async () => {
    const { svc, calls } = makeService();
    await svc.cashflowToday();
    const sql = calls[0].sql;

    // Must remain a LEFT JOIN — INNER would drop zero-activity
    // cashboxes silently. The whole motivation for the
    // ON-clause-style void filter is to preserve LEFT JOIN semantics.
    expect(sql).toMatch(/LEFT JOIN cashbox_transactions ct/i);
    expect(sql).not.toMatch(/INNER JOIN cashbox_transactions ct/i);
  });

  it('does NOT touch journal_entries / journal_lines / chart_of_accounts (no JE-based TB formula change)', async () => {
    const { svc, calls } = makeService();
    await svc.cashflowToday();
    const sql = calls[0].sql;
    expect(sql).not.toMatch(/journal_entries|journal_lines|chart_of_accounts/i);
  });
});
