/**
 * pos.service.invoice-delta.spec.ts — PR-POS-INVOICE-DELTA-1
 *
 * Pins the monetary-only delta path for invoice edits:
 *   · Detection (`classifyInvoiceEdit`) — pure function, all branches.
 *   · `editInvoice` orchestration:
 *     - +Δ monetary-only  → applyMonetaryDeltaEdit → postInvoiceDelta
 *       (NO reverseByReference, NO postInvoiceEdit, NO stock reversal,
 *        NO DELETE FROM invoice_items / invoice_payments, EXACTLY ONE
 *        new invoice_payments row for +Δ).
 *     - 0 delta monetary-only → applyMonetaryDeltaEdit, NO payment
 *       INSERT, NO postInvoiceDelta call.
 *     - −Δ monetary-only   → falls through to legacy path
 *       (postInvoiceEdit), because invoice_payments.amount > 0 CHECK
 *       blocks the symmetric −Δ row.  Test documents that constraint.
 *     - Structural (qty change, payment-method swap, customer change)
 *       → legacy path, unchanged behavior.
 *
 * Each `editInvoice` test asserts on the captured SQL stream plus the
 * mocked posting service method calls.  No real DB / engine involved.
 */
import { BadRequestException } from '@nestjs/common';
import { PosService, classifyInvoiceEdit } from './pos.service';

// ────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────

const ORIG_INVOICE = {
  id: 'inv-1',
  invoice_no: 'INV-2026-000123',
  status: 'paid',
  warehouse_id: 'wh-1',
  shift_id: 'shift-1',
  customer_id: null,
  salesperson_id: 'sp-1',
  tax_rate: 0,
  paid_amount: '100.00',
  grand_total: '100.00',
  subtotal: '100.00',
  cogs_total: '60.00',
  notes: null,
};

const ORIG_ITEMS = [
  { id: 1, invoice_id: 'inv-1', variant_id: 'v-1', quantity: 2, unit_price: 50, unit_cost: 30 },
];

const ORIG_PAYMENTS = [
  {
    id: 1,
    invoice_id: 'inv-1',
    payment_method: 'cash',
    amount: '100.00',
    payment_account_id: null,
    payment_account_snapshot: null,
  },
];

// ────────────────────────────────────────────────────────────────────
// classifyInvoiceEdit — pure function, all branches
// ────────────────────────────────────────────────────────────────────

describe('classifyInvoiceEdit — PR-POS-INVOICE-DELTA-1', () => {
  const orig = { paid_amount: '100.00', customer_id: null };
  const items = [
    { variant_id: 'v-1', quantity: 2 },
    { variant_id: 'v-2', quantity: 1 },
  ];
  const payments = [
    { payment_method: 'cash', amount: '100.00', payment_account_id: null },
  ];

  it('positive delta monetary-only → { monetary_only: true, delta: 0.02 }', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 51 },
        { variant_id: 'v-2', qty: 1, unit_price: 0.02 },
      ],
      payments: [{ payment_method: 'cash', amount: 100.02 }],
    };
    expect(classifyInvoiceEdit(orig, items, payments, dto)).toEqual({
      monetary_only: true,
      delta: 0.02,
    });
  });

  it('large positive delta (+2000) still monetary-only', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 1050 },
        { variant_id: 'v-2', qty: 1, unit_price: 0 },
      ],
      payments: [{ payment_method: 'cash', amount: 2100 }],
    };
    expect(classifyInvoiceEdit(orig, items, payments, dto)).toEqual({
      monetary_only: true,
      delta: 2000,
    });
  });

  it('zero delta monetary-only → { monetary_only: true, delta: 0 }', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 60, discount: 10 },
        { variant_id: 'v-2', qty: 1, unit_price: -10 },
      ],
      payments: [{ payment_method: 'cash', amount: 100 }],
    };
    const r = classifyInvoiceEdit(orig, items, payments, dto);
    expect(r.monetary_only).toBe(true);
    if (r.monetary_only) expect(r.delta).toBe(0);
  });

  it('negative delta → structural (delegated to legacy path due to amount > 0 CHECK)', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 49 },
        { variant_id: 'v-2', qty: 1, unit_price: 1 },
      ],
      payments: [{ payment_method: 'cash', amount: 99 }],
    };
    const r = classifyInvoiceEdit(orig, items, payments, dto);
    expect(r.monetary_only).toBe(false);
    if (!r.monetary_only) expect(r.reason).toBe('negative_delta_uses_legacy_path');
  });

  it('qty change → structural', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 3, unit_price: 50 }, // qty: 2 → 3
        { variant_id: 'v-2', qty: 1, unit_price: 0 },
      ],
      payments: [{ payment_method: 'cash', amount: 150 }],
    };
    const r = classifyInvoiceEdit(orig, items, payments, dto);
    expect(r.monetary_only).toBe(false);
    if (!r.monetary_only) expect(r.reason).toBe('qty_changed');
  });

  it('variant swap → structural', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 50 },
        { variant_id: 'v-3', qty: 1, unit_price: 0 }, // v-2 → v-3
      ],
      payments: [{ payment_method: 'cash', amount: 100 }],
    };
    const r = classifyInvoiceEdit(orig, items, payments, dto);
    expect(r.monetary_only).toBe(false);
    if (!r.monetary_only) expect(r.reason).toBe('variant_set_changed');
  });

  it('line count change → structural', () => {
    const dto = {
      lines: [{ variant_id: 'v-1', qty: 2, unit_price: 50 }],
      payments: [{ payment_method: 'cash', amount: 100 }],
    };
    const r = classifyInvoiceEdit(orig, items, payments, dto);
    expect(r.monetary_only).toBe(false);
    if (!r.monetary_only) expect(r.reason).toBe('line_count_changed');
  });

  it('payment_method change → structural', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 50 },
        { variant_id: 'v-2', qty: 1, unit_price: 0 },
      ],
      payments: [{ payment_method: 'card_visa', amount: 100 }], // cash → card_visa
    };
    const r = classifyInvoiceEdit(orig, items, payments, dto);
    expect(r.monetary_only).toBe(false);
    if (!r.monetary_only) expect(r.reason).toBe('payment_shape_changed');
  });

  it('payment_account_id change → structural', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 50 },
        { variant_id: 'v-2', qty: 1, unit_price: 0 },
      ],
      payments: [
        { payment_method: 'cash', amount: 100, payment_account_id: 'acct-NEW' },
      ],
    };
    const r = classifyInvoiceEdit(orig, items, payments, dto);
    expect(r.monetary_only).toBe(false);
    if (!r.monetary_only) expect(r.reason).toBe('payment_shape_changed');
  });

  it('payment count change → structural', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 50 },
        { variant_id: 'v-2', qty: 1, unit_price: 0 },
      ],
      payments: [
        { payment_method: 'cash', amount: 50 },
        { payment_method: 'card_visa', amount: 50 },
      ],
    };
    const r = classifyInvoiceEdit(orig, items, payments, dto);
    expect(r.monetary_only).toBe(false);
    if (!r.monetary_only) expect(r.reason).toBe('payment_count_changed');
  });

  it('customer_id change → structural', () => {
    const origWithCust = { ...orig, customer_id: 'cust-A' };
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 50 },
        { variant_id: 'v-2', qty: 1, unit_price: 0 },
      ],
      payments: [{ payment_method: 'cash', amount: 100 }],
      customer_id: 'cust-B',
    };
    const r = classifyInvoiceEdit(origWithCust, items, payments, dto);
    expect(r.monetary_only).toBe(false);
    if (!r.monetary_only) expect(r.reason).toBe('customer_changed');
  });
});

// ────────────────────────────────────────────────────────────────────
// editInvoice orchestration — fake DataSource + mocked posting
// ────────────────────────────────────────────────────────────────────

interface QueryCall {
  sql: string;
  params: any[];
}

/**
 * Stateful fake DataSource scoped to the editInvoice flow.  Each test
 * supplies an `emResults` queue covering the SELECTs that
 * `editInvoice` issues inside its transaction.  Unused queue entries
 * are ignored; missing entries return `[]` (= empty row set).
 */
function makeFakeDs(opts: { emResults: any[][] }) {
  const emCalls: QueryCall[] = [];
  let emIdx = 0;
  const em = {
    query: async (sql: string, params: any[] = []) => {
      emCalls.push({ sql, params });
      const next = opts.emResults[emIdx++];
      return next ?? [];
    },
  };
  const ds = {
    transaction: async (cb: (em: any) => Promise<any>) => cb(em),
  } as any;
  return { ds, em, emCalls };
}

function makePostingMock() {
  // Typed as `any` so tests can override mockResolvedValueOnce with
  // error-shaped responses without TS narrowing the inferred return.
  return {
    postInvoiceDelta: jest.fn<Promise<any>, any[]>(async () => ({ entry_id: 'je-delta-1' })),
    postInvoiceEdit: jest.fn<Promise<any>, any[]>(async () => ({ entry_id: 'je-edit-1' })),
  };
}

function makeShiftsMock() {
  return {
    refreshClosedShiftSnapshot: jest.fn(async () => ({ status: 'no_op' })),
  };
}

function makeServiceWith(posting: any, ds: any) {
  // Stub the repo (unused by editInvoice but constructor needs it).
  const invoicesRepo = { findOne: async () => null } as any;
  // Constructor: (invoicesRepo, ds, loyalty?, realtime?, notif?, posting?, engine?, payments?, shifts?)
  const svc = new (PosService as any)(
    invoicesRepo,
    ds,
    undefined, // loyalty
    undefined, // realtime
    undefined, // notifications
    posting,   // posting (the bit we care about)
    undefined, // engine
    undefined, // payments
    makeShiftsMock(), // shifts (for refreshClosedShiftSnapshot)
  );
  return svc as PosService;
}

