/**
 * posting.service.purchase-landed.spec.ts — PR-PURCHASES-P2.1
 *
 * Pins postPurchase()'s GL leg shape after the landed-cost rollout.
 * Mocks the engine and asserts on the gl_lines array passed to
 * recordTransaction():
 *
 *   · zero extras  → legacy 3-leg shape (Inventory / [Tax] / Supplier)
 *   · capitalized only → inventory leg DR includes extras_capitalized
 *   · non-capitalized only → new DR leg at GL 529, inventory peels it off
 *   · combined extras → 4 legs (Inventory / VAT / Opex 529 / Supplier),
 *     balanced and totalling grand_total on both sides
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AccountingPostingService } from './posting.service';
import { FinancialEngineService } from './financial-engine.service';

const SUPPLIER_ID = '11111111-1111-1111-1111-111111111111';
const PURCHASE_ID = '22222222-2222-2222-2222-222222222222';

function purchaseRow(overrides: Record<string, any> = {}) {
  return {
    id: PURCHASE_ID,
    purchase_no: 'PO-2026-000001',
    subtotal: '1000.00',
    tax_amount: '0.00',
    shipping_cost: '0.00',
    grand_total: '1000.00',
    paid_amount: '0.00',
    status: 'received',
    received_at: '2026-05-16',
    invoice_date: '2026-05-16',
    supplier_id: SUPPLIER_ID,
    extra_costs_capitalized: '0.00',
    extra_costs_non_capitalized: '0.00',
    ...overrides,
  };
}

async function makeService(opts: { purchase: any }) {
  // Each accountIdByCode call hits SELECT id FROM chart_of_accounts
  // WHERE code = $1; respond per-call by looking at the bound param.
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      // safe() idempotency check
      if (/SELECT id FROM journal_entries/i.test(s)) return [];
      // SELECT * FROM purchases
      if (/FROM purchases WHERE id = \$1/i.test(s)) return [opts.purchase];
      // accountIdByCode
      if (/FROM chart_of_accounts/i.test(s)) {
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

interface CapturedLine {
  account_id?: string;
  account_code?: string;
  debit: number;
  credit: number;
  description?: string;
  supplier_id?: string;
}

function findLine(spec: any, accId: string): CapturedLine | undefined {
  return spec.gl_lines.find((l: any) => l.account_id === accId);
}

describe('postPurchase — Phase 2.1 GL legs', () => {
  it('no extras: 2-leg shape (DR Inventory / CR Supplier), tax = 0 skipped', async () => {
    const { service, engine } = await makeService({
      purchase: purchaseRow(),
    });
    await service.postPurchase(PURCHASE_ID, 'user-1');
    expect(engine.recordTransaction).toHaveBeenCalledTimes(1);
    const spec = engine.recordTransaction.mock.calls[0][0];
    expect(spec.gl_lines).toHaveLength(2);
    const inv = findLine(spec, 'acc-1131')!;
    const supp = findLine(spec, 'acc-211')!;
    expect(inv.debit).toBe(1000);
    expect(supp.credit).toBe(1000);
    // No 529 leg.
    expect(spec.gl_lines.find((l: any) => l.account_id === 'acc-529')).toBeUndefined();
  });

  it('with capitalized extras only: inventory leg DR includes extras_capitalized', async () => {
    const { service, engine } = await makeService({
      purchase: purchaseRow({
        subtotal: '10000.00',
        grand_total: '11000.00',
        extra_costs_capitalized: '1000.00',
      }),
    });
    await service.postPurchase(PURCHASE_ID, 'user-1');
    const spec = engine.recordTransaction.mock.calls[0][0];
    const inv = findLine(spec, 'acc-1131')!;
    const supp = findLine(spec, 'acc-211')!;
    expect(inv.debit).toBe(11000); // 11000 grand − 0 tax − 0 non-cap
    expect(supp.credit).toBe(11000);
    expect(spec.gl_lines.find((l: any) => l.account_id === 'acc-529')).toBeUndefined();
  });

  it('with non-capitalized extras: new DR leg at GL 529, inventory peels it off', async () => {
    const { service, engine } = await makeService({
      purchase: purchaseRow({
        subtotal: '1000.00',
        grand_total: '1075.00',
        extra_costs_non_capitalized: '75.00',
      }),
    });
    await service.postPurchase(PURCHASE_ID, 'user-1');
    const spec = engine.recordTransaction.mock.calls[0][0];
    const inv = findLine(spec, 'acc-1131')!;
    const opex = findLine(spec, 'acc-529')!;
    const supp = findLine(spec, 'acc-211')!;
    expect(inv.debit).toBe(1000); // peeled off 75 non-cap
    expect(opex.debit).toBe(75);
    expect(supp.credit).toBe(1075);
    // Balanced
    const totalDR = spec.gl_lines.reduce((s: number, l: any) => s + Number(l.debit || 0), 0);
    const totalCR = spec.gl_lines.reduce((s: number, l: any) => s + Number(l.credit || 0), 0);
    expect(totalDR).toBe(totalCR);
  });

  it('combined tax + capitalized + non-capitalized: 4 legs, balanced, grand_total on both sides', async () => {
    const { service, engine } = await makeService({
      purchase: purchaseRow({
        subtotal: '10000.00',
        tax_amount: '50.00',
        grand_total: '11125.00',
        extra_costs_capitalized: '1000.00',
        extra_costs_non_capitalized: '75.00',
      }),
    });
    await service.postPurchase(PURCHASE_ID, 'user-1');
    const spec = engine.recordTransaction.mock.calls[0][0];
    expect(spec.gl_lines).toHaveLength(4);
    const inv = findLine(spec, 'acc-1131')!;
    const vat = findLine(spec, 'acc-214')!;
    const opex = findLine(spec, 'acc-529')!;
    const supp = findLine(spec, 'acc-211')!;
    expect(inv.debit).toBe(11000); // 11125 − 50 tax − 75 non-cap
    expect(vat.debit).toBe(50);
    expect(opex.debit).toBe(75);
    expect(supp.credit).toBe(11125);
    const totalDR = spec.gl_lines.reduce((s: number, l: any) => s + Number(l.debit || 0), 0);
    const totalCR = spec.gl_lines.reduce((s: number, l: any) => s + Number(l.credit || 0), 0);
    expect(totalDR).toBe(11125);
    expect(totalCR).toBe(11125);
  });

  it('supplier leg carries supplier_id dimension', async () => {
    const { service, engine } = await makeService({
      purchase: purchaseRow({
        subtotal: '500.00',
        grand_total: '500.00',
      }),
    });
    await service.postPurchase(PURCHASE_ID, 'user-1');
    const spec = engine.recordTransaction.mock.calls[0][0];
    const supp = findLine(spec, 'acc-211')!;
    expect(supp.supplier_id).toBe(SUPPLIER_ID);
  });
});
