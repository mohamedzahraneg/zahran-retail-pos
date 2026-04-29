/**
 * cash-desk.service.spec.ts — PR-CASH-DESK-REORG-1
 * ────────────────────────────────────────────────────────────────────
 *
 * Backend integration test for the three writes that the post-reorg
 * Customers / Suppliers / CashDesk pages call into:
 *
 *   1. `receiveFromCustomer`  ← Customers page "استلام مقبوضة" button
 *   2. `payToSupplier`        ← Suppliers page "دفع لمورد" button
 *   3. `deposit`              ← CashDesk page treasury action
 *
 * The PR-CASH-DESK-REORG-1 audit established that the backend API
 * surface is unchanged — this spec is the unit-level guard that the
 * payload contract the frontend now sends from the new entry points
 * still produces:
 *
 *   • A canonical INSERT into `customer_payments` / `supplier_payments`
 *     with the columns the trigger cascade reads
 *     (`fn_customer_payment_apply` / `fn_supplier_payment_apply`).
 *   • One INSERT per allocation row when allocations are passed.
 *   • A call to the posting service (`postInvoicePayment` /
 *     `postSupplierPayment`) inside the same transaction so the
 *     balanced JE lands together with the payment row.
 *   • A call to the financial engine's `recordManualAdjustment` for
 *     deposits (the engine writes the JE + cashbox_transaction).
 *
 * The trigger cascade itself is NOT tested here — that's database
 * territory. The DataSource is stubbed so we can assert SQL strings
 * + posting/engine mock calls without touching Postgres.
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { CashDeskService } from './cash-desk.service';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

type QueryCall = { sql: string; params: any[] };

/**
 * Stateful fake DataSource. The service runs writes inside
 * `ds.transaction((em) => …)` so the queries we care about flow
 * through `em.query`. `emResults` is a left-to-right queue of fake
 * rows the service should see; `dsCalls`/`emCalls` records every SQL
 * the service emits so the assertions can match against substrings.
 */
function makeFakeDataSource(emResults: any[][]) {
  const dsCalls: QueryCall[] = [];
  const emCalls: QueryCall[] = [];
  let emIdx = 0;
  const em = {
    query: async (sql: string, params: any[] = []) => {
      emCalls.push({ sql, params });
      const next = emResults[emIdx++];
      return next ?? [];
    },
  };
  const ds: any = {
    query: async (sql: string, params: any[] = []) => {
      dsCalls.push({ sql, params });
      return [];
    },
    transaction: async (cb: (em: any) => Promise<any>) => cb(em),
  };
  return { ds, em, dsCalls, emCalls };
}