const sqlMatches = (calls: QueryCall[], pat: RegExp) =>
  calls.filter((c) => pat.test(c.sql));

describe('editInvoice — PR-POS-INVOICE-DELTA-1 monetary-only +Δ path', () => {
  // Common DTO: +0.02 over the original 100.00, lines unchanged.
  const dtoPlus02 = {
    lines: [
      { variant_id: 'v-1', qty: 2, unit_price: 50.01, discount: 0 },
    ],
    payments: [{ payment_method: 'cash', amount: 100.02 }],
    discount_total: 0,
  };

  function emQueueForMonetaryDelta() {
    return [
      [ORIG_INVOICE],     // SELECT * FROM invoices WHERE id=$1 FOR UPDATE
      ORIG_ITEMS,         // SELECT * FROM invoice_items WHERE invoice_id=$1
      ORIG_PAYMENTS,      // SELECT * FROM invoice_payments WHERE invoice_id=$1
      ORIG_ITEMS,         // applyMonetaryDeltaEdit: re-SELECT items for history snapshot
      [{ id: 'hist-1' }], // INSERT INTO invoice_edit_history RETURNING id
      [],                 // INSERT INTO invoice_payments (delta row)
      [{ ...ORIG_INVOICE, grand_total: '100.02', paid_amount: '100.02' }], // UPDATE invoices RETURNING *
      [...ORIG_PAYMENTS, { id: 2, invoice_id: 'inv-1', payment_method: 'cash', amount: '0.02' }], // SELECT after-snapshot
      [],                 // UPDATE invoice_edit_history (backfill)
    ];
  }

  it('+0.02 edit: posts delta JE+CT, does NOT call postInvoiceEdit, inserts ONE +0.02 invoice_payments row', async () => {
    const { ds, emCalls } = makeFakeDs({ emResults: emQueueForMonetaryDelta() });
    const posting = makePostingMock();
    const svc = makeServiceWith(posting, ds);

    const res = await svc.editInvoice('inv-1', dtoPlus02, 'user-1', 'price tweak');

    expect(res).toMatchObject({ edited: true });

    // Phase 2A.1: postInvoiceDelta called with (invoiceId, historyId,
    // delta, userId, em). The history-scoped reference key is what
    // prevents the engine from collapsing this JE into the original
    // sale's idempotency tuple.
    expect(posting.postInvoiceDelta).toHaveBeenCalledTimes(1);
    expect(posting.postInvoiceDelta).toHaveBeenCalledWith(
      'inv-1',
      'hist-1',
      0.02,
      'user-1',
      expect.anything(),
    );

    // postInvoiceEdit (the reverse-and-repost path) NOT called
    expect(posting.postInvoiceEdit).not.toHaveBeenCalled();

    // EXACTLY ONE delta INSERT INTO invoice_payments — the +0.02 row
    const ipInserts = sqlMatches(emCalls, /^\s*INSERT INTO invoice_payments\b/i);
    expect(ipInserts.length).toBe(1);
    expect(ipInserts[0].params).toContain(0.02);

    // No DELETE FROM invoice_payments (legacy path wipes — delta path doesn't)
    const ipDeletes = sqlMatches(emCalls, /^\s*DELETE FROM invoice_payments\b/i);
    expect(ipDeletes.length).toBe(0);

    // No DELETE FROM invoice_items (lines unchanged in monetary-only edit)
    const itemDeletes = sqlMatches(emCalls, /^\s*DELETE FROM invoice_items\b/i);
    expect(itemDeletes.length).toBe(0);

    // No stock_movements writes (lines unchanged)
    const stockMoves = sqlMatches(emCalls, /^\s*INSERT INTO stock_movements\b/i);
    expect(stockMoves.length).toBe(0);
  });

  it('+2000 edit: same delta path applies for a large positive delta', async () => {
    const big = {
      lines: [{ variant_id: 'v-1', qty: 2, unit_price: 1050, discount: 0 }],
      payments: [{ payment_method: 'cash', amount: 2100 }],
      discount_total: 0,
    };
    const { ds } = makeFakeDs({ emResults: emQueueForMonetaryDelta() });
    const posting = makePostingMock();
    const svc = makeServiceWith(posting, ds);

    await svc.editInvoice('inv-1', big, 'user-1', 'large price bump');

    expect(posting.postInvoiceDelta).toHaveBeenCalledWith(
      'inv-1',
      'hist-1',
      2000,
      'user-1',
      expect.anything(),
    );
    expect(posting.postInvoiceEdit).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════
// PR-POS-INVOICE-MONETARY-DELTA-IDEMPOTENCY-FIX-1 (Phase 2A.1)
// --------------------------------------------------------------------
// Before this fix, postInvoiceDelta posted with reference_type='invoice'
// + reference_id=invoiceId, colliding with the original sale JE's
// idempotency tuple. The engine returned skipped=true and the delta JE
// was silently dropped — production showed zero delta JEs across 295
// live invoice JEs.
//
// The fix routes the delta through a fresh reference identity:
//   reference_type = 'invoice_monetary_delta'
//   reference_id   = uuid_v5(uuid_ns_dns(),
//                            'invoice_monetary_delta:' || history_id)
// The engine alias maps the matching cashbox_transactions reference
// back to the 'invoice' entity so per-invoice cash queries still pick
// up the delta.
//
// These tests pin (a) the new call signature in the apply path, and
// (b) the SQL shape produced by the posting helper itself.
// ════════════════════════════════════════════════════════════════════

describe('postInvoiceDelta — Phase 2A.1 idempotency fix', () => {
  // Mocked engine + runner so we can assert on the spec the helper
  // hands to engine.recordTransaction without a real DB.
  function makeRunnerWithUuid() {
    const queries: Array<{ sql: string; params: any[] }> = [];
    const runner = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        queries.push({ sql, params });
        const s = sql.replace(/\s+/g, ' ').trim();
        if (/SELECT\s+uuid_generate_v5/i.test(s)) {
          // Deterministic mock — the actual uuid value doesn't matter
          // for the assertion, only that it's stable per history_id.
          const seed = params[0];
          return [
            { ref_id: `mock-v5-${seed}` },
          ];
        }
        if (/FROM invoices i/i.test(s)) {
          return [
            {
              id: 'inv-1',
              invoice_no: 'INV-2026-000123',
              tax_rate: 0,
              completed_at: null,
              created_at: '2026-05-01T00:00:00Z',
              customer_id: null,
              cashbox_id: 'cb-1',
            },
          ];
        }
        if (/FROM invoice_payments/i.test(s)) {
          return [
            {
              payment_method: 'cash',
              payment_account_id: null,
              payment_account_snapshot: null,
            },
          ];
        }
        if (/SELECT\s+set_config/i.test(s)) {
          return [];
        }
        return [];
      }),
    };
    return { runner, queries };
  }

  function makeEngine(): { engine: any; calls: any[] } {
    const calls: any[] = [];
    const engine = {
      recordTransaction: jest.fn(async (spec: any) => {
        calls.push(spec);
        return { ok: true, entry_id: `je-${spec.reference_id}` };
      }),
    };
    return { engine, calls };
  }

  function instantiatePosting(engine: any, ds: any) {
    // posting.service is the real implementation; we hand it the real
    // engine spy via constructor.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AccountingPostingService } = require('../chart-of-accounts/posting.service');
    return new AccountingPostingService(ds, engine);
  }

  it('passes reference_type="invoice_monetary_delta" with a deterministic history-scoped reference_id', async () => {
    const { runner } = makeRunnerWithUuid();
    const { engine, calls } = makeEngine();
    const ds = { manager: runner, query: runner.query } as any;
    const posting = instantiatePosting(engine, ds);

    const res = await posting.postInvoiceDelta(
      'inv-1',
      'hist-abc',
      5.5,
      'user-1',
      runner,
    );

    expect(res).toMatchObject({ entry_id: expect.any(String) });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: 'sale',
      reference_type: 'invoice_monetary_delta',
      reference_id: 'mock-v5-hist-abc',
    });
    // CRITICAL regression guard: the reference_id MUST NOT equal the
    // invoiceId — that's exactly the collision the fix removes.
    expect(calls[0].reference_id).not.toBe('inv-1');
    // No reversal vocabulary anywhere in the spec.
    expect(JSON.stringify(calls[0])).not.toMatch(/reversal_/);
    expect(JSON.stringify(calls[0])).not.toMatch(/عكس:/);
  });

  it('reference_id is deterministic per history_id (replay safety)', async () => {
    const { runner } = makeRunnerWithUuid();
    const { engine, calls } = makeEngine();
    const ds = { manager: runner, query: runner.query } as any;
    const posting = instantiatePosting(engine, ds);

    await posting.postInvoiceDelta('inv-1', 'hist-stable', 5.5, 'user-1', runner);
    await posting.postInvoiceDelta('inv-1', 'hist-stable', 5.5, 'user-1', runner);

    expect(calls).toHaveLength(2);
    expect(calls[0].reference_id).toBe(calls[1].reference_id);
    // Engine handles the actual dedupe on its idempotency check; here
    // we only assert the helper consistently asks for the same key so
    // the engine can collapse the retry.
  });

  it('rejects calls without a historyId (engineering invariant)', async () => {
    const { runner } = makeRunnerWithUuid();
    const { engine } = makeEngine();
    const ds = { manager: runner, query: runner.query } as any;
    const posting = instantiatePosting(engine, ds);

    await expect(
      posting.postInvoiceDelta('inv-1', '', 5.5, 'user-1', runner),
    ).rejects.toThrow(/historyId is required/);
  });

  it('does NOT emit reversal vocabulary or void writes anywhere in the SQL stream', async () => {
    const { runner, queries } = makeRunnerWithUuid();
    const { engine } = makeEngine();
    const ds = { manager: runner, query: runner.query } as any;
    const posting = instantiatePosting(engine, ds);

    await posting.postInvoiceDelta('inv-1', 'hist-clean', 12.5, 'user-1', runner);

    const allSql = queries.map((q) => q.sql).join('\n');
    expect(allSql).not.toMatch(/reverseByReference/);
    expect(allSql).not.toMatch(/'reversal_/);
    expect(allSql).not.toMatch(/UPDATE\s+journal_entries[\s\S]*is_void\s*=\s*TRUE/i);
    expect(allSql).not.toMatch(/UPDATE\s+cashbox_transactions[\s\S]*is_void\s*=\s*TRUE/i);
    expect(allSql).not.toMatch(/عكس:/);
  });
});

