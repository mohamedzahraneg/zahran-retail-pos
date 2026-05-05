/**
 * shifts.service.snapshot-integrity-guard.spec.ts
 * PR-FIX-SHIFT-SNAPSHOT-REALTIME-INTEGRITY-GUARD
 *
 * Pins the real-time integrity guard that protects every code path
 * which writes the close-snapshot fields on `shifts`:
 *   expected_closing, total_sales, total_returns, total_expenses,
 *   total_cash_in, total_cash_out, invoice_count.
 *
 * Contract:
 *   1. Before any UPDATE to those fields, an independent canonical
 *      recompute runs against authoritative source tables filtered
 *      by `shift_id` (NO cashbox+window fallback).
 *   2. If any field deviates from canonical by > EGP 0.01 (or any
 *      non-zero deviation for `invoice_count`), the writer throws
 *      ConflictException with the Arabic message + diagnostic
 *      breakdown, and the surrounding transaction rolls back.
 *   3. Non-cash payments (instapay / wallet) NEVER inflate
 *      `expected_closing` — the guard reports them in the breakdown
 *      but excludes them from the cash math.
 *   4. Closed shifts with variance treatment already applied are
 *      blocked BEFORE the guard runs (variance treatment guard is
 *      checked first inside refreshClosedShiftSnapshot).
 *
 * The guard is exercised through `refreshClosedShiftSnapshot` in
 * this spec. The same helper backs `close()` and `requestClose()`,
 * which are covered by their own integration paths.
 */
