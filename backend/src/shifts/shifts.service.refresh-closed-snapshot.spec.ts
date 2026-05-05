/**
 * shifts.service.refresh-closed-snapshot.spec.ts
 * PR-FIX-POS-INVOICE-EDIT-REFRESH-CLOSED-SHIFT-SNAPSHOT
 *
 * Pins ShiftsService.refreshClosedShiftSnapshot — the helper that
 * editInvoice (PosService) calls inside its transaction so a closed
 * shift's stored close snapshot is refreshed when one of its
 * invoices is edited (cash↔non-cash swap, amount change, etc.).
 *
 * Contract:
 *   1. status !== 'closed' → no-op (returns the row, no UPDATE).
 *   2. variance_journal_entry_id IS NOT NULL → blocked.
 *   3. variance_treatment IS NOT NULL → blocked.
 *   4. variance_employee_id IS NOT NULL → blocked.
 *   5. otherwise: recompute via computeSummary(shift, em) and UPDATE
 *      only the snapshot fields (expected_closing, total_sales,
 *      total_returns, total_expenses, total_cash_in, total_cash_out,
 *      invoice_count). Generated columns (difference, variance_amount,
 *      variance_type) recompute automatically.
 *   6. actual_closing / closed_at / closed_by / status / variance_*
 *      are NEVER touched.
 *   7. computeSummary is called with the EntityManager argument so
 *      the recompute reads from the same transaction as the caller.
 *
 * The helper is exercised directly: we mock `EntityManager.query`,
 * spy on `computeSummary` for the recompute path, and assert the
 * exact UPDATE SQL + parameters.
 */
import { NotFoundException } from '@nestjs/common';
import { ShiftsService } from './shifts.service';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function makeSvc() {
  const dsCalls: QueryCall[] = [];
  const ds: any = {
    manager: {
      query: async (sql: string, params: any[] = []) => {
        dsCalls.push({ sql, params });
        return [];
      },
    },
    query: async (sql: string, params: any[] = []) => {
      dsCalls.push({ sql, params });
      return [];
    },
  };
  return new ShiftsService(ds);
}

function makeEm(opts: { rows: any[][] }) {
  const calls: QueryCall[] = [];
  let i = 0;
  const em: any = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return opts.rows[i++] ?? [];
    },
  };
  return { em, calls };
}

const SHIFT_ID = '5f128c2d-29eb-4332-999b-770b310a0729'; // SHF-2026-00016 in production

const baseClosedShift = {
  id: SHIFT_ID,
  shift_no: 'SHF-2026-00016',
  status: 'closed',
  opening_balance: '465',
  expected_closing: '1660', // stale — pre-fix value
  actual_closing: '1160',
  closed_at: '2026-05-05T10:34:37+00:00',
  closed_by: '488c5f59-a585-47be-9b0b-d24f0a6bd7dc',
  cashbox_id: '524646d5-7bd6-4d8d-a484-b1f562b039a4',
  warehouse_id: 'b533200b-ec23-4cb8-a539-8c78e3679f78',
  opened_by: '488c5f59-a585-47be-9b0b-d24f0a6bd7dc',
  opened_at: '2026-05-04T09:36:13+00:00',
  variance_journal_entry_id: null,
  variance_treatment: null,
  variance_employee_id: null,
  variance_notes: null,
  variance_approved_by: null,
  variance_approved_at: null,
};

const fakeSummaryAfterEdit = {
  // After cash → InstaPay edit on SHF-16:
  //   opening 465 + cash 1225 − operating 10 − advances 490 − settlements 30 = 1160
  expected_closing: 1160,
  total_sales: 1725,
  total_returns: 0,
  total_expenses: 500,
  total_cash_in: 1225, // cash-only — was 1725 with the InstaPay incorrectly added
  total_cash_out: 530, // 10 + 490 + 30
  invoice_count: 7,
};

// Canonical aggregate row that the new
// PR-FIX-SHIFT-SNAPSHOT-REALTIME-INTEGRITY-GUARD computes inline.
// Must reconcile to the fakeSummaryAfterEdit values within EGP 0.01:
//   total_expenses = expenses_cash + advances_cash = 10 + 490 = 500   ✓
//   total_cash_in  = cash_in_invoices                = 1225            ✓
//   total_cash_out = cash_out_inv_returns + returns_cash_refund
//                  + expenses_cash + advances_cash + settlements_cash
//                  = 0 + 0 + 10 + 490 + 30           = 530             ✓
//   expected       = 465 (opening) + 1225 − 530      = 1160            ✓
//   invoice_count  = 7                                                  ✓
const fakeCanonicalAggMatchingSummary = {
  total_sales: '1725',
  total_returns: '0',
  invoice_count: 7,
  cash_in_invoices: '1225',
  cash_out_inv_returns: '0',
  instapay_in: '500',
  wallet_in: '0',
  expenses_cash: '10',
  advances_cash: '490',
  settlements_cash: '30',
  returns_cash_refund: '0',
};