describe('editInvoice — zero-delta monetary-only path', () => {
  const dtoZero = {
    // line unit_price 60 with discount 10 + line price 0 = 110-10 = 100 = old total
    lines: [{ variant_id: 'v-1', qty: 2, unit_price: 60, discount: 20 }],
    payments: [{ payment_method: 'cash', amount: 100 }],
    discount_total: 0,
  };

  function emQueueZero() {
    return [
      [ORIG_INVOICE],
      ORIG_ITEMS,
      ORIG_PAYMENTS,
      ORIG_ITEMS,
      [{ id: 'hist-1' }],
      // NO delta payment INSERT — delta = 0 skips it
      [{ ...ORIG_INVOICE }],
      ORIG_PAYMENTS,
      [],
    ];
  }

  it('0 delta: no postInvoiceDelta, no postInvoiceEdit, no payment INSERT, no stock writes', async () => {
    const { ds, emCalls } = makeFakeDs({ emResults: emQueueZero() });
    const posting = makePostingMock();
    const svc = makeServiceWith(posting, ds);

    await svc.editInvoice('inv-1', dtoZero, 'user-1', 'metadata only');

    expect(posting.postInvoiceDelta).not.toHaveBeenCalled();
    expect(posting.postInvoiceEdit).not.toHaveBeenCalled();

    expect(sqlMatches(emCalls, /^\s*INSERT INTO invoice_payments\b/i).length).toBe(0);
    expect(sqlMatches(emCalls, /^\s*DELETE FROM invoice_payments\b/i).length).toBe(0);
    expect(sqlMatches(emCalls, /^\s*INSERT INTO stock_movements\b/i).length).toBe(0);
  });
});

describe('editInvoice — negative-delta + structural fall through to legacy path', () => {
  function emQueueLegacy() {
    return [
      [ORIG_INVOICE],
      ORIG_ITEMS,
      ORIG_PAYMENTS,
      // Legacy path: stock reversal inserts, cashbox lookup, history,
      // wipes, recompute, item INSERTs, payment INSERTs, UPDATE.
      // We only need enough entries for it to complete its query stream
      // and call postInvoiceEdit; extra calls return [] which is fine.
      [],                                // stock_movements reverse (per item)
      [{ cashbox_id: 'cb-1' }],          // cashbox lookup
      [{ id: 'hist-1' }],                // history INSERT RETURNING
      [],                                 // DELETE invoice_items
      [],                                 // DELETE invoice_payments
      [{ id: 'v-1', cost_price: 30, sku: 'SKU-1', product_name: 'كوتش', color_name: null, size_label: null }], // variant lookup
      [],                                 // INSERT invoice_items
      [],                                 // INSERT stock_movements sale
      [],                                 // INSERT invoice_payments
      [{ ...ORIG_INVOICE, grand_total: '99.98' }], // UPDATE RETURNING
      ORIG_ITEMS,
      ORIG_PAYMENTS,
      [],
    ];
  }

  it('-0.02 monetary-only edit: classifyInvoiceEdit rejects (negative_delta_uses_legacy_path), legacy postInvoiceEdit called', async () => {
    const dtoMinus02 = {
      lines: [{ variant_id: 'v-1', qty: 2, unit_price: 49.99, discount: 0 }],
      payments: [{ payment_method: 'cash', amount: 99.98 }],
      discount_total: 0,
    };
    const { ds } = makeFakeDs({ emResults: emQueueLegacy() });
    const posting = makePostingMock();
    const svc = makeServiceWith(posting, ds);

    await svc.editInvoice('inv-1', dtoMinus02, 'user-1', 'negative delta');

    // Legacy path → postInvoiceEdit called, postInvoiceDelta NOT called.
    expect(posting.postInvoiceEdit).toHaveBeenCalledTimes(1);
    expect(posting.postInvoiceDelta).not.toHaveBeenCalled();
  });

  it('structural edit that is still NEGATIVE (line removed) falls through to legacy postInvoiceEdit', async () => {
    // Originally this slot tested qty-up under PR-POS-INVOICE-DELTA-1,
    // when qty changes always went legacy. Phase 2A reclassifies pure
    // qty-up as positive_structural_delta, so this test now uses a
    // genuinely-negative shape (line removed entirely) to verify the
    // legacy path still fires for non-additive edits.
    const dtoNegative = {
      lines: [{ variant_id: 'v-other', qty: 1, unit_price: 50, discount: 0 }],
      payments: [{ payment_method: 'cash', amount: 50 }],
      discount_total: 0,
    };
    // Adjust the legacy queue's variant lookup (slot 8) to return
    // v-other so postInvoiceEdit's repost can resolve cost_price.
    const queue = emQueueLegacy();
    queue[8] = [
      { id: 'v-other', cost_price: 30, sku: 'SKU-OTHER', product_name: 'منتج آخر', color_name: null, size_label: null },
    ];
    const { ds } = makeFakeDs({ emResults: queue });
    const posting = makePostingMock();
    const svc = makeServiceWith(posting, ds);

    await svc.editInvoice('inv-1', dtoNegative, 'user-1', 'remove v-1, add other');

    expect(posting.postInvoiceEdit).toHaveBeenCalledTimes(1);
    expect(posting.postInvoiceDelta).not.toHaveBeenCalled();
  });

  // NOTE: This test was originally written under PR-POS-INVOICE-DELTA-1
  // when payment_method swaps were treated as structural edits and went
  // through the legacy reverse-and-repost path.  PR-POS-INVOICE-PAYMENT-
  // REDISTRIBUTION-1 (Phase 1) reclassifies same-total payment_method
  // swaps as `payment_redistribution` so they NO LONGER call
  // postInvoiceEdit / reverseByReference / create `reversal_sale`.  The
  // test now asserts the new correct behavior; legacy structural
  // behavior is still pinned by the qty-change test above and the new
  // Phase 1 GUARD test below.
  it('payment_method swap (cash → card_visa, same total): now uses redistribution path (NOT legacy)', async () => {
    // Real-world card_visa swap binds to a payment_account whose snapshot
    // carries the cashbox_id.  Without it, the GL routing would have no
    // liquid cashbox to land on (engine Guard A).
    const dtoMethodSwap = {
      lines: [{ variant_id: 'v-1', qty: 2, unit_price: 50, discount: 0 }],
      payments: [
        { payment_method: 'card_visa', amount: 100, payment_account_id: 'acct-visa' },
      ],
      discount_total: 0,
    };
    const emResults = [
      [{ ...ORIG_INVOICE, paid_amount: '100.00', grand_total: '100.00' }],
      [{ id: 1, invoice_id: 'inv-1', variant_id: 'v-1', quantity: 2 }],
      [{ id: 1, invoice_id: 'inv-1', payment_method: 'cash', amount: '100.00', payment_account_id: null, payment_account_snapshot: null }],
      [{ id: 'hist-swap-1' }],          // INSERT history (FIRST)
      [{ cashbox_id: 'cb-main' }],      // SELECT shift cashbox
      [{ cashbox_id: 'cb-visa' }],      // SELECT payment_accounts.cashbox_id for the new card_visa bucket
      [],                                // INSERT new card_visa payment row
      [],                                // DELETE cash payment row
      [{ ...ORIG_INVOICE }],            // UPDATE invoices
      [{ id: 2, payment_method: 'card_visa', amount: '100.00' }],
      [],                                // backfill history
    ];
    const { ds } = makeFakeDs({ emResults });
    const posting = makePostingMock();
    // Add the new mock method for this test
    (posting as any).postInvoicePaymentRedistribution = jest.fn<Promise<any>, any[]>(
      async () => ({ ok: true, entry_ids: ['je-transfer-swap-1'] }),
    );
    const svc = makeServiceWith(posting, ds);

    await svc.editInvoice('inv-1', dtoMethodSwap, 'user-1', 'method change');

    // Phase 1 contract: NO reverse-and-repost, NO postInvoiceEdit.
    expect(posting.postInvoiceEdit).not.toHaveBeenCalled();
    expect(posting.postInvoiceDelta).not.toHaveBeenCalled();
    // The redistribution path was used instead.
    expect((posting as any).postInvoicePaymentRedistribution).toHaveBeenCalledTimes(1);
    const transfers = (posting as any).postInvoicePaymentRedistribution.mock.calls[0][2] as any[];
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      from_cashbox_id: 'cb-main',  // cash side (shift cashbox)
      to_cashbox_id: 'cb-visa',    // card_visa side (PA cashbox)
      amount: 100,
    });
  });
});

