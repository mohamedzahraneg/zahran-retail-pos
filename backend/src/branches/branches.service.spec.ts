/**
 * branches.service.spec.ts — PR-BRANCHES-WAREHOUSES-FOUNDATION
 *
 * Pins BranchesService CRUD + warehouse-linking behavior and the
 * STATIC GUARDRAIL: the service writes ONLY to `branches` and
 * `warehouse_branches`. It must NOT write to stock, stock_movements,
 * invoices, purchases, returns, stock_transfers, inventory_counts,
 * cashboxes, journal_entries, journal_lines, supplier_*, payment_*.
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
import { BranchesService } from './branches.service';

type QueryCall = { sql: string; params: any[] };

interface MakeOpts {
  responses?: Array<any[]>;
}

async function makeService(opts: MakeOpts = {}) {
  const queue = [...(opts.responses ?? [])];
  const calls: QueryCall[] = [];
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return queue.length ? queue.shift() : [];
    }),
    transaction: jest.fn(async (cb: any) => {
      const mgr = {
        query: jest.fn(async (sql: string, params: any[] = []) => {
          calls.push({ sql, params });
          return queue.length ? queue.shift() : [];
        }),
      };
      return cb(mgr);
    }),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [BranchesService, { provide: DataSource, useValue: ds }],
  }).compile();
  return { service: moduleRef.get(BranchesService), calls };
}

const BID = '11111111-1111-1111-1111-111111111111';
const WID = '22222222-2222-2222-2222-222222222222';

describe('BranchesService.create', () => {
  it('inserts with trimmed code + name_ar and defaults type=retail', async () => {
    const { service, calls } = await makeService({
      responses: [
        // duplicate-check returns no row
        [],
        // INSERT returns the new row
        [{ id: BID, code: 'CAI-01', name_ar: 'فرع القاهرة' }],
      ],
    });
    const row = await service.create({
      code: '  CAI-01  ',
      name_ar: '  فرع القاهرة  ',
    } as any);
    expect((row as any).id).toBe(BID);
    const insert = calls.find((c) => /INSERT INTO\s+branches/i.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe('CAI-01');
    expect(insert!.params[1]).toBe('فرع القاهرة');
    expect(insert!.params[3]).toBe('retail');
  });

  it('rejects blank code', async () => {
    const { service } = await makeService();
    await expect(
      service.create({ code: '   ', name_ar: 'X' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects blank name_ar', async () => {
    const { service } = await makeService();
    await expect(
      service.create({ code: 'X', name_ar: '   ' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid type', async () => {
    const { service } = await makeService();
    await expect(
      service.create({
        code: 'X',
        name_ar: 'X',
        type: 'spaceship',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects duplicate code with 409', async () => {
    const { service } = await makeService({
      responses: [[{ id: 'someone-else' }]],
    });
    await expect(
      service.create({ code: 'CAI-01', name_ar: 'X' } as any),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('BranchesService.update', () => {
  it('builds dynamic UPDATE for non-undefined fields only', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: BID, code: 'CAI-01', name_ar: 'Q' }],
      ],
    });
    await service.update(BID, { name_ar: 'الجديد' });
    const upd = calls.find((c) => /UPDATE\s+branches/i.test(c.sql));
    expect(upd).toBeDefined();
    expect(upd!.sql).toMatch(/SET\s+name_ar\s*=/);
    expect(upd!.sql).not.toMatch(/code\s*=/);
    expect(upd!.params).toEqual(['الجديد', BID]);
  });

  it('rejects new code that duplicates another row', async () => {
    const { service } = await makeService({
      responses: [[{ id: 'someone-else' }]],
    });
    await expect(
      service.update(BID, { code: 'CAI-01' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('BranchesService.linkWarehouse', () => {
  it('demotes existing primary BEFORE inserting a new primary link', async () => {
    const { service, calls } = await makeService({
      responses: [
        // findOne(branch)
        [{ id: BID }],
        // warehouse exists
        [{ id: WID }],
        // demote existing primaries (UPDATE) — no rows
        [],
        // upsert returning row
        [{ warehouse_id: WID, branch_id: BID, is_primary: true }],
      ],
    });
    const row = await service.linkWarehouse(BID, WID, { is_primary: true });
    expect(row).toMatchObject({ warehouse_id: WID, branch_id: BID });

    const demoteIdx = calls.findIndex((c) =>
      /UPDATE\s+warehouse_branches[\s\S]*SET\s+is_primary\s*=\s*FALSE/i.test(
        c.sql,
      ),
    );
    const upsertIdx = calls.findIndex((c) =>
      /INSERT INTO\s+warehouse_branches/i.test(c.sql),
    );
    expect(demoteIdx).toBeGreaterThanOrEqual(0);
    expect(upsertIdx).toBeGreaterThan(demoteIdx);
  });

  it('does not demote when is_primary is false', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: BID }],
        [{ id: WID }],
        [{ warehouse_id: WID, branch_id: BID, is_primary: false }],
      ],
    });
    await service.linkWarehouse(BID, WID);
    const demote = calls.find((c) =>
      /UPDATE\s+warehouse_branches[\s\S]*is_primary\s*=\s*FALSE/i.test(c.sql),
    );
    expect(demote).toBeUndefined();
  });

  it('throws 404 when the warehouse does not exist', async () => {
    const { service } = await makeService({
      responses: [[{ id: BID }], []],
    });
    await expect(
      service.linkWarehouse(BID, WID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('BranchesService.setPrimary', () => {
  it('demotes any current primary then promotes the requested link', async () => {
    const { service, calls } = await makeService({
      responses: [
        // findOne(branch)
        [{ id: BID }],
        // demote
        [],
        // promote returns the now-primary row
        [{ warehouse_id: WID, branch_id: BID, is_primary: true }],
      ],
    });
    await service.setPrimary(BID, WID);
    const demote = calls.find((c) =>
      /UPDATE\s+warehouse_branches[\s\S]*is_primary\s*=\s*FALSE/i.test(c.sql),
    );
    const promote = calls.find((c) =>
      /UPDATE\s+warehouse_branches[\s\S]*SET\s+is_primary\s*=\s*TRUE/i.test(
        c.sql,
      ),
    );
    expect(demote).toBeDefined();
    expect(promote).toBeDefined();
  });

  it('throws 404 when the link does not exist', async () => {
    const { service } = await makeService({
      responses: [[{ id: BID }], [], []],
    });
    await expect(
      service.setPrimary(BID, WID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('BranchesService.unlinkWarehouse', () => {
  it('deletes the row by composite key', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: BID }],
        [{ warehouse_id: WID }],
      ],
    });
    const out = await service.unlinkWarehouse(BID, WID);
    expect(out).toEqual({ unlinked: true });
    const del = calls.find((c) =>
      /DELETE FROM\s+warehouse_branches/i.test(c.sql),
    );
    expect(del).toBeDefined();
    expect(del!.params).toEqual([BID, WID]);
  });

  it('throws 404 when the link is not found', async () => {
    const { service } = await makeService({
      responses: [[{ id: BID }], []],
    });
    await expect(
      service.unlinkWarehouse(BID, WID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('BranchesService.listWarehousesWithBranches', () => {
  it('returns a pure SELECT with primary_branch + branches rollups', async () => {
    const { service, calls } = await makeService({
      responses: [
        [
          {
            id: WID,
            code: 'WH-01',
            primary_branch: null,
            branches: [],
          },
        ],
      ],
    });
    await service.listWarehousesWithBranches();
    expect(calls[0].sql).toMatch(/FROM\s+warehouses\s+w/i);
    expect(calls[0].sql).toMatch(/JOIN\s+branches\s+b/i);
    expect(calls[0].sql).toMatch(/primary_branch/);
    // No INSERT/UPDATE/DELETE in the SELECT.
    expect(calls[0].sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
  });
});

describe('STATIC GUARDRAIL — branches write footprint', () => {
  const SRC = readFileSync(
    join(__dirname, 'branches.service.ts'),
    'utf8',
  );
  // Strip `//` and `/* */` comments so doc strings that mention
  // forbidden tables (e.g. "no writes to stock") don't trip the
  // guard.
  const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /\/\/[^\n]*/g,
    '',
  );

  it('only INSERTs into branches or warehouse_branches', () => {
    const inserts = stripped.match(/INSERT INTO\s+(\w+)/gi) || [];
    expect(inserts.length).toBeGreaterThan(0);
    for (const ins of inserts) {
      expect(ins).toMatch(/INSERT INTO\s+(branches|warehouse_branches)\b/i);
    }
  });

  it('only UPDATEs branches or warehouse_branches', () => {
    const updates = stripped.match(/UPDATE\s+\w+\s+SET/gi) || [];
    expect(updates.length).toBeGreaterThan(0);
    for (const upd of updates) {
      expect(upd).toMatch(
        /UPDATE\s+(branches|warehouse_branches)\s+SET/i,
      );
    }
  });

  it('only DELETEs warehouse_branches', () => {
    const deletes = stripped.match(/DELETE FROM\s+(\w+)/gi) || [];
    for (const del of deletes) {
      expect(del).toMatch(/DELETE FROM\s+warehouse_branches\b/i);
    }
  });

  it('no stock / GL / cashbox / supplier-ledger touch', () => {
    expect(stripped).not.toMatch(/UPDATE\s+stock\b/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+stock\b/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+stock_movements/i);
    expect(stripped).not.toMatch(/UPDATE\s+stock_movements/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+invoices/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+invoice_items/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+purchases\b/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+purchase_items/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+returns\b/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+stock_transfers/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+inventory_counts/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+cashboxes\b/i);
    expect(stripped).not.toMatch(/journal_entries/i);
    expect(stripped).not.toMatch(/journal_lines/i);
    expect(stripped).not.toMatch(/cashbox_transactions/i);
    expect(stripped).not.toMatch(/supplier_ledger/i);
    expect(stripped).not.toMatch(/supplier_payments/i);
    expect(stripped).not.toMatch(/payment_allocations/i);
    expect(stripped).not.toMatch(/\bquantity_on_hand\s*=/i);
    expect(stripped).not.toMatch(/\bbalance_after_qty\s*=/i);
  });

  it('does not write business columns on the warehouses row', () => {
    // The service may SELECT from warehouses, but must NOT mutate it.
    expect(stripped).not.toMatch(/UPDATE\s+warehouses\b/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+warehouses\b/i);
    expect(stripped).not.toMatch(/DELETE FROM\s+warehouses\b/i);
  });

  it('does not reach into the financial engine helpers', () => {
    expect(stripped).not.toMatch(/postPurchase\b/);
    expect(stripped).not.toMatch(/postSupplierPayment\b/);
    expect(stripped).not.toMatch(/postInvoiceEdit\b/);
    expect(stripped).not.toMatch(/reverseByReference\b/);
    expect(stripped).not.toMatch(/recordTransaction\b/);
    expect(stripped).not.toMatch(/financialEngine/i);
    expect(stripped).not.toMatch(/posting\.service\b/);
    expect(stripped).not.toMatch(/fn_record_cashbox_txn\b/);
  });
});
