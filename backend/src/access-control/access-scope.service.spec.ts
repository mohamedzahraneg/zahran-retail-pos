/**
 * access-scope.service.spec.ts — PR-USER-BRANCH-WAREHOUSE-ACCESS
 *
 * Pins the read-side of the access foundation:
 *   · bypass role => `null` (no restriction)
 *   · zero access rows => `null` (fallback allow-all)
 *   · ≥1 rows => the array of allowed ids, optionally filtered by
 *     minLevel
 *   · default branch/warehouse helpers query is_default = TRUE
 *   · static guard: zero INSERT/UPDATE/DELETE in the service source
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccessScopeService } from './access-scope.service';

type QueryCall = { sql: string; params: any[] };

function makeRouter(routes: Array<{ match: RegExp; rows: any[] }>) {
  const calls: QueryCall[] = [];
  const handler = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    const r = routes.find((x) => x.match.test(sql));
    return r ? r.rows : [];
  });
  return { calls, handler };
}

async function build(handler: jest.Mock) {
  const ds: any = { query: handler };
  const mod = await Test.createTestingModule({
    providers: [
      AccessScopeService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  return mod.get(AccessScopeService);
}

const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BRANCH_A = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';
const BRANCH_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2';
const WH_A = 'cccccccc-cccc-cccc-cccc-cccccccccc01';
const WH_B = 'cccccccc-cccc-cccc-cccc-cccccccccc02';

describe('AccessScopeService.isBypassRole', () => {
  it.each(['admin', 'super_admin', 'superadmin', 'manager', 'ADMIN'])(
    '%s is a bypass role',
    async (role) => {
      const svc = await build(makeRouter([]).handler);
      expect(svc.isBypassRole(role)).toBe(true);
    },
  );

  it.each(['cashier', 'salesperson', 'stock_keeper', 'accountant', null, undefined, ''])(
    '%s is NOT a bypass role',
    async (role) => {
      const svc = await build(makeRouter([]).handler);
      expect(svc.isBypassRole(role as any)).toBe(false);
    },
  );
});

describe('AccessScopeService.getUserBranchIds', () => {
  it('bypass role short-circuits to null without hitting the DB', async () => {
    const { calls, handler } = makeRouter([{ match: /./, rows: [] }]);
    const svc = await build(handler);
    const result = await svc.getUserBranchIds(USER, { role: 'admin' });
    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });

  it('returns null when the user has zero rows (fallback allow-all)', async () => {
    const svc = await build(makeRouter([{ match: /./, rows: [] }]).handler);
    const result = await svc.getUserBranchIds(USER, { role: 'cashier' });
    expect(result).toBeNull();
  });

  it('returns the array of branch ids when the user has rows', async () => {
    const svc = await build(
      makeRouter([
        {
          match: /FROM user_branch_access/,
          rows: [
            { branch_id: BRANCH_A, access_level: 'view' },
            { branch_id: BRANCH_B, access_level: 'manage' },
          ],
        },
      ]).handler,
    );
    const result = await svc.getUserBranchIds(USER, { role: 'cashier' });
    expect(result).toEqual([BRANCH_A, BRANCH_B]);
  });

  it('filters by minLevel — view rows excluded when minLevel=manage', async () => {
    const svc = await build(
      makeRouter([
        {
          match: /FROM user_branch_access/,
          rows: [
            { branch_id: BRANCH_A, access_level: 'view' },
            { branch_id: BRANCH_B, access_level: 'manage' },
          ],
        },
      ]).handler,
    );
    const result = await svc.getUserBranchIds(USER, {
      role: 'cashier',
      minLevel: 'manage',
    });
    expect(result).toEqual([BRANCH_B]);
  });
});

describe('AccessScopeService.getUserWarehouseIds', () => {
  it('returns warehouses ordered by row insertion', async () => {
    const svc = await build(
      makeRouter([
        {
          match: /FROM user_warehouse_access/,
          rows: [
            { warehouse_id: WH_A, access_level: 'operate' },
            { warehouse_id: WH_B, access_level: 'view' },
          ],
        },
      ]).handler,
    );
    const result = await svc.getUserWarehouseIds(USER, {
      role: 'cashier',
    });
    expect(result).toEqual([WH_A, WH_B]);
  });

  it('filters by minLevel=operate', async () => {
    const svc = await build(
      makeRouter([
        {
          match: /FROM user_warehouse_access/,
          rows: [
            { warehouse_id: WH_A, access_level: 'operate' },
            { warehouse_id: WH_B, access_level: 'view' },
          ],
        },
      ]).handler,
    );
    const result = await svc.getUserWarehouseIds(USER, {
      role: 'cashier',
      minLevel: 'operate',
    });
    expect(result).toEqual([WH_A]);
  });

  it('fallback null on zero rows', async () => {
    const svc = await build(makeRouter([{ match: /./, rows: [] }]).handler);
    expect(await svc.getUserWarehouseIds(USER, { role: 'cashier' })).toBeNull();
  });
});

describe('AccessScopeService.canAccessBranch / canAccessWarehouse', () => {
  it('canAccessBranch returns true for bypass role', async () => {
    const svc = await build(makeRouter([]).handler);
    expect(await svc.canAccessBranch(USER, BRANCH_A, { role: 'admin' })).toBe(true);
  });

  it('canAccessBranch returns true when user has zero rows', async () => {
    const svc = await build(makeRouter([{ match: /./, rows: [] }]).handler);
    expect(await svc.canAccessBranch(USER, BRANCH_A, { role: 'cashier' })).toBe(true);
  });

  it('canAccessBranch returns false when branch is outside the allow-list', async () => {
    const svc = await build(
      makeRouter([
        {
          match: /FROM user_branch_access/,
          rows: [{ branch_id: BRANCH_A, access_level: 'view' }],
        },
      ]).handler,
    );
    expect(await svc.canAccessBranch(USER, BRANCH_B, { role: 'cashier' })).toBe(false);
  });

  it('canAccessWarehouse mirrors the branch helper semantics', async () => {
    const svc = await build(
      makeRouter([
        {
          match: /FROM user_warehouse_access/,
          rows: [{ warehouse_id: WH_A, access_level: 'view' }],
        },
      ]).handler,
    );
    expect(await svc.canAccessWarehouse(USER, WH_A, { role: 'cashier' })).toBe(true);
    expect(await svc.canAccessWarehouse(USER, WH_B, { role: 'cashier' })).toBe(false);
  });
});

describe('AccessScopeService.getDefaultBranch / getDefaultWarehouse', () => {
  it('queries is_default = TRUE for branch', async () => {
    const { calls, handler } = makeRouter([
      { match: /FROM user_branch_access/, rows: [{ branch_id: BRANCH_A }] },
    ]);
    const svc = await build(handler);
    expect(await svc.getDefaultBranch(USER)).toBe(BRANCH_A);
    expect(calls[0].sql).toMatch(/is_default = TRUE/);
  });

  it('queries is_default = TRUE for warehouse', async () => {
    const { calls, handler } = makeRouter([
      {
        match: /FROM user_warehouse_access/,
        rows: [{ warehouse_id: WH_A }],
      },
    ]);
    const svc = await build(handler);
    expect(await svc.getDefaultWarehouse(USER)).toBe(WH_A);
    expect(calls[0].sql).toMatch(/is_default = TRUE/);
  });

  it('null when no default row exists', async () => {
    const svc = await build(makeRouter([{ match: /./, rows: [] }]).handler);
    expect(await svc.getDefaultBranch(USER)).toBeNull();
    expect(await svc.getDefaultWarehouse(USER)).toBeNull();
  });
});

describe('AccessScopeService.getUserAccessSummary', () => {
  it('returns branches + warehouses arrays with the default flags', async () => {
    const svc = await build(
      makeRouter([
        {
          match: /FROM user_branch_access uba/,
          rows: [
            {
              user_id: USER,
              branch_id: BRANCH_A,
              access_level: 'view',
              is_default: true,
              branch_code: 'CAI-01',
              branch_name_ar: 'فرع القاهرة',
              branch_name_en: 'Cairo',
              branch_type: 'retail',
              branch_is_active: true,
            },
          ],
        },
        {
          match: /FROM user_warehouse_access uwa/,
          rows: [
            {
              user_id: USER,
              warehouse_id: WH_A,
              access_level: 'view',
              is_default: true,
              warehouse_code: 'WH-A',
              warehouse_name_ar: 'الرئيسي',
              warehouse_name_en: null,
              warehouse_is_active: true,
            },
          ],
        },
      ]).handler,
    );
    const res = await svc.getUserAccessSummary(USER);
    expect(res.default_branch_id).toBe(BRANCH_A);
    expect(res.default_warehouse_id).toBe(WH_A);
    expect(res.branches).toHaveLength(1);
    expect(res.warehouses).toHaveLength(1);
  });
});

describe('AccessScopeService — static guard', () => {
  const SRC = readFileSync(
    join(__dirname, 'access-scope.service.ts'),
    'utf8',
  );
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /\/\/[^\n]*/g,
    '',
  );

  it('contains zero INSERT/UPDATE/DELETE statements (read-only by design)', () => {
    expect(code).not.toMatch(/\bINSERT INTO\b/i);
    expect(code).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(code).not.toMatch(/\bDELETE FROM\b/i);
  });

  it('never touches stock / stock_movements / journal / cashbox tables', () => {
    for (const pat of [
      /\bstock\b/i,
      /\bstock_movements\b/i,
      /\bjournal_entries\b/i,
      /\bjournal_lines\b/i,
      /\bcashbox/i,
      /\binvoices?\b/i,
      /\bpurchases?\b/i,
    ]) {
      expect(code).not.toMatch(pat);
    }
  });
});
