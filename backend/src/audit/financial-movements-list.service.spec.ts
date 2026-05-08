/**
 * FinancialMovementsListService — unit tests
 *
 * Pins:
 *   · Period normalization (today/yesterday/week/month/custom).
 *   · Custom range validation (YYYY-MM-DD shape, from <= to).
 *   · Limit clamping (default 50, max 200, min 1).
 *   · reference_type allowlisting.
 *   · Read-only SQL contract — every executed query is a SELECT.
 *   · Indicator stamping (has_journal/has_cashbox_transaction/
 *     has_stock_movement) using bulk indicator queries.
 *   · Source ids are passed as parameters, never interpolated.
 */
import { BadRequestException } from '@nestjs/common';
import {
  FinancialMovementsListService,
  type ListQuery,
} from './financial-movements-list.service';

function makeDsStub(results: any[][]) {
  let i = 0;
  const calls: Array<{ sql: string; params: any[] }> = [];
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const next = results[i++];
      return next ?? [];
    }),
  };
  return { ds, calls };
}

describe('FinancialMovementsListService — read-only', () => {
  it('default period is "today" with single-day range', async () => {
    // 8 per-source SELECTs all empty + 0 indicator queries (skipped
    // because items.length === 0).
    const { ds } = makeDsStub([[], [], [], [], [], [], [], []]);
    const svc = new FinancialMovementsListService(ds);

    const res = await svc.list({});
    expect(res.period).toBe('today');
    expect(res.from).toBe(res.to);
    expect(res.items).toEqual([]);
    expect(res.totals.total).toBe(0);
  });

  it('period=yesterday produces a single-day range one day before today', async () => {
    const { ds } = makeDsStub([[], [], [], [], [], [], [], []]);
    const svc = new FinancialMovementsListService(ds);

    const res = await svc.list({ period: 'yesterday' });
    expect(res.period).toBe('yesterday');
    expect(res.from).toBe(res.to);
    // Verify it's a valid ISO date and is < today.
    const today = new Date().toISOString().slice(0, 10);
    expect(res.from < today).toBe(true);
    expect(/^\d{4}-\d{2}-\d{2}$/.test(res.from)).toBe(true);
  });

  it('period=week produces a 7-day window ending today', async () => {
    const { ds } = makeDsStub([[], [], [], [], [], [], [], []]);
    const svc = new FinancialMovementsListService(ds);

    const res = await svc.list({ period: 'week' });
    expect(res.period).toBe('week');
    const fromD = new Date(res.from + 'T00:00:00Z');
    const toD = new Date(res.to + 'T00:00:00Z');
    const days = Math.round((toD.getTime() - fromD.getTime()) / 86_400_000);
    expect(days).toBe(6); // last 7 days inclusive
  });

  it('period=month starts on the first of the current month', async () => {
    const { ds } = makeDsStub([[], [], [], [], [], [], [], []]);
    const svc = new FinancialMovementsListService(ds);

    const res = await svc.list({ period: 'month' });
    expect(res.period).toBe('month');
    expect(res.from.endsWith('-01')).toBe(true);
  });

  it('period=custom requires from + to in YYYY-MM-DD shape', async () => {
    const { ds } = makeDsStub([]);
    const svc = new FinancialMovementsListService(ds);

    await expect(svc.list({ period: 'custom' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      svc.list({ period: 'custom', from: '2026/01/01', to: '2026/01/31' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      svc.list({ period: 'custom', from: '2026-01-31', to: '2026-01-01' }),
    ).rejects.toThrow(/from must be <= to/);
  });

  it('period=custom with valid range passes through unchanged', async () => {
    const { ds } = makeDsStub([[], [], [], [], [], [], [], []]);
    const svc = new FinancialMovementsListService(ds);

    const res = await svc.list({
      period: 'custom',
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(res.from).toBe('2026-01-01');
    expect(res.to).toBe('2026-01-31');
  });

  it('limit defaults to 50, clamps min 1 / max 200', async () => {
    const { ds } = makeDsStub([[], [], [], [], [], [], [], []]);
    const svc = new FinancialMovementsListService(ds);

    expect((await svc.list({})).limit).toBe(50);
    expect((await svc.list({ limit: 0 })).limit).toBe(50);
    expect((await svc.list({ limit: -5 })).limit).toBe(50);
    expect((await svc.list({ limit: 1 })).limit).toBe(1);
    expect((await svc.list({ limit: 999 })).limit).toBe(200);
  });

  it('reference_type filter limits per-source SELECTs to that type only', async () => {
    const { ds, calls } = makeDsStub([
      // Single source SELECT (invoice only) returns one row.
      [
        {
          source_id: 'inv-1',
          number: 'INV-1',
          date: '2026-04-30T10:00:00Z',
          party_id: null,
          party_name: null,
          total: '100.00',
          status: 'paid',
        },
      ],
      // Bulk journal indicator
      [{ id: 'inv-1' }],
      // Bulk cashbox indicator
      [{ id: 'inv-1' }],
      // Bulk stock indicator
      [{ id: 'inv-1' }],
    ]);
    const svc = new FinancialMovementsListService(ds);

    const res = await svc.list({ reference_type: 'invoice' });
    // Only 1 per-source SELECT + up to 3 bulk indicator queries.
    expect(calls.length).toBeLessThanOrEqual(4);
    // The first call must be the invoice SQL.
    expect(calls[0].sql).toMatch(/FROM invoices/);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].source_type).toBe('invoice');
    expect(res.items[0].has_journal).toBe(true);
    expect(res.items[0].has_cashbox_transaction).toBe(true);
    expect(res.items[0].has_stock_movement).toBe(true);
  });

  it('every executed SQL is SELECT only — no mutation', async () => {
    const { ds, calls } = makeDsStub([
      [
        {
          source_id: 'inv-1',
          number: 'INV-1',
          date: '2026-04-30T10:00:00Z',
          party_id: null,
          party_name: null,
          total: '100.00',
          status: 'paid',
        },
      ],
      [], [], [], [], [], [], [], // 7 more empty per-source results
      [], // bulk journal
      [], // bulk cashbox
      [], // bulk stock
    ]);
    const svc = new FinancialMovementsListService(ds);

    await svc.list({});

    for (const c of calls) {
      const trimmed = c.sql.trim().toUpperCase();
      expect(/^SELECT|^WITH/.test(trimmed)).toBe(true);
      expect(/\bINSERT\s+INTO\b/.test(trimmed)).toBe(false);
      expect(/\bUPDATE\s+\w+\s+SET\b/.test(trimmed)).toBe(false);
      expect(/\bDELETE\s+FROM\b/.test(trimmed)).toBe(false);
      expect(/\bTRUNCATE\b/.test(trimmed)).toBe(false);
      expect(/\bDROP\b/.test(trimmed)).toBe(false);
      expect(/\bALTER\b/.test(trimmed)).toBe(false);
    }
  });

  it('parameterizes ids via $2 placeholder — never string-interpolates', async () => {
    const { ds, calls } = makeDsStub([
      [
        {
          source_id: '11111111-2222-3333-4444-555555555555',
          number: 'INV-A',
          date: '2026-04-30T10:00:00Z',
          party_id: null,
          party_name: null,
          total: '100.00',
          status: 'paid',
        },
      ],
      [], [], [], [], [], [], [],
      [], [], [],
    ]);
    const svc = new FinancialMovementsListService(ds);

    await svc.list({});

    // Every bulk indicator query must use $1 (type) + $2 (id array).
    const indicatorCalls = calls.filter((c) =>
      /reference_id::text = ANY\(\$2/.test(c.sql),
    );
    expect(indicatorCalls.length).toBeGreaterThan(0);
    for (const c of indicatorCalls) {
      // params[1] is the ids array — never embedded in SQL.
      expect(Array.isArray(c.params[1])).toBe(true);
      expect(c.sql).not.toMatch(/11111111-2222-3333-4444-555555555555/);
    }
  });

  it('totals reflect per-row indicator stamping', async () => {
    // Bulk indicators are bucketed per source_type, so for results
    // spanning both invoice + return there is one query per (type,
    // indicator) pair, not one global query.  Order: 8 per-source
    // SELECTs → 2 journal (invoice, return) → 2 cashbox → 2 stock.
    const { ds } = makeDsStub([
      // invoice — has JE, has CT, has stock
      [{
        source_id: 'inv-1', number: 'INV-1',
        date: '2026-04-30T10:00:00Z', party_id: null,
        party_name: null, total: '100', status: 'paid',
      }],
      // return — has JE only
      [{
        source_id: 'ret-1', number: 'RET-1',
        date: '2026-04-29T10:00:00Z', party_id: null,
        party_name: null, total: '50', status: 'refunded',
      }],
      [], [], [], [], [], [], // remaining 6 source SELECTs empty
      // bulk journal — invoice bucket then return bucket
      [{ id: 'inv-1' }],
      [{ id: 'ret-1' }],
      // bulk cashbox — only invoice has CT, return bucket empty
      [{ id: 'inv-1' }],
      [],
      // bulk stock — only invoice has stock, return bucket empty
      [{ id: 'inv-1' }],
      [],
    ]);
    const svc = new FinancialMovementsListService(ds);
    const res = await svc.list({});

    expect(res.items).toHaveLength(2);
    expect(res.totals.total).toBe(2);
    expect(res.totals.with_journal).toBe(2);
    expect(res.totals.with_cashbox_transaction).toBe(1);
    expect(res.totals.with_stock_movement).toBe(1);
    // The return is missing stock + cashbox → flags_count >= 1.
    const ret = res.items.find((i) => i.source_id === 'ret-1');
    expect(ret?.flags_count).toBeGreaterThan(0);
    // Newest first — invoice (Apr 30) before return (Apr 29).
    expect(res.items[0].source_id).toBe('inv-1');
  });

  it('items are sorted DESC by date and clamped to limit', async () => {
    const dates = [
      '2026-04-30T10:00:00Z',
      '2026-04-29T10:00:00Z',
      '2026-04-28T10:00:00Z',
      '2026-04-27T10:00:00Z',
    ];
    const rows = dates.map((d, i) => ({
      source_id: `inv-${i}`,
      number: `INV-${i}`,
      date: d,
      party_id: null,
      party_name: null,
      total: '100',
      status: 'paid',
    }));
    const { ds } = makeDsStub([
      rows, [], [], [], [], [], [], [],
      [], [], [],
    ]);
    const svc = new FinancialMovementsListService(ds);
    const res = await svc.list({ limit: 2 });

    expect(res.items).toHaveLength(2);
    expect(res.items[0].date).toBe(dates[0]);
    expect(res.items[1].date).toBe(dates[1]);
  });
});
