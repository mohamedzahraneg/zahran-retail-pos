/**
 * shifts.service.list-live-summary.spec.ts
 * PR-FIX-SHIFTS-PAGE-BULK-LIVE-VARIANCE
 *
 * Pins the bulk live-summary endpoint that replaces the per-row
 * `summary(id)` fan-out the Shifts list page used to do (which
 * exhausted the Supavisor pooler with EMAXCONNSESSION on refresh).
 *
 * Contract:
 *   1. Empty `shift_ids[]` → 400 (BadRequestException).
 *   2. > 100 shift_ids → 422 (UNPROCESSABLE_ENTITY).
 *   3. Computes LIVE variance per shift; non-cash payments do NOT
 *      inflate the cash side (SHF-2026-00016 reproducer).
 *   4. Runs **at most 5 SQL queries total** regardless of N shifts
 *      (bounded), and NEVER calls `summary()` / `computeSummary()`
 *      per shift.
 */
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { ShiftsService } from './shifts.service';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function makeSvc(opts: { dsResults?: any[][] } = {}) {
  const calls: QueryCall[] = [];
  let i = 0;
  const ds: any = {
    manager: {
      query: async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        return opts.dsResults?.[i++] ?? [];
      },
    },
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return opts.dsResults?.[i++] ?? [];
    },
  };
  const svc = new ShiftsService(ds);
  return { svc, calls };
}

const SHF16 = '00000000-0000-4000-8000-000000000016';
const SHF13 = '00000000-0000-4000-8000-000000000013';
const CASHBOX = '524646d5-7bd6-4d8d-a484-b1f562b039a4';
const USER = '488c5f59-a585-47be-9b0b-d24f0a6bd7dc';

