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

  it('payment_method swap (cash → card_visa): legacy path', async () => {
    const dtoMethodSwap = {
      lines: [{ variant_id: 'v-1', qty: 2, unit_price: 50, discount: 0 }],
      payments: [{ payment_method: 'card_visa', amount: 100 }],
      discount_total: 0,
    };
    const { ds } = makeFakeDs({ emResults: emQueueLegacy() });
    const posting = makePostingMock();
    const svc = makeServiceWith(posting, ds);

    await svc.editInvoice('inv-1', dtoMethodSwap, 'user-1', 'method change');

    expect(posting.postInvoiceEdit).toHaveBeenCalledTimes(1);
    expect(posting.postInvoiceDelta).not.toHaveBeenCalled();
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
