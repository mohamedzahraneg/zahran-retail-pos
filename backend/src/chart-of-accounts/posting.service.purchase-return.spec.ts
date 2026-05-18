/**
 * posting.service.purchase-return.spec.ts — PR-P2.4A
 *
 * Pins postPurchaseReturn()'s GL leg shape per settlement type. Mocks
 * the engine + DataSource and asserts on the gl_lines passed to
 * recordTransaction():
 *
 *   · supplier_credit → DR 211 (with supplier_id) / CR 1131
 *   · cash_refund     → DR cashbox-COA-child       / CR 1131
 *   · bank_refund     → DR cashbox-COA-child       / CR 1131
 *   · no_settlement   → skipped entirely (no JE)
 *   · idempotency     → existing live JE short-circuits
 *   · status guard    → non-posted return skipped
 *   · zero total      → skipped (defensive)
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AccountingPostingService } from './posting.service';
import { FinancialEngineService } from './financial-engine.service';

const SUPPLIER_ID = '11111111-1111-1111-1111-111111111111';
const RETURN_ID = '22222222-2222-2222-2222-222222222222';
const CASHBOX_ID = '33333333-3333-3333-3333-333333333333';

function returnRow(overrides: Record<string, any> = {}) {
  return {
    id: RETURN_ID,
    return_no: 'PR-2026-000001',
    return_date: '2026-05-16',
    supplier_id: SUPPLIER_ID,
    warehouse_id: '44444444-4444-4444-4444-444444444444',
    total_amount: '500.00',
    status: 'posted',
    settlement_type: 'supplier_credit',
    refund_amount: null,
    cashbox_id: null,
    ...overrides,
  };
}

async function makeService(opts: {
  ret: any;
  existingEntry?: { id: string } | null;
  cashboxAccId?: string | null;
}) {
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      // safe() idempotency check
      if (/SELECT id FROM journal_entries/i.test(s)) {
        return opts.existingEntry ? [opts.existingEntry] : [];
      }
      if (/FROM purchase_returns pr WHERE pr\.id = \$1/i.test(s)) {
        return [opts.ret];
      }
      // cashboxAccountId — explicit map (WHERE cashbox_id = $1)
      if (
        /FROM chart_of_accounts WHERE cashbox_id = \$1/i.test(s)
        && opts.cashboxAccId
      ) {
        return [{ id: opts.cashboxAccId }];
      }
      // cashboxAccountId — kind lookup fallback
      if (/SELECT kind FROM cashboxes/i.test(s)) {
        return [{ kind: 'cash' }];
      }
      // accountIdByCode
      if (/FROM chart_of_accounts WHERE code = \$1/i.test(s)) {
        const code = params[0];
        return [{ id: `acc-${code}` }];
      }
      return [];
    }),
    manager: { query: jest.fn() },
    transaction: jest.fn(async (cb: any) => cb({ query: ds.query })),
  };
  const engine: any = {
    recordTransaction: jest.fn(async (spec: any) => ({
      ok: true,
      entry_id: 'je-1',
      gl_lines: spec.gl_lines,
    })),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AccountingPostingService,
      { provide: DataSource, useValue: ds },
      { provide: FinancialEngineService, useValue: engine },
    ],
  }).compile();
  const service = moduleRef.get(AccountingPostingService);
  return { service, ds, engine };
}

function findLine(spec: any, accId: string) {
  return spec.gl_lines.find((l: any) => l.account_id === accId);
}

describe('postPurchaseReturn — PR-P2.4A GL legs', () => {
  it('supplier_credit: DR 211 (supplier_id dim) / CR 1131, balanced', async () => {
    const { service, engine } = await makeService({
      ret: returnRow({
        settlement_type: 'supplier_credit',
        total_amount: '500.00',
      }),
    });
    await service.postPurchaseReturn(RETURN_ID, 'user-1');
    expect(engine.recordTransaction).toHaveBeenCalledTimes(1);
    const spec = engine.recordTransaction.mock.calls[0][0];
    expect(spec.reference_type).toBe('purchase_return');
    expect(spec.reference_id).toBe(RETURN_ID);
    expect(spec.gl_lines).toHaveLength(2);

    const supp = findLine(spec, 'acc-211');
    const inv = findLine(spec, 'acc-1131');
    expect(supp).toBeDefined();
    expect(supp.debit).toBe(500);
    expect(supp.credit).toBe(0);
    expect(supp.supplier_id).toBe(SUPPLIER_ID);
    expect(inv).toBeDefined();
    expect(inv.debit).toBe(0);
    expect(inv.credit).toBe(500);

    const totalDR = spec.gl_lines.reduce(
      (s: number, l: any) => s + Number(l.debit || 0),
      0,
    );
    const totalCR = spec.gl_lines.reduce(
      (s: number, l: any) => s + Number(l.credit || 0),
      0,
    );
    expect(totalDR).toBe(totalCR);
    expect(totalDR).toBe(500);
  });

  it('cash_refund: DR cashbox-COA-child / CR 1131, balanced, cashbox_id dim', async () => {
    const { service, engine } = await makeService({
      ret: returnRow({
        settlement_type: 'cash_refund',
        total_amount: '300.00',
        refund_amount: '300.00',
        cashbox_id: CASHBOX_ID,
      }),
      cashboxAccId: 'acc-1111-cashbox-child',
    });
    await service.postPurchaseReturn(RETURN_ID, 'user-1');
    const spec = engine.recordTransaction.mock.calls[0][0];
    expect(spec.gl_lines).toHaveLength(2);
    const cashLine = findLine(spec, 'acc-1111-cashbox-child');
    const inv = findLine(spec, 'acc-1131');
    expect(cashLine).toBeDefined();
    expect(cashLine.debit).toBe(300);
    expect(cashLine.credit).toBe(0);
    expect(cashLine.cashbox_id).toBe(CASHBOX_ID);
    expect(inv.credit).toBe(300);
    // No supplier line for cash refunds.
    expect(findLine(spec, 'acc-211')).toBeUndefined();
  });

  it('bank_refund: DR cashbox-COA-child / CR 1131', async () => {
    const { service, engine } = await makeService({
      ret: returnRow({
        settlement_type: 'bank_refund',
        total_amount: '750.50',
        refund_amount: '750.50',
        cashbox_id: CASHBOX_ID,
      }),
      cashboxAccId: 'acc-1112-bank-child',
    });
    await service.postPurchaseReturn(RETURN_ID, 'user-1');
    const spec = engine.recordTransaction.mock.calls[0][0];
    expect(spec.gl_lines).toHaveLength(2);
    const bankLine = findLine(spec, 'acc-1112-bank-child');
    const inv = findLine(spec, 'acc-1131');
    expect(bankLine.debit).toBe(750.5);
    expect(inv.credit).toBe(750.5);
    expect(findLine(spec, 'acc-211')).toBeUndefined();
  });

  it('no_settlement: skipped entirely (no engine call)', async () => {
    const { service, engine } = await makeService({
      ret: returnRow({ settlement_type: 'no_settlement' }),
    });
    const res = await service.postPurchaseReturn(RETURN_ID, 'user-1');
    expect(engine.recordTransaction).not.toHaveBeenCalled();
    expect(res).toBeNull();
  });

  it('idempotency: short-circuits when a live JE already exists', async () => {
    const { service, engine } = await makeService({
      ret: returnRow({ settlement_type: 'supplier_credit' }),
      existingEntry: { id: 'existing-je' },
    });
    const res: any = await service.postPurchaseReturn(RETURN_ID, 'user-1');
    expect(engine.recordTransaction).not.toHaveBeenCalled();
    expect(res?.skipped).toBe(true);
    expect(res?.entry_id).toBe('existing-je');
  });

  it('status guard: non-posted return is skipped', async () => {
    const { service, engine } = await makeService({
      ret: returnRow({ status: 'cancelled' }),
    });
    const res = await service.postPurchaseReturn(RETURN_ID, 'user-1');
    expect(engine.recordTransaction).not.toHaveBeenCalled();
    expect(res).toBeNull();
  });

  it('zero total: skipped (defensive — no balanced 2-leg possible)', async () => {
    const { service, engine } = await makeService({
      ret: returnRow({
        settlement_type: 'supplier_credit',
        total_amount: '0.00',
      }),
    });
    const res = await service.postPurchaseReturn(RETURN_ID, 'user-1');
    expect(engine.recordTransaction).not.toHaveBeenCalled();
    expect(res).toBeNull();
  });
});
