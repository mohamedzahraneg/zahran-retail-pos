/**
 * purchases.service.list-cancelled.spec.ts
 *
 * Purchases UX fixes — pins the new default-list behavior:
 *
 *   · `list({})` excludes cancelled invoices (operator complaint that
 *     cancelled rows were noise in the default view).
 *   · `list({ status: 'cancelled' })` still returns ONLY cancelled.
 *   · `list({ include_cancelled: true })` returns everything including
 *     cancelled.
 *   · The query stays read-only — no INSERT/UPDATE/DELETE issued.
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { PurchasesService } from './purchases.service';

type QueryCall = { sql: string; params: any[] };

async function makeService() {
  const queries: QueryCall[] = [];
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      return [];
    }),
    manager: { query: jest.fn() },
    transaction: jest.fn(async (cb: any) => cb({ query: jest.fn() })),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      PurchasesService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  const service = moduleRef.get(PurchasesService);
  return { service, queries };
}

describe('PurchasesService.list — cancelled exclusion (Purchases UX fixes)', () => {
  it('default call excludes cancelled with a literal predicate', async () => {
    const { service, queries } = await makeService();
    await service.list({} as any);
    const sql = queries[0].sql;
    expect(sql).toMatch(/p\.status\s*<>\s*'cancelled'/);
    // No params bound — predicate is literal.
    expect(queries[0].params).toEqual([]);
  });

  it('explicit status=cancelled honours the operator-supplied filter', async () => {
    const { service, queries } = await makeService();
    await service.list({ status: 'cancelled' } as any);
    const sql = queries[0].sql;
    // The explicit filter wins; we do NOT also emit the
    // `<> 'cancelled'` predicate.
    expect(sql).toMatch(/p\.status\s*=\s*\$1/);
    expect(sql).not.toMatch(/p\.status\s*<>\s*'cancelled'/);
    expect(queries[0].params).toEqual(['cancelled']);
  });

  it('explicit status=draft excludes cancelled implicitly via the status predicate', async () => {
    const { service, queries } = await makeService();
    await service.list({ status: 'draft' } as any);
    const sql = queries[0].sql;
    expect(sql).toMatch(/p\.status\s*=\s*\$1/);
    // No defensive `<> cancelled` clause — the status filter already
    // narrows the result set.
    expect(sql).not.toMatch(/p\.status\s*<>\s*'cancelled'/);
    expect(queries[0].params).toEqual(['draft']);
  });

  it('include_cancelled=true surfaces cancelled rows again', async () => {
    const { service, queries } = await makeService();
    await service.list({ include_cancelled: true } as any);
    const sql = queries[0].sql;
    // No status filter, no defensive cancelled exclusion.
    expect(sql).not.toMatch(/p\.status\s*<>\s*'cancelled'/);
    expect(sql).not.toMatch(/p\.status\s*=\s*\$/);
    expect(queries[0].params).toEqual([]);
  });

  it('list is read-only: never emits INSERT/UPDATE/DELETE', async () => {
    const { service, queries } = await makeService();
    await service.list({} as any);
    await service.list({ status: 'cancelled' } as any);
    await service.list({ include_cancelled: true } as any);
    const sql = queries.map((q) => q.sql).join('\n');
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s/i);
  });
});