describe('editInvoice — guard rails', () => {
  it('throws on empty dto.lines (lines required regardless of edit shape)', async () => {
    const { ds } = makeFakeDs({ emResults: [] });
    const svc = makeServiceWith(makePostingMock(), ds);
    let thrown: unknown = null;
    try {
      await svc.editInvoice('inv-1', { lines: [], payments: [] }, 'u-1', 'no lines');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
  });

  it('+Δ delta path bubbles postInvoiceDelta errors as BadRequestException', async () => {
    const { ds } = makeFakeDs({
      emResults: [
        [ORIG_INVOICE],
        ORIG_ITEMS,
        ORIG_PAYMENTS,
        ORIG_ITEMS,
        [{ id: 'hist-1' }],
        [],
        [{ ...ORIG_INVOICE, grand_total: '100.02' }],
        [...ORIG_PAYMENTS],
        [],
      ],
    });
    const posting = makePostingMock();
    posting.postInvoiceDelta.mockResolvedValueOnce({ error: 'cashbox_not_resolvable_via_shift' });
    const svc = makeServiceWith(posting, ds);

    const dto = {
      lines: [{ variant_id: 'v-1', qty: 2, unit_price: 50.01, discount: 0 }],
      payments: [{ payment_method: 'cash', amount: 100.02 }],
      discount_total: 0,
    };

    let thrown: unknown = null;
    try {
      await svc.editInvoice('inv-1', dto, 'u-1', 'bubble error');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as Error).message).toContain('cashbox_not_resolvable_via_shift');
  });
});

// ════════════════════════════════════════════════════════════════════
// PR-POS-INVOICE-PAYMENT-REDISTRIBUTION-1
// --------------------------------------------------------------------
// Phase 1 — payment-composition edits (add/remove/swap payment method
// while keeping grand_total + paid_amount unchanged) must route
// through applyPaymentRedistributionEdit and NOT call postInvoiceEdit
// or reverseByReference.  No `reversal_sale` CT, no "عكس:" note, the
// original sale JE stays is_void=false.
// ════════════════════════════════════════════════════════════════════
import { classifyPaymentRedistribution } from './pos.service';

describe('classifyPaymentRedistribution — PR-POS-INVOICE-PAYMENT-REDISTRIBUTION-1', () => {
  const orig = {
    customer_id: null,
    grand_total: '725.00',
    paid_amount: '725.00',
  };
  const items = [
    { variant_id: 'v-1', quantity: 1 },
    { variant_id: 'v-2', quantity: 1 },
  ];
  const origPayments = [
    { payment_method: 'instapay', amount: '725.00', payment_account_id: 'acct-instapay' },
  ];

  it('the screenshot case (InstaPay 725 → InstaPay 700 + cash 25) is classified as redistribution with one pair', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 1 },
        { variant_id: 'v-2', qty: 1 },
      ],
      payments: [
        { payment_method: 'instapay', amount: 700, payment_account_id: 'acct-instapay' },
        { payment_method: 'cash', amount: 25 },
      ],
    };
    const r = classifyPaymentRedistribution(orig, items, origPayments, dto);
    expect(r.kind).toBe('payment_redistribution');
    if (r.kind === 'payment_redistribution') {
      expect(r.bucket_deltas).toHaveLength(2);
      const instapay = r.bucket_deltas.find((b) => b.payment_method === 'instapay')!;
      const cash = r.bucket_deltas.find((b) => b.payment_method === 'cash')!;
      expect(instapay.delta).toBe(-25);
      expect(cash.delta).toBe(25);
      // Pair invariant: deltas sum to zero
      expect(r.bucket_deltas.reduce((s, b) => s + b.delta, 0)).toBeCloseTo(0, 5);
    }
  });

  it('remove payment method (cash 500 + InstaPay 300 → cash 800) is classified as redistribution', () => {
    const origRemoveCase = { customer_id: null, grand_total: '800.00', paid_amount: '800.00' };
    const origPaymentsTwo = [
      { payment_method: 'cash', amount: '500.00', payment_account_id: null },
      { payment_method: 'instapay', amount: '300.00', payment_account_id: 'acct-instapay' },
    ];
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 1 },
        { variant_id: 'v-2', qty: 1 },
      ],
      payments: [{ payment_method: 'cash', amount: 800 }],
    };
    const r = classifyPaymentRedistribution(origRemoveCase, items, origPaymentsTwo, dto);
    expect(r.kind).toBe('payment_redistribution');
    if (r.kind === 'payment_redistribution') {
      const cash = r.bucket_deltas.find((b) => b.payment_method === 'cash')!;
      const ip = r.bucket_deltas.find((b) => b.payment_method === 'instapay')!;
      expect(cash.delta).toBe(300);
      expect(ip.delta).toBe(-300);
    }
  });

  it('grand_total change → not_redistribution (paid_does_not_match_grand_total)', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 1 },
        { variant_id: 'v-2', qty: 1 },
      ],
      payments: [
        { payment_method: 'instapay', amount: 700, payment_account_id: 'acct-instapay' },
        { payment_method: 'cash', amount: 26 },
      ],
    };
    const r = classifyPaymentRedistribution(orig, items, origPayments, dto);
    expect(r.kind).toBe('not_redistribution');
    if (r.kind === 'not_redistribution') {
      // Either paid_total_changed or paid_does_not_match_grand_total
      expect(['paid_total_changed', 'paid_does_not_match_grand_total']).toContain(r.reason);
    }
  });

  it('line count change → not_redistribution', () => {
    const dto = {
      lines: [{ variant_id: 'v-1', qty: 1 }],
      payments: [{ payment_method: 'instapay', amount: 725, payment_account_id: 'acct-instapay' }],
    };
    const r = classifyPaymentRedistribution(orig, items, origPayments, dto);
    expect(r.kind).toBe('not_redistribution');
    if (r.kind === 'not_redistribution') expect(r.reason).toBe('line_count_changed');
  });

  it('qty change → not_redistribution', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2 }, // qty 1 → 2
        { variant_id: 'v-2', qty: 1 },
      ],
      payments: [
        { payment_method: 'instapay', amount: 700, payment_account_id: 'acct-instapay' },
        { payment_method: 'cash', amount: 25 },
      ],
    };
    const r = classifyPaymentRedistribution(orig, items, origPayments, dto);
    expect(r.kind).toBe('not_redistribution');
    if (r.kind === 'not_redistribution') expect(r.reason).toBe('qty_changed');
  });

  it('customer change → not_redistribution', () => {
    const origCust = { ...orig, customer_id: 'cust-A' };
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 1 },
        { variant_id: 'v-2', qty: 1 },
      ],
      payments: [
        { payment_method: 'instapay', amount: 700, payment_account_id: 'acct-instapay' },
        { payment_method: 'cash', amount: 25 },
      ],
      customer_id: 'cust-B',
    };
    const r = classifyPaymentRedistribution(origCust, items, origPayments, dto);
    expect(r.kind).toBe('not_redistribution');
    if (r.kind === 'not_redistribution') expect(r.reason).toBe('customer_changed');
  });

  it('no payment changes at all → not_redistribution (no_bucket_changes)', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 1 },
        { variant_id: 'v-2', qty: 1 },
      ],
      payments: [{ payment_method: 'instapay', amount: 725, payment_account_id: 'acct-instapay' }],
    };
    const r = classifyPaymentRedistribution(orig, items, origPayments, dto);
    expect(r.kind).toBe('not_redistribution');
    if (r.kind === 'not_redistribution') expect(r.reason).toBe('no_bucket_changes');
  });
});

