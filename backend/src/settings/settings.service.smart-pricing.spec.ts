/**
 * settings.service.smart-pricing.spec.ts — PR-PURCHASES-P3.3
 *
 * Pins the typed smart_pricing settings flow. Stubs the DataSource so
 * we can capture the exact SQL the service emits and assert:
 *   · defaults are returned when no rows exist
 *   · seeded values override defaults key-by-key
 *   · update writes one upsert per non-undefined field, inside one txn
 *   · cross-field invariant: high_margin > recommended_margin
 *   · NO write into product_variants / variant_price_history /
 *     journal / cashbox / stock / purchase tables
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { SettingsService } from './settings.service';

type QueryCall = { sql: string; params: any[] };

interface MakeServiceOpts {
  responses?: Array<any[]>;
}

async function makeService(opts: MakeServiceOpts = {}) {
  const queue = [...(opts.responses ?? [])];
  const calls: QueryCall[] = [];
  const innerQuery = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    return queue.length ? queue.shift() : [];
  });
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return queue.length ? queue.shift() : [];
    }),
    transaction: jest.fn(async (cb: any) => cb({ query: innerQuery })),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      SettingsService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  const service = moduleRef.get(SettingsService);
  return { service, calls, ds };
}

const USER = '11111111-1111-1111-1111-111111111111';

describe('SettingsService.getSmartPricing — P3.3', () => {
  it('returns built-in defaults when no rows exist', async () => {
    const { service } = await makeService({ responses: [[]] });
    const out = await service.getSmartPricing();
    expect(out).toMatchObject({
      competitive_markup_pct: 15,
      recommended_margin_pct: 30,
      high_margin_pct: 40,
      wholesale_markup_pct: 10,
      min_margin_pct_default: 15,
      rounding_step: 5,
      rounding_mode: 'nearest',
      show_wholesale_card: true,
      show_high_margin_card: true,
    });
  });

  it('overlays seeded values on top of defaults', async () => {
    const { service } = await makeService({
      responses: [
        [
          { key: 'smart_pricing.competitive_markup_pct', value: 20 },
          { key: 'smart_pricing.recommended_margin_pct', value: 35 },
          { key: 'smart_pricing.rounding_step', value: 10 },
          { key: 'smart_pricing.rounding_mode', value: 'ceil' },
          { key: 'smart_pricing.show_wholesale_card', value: false },
          // unknown key should be ignored
          { key: 'smart_pricing.future_key', value: 99 },
        ],
      ],
    });
    const out = await service.getSmartPricing();
    expect(out.competitive_markup_pct).toBe(20);
    expect(out.recommended_margin_pct).toBe(35);
    expect(out.rounding_step).toBe(10);
    expect(out.rounding_mode).toBe('ceil');
    expect(out.show_wholesale_card).toBe(false);
    // Fields not in the row set still come from defaults.
    expect(out.high_margin_pct).toBe(40);
    expect(out.wholesale_markup_pct).toBe(10);
    expect((out as any).future_key).toBeUndefined();
  });
});

describe('SettingsService.updateSmartPricing — P3.3', () => {
  it('writes one upsert per non-undefined field, inside one transaction', async () => {
    const { service, calls, ds } = await makeService({
      responses: [
        [],
        [],
        [],
        // The final getSmartPricing read after the write.
        [],
      ],
    });
    const out = await service.updateSmartPricing(
      {
        competitive_markup_pct: 18,
        recommended_margin_pct: 32,
        rounding_step: 10,
      },
      USER,
    );
    expect(ds.transaction).toHaveBeenCalledTimes(1);
    const upserts = calls.filter((c) =>
      /INSERT INTO settings\b/.test(c.sql),
    );
    expect(upserts).toHaveLength(3);
    expect(upserts.map((u) => u.params[0])).toEqual(
      expect.arrayContaining([
        'smart_pricing.competitive_markup_pct',
        'smart_pricing.recommended_margin_pct',
        'smart_pricing.rounding_step',
      ]),
    );
    // Returned snapshot honors the defaults overlay (read post-write).
    expect(out.high_margin_pct).toBe(40);
  });

  it('no-op when payload is empty — returns current state without writing', async () => {
    const { service, calls, ds } = await makeService({
      responses: [[]],
    });
    await service.updateSmartPricing({}, USER);
    expect(ds.transaction).not.toHaveBeenCalled();
    expect(
      calls.filter((c) => /INSERT INTO settings\b/.test(c.sql)),
    ).toHaveLength(0);
  });

  it('rejects when recommended_margin >= high_margin', async () => {
    const { service, ds } = await makeService();
    await expect(
      service.updateSmartPricing(
        { recommended_margin_pct: 40, high_margin_pct: 40 },
        USER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ds.transaction).not.toHaveBeenCalled();
  });

  it('updateSmartPricing never writes to product_variants / variant_price_history / accounting / cashbox / stock / purchase tables', async () => {
    const { service, calls } = await makeService({
      responses: [[], []],
    });
    await service.updateSmartPricing(
      { competitive_markup_pct: 18 },
      USER,
    );
    const allSql = calls.map((c) => c.sql).join('\n');
    expect(allSql).not.toMatch(/product_variants/i);
    expect(allSql).not.toMatch(/variant_price_history/i);
    expect(allSql).not.toMatch(/journal_entries|journal_lines/i);
    expect(allSql).not.toMatch(/cashbox_transactions/i);
    expect(allSql).not.toMatch(/stock_movements/i);
    expect(allSql).not.toMatch(/supplier_ledger/i);
    expect(allSql).not.toMatch(/purchase_items|purchase_extra_costs/i);
    // Only writes are to `settings`.
    const writes = calls.filter((c) =>
      /\b(INSERT|UPDATE|DELETE)\b/i.test(c.sql),
    );
    for (const w of writes) {
      expect(w.sql).toMatch(/\bsettings\b/i);
    }
  });
});