describe('CashDeskService — PR-CASH-DESK-REORG-1', () => {
  describe('receiveFromCustomer', () => {
    it('inserts customer_payments with the canonical column tuple + auto-posts the JE', async () => {
      // emResults queue, in source order:
      //   [0] SELECT nextval(seq_customer_payment_no) → seq=42
      //   [1] SELECT warehouse_id FROM cashboxes      → wh-1
      //   [2] INSERT INTO customer_payments RETURNING * → payment row
      const { ds, emCalls } = makeFakeDataSource([
        [{ seq: 42 }],
        [{ warehouse_id: 'wh-1' }],
        [{ id: 'pay-1', payment_no: 'CR-000042' }],
      ]);
      const posting = {
        postInvoicePayment: jest.fn().mockResolvedValue({ entry_id: "je-1" }),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          { provide: AccountingPostingService, useValue: posting },
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      const out = await service.receiveFromCustomer(
        {
          customer_id: 'cust-1',
          cashbox_id: 'cb-1',
          payment_method: 'cash',
          amount: 250,
          kind: 'settle_invoices',
        } as any,
        'user-1',
      );

      // 1. The seq SELECT fires first.
      expect(emCalls[0].sql).toMatch(/seq_customer_payment_no/);
      // 2. The warehouse lookup fires next, scoped to the cashbox.
      expect(emCalls[1].sql).toMatch(/SELECT warehouse_id FROM cashboxes/);
      expect(emCalls[1].params).toEqual(['cb-1']);
      // 3. The INSERT carries every column the trigger reads.
      const insert = emCalls[2];
      expect(insert.sql).toMatch(/INSERT INTO customer_payments/);
      // The column tuple is positional — params order is the contract.
      expect(insert.params).toEqual([
        'CR-000042',          // payment_no  (CR + zero-padded seq)
        'cust-1',             // customer_id
        'cb-1',               // cashbox_id
        'wh-1',               // warehouse_id (NOT NULL on the table)
        'cash',               // payment_method
        250,                  // amount
        'settle_invoices',    // kind
        null,                 // reference
        null,                 // notes
        'user-1',             // received_by
        // PR-FIN-PAYACCT-4C — payment_account_id + snapshot. Both null
        // because this is a cash receipt; the validateAndFreezeAccount
        // helper short-circuits cash to {paymentAccountId:null, snapshot:null}.
        null,                 // payment_account_id
        null,                 // payment_account_snapshot (jsonb, null when no account)
      ]);
      // 4. The posting service is called with the payment id + the
      //    transaction's `em` so the JE lands inside the same tx.
      expect(posting.postInvoicePayment).toHaveBeenCalledTimes(1);
      expect(posting.postInvoicePayment).toHaveBeenCalledWith(
        'pay-1',
        'user-1',
        expect.any(Object),
      );
      // 5. Service returns the inserted row so the controller can
      //    forward the payment_no to the FE.
      expect(out).toEqual({ id: 'pay-1', payment_no: 'CR-000042' });
    });

    it('writes one customer_payment_allocations row per allocation entry', async () => {
      const { ds, emCalls } = makeFakeDataSource([
        [{ seq: 99 }],
        [{ warehouse_id: 'wh-1' }],
        [{ id: 'pay-2' }],
        [{}], // allocation 1 INSERT
        [{}], // allocation 2 INSERT
      ]);
      const posting = {
        postInvoicePayment: jest.fn().mockResolvedValue({ entry_id: "je-1" }),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          { provide: AccountingPostingService, useValue: posting },
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      await service.receiveFromCustomer(
        {
          customer_id: 'cust-1',
          cashbox_id: 'cb-1',
          payment_method: 'cash',
          amount: 300,
          kind: 'settle_invoices',
          allocations: [
            { invoice_id: 'inv-1', amount: 200 },
            { invoice_id: 'inv-2', amount: 100 },
          ],
        } as any,
        'user-1',
      );

      // After the payment INSERT (index 2), there must be exactly two
      // allocation INSERTs in the same transaction.
      const allocCalls = emCalls.filter((c) =>
        /customer_payment_allocations/.test(c.sql),
      );
      expect(allocCalls).toHaveLength(2);
      expect(allocCalls[0].params).toEqual(['pay-2', 'inv-1', 200]);
      expect(allocCalls[1].params).toEqual(['pay-2', 'inv-2', 100]);
    });

    it("PR-FIN-PAYACCT-2: posting failure THROWS so the whole tx rolls back (was: swallowed)", async () => {
      // Pre-PR-FIN-PAYACCT-2 contract pinned the legacy "best-effort"
      // posting: if `posting.postInvoicePayment` rejected, the service
      // discarded the error and returned the payment. That left an
      // orphan customer_payment + cashbox_transactions + customer_ledger
      // row with no journal_entry — silent drift between cashbox and GL.
      //
      // New contract: posting MUST complete or the whole tx rolls back.
      // A rejected posting promise propagates through the
      // `ds.transaction((em) => …)` envelope and surfaces as a
      // BadRequestException to the caller; the trigger-driven side
      // effects roll back with it, so no committed state without a JE.
      //
      // (Note: in production `posting.service.safe()` always RESOLVES,
      // never rejects — it converts errors into `{error}` returns.
      // The legacy test mocked a rejection to exercise the .catch().
      // The new test exercises the same shape the FE would observe if a
      // posting promise ever did reject for any reason.)
      const { ds } = makeFakeDataSource([
        [{ seq: 1 }],
        [{ warehouse_id: 'wh-1' }],
        [{ id: 'pay-3' }],
      ]);
      const posting = {
        postInvoicePayment: jest
          .fn()
          .mockRejectedValue(new Error('GL not seeded')),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          { provide: AccountingPostingService, useValue: posting },
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      await expect(
        service.receiveFromCustomer(
          {
            customer_id: 'cust-1',
            cashbox_id: 'cb-1',
            payment_method: 'cash',
            amount: 50,
            kind: 'refund',
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/GL not seeded/);
    });
  });

  describe('payToSupplier', () => {
    it('inserts supplier_payments with the canonical column tuple + auto-posts the JE', async () => {
      const { ds, emCalls } = makeFakeDataSource([
        [{ seq: 7 }],
        [{ warehouse_id: 'wh-2' }],
        [{ id: 'sp-1', payment_no: 'CP-000007' }],
      ]);
      const posting = {
        postSupplierPayment: jest.fn().mockResolvedValue({ entry_id: "je-1" }),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          { provide: AccountingPostingService, useValue: posting },
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      const out = await service.payToSupplier(
        {
          supplier_id: 'sup-1',
          cashbox_id: 'cb-2',
          payment_method: 'cash',
          amount: 800,
        } as any,
        'user-1',
      );

      expect(emCalls[0].sql).toMatch(/seq_supplier_payment_no/);
      expect(emCalls[1].sql).toMatch(/SELECT warehouse_id FROM cashboxes/);
      expect(emCalls[1].params).toEqual(['cb-2']);
      const insert = emCalls[2];
      expect(insert.sql).toMatch(/INSERT INTO supplier_payments/);
      // Note: supplier_payments has no `kind` column — the param tuple
      // is one shorter than the customer side (paid_by is the trailing
      // user column).
      expect(insert.params).toEqual([
        'CP-000007',          // payment_no  (CP + zero-padded seq)
        'sup-1',              // supplier_id
        'cb-2',               // cashbox_id
        'wh-2',               // warehouse_id
        'cash',               // payment_method
        800,                  // amount
        null,                 // reference
        null,                 // notes
        'user-1',             // paid_by
        // PR-FIN-PAYACCT-4C — payment_account_id + snapshot. Both null
        // because this is a cash payment.
        null,                 // payment_account_id
        null,                 // payment_account_snapshot
      ]);
      expect(posting.postSupplierPayment).toHaveBeenCalledTimes(1);
      expect(posting.postSupplierPayment).toHaveBeenCalledWith(
        'sp-1',
        'user-1',
        expect.any(Object),
      );
      expect(out).toEqual({ id: 'sp-1', payment_no: 'CP-000007' });
    });

    it('writes one supplier_payment_allocations row per allocation entry', async () => {
      const { ds, emCalls } = makeFakeDataSource([
        [{ seq: 50 }],
        [{ warehouse_id: 'wh-1' }],
        [{ id: 'sp-2' }],
        [{}],
        [{}],
      ]);
      const posting = {
        postSupplierPayment: jest.fn().mockResolvedValue({ entry_id: "je-1" }),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          { provide: AccountingPostingService, useValue: posting },
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      await service.payToSupplier(
        {
          supplier_id: 'sup-1',
          cashbox_id: 'cb-1',
          payment_method: 'cash',
          amount: 500,
          allocations: [
            { invoice_id: 'pur-1', amount: 300 },
            { invoice_id: 'pur-2', amount: 200 },
          ],
        } as any,
        'user-1',
      );

      const allocCalls = emCalls.filter((c) =>
        /supplier_payment_allocations/.test(c.sql),
      );
      expect(allocCalls).toHaveLength(2);
      // The supplier-side allocation column is `purchase_id` (the
      // table joins to purchases, not invoices).
      expect(allocCalls[0].sql).toMatch(/purchase_id/);
      expect(allocCalls[0].params).toEqual(['sp-2', 'pur-1', 300]);
      expect(allocCalls[1].params).toEqual(['sp-2', 'pur-2', 200]);
    });
  });

  describe('deposit (treasury opening-balance / withdrawal)', () => {
    it('delegates to FinancialEngineService.recordManualAdjustment with the canonical args', async () => {
      // emResults queue:
      //   [0] SELECT current_balance FOR UPDATE → cashbox row
      //   [1] SELECT gen_random_uuid()         → ref_id
      //   [2] SELECT current_balance (after)   → new balance
      const { ds } = makeFakeDataSource([
        [{ current_balance: 1000 }],
        [{ ref_id: 'ref-1' }],
        [{ current_balance: 1500 }],
      ]);
      const engine = {
        recordManualAdjustment: jest.fn().mockResolvedValue({ ok: true }),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          { provide: FinancialEngineService, useValue: engine },
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      const out = await service.deposit(
        {
          cashbox_id: 'cb-1',
          direction: 'in',
          amount: 500,
          notes: 'إيداع نقدي',
        },
        'user-1',
      );

      expect(engine.recordManualAdjustment).toHaveBeenCalledTimes(1);
      const args = engine.recordManualAdjustment.mock.calls[0][0];
      expect(args).toMatchObject({
        reference_id: 'ref-1',
        cashbox_id: 'cb-1',
        direction: 'in',
        amount: 500,
        user_id: 'user-1',
        notes: 'إيداع نقدي',
      });
      // The `em` is plumbed through so the engine's writes share the
      // outer transaction (atomic with the cashbox lock above).
      expect(args.em).toBeDefined();
      expect(out).toEqual({
        id: 'ref-1',
        cashbox_id: 'cb-1',
        direction: 'in',
        amount: 500,
        new_balance: 1500,
      });
    });

    it('throws when amount is non-positive (zero, negative, missing)', async () => {
      const { ds } = makeFakeDataSource([]);
      const engine = { recordManualAdjustment: jest.fn() };
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          { provide: FinancialEngineService, useValue: engine },
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      for (const bad of [0, -10, undefined as any]) {
        await expect(
          service.deposit(
            { cashbox_id: 'cb-1', direction: 'in', amount: bad },
            'user-1',
          ),
        ).rejects.toThrow(/amount must be positive/);
      }
      // Engine NEVER fires for invalid input — an injection attempt
      // via amount=0 must not write any GL row.
      expect(engine.recordManualAdjustment).not.toHaveBeenCalled();
    });

    it('throws when direction is neither "in" nor "out"', async () => {
      const { ds } = makeFakeDataSource([]);
      const engine = { recordManualAdjustment: jest.fn() };
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          { provide: FinancialEngineService, useValue: engine },
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      await expect(
        service.deposit(
          { cashbox_id: 'cb-1', direction: 'sideways' as any, amount: 100 },
          'user-1',
        ),
      ).rejects.toThrow(/direction must be in or out/);
      expect(engine.recordManualAdjustment).not.toHaveBeenCalled();
    });

    it('propagates engine errors as BadRequestException so the controller returns 400', async () => {
      const { ds } = makeFakeDataSource([
        [{ current_balance: 1000 }],
        [{ ref_id: 'ref-2' }],
      ]);
      const engine = {
        recordManualAdjustment: jest
          .fn()
          .mockResolvedValue({ ok: false, error: 'GL_ACCOUNT_MISSING' }),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          { provide: FinancialEngineService, useValue: engine },
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      await expect(
        service.deposit(
          { cashbox_id: 'cb-1', direction: 'in', amount: 100 },
          'user-1',
        ),
      ).rejects.toThrow(/GL_ACCOUNT_MISSING/);
    });
  });
});

/* ============================================================================
 * PR-FIN-PAYACCT-1 — createCashbox opening-balance semantics
 * ----------------------------------------------------------------------------
 * Pins Option B.1 from the audit:
 *
 *   • opening = 0  → INSERT only, no engine call, no JE/CT, current_balance=0
 *   • opening > 0  → INSERT (current=0, opening_col=0) + engine.recordTransaction
 *                    (ref_type='cashbox_opening', cash_movement category='opening')
 *                    + UPDATE cashboxes SET opening_journal_entry_id, opening_posted_at
 *
 * No double-count: cashboxes.opening_balance column is left at 0 in the new flow
 * so v_cash_position.computed = 0 + Σct(opening) = opening_amount, matching
 * GL 1111 net debit (= opening_amount). Drift = 0. Verified at the SQL level
 * by the integration tests; this unit-level spec verifies the call shapes.
 * ========================================================================== */
describe('CashDeskService.createCashbox — PR-FIN-PAYACCT-1', () => {
  /**
   * Build the canonical emResults queue for createCashbox. Order MUST
   * match the service's actual SQL flow:
   *   [0] INSERT INTO cashboxes RETURNING *  → cashbox row
   *   [1] SELECT existing GL where cashbox_id → empty (forces the link
   *       function to look up parent next)
   *   [2] SELECT parent COA where code='111'  → empty (graceful early
   *       return inside linkOrCreateGLSubAccount — keeps the queue
   *       short for tests that don't care about COA seeding)
   * If opening > 0, the queue continues with:
   *   [3] UPDATE cashboxes (trace columns)    → empty
   *   [4] SELECT * FROM cashboxes WHERE id    → refreshed row
   */
  function buildEmResults(opts: {
    cashbox_id: string;
    refreshed?: any; // only used when opening > 0
  }) {
    const cashbox = {
      id: opts.cashbox_id,
      name_ar: 'الخزينة الرئيسية',
      kind: 'cash',
      current_balance: '0.00',
      opening_balance: '0.00',
      is_active: true,
    };
    const queue: any[][] = [
      [cashbox],   // [0] INSERT cashboxes RETURNING *
      [],          // [1] SELECT existing GL → none
      [],          // [2] SELECT parent COA → none (early return)
    ];
    if (opts.refreshed) {
      queue.push([]);              // [3] UPDATE cashboxes (trace cols)
      queue.push([opts.refreshed]); // [4] re-SELECT for caller
    }
    return queue;
  }

  function withWarehouseSeed(ds: any) {
    // dto.warehouse_id is supplied in tests so the warehouse fallback
    // SELECT (`this.ds.query`) is never hit. The empty array returned
    // from the default `ds.query` mock is therefore irrelevant.
    return ds;
  }

  it('1) opening=0 → INSERT only, no engine call, no JE/CT, current_balance stays 0', async () => {
    const { ds, emCalls } = makeFakeDataSource(
      buildEmResults({ cashbox_id: 'cb-1' }),
    );
    withWarehouseSeed(ds);
    const engine = { recordTransaction: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CashDeskService,
        { provide: DataSource, useValue: ds },
        { provide: FinancialEngineService, useValue: engine },
      ],
    }).compile();
    const service = moduleRef.get(CashDeskService);

    const out = await service.createCashbox(
      {
        name_ar: 'الخزينة الرئيسية',
        kind: 'cash',
        warehouse_id: 'wh-1',
        opening_balance: 0,
      } as any,
      'user-1',
    );

    // 1a. INSERT happened with current_balance=0, opening_balance=0
    //     (the literal `0,0` in the VALUES clause — NOT $18,$18).
    const insert = emCalls.find((c) => /INSERT INTO cashboxes/.test(c.sql))!;
    expect(insert).toBeDefined();
    expect(insert.sql).toMatch(/current_balance,\s*opening_balance,\s*\n?\s*is_active\)/);
    // The new INSERT does NOT carry an $18 placeholder for opening — the
    // values are literal 0,0 in the SQL.
    expect(insert.sql).toMatch(/VALUES\s*\([^)]*,0,0,TRUE\)/);
    expect(insert.params).not.toContain(0); // params end before the literal zeros

    // 1b. Engine NEVER called.
    expect(engine.recordTransaction).not.toHaveBeenCalled();

    // 1c. No UPDATE on cashboxes (no trace columns to backfill).
    const updateCalls = emCalls.filter((c) => /UPDATE cashboxes/.test(c.sql));
    expect(updateCalls).toHaveLength(0);

    // 1d. Returned row carries current_balance=0.
    expect(out.current_balance).toBe('0.00');
    expect(out.opening_balance).toBe('0.00');
  });

  it('2) opening=1000 → engine.recordTransaction called with the canonical opening spec', async () => {
    const { ds, emCalls } = makeFakeDataSource(
      buildEmResults({
        cashbox_id: 'cb-2',
        refreshed: {
          id: 'cb-2',
          name_ar: 'بنك الأهلي',
          kind: 'bank',
          // After the engine returns, fn_record_cashbox_txn has lifted
          // current_balance from 0 to 1000. opening_balance column STAYS
          // at 0 — the value lives in the CT/JE ledger now.
          current_balance: '1000.00',
          opening_balance: '0.00',
          opening_journal_entry_id: 'je-1',
          opening_posted_at: '2026-04-29T10:00:00.000Z',
          is_active: true,
        },
      }),
    );
    const engine = {
      recordTransaction: jest.fn().mockResolvedValue({
        ok: true,
        entry_id: 'je-1',
        entry_no: 'JE-2026-000001',
        cash_txn_ids: [42],
      }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CashDeskService,
        { provide: DataSource, useValue: ds },
        { provide: FinancialEngineService, useValue: engine },
      ],
    }).compile();
    const service = moduleRef.get(CashDeskService);

    const out = await service.createCashbox(
      {
        name_ar: 'بنك الأهلي',
        kind: 'bank',
        institution_code: 'nbe',
        warehouse_id: 'wh-1',
        opening_balance: 1000,
      } as any,
      'user-1',
    );

    // 2a. Engine called exactly once with the canonical opening spec.
    expect(engine.recordTransaction).toHaveBeenCalledTimes(1);
    const spec = engine.recordTransaction.mock.calls[0][0];
    expect(spec).toMatchObject({
      kind: 'opening_balance',
      reference_type: 'cashbox_opening',
      reference_id: 'cb-2',
      user_id: 'user-1',
    });

    // 2b. GL legs balanced: DR cashbox 1000 / CR 31 1000.
    expect(spec.gl_lines).toHaveLength(2);
    const dr = spec.gl_lines.find((l: any) => l.debit > 0);
    const cr = spec.gl_lines.find((l: any) => l.credit > 0);
    expect(dr).toMatchObject({
      resolve_from_cashbox_id: 'cb-2',
      cashbox_id: 'cb-2',
      debit: 1000,
    });
    expect(cr).toMatchObject({ account_code: '31', credit: 1000 });

    // 2c. Cash movement carries category='opening' on the dest cashbox.
    expect(spec.cash_movements).toHaveLength(1);
    expect(spec.cash_movements[0]).toMatchObject({
      cashbox_id: 'cb-2',
      direction: 'in',
      amount: 1000,
      category: 'opening',
    });

    // 2d. Transaction's em was threaded through.
    expect(spec.em).toBeDefined();

    // 2e. UPDATE cashboxes set the trace columns with je-1.
    const update = emCalls.find((c) => /UPDATE cashboxes/.test(c.sql))!;
    expect(update).toBeDefined();
    expect(update.sql).toMatch(/opening_journal_entry_id\s*=\s*\$2/);
    expect(update.sql).toMatch(/opening_posted_at\s*=\s*NOW\(\)/);
    expect(update.params).toEqual(['cb-2', 'je-1']);

    // 2f. Returned row reflects engine-driven current_balance.
    expect(out.current_balance).toBe('1000.00');
    expect(out.opening_balance).toBe('0.00'); // intentionally NOT stored
    expect(out.opening_journal_entry_id).toBe('je-1');
  });

  it('3) opening=1000 → exactly ONE CT row (category=opening) and ONE JE (ref=cashbox_opening)', async () => {
    // The CT row + JE are written by the engine, not by the service. We
    // assert the SHAPE of what the engine receives — the engine's own
    // contract (`recordTransaction` writes 1 JE with the spec.reference_*
    // and 1 CT row per cash_movements entry) is covered by the engine's
    // own spec. Combined, this proves "exactly one of each" from
    // createCashbox's perspective.
    const { ds } = makeFakeDataSource(
      buildEmResults({
        cashbox_id: 'cb-3',
        refreshed: { id: 'cb-3', current_balance: '500.00' },
      }),
    );
    const engine = {
      recordTransaction: jest
        .fn()
        .mockResolvedValue({ ok: true, entry_id: 'je-3' }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CashDeskService,
        { provide: DataSource, useValue: ds },
        { provide: FinancialEngineService, useValue: engine },
      ],
    }).compile();
    const service = moduleRef.get(CashDeskService);

    await service.createCashbox(
      {
        name_ar: 'الخزينة',
        kind: 'cash',
        warehouse_id: 'wh-1',
        opening_balance: 500,
      } as any,
      'user-1',
    );

    // The engine call MUST be a single envelope (one JE, one CT).
    const spec = engine.recordTransaction.mock.calls[0][0];
    expect(spec.gl_lines).toHaveLength(2);          // 2 GL legs = 1 JE
    expect(spec.cash_movements).toHaveLength(1);    // 1 cash movement = 1 CT
    expect(spec.cash_movements[0].category).toBe('opening');
    expect(spec.reference_type).toBe('cashbox_opening');
  });

  it('4) v_cash_position drift stays 0 — opening_balance column is NOT set verbatim', async () => {
    // The new flow's invariant: cashboxes.opening_balance column is
    // ALWAYS 0 at INSERT, regardless of the user-supplied opening
    // amount. v_cash_position.computed = opening + Σct = 0 + opening
    // (via the engine's CT row), and current_balance = 0 + opening
    // (via fn_record_cashbox_txn's UPDATE). drift = 0.
    const { ds, emCalls } = makeFakeDataSource(
      buildEmResults({
        cashbox_id: 'cb-4',
        refreshed: { id: 'cb-4' },
      }),
    );
    const engine = {
      recordTransaction: jest
        .fn()
        .mockResolvedValue({ ok: true, entry_id: 'je-4' }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CashDeskService,
        { provide: DataSource, useValue: ds },
        { provide: FinancialEngineService, useValue: engine },
      ],
    }).compile();
    const service = moduleRef.get(CashDeskService);

    await service.createCashbox(
      {
        name_ar: 'بنك',
        kind: 'bank',
        institution_code: 'cib',
        warehouse_id: 'wh-1',
        opening_balance: 7777,
      } as any,
      'user-1',
    );

    const insert = emCalls.find((c) => /INSERT INTO cashboxes/.test(c.sql))!;
    // The literal `0,0` (current_balance, opening_balance) is the proof
    // that the user-supplied 7777 was NOT written into either column at
    // INSERT time. The number lives in the CT row + GL JE only.
    expect(insert.sql).toMatch(/VALUES\s*\([^)]*,0,0,TRUE\)/);
    // 7777 must NOT appear in the INSERT params either.
    expect(insert.params).not.toContain(7777);
  });

  it('5) idempotent replay: engine returns skipped → no double JE/CT, no double UPDATE', async () => {
    // The engine's contract is: a replay against the same
    // (reference_type, reference_id) returns
    // {ok:true, skipped:true, entry_id, reason:'idempotent-replay'}.
    // Migration 119's partial unique index promotes this to a DB
    // constraint. The service MUST handle the skipped path the same
    // way as the first call — only the trace-column UPDATE distinction
    // changes (since the JE already existed before this call, the
    // UPDATE would re-write the same entry_id, which is harmless).
    const { ds, emCalls } = makeFakeDataSource(
      buildEmResults({
        cashbox_id: 'cb-5',
        refreshed: { id: 'cb-5', current_balance: '1500.00' },
      }),
    );
    const engine = {
      recordTransaction: jest.fn().mockResolvedValue({
        ok: true,
        skipped: true,
        entry_id: 'je-existing',
        reason: 'idempotent-replay',
      }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CashDeskService,
        { provide: DataSource, useValue: ds },
        { provide: FinancialEngineService, useValue: engine },
      ],
    }).compile();
    const service = moduleRef.get(CashDeskService);

    await service.createCashbox(
      {
        name_ar: 'الخزينة',
        kind: 'cash',
        warehouse_id: 'wh-1',
        opening_balance: 1500,
      } as any,
      'user-1',
    );

    // Engine called once (the service does not retry on its own).
    expect(engine.recordTransaction).toHaveBeenCalledTimes(1);
    // The skipped path does NOT trigger a second engine call.
    // (current_balance is incremented at most once because
    // `fn_record_cashbox_txn` is invoked at most once per JE entry.)
    const updateCalls = emCalls.filter((c) => /UPDATE cashboxes/.test(c.sql));
    expect(updateCalls).toHaveLength(1); // just the trace columns
  });

  it('6) engine_bypass_alerts contract: NO direct cashboxes.current_balance UPDATE', async () => {
    // Cross-check: the service must never UPDATE cashboxes.current_balance
    // outside the engine. If we ever regressed, the safety greps in CI
    // would catch it; this unit test pins the invariant at the call-shape
    // layer.
    const { ds, emCalls } = makeFakeDataSource(
      buildEmResults({
        cashbox_id: 'cb-6',
        refreshed: { id: 'cb-6' },
      }),
    );
    const engine = {
      recordTransaction: jest
        .fn()
        .mockResolvedValue({ ok: true, entry_id: 'je-6' }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CashDeskService,
        { provide: DataSource, useValue: ds },
        { provide: FinancialEngineService, useValue: engine },
      ],
    }).compile();
    const service = moduleRef.get(CashDeskService);

    await service.createCashbox(
      {
        name_ar: 'محفظة WE',
        kind: 'ewallet',
        institution_code: 'we_pay',
        warehouse_id: 'wh-1',
        opening_balance: 250,
      } as any,
      'user-1',
    );

    // No UPDATE of `current_balance` from the service. Only the trace
    // UPDATE which never touches that column.
    const balanceUpdates = emCalls.filter((c) =>
      /UPDATE cashboxes[\s\S]*current_balance\s*=/.test(c.sql),
    );
    expect(balanceUpdates).toHaveLength(0);
  });

  it('7) frontend-style payload still accepted: opening_balance field reinterpreted as funding amount', async () => {
    // The FE form (Cashboxes.tsx) keeps sending `{opening_balance: N}`.
    // The new contract: backend accepts the same field but routes it
    // through the engine instead of dropping it into the column. This
    // test pins that contract — same DTO shape, new semantics.
    const { ds } = makeFakeDataSource(
      buildEmResults({
        cashbox_id: 'cb-7',
        refreshed: {
          id: 'cb-7',
          current_balance: '300.00',
          opening_balance: '0.00',
        },
      }),
    );
    const engine = {
      recordTransaction: jest
        .fn()
        .mockResolvedValue({ ok: true, entry_id: 'je-7' }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CashDeskService,
        { provide: DataSource, useValue: ds },
        { provide: FinancialEngineService, useValue: engine },
      ],
    }).compile();
    const service = moduleRef.get(CashDeskService);

    // Mimic the FE payload exactly.
    const out = await service.createCashbox(
      {
        name_ar: 'الخزينة',
        kind: 'cash',
        warehouse_id: 'wh-1',
        currency: 'EGP',
        opening_balance: 300, // <-- this is what the FE sends today
      } as any,
      'user-1',
    );

    // Engine got the 300 as the funding amount.
    const spec = engine.recordTransaction.mock.calls[0][0];
    expect(spec.gl_lines[0].debit).toBe(300);
    expect(spec.cash_movements[0].amount).toBe(300);

    // The stored `opening_balance` column stays at 0 (no double-count).
    expect(out.opening_balance).toBe('0.00');
    // The stored `current_balance` reflects the engine-driven movement.
    expect(out.current_balance).toBe('300.00');
  });

  it('8) negative opening rejected (defensive)', async () => {
    const { ds } = makeFakeDataSource([]);
    const engine = { recordTransaction: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CashDeskService,
        { provide: DataSource, useValue: ds },
        { provide: FinancialEngineService, useValue: engine },
      ],
    }).compile();
    const service = moduleRef.get(CashDeskService);

    await expect(
      service.createCashbox(
        {
          name_ar: 'X',
          kind: 'cash',
          warehouse_id: 'wh-1',
          opening_balance: -50,
        } as any,
        'user-1',
      ),
    ).rejects.toThrow(/سالب/);
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });

  it('9) opening>0 with engine missing (no engine wired) is rejected up front', async () => {
    const { ds } = makeFakeDataSource([]);
    // No FinancialEngineService provider — emulates a legacy setup
    // where the engine module wasn't registered.
    const moduleRef = await Test.createTestingModule({
      providers: [
        CashDeskService,
        { provide: DataSource, useValue: ds },
      ],
    }).compile();
    const service = moduleRef.get(CashDeskService);

    await expect(
      service.createCashbox(
        {
          name_ar: 'X',
          kind: 'cash',
          warehouse_id: 'wh-1',
          opening_balance: 100,
        } as any,
        'user-1',
      ),
    ).rejects.toThrow(/المحرك المحاسبي/);
  });

  it('10) engine returns ok:false → BadRequestException rolls back the whole transaction', async () => {
    // If the engine returns {ok:false, error}, the service must throw
    // so the outer `ds.transaction` rolls back the cashbox INSERT (and
    // the GL sub-account if any). We assert the throw + the post-
    // rollback contract that the trace UPDATE was never issued.
    const { ds, emCalls } = makeFakeDataSource(
      buildEmResults({ cashbox_id: 'cb-rb' }),
    );
    const engine = {
      recordTransaction: jest
        .fn()
        .mockResolvedValue({ ok: false, error: 'GL_ACCOUNT_31_MISSING' }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CashDeskService,
        { provide: DataSource, useValue: ds },
        { provide: FinancialEngineService, useValue: engine },
      ],
    }).compile();
    const service = moduleRef.get(CashDeskService);

    await expect(
      service.createCashbox(
        {
          name_ar: 'X',
          kind: 'cash',
          warehouse_id: 'wh-1',
          opening_balance: 100,
        } as any,
        'user-1',
      ),
    ).rejects.toThrow(/GL_ACCOUNT_31_MISSING/);

    // No trace UPDATE landed.
    expect(
      emCalls.some((c) => /UPDATE cashboxes/.test(c.sql)),
    ).toBe(false);
  });
});