// editInvoice orchestration — payment redistribution path
describe('editInvoice — PR-POS-INVOICE-PAYMENT-REDISTRIBUTION-1', () => {
  // Mirrors the screenshot scenario: invoice with InstaPay 725 →
  // InstaPay 700 + cash 25.  grand_total stays 725.
  const ORIG_INVOICE_RDS = {
    id: 'inv-rds-1',
    invoice_no: 'INV-2026-RDS-1',
    status: 'paid',
    warehouse_id: 'wh-1',
    shift_id: 'shift-1',
    customer_id: null,
    salesperson_id: 'sp-1',
    tax_rate: 0,
    paid_amount: '725.00',
    grand_total: '725.00',
    subtotal: '725.00',
    cogs_total: '0.00',
    notes: null,
  };
  const ORIG_ITEMS_RDS = [
    { id: 1, invoice_id: 'inv-rds-1', variant_id: 'v-1', quantity: 1, unit_price: 350, unit_cost: 0 },
    { id: 2, invoice_id: 'inv-rds-1', variant_id: 'v-2', quantity: 1, unit_price: 375, unit_cost: 0 },
  ];
  const ORIG_PAYMENTS_RDS = [
    {
      id: 1,
      invoice_id: 'inv-rds-1',
      payment_method: 'instapay',
      amount: '725.00',
      payment_account_id: 'acct-instapay',
      payment_account_snapshot: { cashbox_id: 'cb-instapay' },
    },
  ];

  const dtoSwap = {
    lines: [
      { variant_id: 'v-1', qty: 1, unit_price: 350, discount: 0 },
      { variant_id: 'v-2', qty: 1, unit_price: 375, discount: 0 },
    ],
    payments: [
      { payment_method: 'instapay', amount: 700, payment_account_id: 'acct-instapay' },
      { payment_method: 'cash', amount: 25 },
    ],
    discount_total: 0,
  };

  function makePostingMockWithRedistribution() {
    return {
      postInvoiceDelta: jest.fn<Promise<any>, any[]>(async () => ({ entry_id: 'je-delta-1' })),
      postInvoiceEdit:  jest.fn<Promise<any>, any[]>(async () => ({ entry_id: 'je-edit-1' })),
      postInvoicePaymentRedistribution: jest.fn<Promise<any>, any[]>(async () => ({
        ok: true, entry_ids: ['je-transfer-1'],
      })),
    };
  }

  function emQueueRedistribution() {
    return [
      [ORIG_INVOICE_RDS],                        // SELECT * FROM invoices FOR UPDATE
      ORIG_ITEMS_RDS,                            // SELECT items
      ORIG_PAYMENTS_RDS,                         // SELECT payments
      // applyPaymentRedistributionEdit begins here:
      [{ id: 'hist-rds-1' }],                    // INSERT history RETURNING id (FIRST)
      [{ cashbox_id: 'cb-main' }],               // SELECT cashbox_id FROM shifts (SECOND)
      [],                                         // UPDATE invoice_payments (instapay row to 700)
      [],                                         // INSERT invoice_payments (new cash row)
      [{ ...ORIG_INVOICE_RDS }],                 // UPDATE invoices RETURNING *
      [                                           // SELECT after-snapshot
        { id: 1, payment_method: 'instapay', amount: '700.00' },
        { id: 2, payment_method: 'cash', amount: '25.00' },
      ],
      [],                                         // UPDATE history backfill
    ];
  }

  it('payment swap (InstaPay 725 → InstaPay 700 + cash 25): postInvoicePaymentRedistribution called, NOT postInvoiceEdit', async () => {
    const { ds } = makeFakeDs({ emResults: emQueueRedistribution() });
    const posting = makePostingMockWithRedistribution();
    const svc = makeServiceWith(posting, ds);

    const res = await svc.editInvoice('inv-rds-1', dtoSwap, 'user-1', 'وسيلة دفع');
    expect(res).toMatchObject({ edited: true });

    // Redistribution path called
    expect(posting.postInvoicePaymentRedistribution).toHaveBeenCalledTimes(1);
    const callArgs = posting.postInvoicePaymentRedistribution.mock.calls[0];
    expect(callArgs[0]).toBe('inv-rds-1');                  // invoiceId
    expect(callArgs[1]).toBe('hist-rds-1');                 // historyId
    const transfers = callArgs[2] as any[];                  // pairs
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      from_cashbox_id: 'cb-instapay',
      to_cashbox_id: 'cb-main',
      amount: 25,
    });

    // Legacy reverse-and-repost path NOT called
    expect(posting.postInvoiceEdit).not.toHaveBeenCalled();
    expect(posting.postInvoiceDelta).not.toHaveBeenCalled();
  });

  it('payment swap path does NOT delete invoice_items or invoice_payments wholesale; uses surgical UPDATE/INSERT/DELETE per bucket', async () => {
    const { ds, emCalls } = makeFakeDs({ emResults: emQueueRedistribution() });
    const posting = makePostingMockWithRedistribution();
    const svc = makeServiceWith(posting, ds);

    await svc.editInvoice('inv-rds-1', dtoSwap, 'user-1', 'وسيلة دفع');

    // Legacy path issues wholesale wipes: DELETE FROM invoice_items / invoice_payments.
    // Redistribution path must NOT.
    const wholesaleItemDeletes = emCalls.filter((c) =>
      /^\s*DELETE FROM invoice_items WHERE invoice_id\s*=/i.test(c.sql),
    );
    const wholesalePaymentDeletes = emCalls.filter((c) =>
      /^\s*DELETE FROM invoice_payments WHERE invoice_id\s*=/i.test(c.sql),
    );
    expect(wholesaleItemDeletes).toHaveLength(0);
    expect(wholesalePaymentDeletes).toHaveLength(0);

    // Per-bucket UPDATE + INSERT happened.
    const ipUpdates = emCalls.filter((c) =>
      /^\s*UPDATE invoice_payments SET amount/i.test(c.sql),
    );
    const ipInserts = emCalls.filter((c) =>
      /^\s*INSERT INTO invoice_payments/i.test(c.sql),
    );
    expect(ipUpdates).toHaveLength(1); // InstaPay 725 → 700
    expect(ipInserts).toHaveLength(1); // new cash 25 row
  });

  it('REMOVAL case (cash 500 + InstaPay 300 → cash 800): redistribution path, deletes the removed bucket row', async () => {
    const origRemoval = { ...ORIG_INVOICE_RDS, grand_total: '800.00', paid_amount: '800.00' };
    const origPaymentsTwo = [
      { id: 11, invoice_id: 'inv-rds-1', payment_method: 'cash', amount: '500.00', payment_account_id: null, payment_account_snapshot: null },
      { id: 12, invoice_id: 'inv-rds-1', payment_method: 'instapay', amount: '300.00', payment_account_id: 'acct-instapay', payment_account_snapshot: { cashbox_id: 'cb-instapay' } },
    ];
    const dtoRemove = {
      lines: [
        { variant_id: 'v-1', qty: 1, unit_price: 350, discount: 0 },
        { variant_id: 'v-2', qty: 1, unit_price: 450, discount: 0 },
      ],
      payments: [{ payment_method: 'cash', amount: 800 }],
      discount_total: 0,
    };

    const emResults = [
      [origRemoval],
      ORIG_ITEMS_RDS,
      origPaymentsTwo,
      [{ id: 'hist-rds-2' }],          // history INSERT (FIRST)
      [{ cashbox_id: 'cb-main' }],     // shift lookup (SECOND)
      [],                              // UPDATE cash row 500 → 800
      [],                              // DELETE instapay row
      [{ ...origRemoval }],            // UPDATE invoices
      [                                 // SELECT after-snapshot
        { id: 11, payment_method: 'cash', amount: '800.00' },
      ],
      [],                              // history backfill
    ];

    const { ds, emCalls } = makeFakeDs({ emResults });
    const posting = makePostingMockWithRedistribution();
    const svc = makeServiceWith(posting, ds);

    await svc.editInvoice('inv-rds-1', dtoRemove, 'user-1', 'إزالة وسيلة دفع');

    expect(posting.postInvoicePaymentRedistribution).toHaveBeenCalledTimes(1);
    const transfers = posting.postInvoicePaymentRedistribution.mock.calls[0][2] as any[];
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      from_cashbox_id: 'cb-instapay',
      to_cashbox_id: 'cb-main',
      amount: 300,
    });

    expect(posting.postInvoiceEdit).not.toHaveBeenCalled();

    // Per-bucket DELETE for the removed instapay row (NOT a wholesale wipe)
    const targetedDeletes = emCalls.filter((c) =>
      /^\s*DELETE FROM invoice_payments WHERE id\s*=/i.test(c.sql),
    );
    expect(targetedDeletes).toHaveLength(1);
  });

  it('GUARD: redistribution path NEVER invokes the legacy postInvoiceEdit (regression guard for reversal_sale)', async () => {
    const { ds } = makeFakeDs({ emResults: emQueueRedistribution() });
    const posting = makePostingMockWithRedistribution();
    const svc = makeServiceWith(posting, ds);

    await svc.editInvoice('inv-rds-1', dtoSwap, 'user-1', 'وسيلة دفع');

    expect(posting.postInvoiceEdit).not.toHaveBeenCalled();
  });

  it('GUARD: structural QTY DECREASE / line removal STILL goes through legacy postInvoiceEdit — Phase 2B work', async () => {
    // Phase 2A reclassifies positive qty changes as
    // positive_structural_delta. Negative structural edits (qty down,
    // line removed, line revenue down) still fall through to legacy
    // reverse-and-repost; that's the Phase 2B scope.
    const dtoQtyDown = {
      lines: [
        { variant_id: 'v-1', qty: 0.5, unit_price: 350, discount: 0 }, // qty 1→0.5 (decrease)
        { variant_id: 'v-2', qty: 1, unit_price: 375, discount: 0 },
      ],
      payments: [{ payment_method: 'instapay', amount: 550, payment_account_id: 'acct-instapay' }],
      discount_total: 0,
    };
    // Legacy path emQueue (enough entries to reach postInvoiceEdit)
    const emResults = [
      [ORIG_INVOICE_RDS],                // [0] SELECT invoices
      ORIG_ITEMS_RDS,                    // [1] SELECT items
      ORIG_PAYMENTS_RDS,                 // [2] SELECT payments
      [],                                // [3] INSERT stock_movements (item 1)
      [],                                // [4] INSERT stock_movements (item 2)
      [{ cashbox_id: 'cb-instapay' }],   // [5] SELECT cashbox_id FROM cashbox_transactions
      [{ id: 'hist-legacy-1' }],         // [6] INSERT history RETURNING id
      [],                                // [7] DELETE invoice_items
      [],                                // [8] DELETE invoice_payments
      [                                   // [9] SELECT variants
        { id: 'v-1', cost_price: 0, sku: 'SKU-1', product_name: 'A', color_name: null, size_label: null },
        { id: 'v-2', cost_price: 0, sku: 'SKU-2', product_name: 'B', color_name: null, size_label: null },
      ],
      [],                                // [10] INSERT invoice_items v-1
      [],                                // [11] INSERT stock_movements sale v-1
      [],                                // [12] INSERT invoice_items v-2
      [],                                // [13] INSERT stock_movements sale v-2
      [],                                // [14] INSERT invoice_payments
      [{ ...ORIG_INVOICE_RDS, grand_total: '550.00' }], // [15] UPDATE invoices
      ORIG_ITEMS_RDS,                    // [16] SELECT items after
      ORIG_PAYMENTS_RDS,                 // [17] SELECT payments after
      [],                                // [18] backfill history
    ];
    const { ds } = makeFakeDs({ emResults });
    const posting = makePostingMockWithRedistribution();
    const svc = makeServiceWith(posting, ds);

    await svc.editInvoice('inv-rds-1', dtoQtyDown, 'user-1', 'qty down');

    expect(posting.postInvoiceEdit).toHaveBeenCalledTimes(1);
    expect(posting.postInvoicePaymentRedistribution).not.toHaveBeenCalled();
  });

  it('payment redistribution path bubbles posting errors as BadRequestException', async () => {
    const { ds } = makeFakeDs({ emResults: emQueueRedistribution() });
    const posting = makePostingMockWithRedistribution();
    posting.postInvoicePaymentRedistribution.mockResolvedValueOnce({
      error: 'transfer_failed:engine_guard_b',
    });
    const svc = makeServiceWith(posting, ds);

    let thrown: unknown = null;
    try {
      await svc.editInvoice('inv-rds-1', dtoSwap, 'user-1', 'وسيلة دفع');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as Error).message).toContain('transfer_failed');
  });
});

