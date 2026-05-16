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

    // postInvoiceDelta called with delta = 0.02
    expect(posting.postInvoiceDelta).toHaveBeenCalledTimes(1);
    expect(posting.postInvoiceDelta).toHaveBeenCalledWith(
      'inv-1',
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
      2000,
      'user-1',
      expect.anything(),
    );
    expect(posting.postInvoiceEdit).not.toHaveBeenCalled();
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

  it('structural edit (qty change): legacy postInvoiceEdit called, no delta posting', async () => {
    const dtoStructural = {
      lines: [{ variant_id: 'v-1', qty: 3, unit_price: 50, discount: 0 }], // qty 2 → 3
      payments: [{ payment_method: 'cash', amount: 150 }],
      discount_total: 0,
    };
    const { ds } = makeFakeDs({ emResults: emQueueLegacy() });
    const posting = makePostingMock();
    const svc = makeServiceWith(posting, ds);

    await svc.editInvoice('inv-1', dtoStructural, 'user-1', 'add unit');

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

  it('GUARD: line-item structural edits (qty change) STILL go through legacy postInvoiceEdit — Phase 2 work', async () => {
    // qty change → classifyInvoiceEdit returns monetary_only=false →
    // classifyPaymentRedistribution returns not_redistribution
    // (qty_changed) → falls through to legacy postInvoiceEdit.
    const dtoQtyChange = {
      lines: [
        { variant_id: 'v-1', qty: 2, unit_price: 350, discount: 0 }, // qty 1→2
        { variant_id: 'v-2', qty: 1, unit_price: 375, discount: 0 },
      ],
      payments: [{ payment_method: 'instapay', amount: 1075, payment_account_id: 'acct-instapay' }],
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
      [{ ...ORIG_INVOICE_RDS, grand_total: '1075.00' }], // [15] UPDATE invoices
      ORIG_ITEMS_RDS,                    // [16] SELECT items after
      ORIG_PAYMENTS_RDS,                 // [17] SELECT payments after
      [],                                // [18] backfill history
    ];
    const { ds } = makeFakeDs({ emResults });
    const posting = makePostingMockWithRedistribution();
    const svc = makeServiceWith(posting, ds);

    await svc.editInvoice('inv-rds-1', dtoQtyChange, 'user-1', 'qty change');

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
