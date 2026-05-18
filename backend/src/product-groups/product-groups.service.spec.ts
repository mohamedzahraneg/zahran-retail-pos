/**
 * product-groups.service.spec.ts — PR-P9.1a
 *
 * Pins ProductGroupsService CRUD + membership behavior and the
 * STATIC GUARDRAIL: the service writes ONLY to product_groups +
 * product_group_variants — never to prices, stock, GL, cashbox,
 * supplier ledger, supplier payments, or any other write surface.
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProductGroupsService } from './product-groups.service';

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
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProductGroupsService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  return { service: moduleRef.get(ProductGroupsService), calls };
}

const GID = '11111111-1111-1111-1111-111111111111';
const VID = '22222222-2222-2222-2222-222222222222';
const VID2 = '33333333-3333-3333-3333-333333333333';
const USER = '99999999-9999-9999-9999-999999999999';

describe('ProductGroupsService.create', () => {
  it('inserts a row with trimmed name + nullable optional columns', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: GID, name_ar: 'مجموعة الصيف', is_active: true }],
      ],
    });
    const row = await service.create(
      { name_ar: '  مجموعة الصيف  ' } as any,
      USER,
    );
    expect((row as any).id).toBe(GID);
    const insert = calls.find((c) =>
      /INSERT INTO\s+product_groups/i.test(c.sql),
    );
    expect(insert).toBeDefined();
    expect(insert!.params).toEqual([
      'مجموعة الصيف',
      null,
      null,
      null,
      USER,
    ]);
  });

  it('rejects blank name_ar with Arabic message', async () => {
    const { service } = await makeService();
    await expect(
      service.create({ name_ar: '   ' } as any),
    ).rejects.toMatchObject({ message: 'اسم المجموعة مطلوب' });
  });
});

describe('ProductGroupsService.update', () => {
  it('builds dynamic UPDATE for non-undefined fields only', async () => {
    const { service, calls } = await makeService({
      responses: [[{ id: GID, name_ar: 'تخفيضات' }]],
    });
    await service.update(GID, { name_ar: 'تخفيضات', is_active: false });
    const upd = calls.find((c) =>
      /UPDATE\s+product_groups\s+SET/i.test(c.sql),
    );
    expect(upd).toBeDefined();
    // We do not assert exact SQL placement (set order) — only that
    // the changed columns are present and the row id is the last
    // bound param.
    expect(upd!.sql).toMatch(/name_ar/);
    expect(upd!.sql).toMatch(/is_active/);
    expect(upd!.sql).toMatch(/updated_at\s*=\s*NOW\(\)/);
    expect(upd!.params).toContain(GID);
    expect(upd!.params).toContain('تخفيضات');
    expect(upd!.params).toContain(false);
  });

  it('rejects PATCH that blanks name_ar', async () => {
    const { service } = await makeService();
    await expect(
      service.update(GID, { name_ar: '   ' }),
    ).rejects.toMatchObject({
      message: 'اسم المجموعة لا يمكن أن يكون فارغًا',
    });
  });

  it('throws NotFoundException when the row does not exist', async () => {
    const { service } = await makeService({ responses: [[]] });
    await expect(
      service.update(GID, { name_ar: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ProductGroupsService.remove (soft-delete)', () => {
  it('flips is_active=false instead of DELETE', async () => {
    const { service, calls } = await makeService({
      responses: [[{ id: GID }]],
    });
    const res = await service.remove(GID);
    expect(res).toEqual({ deactivated: true, id: GID });
    const upd = calls.find((c) =>
      /UPDATE\s+product_groups\s+SET\s+is_active\s*=\s*FALSE/i.test(c.sql),
    );
    expect(upd).toBeDefined();
    // No DELETE FROM ever issued.
    expect(
      calls.find((c) => /DELETE FROM\s+product_groups\b/i.test(c.sql)),
    ).toBeUndefined();
  });

  it('throws NotFoundException for missing group', async () => {
    const { service } = await makeService({ responses: [[]] });
    await expect(service.remove(GID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('ProductGroupsService.addVariants', () => {
  it('rejects empty list', async () => {
    const { service } = await makeService();
    await expect(
      service.addVariants(GID, { variant_ids: [] } as any),
    ).rejects.toMatchObject({ message: 'قائمة الأصناف مطلوبة' });
  });

  it('rejects > 500 variants', async () => {
    const { service } = await makeService();
    const ids = Array.from(
      { length: 501 },
      (_, i) =>
        `${i.toString(16).padStart(8, '0')}-1111-1111-1111-111111111111`,
    );
    await expect(
      service.addVariants(GID, { variant_ids: ids } as any),
    ).rejects.toMatchObject({
      message: 'عدد الأصناف كبير جدًا. أضف بدفعات لا تتجاوز 500.',
    });
  });

  it('throws NotFound when the group is missing', async () => {
    const { service } = await makeService({ responses: [[]] });
    await expect(
      service.addVariants(GID, { variant_ids: [VID] } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('idempotent INSERT: uses ON CONFLICT DO NOTHING + reports added/skipped', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: GID }],          // group exists
        [{ cnt: 1 }],           // count before
        [],                     // INSERT
        [{ cnt: 2 }],           // count after
      ],
    });
    const res = await service.addVariants(
      GID,
      { variant_ids: [VID, VID2] } as any,
      USER,
    );
    expect(res).toEqual({
      group_id: GID,
      requested: 2,
      added: 1,
      skipped: 1,
      member_count: 2,
    });
    const insert = calls.find((c) =>
      /INSERT INTO\s+product_group_variants/i.test(c.sql),
    );
    expect(insert).toBeDefined();
    expect(insert!.sql).toMatch(/ON CONFLICT DO NOTHING/i);
    expect(insert!.params[0]).toBe(GID);
    expect(insert!.params[1]).toEqual([VID, VID2]);
    expect(insert!.params[2]).toBe(USER);
  });
});

describe('ProductGroupsService.removeVariant', () => {
  it('issues DELETE on the membership row', async () => {
    const { service, calls } = await makeService({
      responses: [[], [{ cnt: 5 }]],
    });
    const res = await service.removeVariant(GID, VID);
    expect(res.group_id).toBe(GID);
    expect(res.variant_id).toBe(VID);
    expect(res.member_count).toBe(5);
    const del = calls.find((c) =>
      /DELETE FROM\s+product_group_variants[\s\S]*?WHERE\s+group_id\s*=\s*\$1\s+AND\s+variant_id\s*=\s*\$2/i.test(
        c.sql,
      ),
    );
    expect(del).toBeDefined();
    expect(del!.params).toEqual([GID, VID]);
  });
});

describe('ProductGroupsService.list / findOne', () => {
  it('list returns member_count via LEFT JOIN aggregate', async () => {
    const { service, calls } = await makeService({
      responses: [[{ id: GID, name_ar: 'X', member_count: 3 }]],
    });
    const rows = await service.list({});
    expect(rows).toHaveLength(1);
    const q = calls[0];
    expect(q.sql).toMatch(/product_groups/);
    expect(q.sql).toMatch(/COALESCE\(m\.cnt,\s*0\)::int\s+AS\s+member_count/);
  });

  it('list q filter binds the ILIKE pattern', async () => {
    const { service, calls } = await makeService({ responses: [[]] });
    await service.list({ q: '  صيف  ' });
    expect(calls[0].sql).toMatch(/ILIKE/i);
    expect(calls[0].params[0]).toBe('%صيف%');
  });

  it('list is_active filter is bound as boolean', async () => {
    const { service, calls } = await makeService({ responses: [[]] });
    await service.list({ is_active: false });
    expect(calls[0].sql).toMatch(/g\.is_active\s*=\s*\$1/);
    expect(calls[0].params[0]).toBe(false);
  });

  it('findOne throws 404 when group missing', async () => {
    const { service } = await makeService({ responses: [[]] });
    await expect(service.findOne(GID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('findOne returns header + members joined to variants', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: GID, name_ar: 'X', is_active: true }],
        [
          {
            variant_id: VID,
            sku: 'A-1',
            current_cost_price: '50.00',
            current_selling_price: '100.00',
            stock_on_hand: 5,
          },
        ],
      ],
    });
    const res: any = await service.findOne(GID);
    expect(res.id).toBe(GID);
    expect(res.members).toHaveLength(1);
    expect(res.members[0].sku).toBe('A-1');
    // Members query joins product_variants + products + colors + sizes
    // + stock — but never writes anything.
    const membersQ = calls[1];
    expect(membersQ.sql).toMatch(/FROM\s+product_group_variants\s+pgv/);
    expect(membersQ.sql).toMatch(/JOIN\s+product_variants\s+pv/);
    expect(membersQ.sql).toMatch(/LEFT JOIN\s+\(/);
  });
});

describe('STATIC GUARDRAIL — product-groups write footprint', () => {
  const SRC = readFileSync(
    join(__dirname, 'product-groups.service.ts'),
    'utf8',
  );
  const stripped = SRC.split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

  it('only INSERTs into product_groups + product_group_variants', () => {
    const inserts = stripped.match(/INSERT INTO\s+(\w+)/gi) || [];
    for (const ins of inserts) {
      expect(ins).toMatch(
        /INSERT INTO\s+(product_groups|product_group_variants)\b/i,
      );
    }
  });

  it('only UPDATEs product_groups', () => {
    const updates = stripped.match(/UPDATE\s+\w+\s+SET/gi) || [];
    for (const upd of updates) {
      expect(upd).toMatch(/UPDATE\s+product_groups\s+SET/i);
    }
  });

  it('only DELETEs product_group_variants (group rows soft-delete)', () => {
    const deletes = stripped.match(/DELETE FROM\s+(\w+)/gi) || [];
    for (const del of deletes) {
      expect(del).toMatch(/DELETE FROM\s+product_group_variants\b/i);
    }
  });

  it('no `selling_price =` / `cost_price =` writes', () => {
    // Word-boundary anchors keep the regex from matching the read-only
    // SELECT aliases `current_selling_price` / `current_cost_price`.
    expect(stripped).not.toMatch(/\bselling_price\s*=/i);
    expect(stripped).not.toMatch(/\bcost_price\s*=/i);
  });

  it('no stock / GL / cashbox / supplier ledger touch', () => {
    expect(stripped).not.toMatch(/INSERT INTO\s+stock_movements/i);
    expect(stripped).not.toMatch(/UPDATE\s+stock\b/i);
    expect(stripped).not.toMatch(/\bavg_cost\s*=/i);
    expect(stripped).not.toMatch(/journal_entries/i);
    expect(stripped).not.toMatch(/journal_lines/i);
    expect(stripped).not.toMatch(/cashbox_transactions/i);
    expect(stripped).not.toMatch(/cashbox_balances/i);
    expect(stripped).not.toMatch(/supplier_ledger/i);
    expect(stripped).not.toMatch(/supplier_payments/i);
    expect(stripped).not.toMatch(/supplier_payment_allocations/i);
  });

  it('no forbidden helpers or engine references', () => {
    expect(stripped).not.toMatch(/postPurchase\b/);
    expect(stripped).not.toMatch(/postSupplierPayment\b/);
    expect(stripped).not.toMatch(/postInvoiceEdit\b/);
    expect(stripped).not.toMatch(/reverseByReference\b/);
    expect(stripped).not.toMatch(/recordTransaction\b/);
    expect(stripped).not.toMatch(/financialEngine/i);
    expect(stripped).not.toMatch(/posting\.service\b/);
    expect(stripped).not.toMatch(/fn_void_purchase\b/);
    expect(stripped).not.toMatch(/fn_record_cashbox_txn\b/);
  });
});

describe('STATIC GUARDRAIL — product-groups controller has no apply verb', () => {
  const SRC = readFileSync(
    join(__dirname, 'product-groups.controller.ts'),
    'utf8',
  );
  const stripped = SRC.split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

  it('controller exposes only CRUD + membership verbs', () => {
    expect(stripped).not.toMatch(/\/apply\b/);
    expect(stripped).not.toMatch(/\/preview\b/);
    expect(stripped).not.toMatch(/applyVariantPrices/);
    expect(stripped).not.toMatch(/smartPricing/);
    expect(stripped).not.toMatch(/costAdjustment/);
  });

  it('all write routes are gated by products.groups_manage', () => {
    const writeRoutes = ['POST', 'PATCH', 'DELETE'];
    // The class-level decorator gates reads with products.view. Each
    // method that mutates state must additionally declare
    // products.groups_manage.
    const groupManageHits =
      stripped.match(/@Permissions\('products\.groups_manage'\)/g) || [];
    // 5 write methods: create, update, remove, addVariants, removeVariant
    expect(groupManageHits.length).toBe(5);
    // Sanity: writeRoutes mentioned for completeness, but only counted
    // via the permission decorator above.
    expect(writeRoutes.length).toBe(3);
  });
});
