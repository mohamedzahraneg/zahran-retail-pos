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
        postInvoicePayment: jest.fn().mockResolvedValue(undefined),
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
        postInvoicePayment: jest.fn().mockResolvedValue(undefined),
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

    it("swallows posting errors so a missing JE doesn't roll back the payment", async () => {
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

      // The promise must resolve (NOT throw) — this is the
      // "post on best-effort" contract that lets imports work
      // before COA is wired in fresh installs.
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
      ).resolves.toEqual({ id: 'pay-3' });
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
        postSupplierPayment: jest.fn().mockResolvedValue(undefined),
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
        postSupplierPayment: jest.fn().mockResolvedValue(undefined),
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