// ════════════════════════════════════════════════════════════════════
// PR-POS-INVOICE-POSITIVE-STRUCTURAL-DELTA-1 (Phase 2A)
// --------------------------------------------------------------------
// Positive structural edits (add line, qty up, line revenue up — any
// combination) must route through applyPositiveStructuralDeltaEdit and
// NEVER call postInvoiceEdit / reverseByReference. The original sale
// JE stays is_void=false. No `reversal_sale` CT, no "عكس:" note, no
// stock_movements adjustment-in reversal, no DELETE of invoice_items /
// invoice_payments wholesale.
// ════════════════════════════════════════════════════════════════════
import { classifyPositiveStructuralDelta } from './pos.service';

describe('classifyPositiveStructuralDelta — Phase 2A pure function', () => {
  const ORIG_PSD = {
    customer_id: null,
    grand_total: '100.00',
    paid_amount: '100.00',
  };
  const ITEMS_PSD = [
    { variant_id: 'v-1', quantity: 2, unit_price: 50, unit_cost: 30, line_total: 100 },
  ];
  const PAYMENTS_PSD = [
    { id: 1, payment_method: 'cash', amount: '100.00', payment_account_id: null },
  ];

  it('add brand-new line + extra cash payment → positive_structural_delta with 1 line + 1 payment delta', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 50 },
        { variant_id: 'v-2', qty: 1, unit_price: 25 },
      ],
      payments: [
        { payment_method: 'cash', amount: 125 },
      ],
    };
    const r = classifyPositiveStructuralDelta(ORIG_PSD, ITEMS_PSD, PAYMENTS_PSD, dto);
    expect(r.kind).toBe('positive_structural_delta');
    if (r.kind === 'positive_structural_delta') {
      expect(r.line_deltas).toHaveLength(1);
      expect(r.line_deltas[0]).toMatchObject({
        variant_id: 'v-2',
        delta_qty: 1,
        unit_price: 25,
        delta_revenue: 25,
      });
      expect(r.payment_deltas).toHaveLength(1);
      expect(r.payment_deltas[0]).toMatchObject({
        payment_method: 'cash',
        delta_amount: 25,
      });
      expect(r.delta_grand_total).toBe(25);
      expect(r.delta_paid_total).toBe(25);
      expect(r.delta_unpaid).toBe(0);
    }
  });

  it('qty increase only (v-1 qty 2→3, same price) + extra cash → positive_structural_delta', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 3, unit_price: 50 },
      ],
      payments: [
        { payment_method: 'cash', amount: 150 },
      ],
    };
    const r = classifyPositiveStructuralDelta(ORIG_PSD, ITEMS_PSD, PAYMENTS_PSD, dto);
    expect(r.kind).toBe('positive_structural_delta');
    if (r.kind === 'positive_structural_delta') {
      expect(r.line_deltas).toHaveLength(1);
      expect(r.line_deltas[0]).toMatchObject({
        variant_id: 'v-1',
        delta_qty: 1,
        unit_price: 50,
      });
      expect(r.delta_grand_total).toBe(50);
    }
  });

  it('qty + price increase on the SAME variant: derived unit_price = delta_revenue / delta_qty', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 3, unit_price: 60 },
      ],
      payments: [
        { payment_method: 'cash', amount: 180 },
      ],
    };
    const r = classifyPositiveStructuralDelta(ORIG_PSD, ITEMS_PSD, PAYMENTS_PSD, dto);
    expect(r.kind).toBe('positive_structural_delta');
    if (r.kind === 'positive_structural_delta') {
      // orig revenue 100 (2×50), new revenue 180 (3×60) → delta_rev 80, delta_qty 1 → unit_price 80
      expect(r.line_deltas[0]).toMatchObject({
        variant_id: 'v-1',
        delta_qty: 1,
        unit_price: 80,
        delta_revenue: 80,
      });
      expect(r.delta_grand_total).toBe(80);
    }
  });

  it('combined add line + qty increase + additional payment', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 3, unit_price: 50 },
        { variant_id: 'v-2', qty: 2, unit_price: 30 },
      ],
      payments: [
        { payment_method: 'cash', amount: 210 },
      ],
    };
    const r = classifyPositiveStructuralDelta(ORIG_PSD, ITEMS_PSD, PAYMENTS_PSD, dto);
    expect(r.kind).toBe('positive_structural_delta');
    if (r.kind === 'positive_structural_delta') {
      expect(r.line_deltas).toHaveLength(2);
      expect(r.delta_grand_total).toBe(110);
      expect(r.delta_paid_total).toBe(110);
    }
  });

  it('partial-paid delta: unpaid portion goes to delta_unpaid (customer receivable)', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 50 },
        { variant_id: 'v-2', qty: 1, unit_price: 25 },
      ],
      payments: [
        { payment_method: 'cash', amount: 110 }, // only +10 extra paid for +25 delta
      ],
    };
    const r = classifyPositiveStructuralDelta(ORIG_PSD, ITEMS_PSD, PAYMENTS_PSD, dto);
    expect(r.kind).toBe('positive_structural_delta');
    if (r.kind === 'positive_structural_delta') {
      expect(r.delta_grand_total).toBe(25);
      expect(r.delta_paid_total).toBe(10);
      expect(r.delta_unpaid).toBe(15);
    }
  });

  it('new payment bucket added (cash + new instapay) is allowed', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 50 },
        { variant_id: 'v-2', qty: 1, unit_price: 50 },
      ],
      payments: [
        { payment_method: 'cash', amount: 100 },
        { payment_method: 'instapay', amount: 50, payment_account_id: 'acct-ip' },
      ],
    };
    const r = classifyPositiveStructuralDelta(ORIG_PSD, ITEMS_PSD, PAYMENTS_PSD, dto);
    expect(r.kind).toBe('positive_structural_delta');
    if (r.kind === 'positive_structural_delta') {
      expect(r.payment_deltas).toHaveLength(1);
      expect(r.payment_deltas[0]).toMatchObject({
        payment_method: 'instapay',
        payment_account_id: 'acct-ip',
        delta_amount: 50,
      });
    }
  });

  it('customer change → not_positive_structural (customer_changed)', () => {
    const dto = {
      lines: [{ variant_id: 'v-1', qty: 3, unit_price: 50 }],
      payments: [{ payment_method: 'cash', amount: 150 }],
      customer_id: 'cust-other',
    };
    const r = classifyPositiveStructuralDelta(ORIG_PSD, ITEMS_PSD, PAYMENTS_PSD, dto);
    expect(r).toEqual({ kind: 'not_positive_structural', reason: 'customer_changed' });
  });

  it('qty decrease (v-1 2→1) → not_positive_structural (qty_decreased)', () => {
    const dto = {
      lines: [{ variant_id: 'v-1', qty: 1, unit_price: 50 }],
      payments: [{ payment_method: 'cash', amount: 50 }],
    };
    const r = classifyPositiveStructuralDelta(ORIG_PSD, ITEMS_PSD, PAYMENTS_PSD, dto);
    expect(r).toEqual({ kind: 'not_positive_structural', reason: 'qty_decreased' });
  });

  it('variant removed entirely → not_positive_structural (variant_removed)', () => {
    const dto = {
      lines: [{ variant_id: 'v-other', qty: 1, unit_price: 100 }],
      payments: [{ payment_method: 'cash', amount: 100 }],
    };
    const r = classifyPositiveStructuralDelta(ORIG_PSD, ITEMS_PSD, PAYMENTS_PSD, dto);
    expect(r).toEqual({ kind: 'not_positive_structural', reason: 'variant_removed' });
  });

  it('per-line revenue decrease (v-1 qty 2→2 + price 50→40) → not_positive_structural (price_only_change_on_unchanged_qty_line)', () => {
    // dQty=0 + dRev<0 actually surfaces line_revenue_decreased first.
    const dto = {
      lines: [{ variant_id: 'v-1', qty: 2, unit_price: 40 }],
      payments: [{ payment_method: 'cash', amount: 80 }],
    };
    const r = classifyPositiveStructuralDelta(ORIG_PSD, ITEMS_PSD, PAYMENTS_PSD, dto);
    expect(r).toEqual({ kind: 'not_positive_structural', reason: 'line_revenue_decreased' });
  });

  it('price-only change on unchanged qty (v-1 2→2 + price 50→60) → not_positive_structural (price_only_change_on_unchanged_qty_line)', () => {
    const dto = {
      lines: [{ variant_id: 'v-1', qty: 2, unit_price: 60 }],
      payments: [{ payment_method: 'cash', amount: 120 }],
    };
    const r = classifyPositiveStructuralDelta(ORIG_PSD, ITEMS_PSD, PAYMENTS_PSD, dto);
    expect(r).toEqual({
      kind: 'not_positive_structural',
      reason: 'price_only_change_on_unchanged_qty_line',
    });
  });

  it('payment bucket decreased (cash 100→80) → not_positive_structural (payment_bucket_decreased)', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 50 },
        { variant_id: 'v-2', qty: 1, unit_price: 50 },
      ],
      payments: [
        { payment_method: 'cash', amount: 80 },
        { payment_method: 'instapay', amount: 70, payment_account_id: 'acct-ip' },
      ],
    };
    const r = classifyPositiveStructuralDelta(ORIG_PSD, ITEMS_PSD, PAYMENTS_PSD, dto);
    expect(r).toEqual({ kind: 'not_positive_structural', reason: 'payment_bucket_decreased' });
  });

  it('over-payment delta (paid_delta > grand_delta) → not_positive_structural (over_payment_delta)', () => {
    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 50 },
        { variant_id: 'v-2', qty: 1, unit_price: 25 },
      ],
      payments: [{ payment_method: 'cash', amount: 200 }], // +100 paid for +25 grand
    };
    const r = classifyPositiveStructuralDelta(ORIG_PSD, ITEMS_PSD, PAYMENTS_PSD, dto);
    expect(r).toEqual({ kind: 'not_positive_structural', reason: 'over_payment_delta' });
  });

  it('no_line_changes path: every variant has zero deltas → rejected (delegate to other classifiers)', () => {
    const dto = {
      lines: [{ variant_id: 'v-1', qty: 2, unit_price: 50 }],
      payments: [{ payment_method: 'cash', amount: 100 }],
    };
    const r = classifyPositiveStructuralDelta(ORIG_PSD, ITEMS_PSD, PAYMENTS_PSD, dto);
    expect(r).toEqual({ kind: 'not_positive_structural', reason: 'no_line_changes' });
  });
});

