/**
 * access-control.service.spec.ts — PR-USER-BRANCH-WAREHOUSE-ACCESS
 *
 * Pins the write-path of the access-control surface:
 *   · branch_access / warehouse_access arrays replace the user's
 *     existing rows in a single transaction.
 *   · default_branch_id / default_warehouse_id flip is_default to
 *     exactly that row (and clear it on others), preserving the
 *     partial-unique invariant.
 *   · Passing `null` clears the default flag.
 *   · Duplicate ids / invalid access_level raise BadRequestException.
 *   · Setting a default that isn't in the user's allow-list raises
 *     ConflictException.
 *   · Static guard: only INSERT/UPDATE/DELETE against
 *     user_branch_access and user_warehouse_access — never stock,
 *     stock_movements, branches, warehouses, users, or any
 *     accounting/cashbox surface.
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccessControlService } from './access-control.service';
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
  const ds: any = {
    query: handler,
    transaction: jest.fn(async (cb: any) => cb({ query: handler })),
  };
  const mod = await Test.createTestingModule({
    providers: [
      AccessControlService,
      AccessScopeService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  return mod.get(AccessControlService);
}

const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACTOR = '99999999-9999-9999-9999-999999999999';
const BRANCH_A = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';
const BRANCH_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2';
const WH_A = 'cccccccc-cccc-cccc-cccc-cccccccccc01';

function userExistsRouter() {
  return [
    { match: /SELECT id FROM users WHERE/i, rows: [{ id: USER }] },
  ];
}

describe('AccessControlService.updateUserAccess', () => {
  it('replaces branch_access list in a transaction (DELETE then per-row INSERT)', async () => {
    const { calls, handler } = makeRouter([
      ...userExistsRouter(),
      { match: /./, rows: [] },
    ]);
    const svc = await build(handler);
    await svc.updateUserAccess(
      USER,
      {
        branch_access: [
          { branch_id: BRANCH_A, access_level: 'view' },
          { branch_id: BRANCH_B, access_level: 'manage' },
        ],
      },
      ACTOR,
    );

    const del = calls.find((c) =>
      /DELETE FROM user_branch_access/i.test(c.sql),
    );
    const inserts = calls.filter((c) =>
      /INSERT INTO user_branch_access/i.test(c.sql),
    );
    expect(del).toBeDefined();
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params).toEqual([USER, BRANCH_A, 'view', ACTOR]);
    expect(inserts[1].params).toEqual([USER, BRANCH_B, 'manage', ACTOR]);
  });

  it('replaces warehouse_access list', async () => {
    const { calls, handler } = makeRouter([
      ...userExistsRouter(),
      { match: /./, rows: [] },
    ]);
    const svc = await build(handler);
    await svc.updateUserAccess(
      USER,
      {
        warehouse_access: [{ warehouse_id: WH_A, access_level: 'admin' }],
      },
      ACTOR,
    );
    const del = calls.find((c) =>
      /DELETE FROM user_warehouse_access/i.test(c.sql),
    );
    const inserts = calls.filter((c) =>
      /INSERT INTO user_warehouse_access/i.test(c.sql),
    );
    expect(del).toBeDefined();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toEqual([USER, WH_A, 'admin', ACTOR]);
  });

  it('rejects an invalid access_level value', async () => {
    const { handler } = makeRouter(userExistsRouter());
    const svc = await build(handler);
    await expect(
      svc.updateUserAccess(
        USER,
        {
          branch_access: [
            { branch_id: BRANCH_A, access_level: 'god-mode' as any },
          ],
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a duplicate branch_id within the payload', async () => {
    const { handler } = makeRouter(userExistsRouter());
    const svc = await build(handler);
    await expect(
      svc.updateUserAccess(
        USER,
        {
          branch_access: [
            { branch_id: BRANCH_A, access_level: 'view' },
            { branch_id: BRANCH_A, access_level: 'manage' },
          ],
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('default_branch_id clears existing defaults then sets the new one', async () => {
    const { calls, handler } = makeRouter([
      ...userExistsRouter(),
      { match: /UPDATE user_branch_access SET is_default = FALSE/i, rows: [] },
      {
        match: /UPDATE user_branch_access SET is_default = TRUE/i,
        rows: [{ branch_id: BRANCH_A }],
      },
      { match: /./, rows: [] },
    ]);
    const svc = await build(handler);
    await svc.updateUserAccess(
      USER,
      { default_branch_id: BRANCH_A },
      ACTOR,
    );
    const clear = calls.find((c) =>
      /UPDATE user_branch_access SET is_default = FALSE/i.test(c.sql),
    );
    const promote = calls.find((c) =>
      /UPDATE user_branch_access SET is_default = TRUE/i.test(c.sql),
    );
    expect(clear).toBeDefined();
    expect(promote).toBeDefined();
    expect(calls.indexOf(clear!)).toBeLessThan(calls.indexOf(promote!));
  });

  it('default_branch_id = null clears the flag without trying to promote', async () => {
    const { calls, handler } = makeRouter([
      ...userExistsRouter(),
      { match: /./, rows: [] },
    ]);
    const svc = await build(handler);
    await svc.updateUserAccess(
      USER,
      { default_branch_id: null },
      ACTOR,
    );
    const clear = calls.find((c) =>
      /UPDATE user_branch_access SET is_default = FALSE/i.test(c.sql),
    );
    const promote = calls.find((c) =>
      /UPDATE user_branch_access SET is_default = TRUE/i.test(c.sql),
    );
    expect(clear).toBeDefined();
    expect(promote).toBeUndefined();
  });

  it('refuses to set a default branch the user does not have access to', async () => {
    const { handler } = makeRouter([
      ...userExistsRouter(),
      // demote OK
      { match: /UPDATE user_branch_access SET is_default = FALSE/i, rows: [] },
      // promote returns 0 rows (no row matched)
      { match: /UPDATE user_branch_access SET is_default = TRUE/i, rows: [] },
    ]);
    const svc = await build(handler);
    await expect(
      svc.updateUserAccess(
        USER,
        { default_branch_id: BRANCH_B },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws 404 when the user does not exist', async () => {
    const { handler } = makeRouter([
      { match: /SELECT id FROM users WHERE/i, rows: [] },
    ]);
    const svc = await build(handler);
    await expect(
      svc.updateUserAccess(USER, { branch_access: [] }, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AccessControlService — static guard', () => {
  const SRC = readFileSync(
    join(__dirname, 'access-control.service.ts'),
    'utf8',
  );
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /\/\/[^\n]*/g,
    '',
  );

  it('only INSERTs into user_branch_access / user_warehouse_access', () => {
    const inserts = code.match(/INSERT INTO\s+(\w+)/gi) ?? [];
    for (const i of inserts) {
      expect(i).toMatch(
        /INSERT INTO\s+(user_branch_access|user_warehouse_access)\b/i,
      );
    }
  });

  it('only UPDATEs user_branch_access / user_warehouse_access', () => {
    const updates = code.match(/UPDATE\s+\w+\s+SET/gi) ?? [];
    for (const u of updates) {
      expect(u).toMatch(
        /UPDATE\s+(user_branch_access|user_warehouse_access)\s+SET/i,
      );
    }
  });

  it('only DELETEs user_branch_access / user_warehouse_access', () => {
    const deletes = code.match(/DELETE FROM\s+\w+/gi) ?? [];
    for (const d of deletes) {
      expect(d).toMatch(
        /DELETE FROM\s+(user_branch_access|user_warehouse_access)\b/i,
      );
    }
  });

  it('never touches stock / stock_movements / journals / cashbox', () => {
    for (const pat of [
      /\bstock\b/i,
      /\bstock_movements\b/i,
      /\bjournal_entries\b/i,
      /\bjournal_lines\b/i,
      /\bcashbox/i,
    ]) {
      expect(code).not.toMatch(pat);
    }
  });
});