// Inverse: cash_in_invoices = 1725 (all cash). Matches the
// "InstaPay → cash" test's summary (expected_closing 1660).
const fakeCanonicalAggAllCash = {
  total_sales: '1725',
  total_returns: '0',
  invoice_count: 7,
  cash_in_invoices: '1725',
  cash_out_inv_returns: '0',
  instapay_in: '0',
  wallet_in: '0',
  expenses_cash: '10',
  advances_cash: '490',
  settlements_cash: '30',
  returns_cash_refund: '0',
};

describe('ShiftsService.refreshClosedShiftSnapshot', () => {
  it('SHF-2026-00016 happy path: refreshes expected_closing from 1660 → 1160 (cash-only) without touching actual_closing', async () => {
    const svc = makeSvc();
    // Spy on the private computeSummary to return the post-edit summary.
    jest
      .spyOn(svc as any, 'computeSummary')
      .mockResolvedValue(fakeSummaryAfterEdit as any);

    const { em, calls } = makeEm({
      rows: [
        // Q1: SELECT shift FOR UPDATE → return the stale closed row.
        [{ ...baseClosedShift }],
        // Q2: canonical recompute (NEW guard) → row that reconciles to summary.
        [{ ...fakeCanonicalAggMatchingSummary }],
        // Q3: UPDATE … RETURNING * → return the refreshed row.
        [
          {
            ...baseClosedShift,
            expected_closing: '1160.00',
            total_cash_in: '1225.00',
            total_cash_out: '530.00',
            total_sales: '1725.00',
            total_expenses: '500.00',
            invoice_count: 7,
            // Generated columns auto-recompute (mocked here for the assert).
            difference: '0.00',
            variance_amount: '0.00',
            variance_type: 'zero',
          },
        ],
      ],
    });

    const result = await svc.refreshClosedShiftSnapshot(SHIFT_ID, em);

    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(Number(result.shift.expected_closing)).toBe(1160);
      expect(Number(result.shift.actual_closing)).toBe(1160); // unchanged
      expect(Number(result.shift.difference)).toBe(0);
      expect(result.shift.variance_type).toBe('zero');
    }

    // Q1 must be a FOR UPDATE select.
    expect(calls).toHaveLength(3);
    expect(calls[0].sql).toMatch(/SELECT \* FROM shifts/i);
    expect(calls[0].sql).toMatch(/FOR UPDATE/i);
    expect(calls[0].params).toEqual([SHIFT_ID]);

    // Q2 = canonical recompute (PR-FIX-SHIFT-SNAPSHOT-REALTIME-
    // INTEGRITY-GUARD). Single CTE that aggregates from authoritative
    // source tables filtered by shift_id only — no cashbox+window.
    expect(calls[1].sql).toMatch(/WITH\s+inv\s+AS/i);
    expect(calls[1].sql).toMatch(/FROM\s+invoices\s+WHERE\s+shift_id/i);
    expect(calls[1].sql).toMatch(/FROM\s+invoice_payments/i);
    expect(calls[1].sql).toMatch(/FROM\s+expenses\s+WHERE\s+shift_id/i);
    expect(calls[1].sql).toMatch(/FROM\s+employee_settlements\s+WHERE\s+shift_id/i);
    expect(calls[1].sql).toMatch(/FROM\s+returns\s+WHERE\s+shift_id/i);
    expect(calls[1].params).toEqual([SHIFT_ID]);

    // Q3 must be an UPDATE that touches ONLY snapshot fields.
    const updSql = calls[2].sql;
    expect(updSql).toMatch(/UPDATE shifts SET/i);
    expect(updSql).toMatch(/expected_closing\s*=\s*\$2/);
    expect(updSql).toMatch(/total_sales\s*=\s*\$3/);
    expect(updSql).toMatch(/total_returns\s*=\s*\$4/);
    expect(updSql).toMatch(/total_expenses\s*=\s*\$5/);
    expect(updSql).toMatch(/total_cash_in\s*=\s*\$6/);
    expect(updSql).toMatch(/total_cash_out\s*=\s*\$7/);
    expect(updSql).toMatch(/invoice_count\s*=\s*\$8/);

    // CRITICAL: the UPDATE must NOT touch any of these fields.
    expect(updSql).not.toMatch(/actual_closing\s*=/);
    expect(updSql).not.toMatch(/closed_at\s*=/);
    expect(updSql).not.toMatch(/closed_by\s*=/);
    expect(updSql).not.toMatch(/\bstatus\s*=/);
    expect(updSql).not.toMatch(/variance_journal_entry_id\s*=/);
    expect(updSql).not.toMatch(/variance_treatment\s*=/);
    expect(updSql).not.toMatch(/variance_employee_id\s*=/);
    expect(updSql).not.toMatch(/variance_notes\s*=/);
    expect(updSql).not.toMatch(/variance_approved_by\s*=/);
    expect(updSql).not.toMatch(/variance_approved_at\s*=/);
    expect(updSql).not.toMatch(/opening_balance\s*=/);
    expect(updSql).not.toMatch(/opened_at\s*=/);
    expect(updSql).not.toMatch(/cashbox_id\s*=/);

    // UPDATE WHERE id binds the shift id we passed in.
    expect(calls[2].params[0]).toBe(SHIFT_ID);
    expect(calls[2].params[1]).toBe(1160); // expected_closing
    expect(calls[2].params[5]).toBe(1225); // total_cash_in
    expect(calls[2].params[6]).toBe(530); // total_cash_out
  });

  it('InstaPay → cash edit increases expected_closing correctly', async () => {
    const svc = makeSvc();
    // After the inverse edit (non-cash 500 → cash 500), cash_total
    // jumps from 1225 to 1725 and expected_closing becomes 1660.
    jest.spyOn(svc as any, 'computeSummary').mockResolvedValue({
      expected_closing: 1660,
      total_sales: 1725,
      total_returns: 0,
      total_expenses: 500,
      total_cash_in: 1725,
      total_cash_out: 530,
      invoice_count: 7,
    } as any);

    const { em, calls } = makeEm({
      rows: [
        [{ ...baseClosedShift, expected_closing: '1160' }],
        // canonical recompute returns the all-cash variant
        [{ ...fakeCanonicalAggAllCash }],
        [{}],
      ],
    });

    const r = await svc.refreshClosedShiftSnapshot(SHIFT_ID, em);
    expect(r.status).toBe('updated');
    // calls[2] is now the UPDATE (calls[0]=SELECT, calls[1]=canonical).
    expect(calls[2].params[1]).toBe(1660); // expected_closing flipped up
    expect(calls[2].params[5]).toBe(1725); // total_cash_in
  });

  it('blocks when variance_journal_entry_id IS NOT NULL', async () => {
    const svc = makeSvc();
    const computeSpy = jest.spyOn(svc as any, 'computeSummary');
    const { em, calls } = makeEm({
      rows: [
        [
          {
            ...baseClosedShift,
            variance_journal_entry_id:
              'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          },
        ],
      ],
    });

    const r = await svc.refreshClosedShiftSnapshot(SHIFT_ID, em);
    expect(r.status).toBe('blocked');
    if (r.status === 'blocked') {
      expect(r.reason).toBe('variance_treated');
    }
    // No recompute, no UPDATE.
    expect(computeSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1); // only the SELECT FOR UPDATE
    expect(calls[0].sql).toMatch(/FOR UPDATE/i);
  });

  it('blocks when variance_treatment IS NOT NULL (no JE yet)', async () => {
    const svc = makeSvc();
    const computeSpy = jest.spyOn(svc as any, 'computeSummary');
    const { em, calls } = makeEm({
      rows: [
        [
          {
            ...baseClosedShift,
            variance_treatment: 'company_loss',
          },
        ],
      ],
    });

    const r = await svc.refreshClosedShiftSnapshot(SHIFT_ID, em);
    expect(r.status).toBe('blocked');
    expect(computeSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('blocks when variance_employee_id IS NOT NULL', async () => {
    const svc = makeSvc();
    const computeSpy = jest.spyOn(svc as any, 'computeSummary');
    const { em, calls } = makeEm({
      rows: [
        [
          {
            ...baseClosedShift,
            variance_employee_id: 'cccccccc-dddd-eeee-ffff-000000000000',
          },
        ],
      ],
    });

    const r = await svc.refreshClosedShiftSnapshot(SHIFT_ID, em);
    expect(r.status).toBe('blocked');
    expect(computeSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('no-op when shift is open (status !== closed)', async () => {
    const svc = makeSvc();
    const computeSpy = jest.spyOn(svc as any, 'computeSummary');
    const { em, calls } = makeEm({
      rows: [[{ ...baseClosedShift, status: 'open', closed_at: null }]],
    });

    const r = await svc.refreshClosedShiftSnapshot(SHIFT_ID, em);
    expect(r.status).toBe('no_op');
    if (r.status === 'no_op') {
      expect(r.reason).toBe('not_closed');
    }
    expect(computeSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('throws NotFoundException when shift does not exist', async () => {
    const svc = makeSvc();
    const { em } = makeEm({ rows: [[]] });
    await expect(
      svc.refreshClosedShiftSnapshot(SHIFT_ID, em),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('passes the EntityManager through to computeSummary so the recompute runs in the same transaction', async () => {
    const svc = makeSvc();
    const computeSpy = jest
      .spyOn(svc as any, 'computeSummary')
      .mockResolvedValue(fakeSummaryAfterEdit as any);
    const { em } = makeEm({
      rows: [
        [{ ...baseClosedShift }],
        [{ ...fakeCanonicalAggMatchingSummary }],
        [{}],
      ],
    });

    await svc.refreshClosedShiftSnapshot(SHIFT_ID, em);

    expect(computeSpy).toHaveBeenCalledTimes(1);
    // Second arg must be the SAME EntityManager.
    expect(computeSpy.mock.calls[0][1]).toBe(em);
  });

  it('snapshot mirrors close() write fields exactly (no extra columns, no missing columns)', async () => {
    const svc = makeSvc();
    jest
      .spyOn(svc as any, 'computeSummary')
      .mockResolvedValue(fakeSummaryAfterEdit as any);
    const { em, calls } = makeEm({
      rows: [
        [{ ...baseClosedShift }],
        [{ ...fakeCanonicalAggMatchingSummary }],
        [{}],
      ],
    });

    await svc.refreshClosedShiftSnapshot(SHIFT_ID, em);
    // calls[0]=SELECT, calls[1]=canonical, calls[2]=UPDATE.
    const updSql = calls[2].sql;

    // Snapshot fields that close() writes AND we should write here:
    for (const col of [
      'expected_closing',
      'total_sales',
      'total_returns',
      'total_expenses',
      'total_cash_in',
      'total_cash_out',
      'invoice_count',
    ]) {
      expect(updSql).toMatch(new RegExp(`${col}\\s*=`));
    }

    // Close() also writes status / closed_by / closed_at / actual_closing
    // / variance_*. We must NOT write any of those (those are
    // close-time-only fields).
    for (const col of [
      'status',
      'closed_by',
      'closed_at',
      'actual_closing',
      'variance_treatment',
      'variance_employee_id',
      'variance_notes',
      'variance_approved_by',
      'variance_approved_at',
      'variance_journal_entry_id',
    ]) {
      expect(updSql).not.toMatch(new RegExp(`${col}\\s*=`));
    }
  });
});

/**
 * Bonus: pin that computeSummary still works WITHOUT an EntityManager
 * (the original close-path signature). This is the "behavior unchanged
 * for existing callers" guarantee.
 */
describe('ShiftsService.computeSummary — em is optional', () => {
  it('computeSummary(shift) without em still routes through this.ds.query (no em fallback path)', async () => {
    const dsCalls: QueryCall[] = [];
    // Returns minimum-viable shapes per query so computeSummary can
    // complete without crashing. computeSummary's 7 queries return:
    //   inv (first row)        — { total_sales, total_cancelled, ... }
    //   payRows (per-method)   — array of {method, ...}
    //   ret (first row)        — { total_returns, return_count }
    //   txRows                 — array of {direction, category, amount, count}
    //   expenseRows            — array of expense rows
    //   settlementRows         — array of settlement rows
    //   refundCtRows           — array of CT rows
    let callIdx = 0;
    const minRows: any[][] = [
      // Q1: inv totals
      [
        {
          total_sales: 0,
          total_cancelled: 0,
          invoice_count: 0,
          cancelled_count: 0,
          remaining_receivable: 0,
        },
      ],
      // Q2: payRows
      [],
      // Q3: ret
      [{ total_returns: 0, return_count: 0 }],
      // Q4: txRows
      [],
      // Q5: expenseRows
      [],
      // Q6: settlementRows
      [],
      // Q7: refundCtRows
      [],
    ];
    const ds: any = {
      manager: {
        query: async (sql: string, params: any[] = []) => {
          dsCalls.push({ sql, params });
          return minRows[callIdx++] ?? [];
        },
      },
      query: async (sql: string, params: any[] = []) => {
        dsCalls.push({ sql, params });
        return minRows[callIdx++] ?? [];
      },
    };
    const svc = new ShiftsService(ds);

    const shift = {
      id: SHIFT_ID,
      shift_no: 'SHF-T-1',
      cashbox_id: 'cb-1',
      warehouse_id: 'wh-1',
      opened_by: 'u-1',
      opened_at: '2026-01-01T00:00:00Z',
      closed_at: '2026-01-01T08:00:00Z',
      opening_balance: '300',
    };

    const result = await (svc as any).computeSummary(shift);

    // The no-em fallback path routed all 7 queries through this.ds.query.
    expect(dsCalls.length).toBe(7);
    // Sanity: opening balance flowed through to expected_closing
    // (with no cash flows, expected = opening = 300).
    expect(Number(result.expected_closing)).toBe(300);
  });
});