/* ============================================================================
 * PR-FIN-PAYACCT-2 — customer/supplier payment posting hardening
 * ----------------------------------------------------------------------------
 * Pins the new atomic-posting contract:
 *
 *   • posting MUST be wired (this.posting non-null) — else throw up front.
 *   • posting return `null`           → throw BadRequestException (Arabic).
 *   • posting return `{error}`        → throw BadRequestException carrying
 *                                       the underlying error message.
 *   • posting return `{skipped:true}` → success (idempotent replay).
 *   • posting return `{entry_id}`     → success.
 *
 * The pre-merge contract was a `.catch(() => undefined)` silent swallow
 * paired with a no-result-inspection caller — so any posting failure
 * left an orphan `customer_payments` / `supplier_payments` row with no
 * GL leg. Production has 0 orphans today (audit verified) because there
 * are 0 historical payments; the hardening lands BEFORE the new
 * Customers/Suppliers-page buttons get real production usage.
 *
 * The legacy `swallows posting errors so a missing JE doesn't roll back
 * the payment` test (was at line 182 of this file) has been flipped to
 * pin the new throw-on-failure contract.
 * ========================================================================== */
describe('CashDeskService.{receiveFromCustomer,payToSupplier} — PR-FIN-PAYACCT-2 atomic posting', () => {
  describe('receiveFromCustomer', () => {
    it('1) success: posting returns {entry_id} → service returns the payment row', async () => {
      const { ds } = makeFakeDataSource([
        [{ seq: 1 }],
        [{ warehouse_id: 'wh-1' }],
        [{ id: 'pay-ok', payment_no: 'CR-000001' }],
      ]);
      const posting = {
        postInvoicePayment: jest.fn().mockResolvedValue({ entry_id: 'je-ok' }),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          { provide: AccountingPostingService, useValue: posting },
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      const out = await service.receiveFromCustomer(
        {
          customer_id: 'cust-1',
          cashbox_id: 'cb-1',
          payment_method: 'cash',
          amount: 100,
          kind: 'refund',
        } as any,
        'user-1',
      );
      expect(out).toEqual({ id: 'pay-ok', payment_no: 'CR-000001' });
      expect(posting.postInvoicePayment).toHaveBeenCalledWith(
        'pay-ok',
        'user-1',
        expect.any(Object),
      );
    });

    it('2) posting returns null → BadRequestException, Arabic message about COA, tx rolls back', async () => {
      const { ds } = makeFakeDataSource([
        [{ seq: 2 }],
        [{ warehouse_id: 'wh-1' }],
        [{ id: 'pay-null' }],
      ]);
      const posting = {
        postInvoicePayment: jest.fn().mockResolvedValue(null),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          { provide: AccountingPostingService, useValue: posting },
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      // The Arabic message must surface both the failure phrase AND
      // the COA codes the operator can act on (1111/1121/212). One
      // call → two substrings → both must be present in the error.
      let captured: any;
      try {
        await service.receiveFromCustomer(
          {
            customer_id: 'cust-1',
            cashbox_id: 'cb-1',
            payment_method: 'cash',
            amount: 100,
            kind: 'refund',
          } as any,
          'user-1',
        );
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeDefined();
      expect(captured.message).toMatch(/فشل ترحيل المقبوضة محاسبياً/);
      expect(captured.message).toMatch(/1111\/1121\/212/);
    });

    it('3) posting returns {error} → BadRequestException carries the underlying error', async () => {
      const { ds } = makeFakeDataSource([
        [{ seq: 3 }],
        [{ warehouse_id: 'wh-1' }],
        [{ id: 'pay-err' }],
      ]);
      const posting = {
        postInvoicePayment: jest
          .fn()
          .mockResolvedValue({ error: 'engine_lockdown_engaged' }),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          { provide: AccountingPostingService, useValue: posting },
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      await expect(
        service.receiveFromCustomer(
          {
            customer_id: 'cust-1',
            cashbox_id: 'cb-1',
            payment_method: 'cash',
            amount: 100,
            kind: 'refund',
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/engine_lockdown_engaged/);
    });

    it('4) posting returns {skipped:true} → idempotent success, payment returned, no throw', async () => {
      const { ds } = makeFakeDataSource([
        [{ seq: 4 }],
        [{ warehouse_id: 'wh-1' }],
        [{ id: 'pay-skip', payment_no: 'CR-000004' }],
      ]);
      const posting = {
        postInvoicePayment: jest
          .fn()
          .mockResolvedValue({ skipped: true, entry_id: 'je-existing' }),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          { provide: AccountingPostingService, useValue: posting },
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      const out = await service.receiveFromCustomer(
        {
          customer_id: 'cust-1',
          cashbox_id: 'cb-1',
          payment_method: 'cash',
          amount: 100,
          kind: 'refund',
        } as any,
        'user-1',
      );
      // Skipped is success — the engine's idempotency caught the replay
      // and the existing JE is reused.
      expect(out).toEqual({ id: 'pay-skip', payment_no: 'CR-000004' });
    });

    it('5) posting service unavailable (this.posting === undefined) → BadRequestException up front', async () => {
      const { ds, emCalls } = makeFakeDataSource([]);
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          // Deliberately NO AccountingPostingService provider — emulates
          // a misconfigured module wiring.
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      await expect(
        service.receiveFromCustomer(
          {
            customer_id: 'cust-1',
            cashbox_id: 'cb-1',
            payment_method: 'cash',
            amount: 100,
            kind: 'refund',
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/خدمة الترحيل المحاسبي غير متاحة/);
      // The throw must happen BEFORE the transaction opens — no INSERT
      // into customer_payments was attempted.
      expect(
        emCalls.some((c) => /INSERT INTO customer_payments/.test(c.sql)),
      ).toBe(false);
    });
  });

  describe('payToSupplier', () => {
    it('6) success: posting returns {entry_id} → service returns the payment row', async () => {
      const { ds } = makeFakeDataSource([
        [{ seq: 1 }],
        [{ warehouse_id: 'wh-1' }],
        [{ id: 'sp-ok', payment_no: 'CP-000001' }],
      ]);
      const posting = {
        postSupplierPayment: jest.fn().mockResolvedValue({ entry_id: 'je-sup' }),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          { provide: AccountingPostingService, useValue: posting },
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      const out = await service.payToSupplier(
        {
          supplier_id: 'sup-1',
          cashbox_id: 'cb-1',
          payment_method: 'cash',
          amount: 200,
        } as any,
        'user-1',
      );
      expect(out).toEqual({ id: 'sp-ok', payment_no: 'CP-000001' });
    });

    it('7) posting returns null → BadRequestException, Arabic message about COA (1111/211)', async () => {
      const { ds } = makeFakeDataSource([
        [{ seq: 2 }],
        [{ warehouse_id: 'wh-1' }],
        [{ id: 'sp-null' }],
      ]);
      const posting = {
        postSupplierPayment: jest.fn().mockResolvedValue(null),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          { provide: AccountingPostingService, useValue: posting },
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      // One call → two substrings, mirror of the customer test above.
      let captured: any;
      try {
        await service.payToSupplier(
          {
            supplier_id: 'sup-1',
            cashbox_id: 'cb-1',
            payment_method: 'cash',
            amount: 200,
          } as any,
          'user-1',
        );
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeDefined();
      expect(captured.message).toMatch(/فشل ترحيل الدفعة محاسبياً/);
      expect(captured.message).toMatch(/1111\/211/);
    });

    it('8) posting returns {error} → BadRequestException carries the underlying error', async () => {
      const { ds } = makeFakeDataSource([
        [{ seq: 3 }],
        [{ warehouse_id: 'wh-1' }],
        [{ id: 'sp-err' }],
      ]);
      const posting = {
        postSupplierPayment: jest
          .fn()
          .mockResolvedValue({ error: 'COA_211_INACTIVE' }),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          { provide: AccountingPostingService, useValue: posting },
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      await expect(
        service.payToSupplier(
          {
            supplier_id: 'sup-1',
            cashbox_id: 'cb-1',
            payment_method: 'cash',
            amount: 200,
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/COA_211_INACTIVE/);
    });

    it('9) posting returns {skipped:true} → idempotent success, payment returned, no throw', async () => {
      const { ds } = makeFakeDataSource([
        [{ seq: 4 }],
        [{ warehouse_id: 'wh-1' }],
        [{ id: 'sp-skip', payment_no: 'CP-000004' }],
      ]);
      const posting = {
        postSupplierPayment: jest
          .fn()
          .mockResolvedValue({ skipped: true, entry_id: 'je-existing-sup' }),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          { provide: AccountingPostingService, useValue: posting },
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      const out = await service.payToSupplier(
        {
          supplier_id: 'sup-1',
          cashbox_id: 'cb-1',
          payment_method: 'cash',
          amount: 200,
        } as any,
        'user-1',
      );
      expect(out).toEqual({ id: 'sp-skip', payment_no: 'CP-000004' });
    });

    it('10) posting service unavailable → BadRequestException up front, no INSERT attempted', async () => {
      const { ds, emCalls } = makeFakeDataSource([]);
      const moduleRef = await Test.createTestingModule({
        providers: [
          CashDeskService,
          { provide: DataSource, useValue: ds },
          // Deliberately NO AccountingPostingService provider.
        ],
      }).compile();
      const service = moduleRef.get(CashDeskService);

      await expect(
        service.payToSupplier(
          {
            supplier_id: 'sup-1',
            cashbox_id: 'cb-1',
            payment_method: 'cash',
            amount: 200,
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/خدمة الترحيل المحاسبي غير متاحة/);
      expect(
        emCalls.some((c) => /INSERT INTO supplier_payments/.test(c.sql)),
      ).toBe(false);
    });
  });
});

/* ============================================================================
 * PR-FIN-PAYACCT-4C — payment_account_id + snapshot freezing
 * ----------------------------------------------------------------------------
 * Pins the new contract for both `receiveFromCustomer` and `payToSupplier`:
 *
 *   • cash + payment_account_id → BadRequestException (Arabic)
 *   • non-cash + active accounts exist + missing payment_account_id
 *       → BadRequestException
 *   • non-cash + valid payment_account_id
 *       → INSERT carries (paymentAccountId, snapshot-as-JSONB-string)
 *       → snapshot fields = display_name, provider_key, identifier,
 *                            gl_account_code, cashbox_id, logo_data_url
 *   • non-cash + zero active accounts
 *       → legacy fallback (paymentAccountId=null, snapshot=null) so
 *         fresh installs without payment_accounts seeded keep working
 *   • mismatched method (account.method ≠ dto.payment_method)
 *       → BadRequestException
 * ========================================================================== */
describe('CashDeskService — PR-FIN-PAYACCT-4C payment_account_id + snapshot', () => {
  // Build a fake DataSource that also returns canned results for the
  // active-accounts SELECT inside validateAndFreezeAccount + the
  // sequence/warehouse SELECTs the receive/pay flow runs.
  function buildFakes(opts: {
    /** Result for `SELECT id FROM payment_accounts WHERE method=$1 AND active`. */
    activeAccountsForMethod?: any[];
    /** Result returned by paymentsService.resolveForPosting (mocked separately). */
    resolveResult?: any;
  }) {
    const emCalls: { sql: string; params: any[] }[] = [];
    let seq = 0;
    const em = {
      query: async (sql: string, params: any[] = []) => {
        emCalls.push({ sql, params });
        // Sequence
        if (/seq_(customer|supplier)_payment_no/.test(sql)) {
          return [{ seq: ++seq }];
        }
        // Warehouse for the cashbox
        if (/SELECT warehouse_id FROM cashboxes/.test(sql)) {
          return [{ warehouse_id: 'wh-1' }];
        }
        // PR-FIN-PAYACCT-4C — active accounts probe
        if (
          /SELECT id::text AS id FROM payment_accounts/.test(sql) &&
          /active = TRUE/.test(sql)
        ) {
          return opts.activeAccountsForMethod ?? [];
        }
        // INSERT customer_payments / supplier_payments
        if (/INSERT INTO customer_payments/.test(sql)) {
          return [{ id: 'cp-x', payment_no: 'CR-000001' }];
        }
        if (/INSERT INTO supplier_payments/.test(sql)) {
          return [{ id: 'sp-x', payment_no: 'CP-000001' }];
        }
        return [];
      },
    };
    const ds: any = {
      query: async () => [],
      transaction: async (cb: (em: any) => Promise<any>) => cb(em),
    };
    const posting = {
      postInvoicePayment: jest.fn().mockResolvedValue({ entry_id: 'je-1' }),
      postSupplierPayment: jest.fn().mockResolvedValue({ entry_id: 'je-1' }),
    };
    const payments = {
      resolveForPosting: jest.fn().mockResolvedValue(opts.resolveResult ?? null),
    };
    return { ds, em, emCalls, posting, payments };
  }

  async function makeService({
    posting,
    payments,
    ds,
  }: {
    posting: any;
    payments: any;
    ds: any;
  }): Promise<CashDeskService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        CashDeskService,
        { provide: DataSource, useValue: ds },
        { provide: AccountingPostingService, useValue: posting },
        { provide: 'PaymentsService', useValue: payments },
      ],
    }).compile();
    // PaymentsService is injected by class token in production. The
    // CashDeskService uses `@Optional() PaymentsService`, so we must
    // provide it under the actual class. Use .overrideProvider via
    // useFactory if needed; for this test the simpler approach is to
    // inject manually after the fact.
    const service = moduleRef.get(CashDeskService);
    // The constructor's @Optional payments slot didn't bind through
    // the string token above, so attach the mock directly. (Tests in
    // the same file already use this pattern for `posting`.)
    (service as any).payments = payments;
    return service;
  }

  describe('receiveFromCustomer', () => {
    it('cash + payment_account_id → rejects with Arabic message', async () => {
      const fakes = buildFakes({});
      const service = await makeService(fakes);

      await expect(
        service.receiveFromCustomer(
          {
            customer_id: 'c1',
            cashbox_id: 'cb-1',
            payment_method: 'cash',
            amount: 50,
            payment_account_id: 'pa-1',
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/لا يمكن إرفاق حساب دفع مع طريقة "نقدي"/);
    });

    it('non-cash + active accounts exist + missing payment_account_id → rejects', async () => {
      const fakes = buildFakes({
        activeAccountsForMethod: [{ id: 'pa-default' }],
      });
      const service = await makeService(fakes);

      await expect(
        service.receiveFromCustomer(
          {
            customer_id: 'c1',
            cashbox_id: 'cb-1',
            payment_method: 'instapay',
            amount: 50,
            // payment_account_id intentionally omitted
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/تتطلب اختيار حساب الدفع/);
    });

    it('non-cash + valid payment_account_id → INSERT carries snapshot JSON + paymentAccountId', async () => {
      const fakes = buildFakes({
        activeAccountsForMethod: [{ id: 'pa-1' }],
        resolveResult: {
          id: 'pa-1',
          method: 'instapay',
          display_name: 'InstaPay',
          provider_key: 'instapay',
          identifier: '0100…',
          gl_account_code: '1114',
          cashbox_id: null,
          metadata: { logo_data_url: 'data:image/png;base64,abc' },
        },
      });
      const service = await makeService(fakes);

      await service.receiveFromCustomer(
        {
          customer_id: 'c1',
          cashbox_id: 'cb-1',
          payment_method: 'instapay',
          amount: 50,
          kind: 'settle_invoices',
          payment_account_id: 'pa-1',
        } as any,
        'user-1',
      );

      const insert = fakes.emCalls.find((c) =>
        /INSERT INTO customer_payments/.test(c.sql),
      )!;
      expect(insert).toBeDefined();
      const lastParams = insert.params.slice(-2);
      // [paymentAccountId, snapshot-JSON-string]
      expect(lastParams[0]).toBe('pa-1');
      expect(typeof lastParams[1]).toBe('string');
      const parsed = JSON.parse(lastParams[1] as string);
      expect(parsed).toEqual({
        display_name: 'InstaPay',
        provider_key: 'instapay',
        identifier: '0100…',
        gl_account_code: '1114',
        cashbox_id: null,
        logo_data_url: 'data:image/png;base64,abc',
      });
    });

    it('non-cash + zero active accounts → legacy fallback (paymentAccountId=null, snapshot=null)', async () => {
      const fakes = buildFakes({ activeAccountsForMethod: [] });
      const service = await makeService(fakes);

      await service.receiveFromCustomer(
        {
          customer_id: 'c1',
          cashbox_id: 'cb-1',
          payment_method: 'instapay',
          amount: 25,
        } as any,
        'user-1',
      );
      const insert = fakes.emCalls.find((c) =>
        /INSERT INTO customer_payments/.test(c.sql),
      )!;
      const lastParams = insert.params.slice(-2);
      expect(lastParams).toEqual([null, null]);
    });

    it('non-cash + valid payment_account_id of MISMATCHED method → rejects', async () => {
      const fakes = buildFakes({
        activeAccountsForMethod: [{ id: 'pa-card' }],
        resolveResult: {
          id: 'pa-card',
          method: 'card_visa',  // mismatched: dto says 'instapay'
          display_name: 'POS Visa',
          provider_key: 'pos_terminal',
          identifier: 'TERM-001',
          gl_account_code: '1113',
          cashbox_id: null,
          metadata: {},
        },
      });
      const service = await makeService(fakes);

      await expect(
        service.receiveFromCustomer(
          {
            customer_id: 'c1',
            cashbox_id: 'cb-1',
            payment_method: 'instapay',
            amount: 50,
            payment_account_id: 'pa-card',
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/طريقته "card_visa".*"instapay"/);
    });
  });

  describe('payToSupplier', () => {
    it('cash + payment_account_id → rejects with Arabic message', async () => {
      const fakes = buildFakes({});
      const service = await makeService(fakes);

      await expect(
        service.payToSupplier(
          {
            supplier_id: 's1',
            cashbox_id: 'cb-1',
            payment_method: 'cash',
            amount: 50,
            payment_account_id: 'pa-1',
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/لا يمكن إرفاق حساب دفع مع طريقة "نقدي"/);
    });

    it('non-cash + valid payment_account_id → INSERT carries snapshot + paymentAccountId', async () => {
      const fakes = buildFakes({
        activeAccountsForMethod: [{ id: 'pa-w' }],
        resolveResult: {
          id: 'pa-w',
          method: 'wallet',
          display_name: 'WE Pay',
          provider_key: 'we_pay',
          identifier: '0100123',
          gl_account_code: '1114',
          cashbox_id: 'cb-w-1',  // pinned cashbox
          metadata: {},
        },
      });
      const service = await makeService(fakes);

      await service.payToSupplier(
        {
          supplier_id: 's1',
          cashbox_id: 'cb-1',
          payment_method: 'wallet',
          amount: 100,
          payment_account_id: 'pa-w',
        } as any,
        'user-1',
      );

      const insert = fakes.emCalls.find((c) =>
        /INSERT INTO supplier_payments/.test(c.sql),
      )!;
      const lastParams = insert.params.slice(-2);
      expect(lastParams[0]).toBe('pa-w');
      const parsed = JSON.parse(lastParams[1] as string);
      expect(parsed.gl_account_code).toBe('1114');
      expect(parsed.cashbox_id).toBe('cb-w-1');
      expect(parsed.display_name).toBe('WE Pay');
    });

    it('non-cash + active accounts exist + missing payment_account_id → rejects', async () => {
      const fakes = buildFakes({
        activeAccountsForMethod: [{ id: 'pa-default' }],
      });
      const service = await makeService(fakes);

      await expect(
        service.payToSupplier(
          {
            supplier_id: 's1',
            cashbox_id: 'cb-1',
            payment_method: 'wallet',
            amount: 100,
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/تتطلب اختيار حساب الدفع/);
    });
  });
});

/* ============================================================================
 * PR-FIN-PAYACCT-4B — getGlDrift exposes v_cashbox_gl_drift
 * ========================================================================== */
describe('CashDeskService.getGlDrift — PR-FIN-PAYACCT-4B', () => {
  it('SELECTs from v_cashbox_gl_drift and returns string-cast numerics', async () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const dsObj: any = {
      query: async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        return [
          {
            cashbox_id: '524646d5-…',
            cashbox_name: 'الخزينة الرئيسية',
            kind: 'cash',
            is_active: true,
            stored_balance: '23905.00',
            gl_total_dr: '28098.00',
            gl_total_cr: '3743.00',
            gl_net: '24355.00',
            drift_amount: '-450.00',
          },
        ];
      },
      transaction: async (cb: any) => cb({ query: dsObj.query }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [CashDeskService, { provide: DataSource, useValue: dsObj }],
    }).compile();
    const service = moduleRef.get(CashDeskService);

    const out = await service.getGlDrift();
    expect(out).toHaveLength(1);
    expect(out[0].cashbox_name).toBe('الخزينة الرئيسية');
    expect(out[0].drift_amount).toBe('-450.00');
    // Sanity: SELECT hits the view name expected by mig 121.
    expect(calls[0].sql).toMatch(/FROM v_cashbox_gl_drift/);
    expect(calls[0].sql).toMatch(/ORDER BY cashbox_name/);
  });
});