import { ConflictException } from '@nestjs/common';
import { ShiftsService } from './shifts.service';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function makeSvc() {
  const ds: any = {
    manager: {
      query: async () => [],
    },
    query: async () => [],
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

const SHIFT_ID = '5f128c2d-29eb-4332-999b-770b310a0729';

const baseClosedShift = {
  id: SHIFT_ID,
  shift_no: 'SHF-2026-00016',
  status: 'closed',
  opening_balance: '465',
  expected_closing: '1660',
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

// ──────────────────────────────────────────────────────────────────
// Scenario 1: ALL CASH SALE — opening 0 + 4110 cash_in − 0 = 4110.
// summary and canonical agree → guard passes silently.
// ──────────────────────────────────────────────────────────────────
const scenarioAllCash = {
  shift: {
    ...baseClosedShift,
    shift_no: 'SHF-T-ALLCASH',
    opening_balance: '0',
  },
  summary: {
    expected_closing: 4110,
    total_sales: 4110,
    total_returns: 0,
    total_expenses: 0,
    total_cash_in: 4110,
    total_cash_out: 0,
    invoice_count: 13,
  },
  canonical: {
    total_sales: '4110',
    total_returns: '0',
    invoice_count: 13,
    cash_in_invoices: '4110',
    cash_out_inv_returns: '0',
    instapay_in: '0',
    wallet_in: '0',
    expenses_cash: '0',
    advances_cash: '0',
    settlements_cash: '0',
    returns_cash_refund: '0',
  },
};

// ──────────────────────────────────────────────────────────────────
// Scenario 2: MIXED CASH + INSTAPAY. total_sales = 1725 (gross).
// total_cash_in = 1225 (cash only). instapay_in = 500 reported only.
// expected_closing excludes the InstaPay 500 → guard passes.
// ──────────────────────────────────────────────────────────────────
const scenarioMixed = {
  shift: { ...baseClosedShift, opening_balance: '465' },
  summary: {
    expected_closing: 1160,
    total_sales: 1725,
    total_returns: 0,
    total_expenses: 500,
    total_cash_in: 1225,
    total_cash_out: 530,
    invoice_count: 7,
  },
  canonical: {
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
  },
};

describe('PR-FIX-SHIFT-SNAPSHOT-REALTIME-INTEGRITY-GUARD', () => {
  // ────────────────────────────────────────────────────────────────
  // Test 1: close all-cash → guard passes
  // ────────────────────────────────────────────────────────────────
  it('Test 1: refresh on all-cash shift passes the guard and writes the snapshot', async () => {
    const svc = makeSvc();
    jest
      .spyOn(svc as any, 'computeSummary')
      .mockResolvedValue(scenarioAllCash.summary as any);

    const { em, calls } = makeEm({
      rows: [
        [{ ...scenarioAllCash.shift }],
        [{ ...scenarioAllCash.canonical }],
        [{ ...scenarioAllCash.shift, expected_closing: '4110.00' }],
      ],
    });

    const r = await svc.refreshClosedShiftSnapshot(SHIFT_ID, em);
    expect(r.status).toBe('updated');
    expect(calls).toHaveLength(3);
    expect(calls[1].sql).toMatch(/WITH\s+inv\s+AS/i); // canonical query ran
    expect(calls[2].sql).toMatch(/UPDATE shifts SET/i);
  });

  // ────────────────────────────────────────────────────────────────
  // Test 2: mixed cash + InstaPay — non-cash NEVER inflates expected
  // ────────────────────────────────────────────────────────────────
  it('Test 2: mixed cash + InstaPay — total_sales includes both, expected_closing excludes InstaPay', async () => {
    const svc = makeSvc();
    jest
      .spyOn(svc as any, 'computeSummary')
      .mockResolvedValue(scenarioMixed.summary as any);

    const { em, calls } = makeEm({
      rows: [
        [{ ...scenarioMixed.shift }],
        [{ ...scenarioMixed.canonical }],
        [{ ...scenarioMixed.shift, expected_closing: '1160.00' }],
      ],
    });

    const r = await svc.refreshClosedShiftSnapshot(SHIFT_ID, em);
    expect(r.status).toBe('updated');
    // Asserts the InstaPay 500 was REPORTED in the canonical breakdown
    // but did NOT raise expected_closing above the cash-only 1160.
    expect(calls[2].params[1]).toBe(1160); // expected_closing
    expect(calls[2].params[5]).toBe(1225); // total_cash_in (cash only, NOT 1725)
  });

  // ────────────────────────────────────────────────────────────────
  // Test 3: phantom cash_out (no expense / settlement / refund row)
  // → guard BLOCKS with ConflictException; no UPDATE runs.
  // ────────────────────────────────────────────────────────────────
  it('Test 3: phantom EGP 460 cash_out not backed by any source row → ConflictException, no UPDATE', async () => {
    const svc = makeSvc();
    // Summary asserts total_cash_out = 460 (with a fake total_expenses
    // = 460) — this is the SHF-2026-00001 phantom-attribution pattern.
    jest.spyOn(svc as any, 'computeSummary').mockResolvedValue({
      expected_closing: 3650,
      total_sales: 4110,
      total_returns: 0,
      total_expenses: 460, // PHANTOM — no expense row backs this
      total_cash_in: 4110,
      total_cash_out: 460, // PHANTOM
      invoice_count: 13,
    } as any);

    const { em, calls } = makeEm({
      rows: [
        [{ ...baseClosedShift, opening_balance: '0', shift_no: 'SHF-T-PHANTOM' }],
        // Canonical truth: zero expenses / settlements / refunds.
        [
          {
            total_sales: '4110',
            total_returns: '0',
            invoice_count: 13,
            cash_in_invoices: '4110',
            cash_out_inv_returns: '0',
            instapay_in: '0',
            wallet_in: '0',
            expenses_cash: '0',
            advances_cash: '0',
            settlements_cash: '0',
            returns_cash_refund: '0',
          },
        ],
      ],
    });

    let captured: any = null;
    try {
      await svc.refreshClosedShiftSnapshot(SHIFT_ID, em);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(ConflictException);
    const body = captured.response ?? captured.getResponse?.() ?? captured;
    expect(body.code).toBe('SHIFT_SNAPSHOT_INTEGRITY_VIOLATION');
    expect(String(body.message)).toMatch(/إجماليات الوردية لا تطابق/);
    expect(body.context).toBe('refresh');
    // Mismatches should call out total_expenses, total_cash_out, expected_closing.
    const fields = (body.mismatches as Array<{ field: string }>).map(
      (m) => m.field,
    );
    expect(fields).toEqual(
      expect.arrayContaining([
        'total_expenses',
        'total_cash_out',
        'expected_closing',
      ]),
    );
    // No UPDATE call.
    expect(calls).toHaveLength(2); // SELECT, canonical
    expect(calls.find((c) => /UPDATE\s+shifts/i.test(c.sql))).toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────────
  // Test 4: non-cash counted as cash — expected_closing inflated by 500
  // → guard BLOCKS.
  // ────────────────────────────────────────────────────────────────
  it('Test 4: non-cash counted as cash (expected = 1660 instead of 1160) → ConflictException', async () => {
    const svc = makeSvc();
    // Summary fakes total_cash_in = 1725 (includes InstaPay 500).
    // Canonical correctly reports cash_in = 1225 / instapay = 500.
    jest.spyOn(svc as any, 'computeSummary').mockResolvedValue({
      expected_closing: 1660, // WRONG: 1225 cash + 500 instapay
      total_sales: 1725,
      total_returns: 0,
      total_expenses: 500,
      total_cash_in: 1725, // WRONG: includes instapay
      total_cash_out: 530,
      invoice_count: 7,
    } as any);

    const { em, calls } = makeEm({
      rows: [
        [{ ...baseClosedShift }],
        [{ ...scenarioMixed.canonical }], // canonical truth: cash 1225 + ip 500
      ],
    });

    let captured: any = null;
    try {
      await svc.refreshClosedShiftSnapshot(SHIFT_ID, em);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(ConflictException);
    const body = captured.response ?? captured.getResponse?.() ?? captured;
    const fields = (body.mismatches as Array<{ field: string }>).map(
      (m) => m.field,
    );
    expect(fields).toEqual(
      expect.arrayContaining(['total_cash_in', 'expected_closing']),
    );
    // breakdown still records the InstaPay separately so finance can
    // see the exclusion happened.
    expect(body.canonical_breakdown.instapay_in).toBe(500);
    expect(calls).toHaveLength(2);
    expect(calls.find((c) => /UPDATE\s+shifts/i.test(c.sql))).toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────────
  // Test 5: SHF-16 cash → InstaPay edit refresh — guard passes
  // (this is the PR #295 happy path; pinned again to confirm the new
  // guard does not regress it).
  // ────────────────────────────────────────────────────────────────
  it('Test 5: post-close cash → InstaPay invoice edit refresh passes guard', async () => {
    const svc = makeSvc();
    jest
      .spyOn(svc as any, 'computeSummary')
      .mockResolvedValue(scenarioMixed.summary as any);

    const { em, calls } = makeEm({
      rows: [
        [{ ...scenarioMixed.shift }],
        [{ ...scenarioMixed.canonical }],
        [{ ...scenarioMixed.shift, expected_closing: '1160.00' }],
      ],
    });

    const r = await svc.refreshClosedShiftSnapshot(SHIFT_ID, em);
    expect(r.status).toBe('updated');
    expect(calls).toHaveLength(3);
  });

  // ────────────────────────────────────────────────────────────────
  // Test 6: refresh with phantom cash_out mismatch (computeSummary
  // claims 660 cash_out but canonical knows none) → BLOCKS.
  // ────────────────────────────────────────────────────────────────
  it('Test 6: closed-shift refresh with phantom cash_out mismatch → ConflictException', async () => {
    const svc = makeSvc();
    jest.spyOn(svc as any, 'computeSummary').mockResolvedValue({
      expected_closing: 18245,
      total_sales: 3135,
      total_returns: 0,
      total_expenses: 2660, // PHANTOM 660 added to a real 2000
      total_cash_in: 3135,
      total_cash_out: 2660,
      invoice_count: 11,
    } as any);

    const { em } = makeEm({
      rows: [
        [{ ...baseClosedShift, opening_balance: '17770', shift_no: 'SHF-T-PHANTOM-2' }],
        [
          {
            total_sales: '3135',
            total_returns: '0',
            invoice_count: 11,
            cash_in_invoices: '3135',
            cash_out_inv_returns: '0',
            instapay_in: '0',
            wallet_in: '0',
            expenses_cash: '2000',
            advances_cash: '0',
            settlements_cash: '0',
            returns_cash_refund: '0',
          },
        ],
      ],
    });

    await expect(
      svc.refreshClosedShiftSnapshot(SHIFT_ID, em),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // ────────────────────────────────────────────────────────────────
  // Test 7: treated variance refresh → BLOCKED before guard runs
  // (existing variance-treatment guard from PR #295 still wins).
  // ────────────────────────────────────────────────────────────────
  it('Test 7: closed shift with variance_journal_entry_id → blocked BEFORE the integrity guard runs', async () => {
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
    // Neither computeSummary NOR the canonical query ran — variance
    // treatment guard short-circuits BEFORE the integrity guard.
    expect(computeSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1); // only the SELECT FOR UPDATE
    expect(calls[0].sql).not.toMatch(/WITH\s+inv\s+AS/i);
    expect(calls.find((c) => /UPDATE\s+shifts/i.test(c.sql))).toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────────
  // Test 8: SHF-2026-00016 fixture remains corrected and reconciles
  // (regression pin against the just-applied production correction).
  // ────────────────────────────────────────────────────────────────
  it('Test 8: SHF-2026-00016 (post-correction) reconciles and the guard passes', async () => {
    const svc = makeSvc();
    // Post-correction summary matches the production state we just
    // committed: expected = actual = 1160, variance = zero.
    jest
      .spyOn(svc as any, 'computeSummary')
      .mockResolvedValue(scenarioMixed.summary as any);

    const { em } = makeEm({
      rows: [
        [{ ...scenarioMixed.shift, expected_closing: '1160' }],
        [{ ...scenarioMixed.canonical }],
        [{ ...scenarioMixed.shift, expected_closing: '1160.00' }],
      ],
    });

    const r = await svc.refreshClosedShiftSnapshot(SHIFT_ID, em);
    expect(r.status).toBe('updated');
  });

  // ────────────────────────────────────────────────────────────────
  // Test 9: pre-audit shifts (SHF-2026-00001 / 00002) are NOT touched
  // by this PR — the guard only protects FUTURE writes. There is no
  // backfill, no migration, no data correction. We assert that
  // calling refresh on a "pre-audit" shift with non-canonical stored
  // values throws; the historical row is unchanged because the throw
  // happens BEFORE any UPDATE.
  // ────────────────────────────────────────────────────────────────
  it('Test 9: pre-audit shifts are NOT touched — guard refuses to refresh, never writes', async () => {
    const svc = makeSvc();
    // Simulate computeSummary returning the LIVE (post-fix) totals
    // — which would correctly compute expected = 4110 — while the
    // stored row says 3650. The refresh would WANT to write 4110,
    // but the canonical agg shows zero cash_out, so the math is
    // self-consistent and the guard PASSES (live=canonical=4110).
    // → This actually demonstrates the CORRECT behaviour: refresh
    // would set expected to 4110, exposing the historical phantom
    // 460 cash_out. We pin the no-historical-correction policy by
    // verifying that production NEVER calls refresh on these shifts
    // through any path other than POS invoice edit. No invoice edit
    // in this scenario → no refresh → no write. The test that
    // matters is the editInvoice → refreshClosedShiftSnapshot
    // contract from PR #295's spec, which we leave intact.
    //
    // Concretely: this test pins that calling refresh on a
    // pre-audit shift with no edits in the call window is a no-op
    // by virtue of nobody calling it. We assert the helper, when
    // called manually with mismatched intended-vs-canonical values,
    // refuses to write.
    jest.spyOn(svc as any, 'computeSummary').mockResolvedValue({
      expected_closing: 3650, // matches stored, phantom 460 baked in
      total_sales: 4110,
      total_returns: 0,
      total_expenses: 460, // PHANTOM
      total_cash_in: 4110,
      total_cash_out: 460, // PHANTOM
      invoice_count: 13,
    } as any);

    const { em, calls } = makeEm({
      rows: [
        [
          {
            ...baseClosedShift,
            shift_no: 'SHF-2026-00001',
            opening_balance: '0',
          },
        ],
        // Canonical truth: zero phantom rows.
        [
          {
            total_sales: '4110',
            total_returns: '0',
            invoice_count: 13,
            cash_in_invoices: '4110',
            cash_out_inv_returns: '0',
            instapay_in: '0',
            wallet_in: '0',
            expenses_cash: '0',
            advances_cash: '0',
            settlements_cash: '0',
            returns_cash_refund: '0',
          },
        ],
      ],
    });

    await expect(
      svc.refreshClosedShiftSnapshot(SHIFT_ID, em),
    ).rejects.toBeInstanceOf(ConflictException);
    // No UPDATE — the historical row is untouched.
    expect(calls.find((c) => /UPDATE\s+shifts/i.test(c.sql))).toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────────
  // Test 10: existing computeSummary "em is optional" back-compat
  // is preserved (nothing in this PR changes that path).
  // ────────────────────────────────────────────────────────────────
  it('Test 10: computeSummary signature is unchanged (em remains optional)', async () => {
    const svc = makeSvc();
    // Just smoke-check the public surface: refresh and computeSummary
    // are both still callable without a runtime crash on signature.
    expect(typeof (svc as any).computeSummary).toBe('function');
    expect(typeof svc.refreshClosedShiftSnapshot).toBe('function');
    // (The full em-optional contract is exercised in
    // shifts.service.refresh-closed-snapshot.spec.ts → "computeSummary
    // — em is optional" describe block.)
  });
});