describe('ShiftsService.listLiveSummary — PR-FIX-SHIFTS-PAGE-BULK-LIVE-VARIANCE', () => {
  it('returns 400 (BadRequestException) on empty shift_ids', async () => {
    const { svc } = makeSvc();
    await expect(svc.listLiveSummary([])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns 422 (UNPROCESSABLE_ENTITY) when > 100 shift_ids', async () => {
    const { svc } = makeSvc();
    const tooMany = Array.from({ length: 101 }, (_, i) =>
      `${i.toString().padStart(8, '0')}-1111-1111-1111-111111111111`,
    );
    let caught: unknown;
    try {
      await svc.listLiveSummary(tooMany);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  });

  it('SHF-2026-00016 reproducer: 500 InstaPay payment does NOT create cash deficit', async () => {
    // Production data audited via the previous PR's read-only DB
    // queries:
    //   opening_balance = 465
    //   cash payments = 1225 / non-cash (InstaPay) = 500
    //   operating expenses = 500 / employee_settlement = 30
    //   actual_closing = 1160 (counted)
    // LIVE expected = 465 + 1225 + 0 + 0 + 0 - 0 - 0 - 500 - 0 - 30 - 0 = 1160
    // LIVE variance = 1160 - 1160 = 0 (NOT -500)
    const { svc, calls } = makeSvc({
      dsResults: [
        // Q1: shifts metadata
        [
          {
            id: SHF16,
            opening_balance: '465',
            actual_closing: '1160',
            cashbox_id: CASHBOX,
            warehouse_id: null,
            opened_by: USER,
            opened_at: '2026-05-04T09:36:13Z',
            closed_at: '2026-05-05T10:34:37Z',
            status: 'closed',
          },
        ],
        // Q2: invoice cash/non-cash + sales
        [
          {
            shift_id: SHF16,
            invoice_count: 7,
            total_sales: '1725.00',
            cash_total: '1225.00',
            non_cash_total: '500.00',
          },
        ],
        // Q3: cashbox_transactions categorized — no customer
        // receipts / no supplier payments / no refunds for SHF-16.
        [
          {
            shift_id: SHF16,
            customer_receipts: '0',
            supplier_payments: '0',
            refund_cash_in: '0',
            refund_cash_out: '0',
            other_cash_in: '0',
            other_cash_out: '0',
          },
        ],
        // Q4: expenses
        [
          {
            shift_id: SHF16,
            operating_expenses: '500.00',
            employee_advances: '0',
          },
        ],
        // Q5: employee_settlements
        [{ shift_id: SHF16, employee_settlements: '30.00' }],
      ],
    });

    const out = await svc.listLiveSummary([SHF16]);

    expect(out).toHaveLength(1);
    const row = out[0];
    expect(row.shift_id).toBe(SHF16);
    // The bug we're fixing — variance must be 0, NOT -500.
    expect(row.variance).toBe(0);
    expect(row.expected_closing).toBe(1160);
    expect(row.actual_closing).toBe(1160);
    expect(row.cash_total).toBe(1225);
    expect(row.non_cash_total).toBe(500); // 500 lives HERE, not in deficit
    expect(row.invoice_count).toBe(7);
    expect(row.total_collections).toBe(1725);

    // Bounded SQL — exactly 5 queries regardless of N=1.
    expect(calls).toHaveLength(5);
    // Every query is scoped via `WHERE s.id = ANY($1::uuid[])`
    // (the bulk pattern, NOT N × single-shift queries).
    for (const c of calls) {
      expect(c.sql).toMatch(/s\.id = ANY\(\$1::uuid\[\]\)/);
      expect(c.params[0]).toEqual([SHF16]);
    }
  });

  it('runs the same 5 queries for N=10 shifts (NO per-shift fan-out)', async () => {
    const ids = Array.from({ length: 10 }, (_, i) =>
      `aaaaaaaa-${i.toString().padStart(4, '0')}-1111-1111-111111111111`,
    );
    const { svc, calls } = makeSvc({
      dsResults: [
        // Q1: shifts metadata — 10 rows
        ids.map((id) => ({
          id,
          opening_balance: '100',
          actual_closing: '100',
          cashbox_id: CASHBOX,
          warehouse_id: null,
          opened_by: USER,
          opened_at: '2026-05-04T07:00:00Z',
          closed_at: '2026-05-04T15:00:00Z',
          status: 'closed',
        })),
        // Q2-Q5: empty per-shift aggregations
        [],
        [],
        [],
        [],
      ],
    });

    const out = await svc.listLiveSummary(ids);

    expect(out).toHaveLength(10);
    // Critical guarantee — NOT 10×5 = 50, exactly 5.
    expect(calls).toHaveLength(5);
  });

  it('does NOT call summary() per shift', async () => {
    // Spy on summary() and computeSummary() (private). If either
    // fires during listLiveSummary, the test fails.
    const ids = ['00000000-0001-1111-1111-111111111111'];
    const { svc } = makeSvc({
      dsResults: [
        [
          {
            id: ids[0],
            opening_balance: '100',
            actual_closing: '100',
            cashbox_id: CASHBOX,
            warehouse_id: null,
            opened_by: USER,
            opened_at: '2026-05-04T07:00:00Z',
            closed_at: '2026-05-04T15:00:00Z',
            status: 'closed',
          },
        ],
        [],
        [],
        [],
        [],
      ],
    });
    const summarySpy = jest.spyOn(svc, 'summary');
    // computeSummary is private — spy on the prototype method by name.
    const computeSpy = jest.spyOn(
      svc as any,
      'computeSummary',
    );

    await svc.listLiveSummary(ids);

    expect(summarySpy).not.toHaveBeenCalled();
    expect(computeSpy).not.toHaveBeenCalled();
  });

  it('returns variance = NULL for an open (not closed) shift (no actual_closing)', async () => {
    const { svc } = makeSvc({
      dsResults: [
        [
          {
            id: SHF13,
            opening_balance: '100',
            actual_closing: null,
            cashbox_id: CASHBOX,
            warehouse_id: null,
            opened_by: USER,
            opened_at: '2026-05-05T07:00:00Z',
            closed_at: null,
            status: 'open',
          },
        ],
        [],
        [],
        [],
        [],
      ],
    });
    const out = await svc.listLiveSummary([SHF13]);
    expect(out[0].actual_closing).toBeNull();
    expect(out[0].variance).toBeNull();
    expect(out[0].expected_closing).toBe(100); // opening + 0 cash flows
  });

  it('drops shift ids that don\'t exist (Q1 returns no row), keeps the others', async () => {
    const { svc } = makeSvc({
      dsResults: [
        // Q1: only one row returned even though we asked for two
        [
          {
            id: SHF16,
            opening_balance: '465',
            actual_closing: '1160',
            cashbox_id: CASHBOX,
            warehouse_id: null,
            opened_by: USER,
            opened_at: '2026-05-04T09:36:13Z',
            closed_at: '2026-05-05T10:34:37Z',
            status: 'closed',
          },
        ],
        // Q2-5: only data for the existing shift
        [{ shift_id: SHF16, invoice_count: 0, total_sales: '0', cash_total: '0', non_cash_total: '0' }],
        [{ shift_id: SHF16, customer_receipts: '0', supplier_payments: '0', refund_cash_in: '0', refund_cash_out: '0', other_cash_in: '0', other_cash_out: '0' }],
        [{ shift_id: SHF16, operating_expenses: '0', employee_advances: '0' }],
        [{ shift_id: SHF16, employee_settlements: '0' }],
      ],
    });
    const out = await svc.listLiveSummary([SHF16, '99999999-9999-9999-9999-999999999999']);
    expect(out).toHaveLength(1);
    expect(out[0].shift_id).toBe(SHF16);
  });
});