describe('editInvoice — Phase 2A positive structural delta path', () => {
  const ORIG_INVOICE_PSD = {
    id: 'inv-psd-1',
    invoice_no: 'INV-2026-000900',
    status: 'paid',
    warehouse_id: 'wh-1',
    shift_id: 'shift-1',
    customer_id: null,
    salesperson_id: 'sp-1',
    tax_rate: 0,
    paid_amount: '100.00',
    grand_total: '100.00',
    subtotal: '100.00',
    cogs_total: '60.00',
    notes: null,
  };
  const ORIG_ITEMS_PSD = [
    {
      id: 1,
      invoice_id: 'inv-psd-1',
      variant_id: 'v-1',
      quantity: 2,
      unit_price: 50,
      unit_cost: 30,
      line_total: 100,
      product_name_snapshot: 'منتج 1',
      sku_snapshot: 'SKU-1',
      color_name_snapshot: null,
      size_label_snapshot: null,
    },
  ];
  const ORIG_PAYMENTS_PSD = [
    {
      id: 1,
      invoice_id: 'inv-psd-1',
      payment_method: 'cash',
      amount: '100.00',
      payment_account_id: null,
      payment_account_snapshot: null,
    },
  ];

  function makePostingMockWithPositiveStructural() {
    return {
      postInvoiceDelta: jest.fn<Promise<any>, any[]>(async () => ({ entry_id: 'je-delta-1' })),
      postInvoiceEdit: jest.fn<Promise<any>, any[]>(async () => ({ entry_id: 'je-edit-1' })),
      postInvoicePaymentRedistribution: jest.fn<Promise<any>, any[]>(async () => ({
        ok: true,
        entry_ids: ['je-transfer-1'],
      })),
      postInvoicePositiveStructuralDelta: jest.fn<Promise<any>, any[]>(async () => ({
        ok: true,
        entry_id: 'je-pos-1',
      })),
    };
  }

  function emQueueAddLine() {
    return [
      [ORIG_INVOICE_PSD],
      ORIG_ITEMS_PSD,
      ORIG_PAYMENTS_PSD,
      // applyPositiveStructuralDeltaEdit begins here:
      [{ id: 'hist-psd-1' }],            // INSERT history RETURNING id
      [                                    // SELECT product_variants for new variants
        {
          id: 'v-2',
          cost_price: 20,
          sku: 'SKU-2',
          product_name: 'منتج 2',
          color_name: null,
          size_label: null,
        },
      ],
      [],                                  // INSERT invoice_items (delta row v-2)
      [],                                  // INSERT stock_movements (delta v-2)
      [],                                  // INSERT invoice_payments (delta cash row)
      [{ ...ORIG_INVOICE_PSD, grand_total: '125.00', paid_amount: '125.00' }], // UPDATE invoices RETURNING *
      [                                    // SELECT items after-snapshot
        ORIG_ITEMS_PSD[0],
        {
          id: 2,
          invoice_id: 'inv-psd-1',
          variant_id: 'v-2',
          quantity: 1,
          unit_price: 25,
          unit_cost: 20,
          line_total: 25,
        },
      ],
      [                                    // SELECT payments after-snapshot
        ORIG_PAYMENTS_PSD[0],
        {
          id: 2,
          invoice_id: 'inv-psd-1',
          payment_method: 'cash',
          amount: '25.00',
        },
      ],
      [],                                  // UPDATE history backfill
    ];
  }

  it('add new line + additional cash 25: routes to postInvoicePositiveStructuralDelta, NOT postInvoiceEdit, NOT delta path', async () => {
    const { ds, emCalls } = makeFakeDs({ emResults: emQueueAddLine() });
    const posting = makePostingMockWithPositiveStructural();
    const svc = makeServiceWith(posting, ds);

    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 50, discount: 0 },
        { variant_id: 'v-2', qty: 1, unit_price: 25, discount: 0 },
      ],
      payments: [{ payment_method: 'cash', amount: 125 }],
      discount_total: 0,
    };

    const res = await svc.editInvoice('inv-psd-1', dto, 'user-1', 'add new line');
    expect(res).toMatchObject({ edited: true });

    // Phase 2A path was used; legacy and other paths were NOT.
    expect(posting.postInvoicePositiveStructuralDelta).toHaveBeenCalledTimes(1);
    expect(posting.postInvoiceEdit).not.toHaveBeenCalled();
    expect(posting.postInvoiceDelta).not.toHaveBeenCalled();
    expect(posting.postInvoicePaymentRedistribution).not.toHaveBeenCalled();

    // Helper got the correct delta payload.
    const args = posting.postInvoicePositiveStructuralDelta.mock.calls[0];
    expect(args[0]).toBe('inv-psd-1');                // invoiceId
    expect(args[1]).toBe('hist-psd-1');               // historyId
    expect(args[2]).toMatchObject({
      line_deltas: [
        { variant_id: 'v-2', delta_qty: 1, unit_price: 25, unit_cost: 20 },
      ],
      payment_deltas: [{ payment_method: 'cash', delta_amount: 25 }],
      delta_unpaid: 0,
      customer_id: null,
    });

    // No DELETE FROM invoice_items / invoice_payments (additive only).
    expect(sqlMatches(emCalls, /^\s*DELETE FROM invoice_items\b/i).length).toBe(0);
    expect(sqlMatches(emCalls, /^\s*DELETE FROM invoice_payments\b/i).length).toBe(0);

    // EXACTLY one stock_movements INSERT — for the delta qty only.
    const stockInserts = sqlMatches(emCalls, /^\s*INSERT INTO stock_movements\b/i);
    expect(stockInserts.length).toBe(1);
    // And it MUST NOT be an adjustment-in (the legacy reversal pattern).
    expect(stockInserts[0].sql).not.toMatch(/'adjustment'\s*,\s*'in'/);
    expect(stockInserts[0].sql).toMatch(/'sale'/);
    // Delta qty 1, delta variant v-2.
    expect(stockInserts[0].params).toContain('v-2');
    expect(stockInserts[0].params).toContain(1);

    // EXACTLY one invoice_items INSERT — for the new variant.
    const itemInserts = sqlMatches(emCalls, /^\s*INSERT INTO invoice_items\b/i);
    expect(itemInserts.length).toBe(1);
    expect(itemInserts[0].params).toContain('v-2');

    // EXACTLY one invoice_payments INSERT — for the additional cash.
    const paymentInserts = sqlMatches(emCalls, /^\s*INSERT INTO invoice_payments\b/i);
    expect(paymentInserts.length).toBe(1);
    expect(paymentInserts[0].params).toContain(25);
  });

  it('Phase 2A: original sale JE is NEVER voided and reverseByReference is NEVER called', async () => {
    const { ds, emCalls } = makeFakeDs({ emResults: emQueueAddLine() });
    const posting = makePostingMockWithPositiveStructural();
    // Spy on reverseByReference: any call here is a regression.
    (posting as any).reverseByReference = jest.fn(async () => {
      throw new Error('reverseByReference must NOT be called from Phase 2A path');
    });
    const svc = makeServiceWith(posting, ds);

    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 50 },
        { variant_id: 'v-2', qty: 1, unit_price: 25 },
      ],
      payments: [{ payment_method: 'cash', amount: 125 }],
      discount_total: 0,
    };

    await svc.editInvoice('inv-psd-1', dto, 'user-1', 'add new line');

    // No UPDATE journal_entries SET is_void = TRUE issued by this path.
    const voidUpdates = emCalls.filter((c) =>
      /UPDATE\s+journal_entries[\s\S]*is_void\s*=\s*TRUE/i.test(c.sql),
    );
    expect(voidUpdates).toHaveLength(0);

    // No CT marker either.
    const ctVoidUpdates = emCalls.filter((c) =>
      /UPDATE\s+cashbox_transactions[\s\S]*is_void\s*=\s*TRUE/i.test(c.sql),
    );
    expect(ctVoidUpdates).toHaveLength(0);

    expect((posting as any).reverseByReference).not.toHaveBeenCalled();
  });

  function emQueueQtyIncrease() {
    return [
      [ORIG_INVOICE_PSD],
      ORIG_ITEMS_PSD,
      ORIG_PAYMENTS_PSD,
      [{ id: 'hist-psd-q' }],            // INSERT history
      // No new variants → no product_variants SELECT.
      [],                                  // INSERT invoice_items (delta v-1 qty 1)
      [],                                  // INSERT stock_movements (delta)
      [],                                  // INSERT invoice_payments (cash +50)
      [{ ...ORIG_INVOICE_PSD, grand_total: '150.00', paid_amount: '150.00' }],
      [
        ORIG_ITEMS_PSD[0],
        { id: 3, invoice_id: 'inv-psd-1', variant_id: 'v-1', quantity: 1, unit_price: 50 },
      ],
      [
        ORIG_PAYMENTS_PSD[0],
        { id: 3, payment_method: 'cash', amount: '50.00' },
      ],
      [],
    ];
  }

  it('qty increase only (v-1 2→3) + extra cash 50: one stock_movement delta, no reversal', async () => {
    const { ds, emCalls } = makeFakeDs({ emResults: emQueueQtyIncrease() });
    const posting = makePostingMockWithPositiveStructural();
    const svc = makeServiceWith(posting, ds);

    const dto = {
      lines: [{ variant_id: 'v-1', qty: 3, unit_price: 50, discount: 0 }],
      payments: [{ payment_method: 'cash', amount: 150 }],
      discount_total: 0,
    };

    await svc.editInvoice('inv-psd-1', dto, 'user-1', 'qty up');

    expect(posting.postInvoicePositiveStructuralDelta).toHaveBeenCalledTimes(1);
    expect(posting.postInvoiceEdit).not.toHaveBeenCalled();

    const args = posting.postInvoicePositiveStructuralDelta.mock.calls[0][2];
    expect(args.line_deltas).toEqual([
      { variant_id: 'v-1', delta_qty: 1, unit_price: 50, unit_cost: 30 },
    ]);
    expect(args.payment_deltas).toEqual([
      expect.objectContaining({
        payment_method: 'cash',
        delta_amount: 50,
      }),
    ]);

    // Stock delta is for v-1 +1 (not a full reverse + replay).
    const stockInserts = sqlMatches(emCalls, /^\s*INSERT INTO stock_movements\b/i);
    expect(stockInserts.length).toBe(1);
    expect(stockInserts[0].sql).toMatch(/'sale'/);
    expect(stockInserts[0].sql).not.toMatch(/'adjustment'\s*,\s*'in'/);
  });

  function emQueueAddLinePartialPay() {
    return [
      [ORIG_INVOICE_PSD],
      ORIG_ITEMS_PSD,
      ORIG_PAYMENTS_PSD,
      [{ id: 'hist-psd-up' }],
      [
        { id: 'v-2', cost_price: 20, sku: 'SKU-2', product_name: 'منتج 2', color_name: null, size_label: null },
      ],
      [],
      [],
      [],
      [{ ...ORIG_INVOICE_PSD, grand_total: '125.00', paid_amount: '110.00' }],
      [ORIG_ITEMS_PSD[0], { id: 2, variant_id: 'v-2', quantity: 1 }],
      [ORIG_PAYMENTS_PSD[0], { id: 2, payment_method: 'cash', amount: '10.00' }],
      [],
    ];
  }

  it('add line with partial-paid delta: helper receives delta_unpaid > 0 (customer receivable)', async () => {
    const { ds } = makeFakeDs({ emResults: emQueueAddLinePartialPay() });
    const posting = makePostingMockWithPositiveStructural();
    const svc = makeServiceWith(posting, ds);

    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 50, discount: 0 },
        { variant_id: 'v-2', qty: 1, unit_price: 25, discount: 0 },
      ],
      payments: [{ payment_method: 'cash', amount: 110 }],
      discount_total: 0,
    };

    await svc.editInvoice('inv-psd-1', dto, 'user-1', 'add line, partial');

    expect(posting.postInvoicePositiveStructuralDelta).toHaveBeenCalledTimes(1);
    const args = posting.postInvoicePositiveStructuralDelta.mock.calls[0][2];
    expect(args.delta_unpaid).toBe(15);
    expect(args.payment_deltas[0]).toMatchObject({ delta_amount: 10 });
  });

  // Legacy fallback emQueue parametrized on the variant lookup so each
  // Phase 2B-pending test can plug its own resolved variant row.
  function emQueueLegacyForPhase2A(variantRow: any) {
    return [
      [ORIG_INVOICE_PSD],
      ORIG_ITEMS_PSD,
      ORIG_PAYMENTS_PSD,
      [],                                  // INSERT stock_movements (reverse v-1)
      [{ cashbox_id: 'cb-1' }],           // SELECT cashbox lookup
      [{ id: 'hist-legacy' }],             // INSERT history
      [],                                   // DELETE invoice_items
      [],                                   // DELETE invoice_payments
      [variantRow],                         // SELECT product_variants
      [],                                   // INSERT invoice_items
      [],                                   // INSERT stock_movements sale
      [],                                   // INSERT invoice_payments
      [{ ...ORIG_INVOICE_PSD, grand_total: '50.00' }],
      ORIG_ITEMS_PSD,
      ORIG_PAYMENTS_PSD,
      [],
    ];
  }

  it('Phase 2B pending: line removal (variant_removed) falls through to legacy postInvoiceEdit', async () => {
    const { ds } = makeFakeDs({
      emResults: emQueueLegacyForPhase2A({
        id: 'v-other',
        cost_price: 30,
        sku: 'SKU-OTHER',
        product_name: 'منتج آخر',
        color_name: null,
        size_label: null,
      }),
    });
    const posting = makePostingMockWithPositiveStructural();
    const svc = makeServiceWith(posting, ds);

    const dto = {
      lines: [{ variant_id: 'v-other', qty: 1, unit_price: 50 }],
      payments: [{ payment_method: 'cash', amount: 50 }],
      discount_total: 0,
    };

    await svc.editInvoice('inv-psd-1', dto, 'user-1', 'remove all + add other');

    expect(posting.postInvoicePositiveStructuralDelta).not.toHaveBeenCalled();
    expect(posting.postInvoiceEdit).toHaveBeenCalledTimes(1);
  });

  it('Phase 2B pending: qty decrease falls through to legacy postInvoiceEdit', async () => {
    const { ds } = makeFakeDs({
      emResults: emQueueLegacyForPhase2A({
        id: 'v-1',
        cost_price: 30,
        sku: 'SKU-1',
        product_name: 'منتج 1',
        color_name: null,
        size_label: null,
      }),
    });
    const posting = makePostingMockWithPositiveStructural();
    const svc = makeServiceWith(posting, ds);

    const dto = {
      lines: [{ variant_id: 'v-1', qty: 1, unit_price: 50 }],
      payments: [{ payment_method: 'cash', amount: 50 }],
      discount_total: 0,
    };

    await svc.editInvoice('inv-psd-1', dto, 'user-1', 'qty down');

    expect(posting.postInvoicePositiveStructuralDelta).not.toHaveBeenCalled();
    expect(posting.postInvoiceEdit).toHaveBeenCalledTimes(1);
  });

  it('Phase 2B pending: per-line revenue decrease (price down, same qty) falls through to legacy postInvoiceEdit', async () => {
    const { ds } = makeFakeDs({
      emResults: emQueueLegacyForPhase2A({
        id: 'v-1',
        cost_price: 30,
        sku: 'SKU-1',
        product_name: 'منتج 1',
        color_name: null,
        size_label: null,
      }),
    });
    const posting = makePostingMockWithPositiveStructural();
    const svc = makeServiceWith(posting, ds);

    const dto = {
      lines: [{ variant_id: 'v-1', qty: 2, unit_price: 25 }],
      payments: [{ payment_method: 'cash', amount: 50 }],
      discount_total: 0,
    };

    await svc.editInvoice('inv-psd-1', dto, 'user-1', 'reduce price');

    expect(posting.postInvoicePositiveStructuralDelta).not.toHaveBeenCalled();
    expect(posting.postInvoiceEdit).toHaveBeenCalledTimes(1);
  });

  it('Phase 2A helper error bubbles as BadRequestException', async () => {
    const { ds } = makeFakeDs({ emResults: emQueueAddLine() });
    const posting = makePostingMockWithPositiveStructural();
    posting.postInvoicePositiveStructuralDelta.mockResolvedValueOnce({
      error: 'no_gl_code_for_payment_method:bizarro',
    });
    const svc = makeServiceWith(posting, ds);

    const dto = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 50 },
        { variant_id: 'v-2', qty: 1, unit_price: 25 },
      ],
      payments: [{ payment_method: 'cash', amount: 125 }],
      discount_total: 0,
    };

    let thrown: unknown = null;
    try {
      await svc.editInvoice('inv-psd-1', dto, 'user-1', 'forced error');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as Error).message).toContain('no_gl_code_for_payment_method:bizarro');
  });
});
