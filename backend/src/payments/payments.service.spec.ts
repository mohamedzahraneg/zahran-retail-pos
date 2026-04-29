/**
 * payments.service.spec.ts — PR-FIN-PAYACCT-4A
 *
 * Pins the admin-API contract for `payment_accounts`:
 *
 *   • create + update validate the optional cashbox_id ↔ method-kind match
 *   • toggleActive flips `active` + clears `is_default` on deactivate
 *   • deleteAccount is soft when the account is referenced by any
 *     invoice/customer/supplier payment; hard otherwise
 *   • resolveForPosting now returns the new `cashbox_id` field so the
 *     downstream PR-FIN-PAYACCT-4C posting path can tag the cash leg
 *
 * The DataSource is stubbed — no real Postgres. The test asserts the
 * SQL strings + parameter tuples the service emits, plus the call
 * shape the caller observes (returned shape, thrown errors).
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';

type QueryCall = { sql: string; params: any[] };

/**
 * Stateful fake DataSource. `dsResults`/`emResults` are queues consumed
 * left-to-right by the corresponding `.query` call. Empty queue
 * defaults to `[]` (modeling a SELECT with no rows).
 */
function makeFakeDataSource(opts: {
  dsResults?: any[][];
  emResults?: any[][];
}) {
  const dsCalls: QueryCall[] = [];
  const emCalls: QueryCall[] = [];
  let dsIdx = 0;
  let emIdx = 0;
  const em = {
    query: async (sql: string, params: any[] = []) => {
      emCalls.push({ sql, params });
      const next = (opts.emResults ?? [])[emIdx++];
      return next ?? [];
    },
  };
  const ds: any = {
    query: async (sql: string, params: any[] = []) => {
      dsCalls.push({ sql, params });
      const next = (opts.dsResults ?? [])[dsIdx++];
      return next ?? [];
    },
    transaction: async (cb: (em: any) => Promise<any>) => cb(em),
  };
  return { ds, dsCalls, emCalls };
}

async function makeService(opts: {
  dsResults?: any[][];
  emResults?: any[][];
}): Promise<{
  service: PaymentsService;
  dsCalls: QueryCall[];
  emCalls: QueryCall[];
  ds: any;
}> {
  const { ds, dsCalls, emCalls } = makeFakeDataSource(opts);
  const moduleRef = await Test.createTestingModule({
    providers: [PaymentsService, { provide: DataSource, useValue: ds }],
  }).compile();
  const service = moduleRef.get(PaymentsService);
  return { service, dsCalls, emCalls, ds };
}

describe('PaymentsService — PR-FIN-PAYACCT-4A admin API', () => {
  // ─────────────────────────────────────────────────────────────────
  // create
  // ─────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('rejects empty display_name with Arabic message before any SQL fires', async () => {
      const { service, emCalls } = await makeService({});

      await expect(
        service.create(
          {
            method: 'instapay',
            display_name: '   ',
            gl_account_code: '1114',
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/اسم العرض مطلوب/);
      expect(emCalls).toHaveLength(0);
    });

    it('rejects is_default=true with active=false up front', async () => {
      const { service, emCalls } = await makeService({});

      await expect(
        service.create(
          {
            method: 'instapay',
            display_name: 'InstaPay',
            gl_account_code: '1114',
            is_default: true,
            active: false,
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/لا يمكن تعيين حساب غير مفعل كافتراضي/);
      expect(emCalls).toHaveLength(0);
    });

    it('without cashbox_id: validator skips, INSERT carries NULL for cashbox_id col', async () => {
      const { service, emCalls } = await makeService({
        emResults: [
          [{ id: 'pa-1' }],   // INSERT
          [{ id: 'pa-1', method: 'instapay', display_name: 'InstaPay' }], // SELECT
        ],
      });

      await service.create(
        {
          method: 'instapay',
          provider_key: 'instapay',
          display_name: 'InstaPay',
          identifier: '0100…',
          gl_account_code: '1114',
        } as any,
        'user-1',
      );

      const insert = emCalls.find((c) => /INSERT INTO payment_accounts/.test(c.sql))!;
      expect(insert).toBeDefined();
      // The column tuple includes cashbox_id; the value is null.
      expect(insert.sql).toMatch(/cashbox_id/);
      expect(insert.params).toContain(null); // cashbox_id slot
    });

    it('with cashbox_id: validator runs FIRST → rejects mismatched kind (instapay → bank cashbox is invalid)', async () => {
      // emResults queue: [SELECT cashboxes from validator → returns kind=bank]
      const { service, emCalls } = await makeService({
        emResults: [[{ id: 'cb-bank-1', kind: 'bank' }]],
      });

      await expect(
        service.create(
          {
            method: 'instapay',
            display_name: 'InstaPay',
            gl_account_code: '1114',
            cashbox_id: 'cb-bank-1',
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/غير متوافقة|ewallet/);

      // No INSERT happened (validator threw before).
      expect(
        emCalls.some((c) => /INSERT INTO payment_accounts/.test(c.sql)),
      ).toBe(false);
    });

    it('with cashbox_id: kind matches method group (instapay → ewallet) → INSERT carries cashbox_id', async () => {
      const { service, emCalls } = await makeService({
        emResults: [
          [{ id: 'cb-w-1', kind: 'ewallet' }],   // validator SELECT
          [{ id: 'pa-2' }],                       // INSERT RETURNING id
          [{ id: 'pa-2', method: 'instapay' }],  // SELECT for getById
        ],
      });

      await service.create(
        {
          method: 'instapay',
          display_name: 'InstaPay',
          gl_account_code: '1114',
          cashbox_id: 'cb-w-1',
        } as any,
        'user-1',
      );

      const insert = emCalls.find((c) => /INSERT INTO payment_accounts/.test(c.sql))!;
      expect(insert.params).toContain('cb-w-1');
    });

    it('cashbox_id pointing to non-existent cashbox → NotFoundException with Arabic message', async () => {
      const { service } = await makeService({
        emResults: [[]], // validator SELECT returns empty
      });

      await expect(
        service.create(
          {
            method: 'instapay',
            display_name: 'InstaPay',
            gl_account_code: '1114',
            cashbox_id: 'cb-missing',
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/الخزنة المرتبطة.*غير موجودة/);
    });

    it('credit/other methods cannot have cashbox_id (no physical mapping)', async () => {
      const { service } = await makeService({
        emResults: [[{ id: 'cb-1', kind: 'cash' }]], // pretend the cashbox exists
      });

      await expect(
        service.create(
          {
            method: 'credit',
            display_name: 'Credit line',
            gl_account_code: '1114',
            cashbox_id: 'cb-1',
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/لا يمكن ربط حساب طريقة الدفع/);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // update
  // ─────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('cashbox_id=null clears the pin without re-validating', async () => {
      const { service, emCalls } = await makeService({
        emResults: [
          [], // UPDATE
          [{ id: 'pa-3', method: 'instapay', cashbox_id: null }],   // SELECT for getById
        ],
      });

      await service.update('pa-3', { cashbox_id: null } as any, 'user-1');

      const update = emCalls.find((c) => /UPDATE payment_accounts/.test(c.sql))!;
      expect(update).toBeDefined();
      expect(update.sql).toMatch(/cashbox_id\s*=\s*\$/);
      expect(update.params).toContain(null);
      // No validator SELECT cashboxes (cashbox_id=null short-circuits).
      expect(emCalls.some((c) => /FROM cashboxes WHERE id/.test(c.sql))).toBe(false);
    });

    it('cashbox_id non-null → re-reads method, validates, then UPDATE', async () => {
      // emResults order:
      //   [0] SELECT method FROM payment_accounts (re-read)
      //   [1] SELECT FROM cashboxes (validator)
      //   [2] UPDATE payment_accounts
      //   [3] SELECT * (getById)
      const { service, emCalls } = await makeService({
        emResults: [
          [{ method: 'wallet' }],
          [{ id: 'cb-w-2', kind: 'ewallet' }],
          [],
          [{ id: 'pa-4' }],
        ],
      });

      await service.update(
        'pa-4',
        { cashbox_id: 'cb-w-2' } as any,
        'user-1',
      );

      // Order matters: re-read before validator before UPDATE.
      const idx = (re: RegExp) =>
        emCalls.findIndex((c) => re.test(c.sql));
      expect(idx(/method::text AS method FROM payment_accounts/)).toBeGreaterThanOrEqual(0);
      expect(idx(/FROM cashboxes WHERE id/)).toBeGreaterThan(
        idx(/method::text AS method FROM payment_accounts/),
      );
      expect(idx(/UPDATE payment_accounts/)).toBeGreaterThan(
        idx(/FROM cashboxes WHERE id/),
      );
    });

    it('rejects empty display_name update with Arabic message', async () => {
      const { service } = await makeService({});

      await expect(
        service.update('pa-5', { display_name: '   ' } as any, 'user-1'),
      ).rejects.toThrow(/فارغاً/);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // toggleActive
  // ─────────────────────────────────────────────────────────────────

  describe('toggleActive', () => {
    it('inactive → active: UPDATE only sets active=TRUE (does NOT touch is_default)', async () => {
      const { service, emCalls } = await makeService({
        emResults: [
          [{ active: false }],            // SELECT FOR UPDATE
          [],                              // UPDATE
          [{ id: 'pa-6', active: true }], // SELECT (getById)
        ],
      });

      await service.toggleActive('pa-6', 'user-1');

      const update = emCalls.find((c) => /UPDATE payment_accounts/.test(c.sql))!;
      // The activate branch sets active=TRUE; is_default stays as-is.
      expect(update.sql).toMatch(/active\s*=\s*TRUE/);
      expect(update.sql).not.toMatch(/is_default/);
    });

    it('active → inactive: UPDATE forces is_default=FALSE and active=FALSE', async () => {
      const { service, emCalls } = await makeService({
        emResults: [
          [{ active: true }],
          [],
          [{ id: 'pa-7', active: false, is_default: false }],
        ],
      });

      await service.toggleActive('pa-7', 'user-1');

      const update = emCalls.find((c) => /UPDATE payment_accounts/.test(c.sql))!;
      expect(update.sql).toMatch(/active\s*=\s*FALSE/);
      expect(update.sql).toMatch(/is_default\s*=\s*FALSE/);
    });

    it('missing row → NotFoundException', async () => {
      const { service } = await makeService({ emResults: [[]] });
      await expect(service.toggleActive('pa-missing', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // deleteAccount
  // ─────────────────────────────────────────────────────────────────

  describe('deleteAccount', () => {
    it('unused account → hard-delete returns mode:hard', async () => {
      const { service, emCalls } = await makeService({
        emResults: [
          [{ id: 'pa-8' }],               // SELECT FOR UPDATE
          [{ usage_count: 0 }],           // SELECT count(*) usage
          [],                              // DELETE
        ],
      });

      const out = await service.deleteAccount('pa-8', 'user-1');
      expect(out).toEqual({ id: 'pa-8', mode: 'hard' });
      expect(emCalls.some((c) => /DELETE FROM payment_accounts/.test(c.sql))).toBe(
        true,
      );
      expect(
        emCalls.some((c) =>
          /UPDATE payment_accounts[\s\S]*active = FALSE/.test(c.sql),
        ),
      ).toBe(false);
    });

    it('used by any payment table → soft-delete returns mode:soft', async () => {
      const { service, emCalls } = await makeService({
        emResults: [
          [{ id: 'pa-9' }],
          [{ usage_count: 3 }],   // referenced 3 times across the 3 tables
          [],                      // soft-delete UPDATE
        ],
      });

      const out = await service.deleteAccount('pa-9', 'user-1');
      expect(out).toEqual({ id: 'pa-9', mode: 'soft' });
      expect(
        emCalls.some((c) => /DELETE FROM payment_accounts/.test(c.sql)),
      ).toBe(false);
      const softUpdate = emCalls.find((c) =>
        /UPDATE payment_accounts[\s\S]*active = FALSE/.test(c.sql),
      )!;
      expect(softUpdate).toBeDefined();
      expect(softUpdate.sql).toMatch(/is_default = FALSE/);
    });

    it('missing row → NotFoundException', async () => {
      const { service } = await makeService({ emResults: [[]] });
      await expect(service.deleteAccount('pa-missing', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('usage SQL counts the three relevant tables', async () => {
      const { service, emCalls } = await makeService({
        emResults: [[{ id: 'pa-10' }], [{ usage_count: 0 }], []],
      });
      await service.deleteAccount('pa-10', 'user-1');

      const usageSql = emCalls.find((c) => /usage_count/.test(c.sql))!;
      expect(usageSql.sql).toMatch(/invoice_payments/);
      expect(usageSql.sql).toMatch(/customer_payments/);
      expect(usageSql.sql).toMatch(/supplier_payments/);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // resolveForPosting (called by PR-PAY-1 + future PR-FIN-PAYACCT-4C)
  // ─────────────────────────────────────────────────────────────────

  describe('resolveForPosting', () => {
    it('null id → returns null without firing SQL', async () => {
      const { service, dsCalls } = await makeService({});
      const out = await service.resolveForPosting(null);
      expect(out).toBeNull();
      expect(dsCalls).toHaveLength(0);
    });

    it('returns the new cashbox_id column in the payload', async () => {
      const { service, dsCalls } = await makeService({
        dsResults: [
          [
            {
              id: 'pa-11',
              method: 'wallet',
              display_name: 'WE Pay',
              provider_key: 'we_pay',
              identifier: '0100…',
              gl_account_code: '1114',
              cashbox_id: 'cb-w-3',
              metadata: {},
            },
          ],
        ],
      });

      const out = await service.resolveForPosting('pa-11');
      expect(out).not.toBeNull();
      expect(out!.cashbox_id).toBe('cb-w-3');
      // Sanity: SELECT carries cashbox_id in the column list.
      expect(dsCalls[0].sql).toMatch(/cashbox_id/);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // setDefault — (regression: existing PR-PAY-2 hotfix behavior preserved)
  // ─────────────────────────────────────────────────────────────────

  describe('setDefault (regression — pre-existing behavior unchanged)', () => {
    it('inactive account → BadRequestException', async () => {
      const { service } = await makeService({
        emResults: [[{ method: 'wallet', active: false }]],
      });
      await expect(service.setDefault('pa-x', 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('active account → clears prior default + flips this row', async () => {
      const { service, emCalls } = await makeService({
        emResults: [
          [{ method: 'wallet', active: true }], // SELECT FOR UPDATE
          [],                                     // UPDATE clear prior
          [],                                     // UPDATE set new default
          [{ id: 'pa-y', is_default: true }],   // getById
        ],
      });
      await service.setDefault('pa-y', 'user-1');

      const updates = emCalls.filter((c) => /UPDATE payment_accounts/.test(c.sql));
      expect(updates).toHaveLength(2);
      expect(updates[0].sql).toMatch(/SET\s+is_default\s*=\s*FALSE/);
      expect(updates[1].sql).toMatch(/SET\s+is_default\s*=\s*TRUE/);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // create — pg conflict translation (regression)
  // ─────────────────────────────────────────────────────────────────

  describe('create — partial unique index conflict', () => {
    it('translates ux_payment_accounts_default_per_method conflict to ConflictException with Arabic message', async () => {
      const { ds } = makeFakeDataSource({});
      // Override to throw the constraint name on the INSERT.
      const moduleRef = await Test.createTestingModule({
        providers: [
          PaymentsService,
          {
            provide: DataSource,
            useValue: {
              ...ds,
              transaction: async (cb: any) =>
                cb({
                  query: async (_sql: string) => {
                    const err: any = new Error(
                      'duplicate key value violates unique constraint "ux_payment_accounts_default_per_method"',
                    );
                    err.detail = 'ux_payment_accounts_default_per_method';
                    throw err;
                  },
                }),
            },
          },
        ],
      }).compile();
      const service = moduleRef.get(PaymentsService);

      await expect(
        service.create(
          {
            method: 'instapay',
            display_name: 'InstaPay',
            gl_account_code: '1114',
            is_default: true,
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(ConflictException);
    });
  });
});

/* ============================================================================
 * PR-FIN-PAYACCT-4B — listBalances() + cheque method support
 * ----------------------------------------------------------------------------
 * Pins:
 *   • listBalances composes payment_accounts × v_payment_account_balance
 *     and returns one row per account (active OR inactive — inactive
 *     rows fall through the LEFT JOIN to 0/0/0/null).
 *   • cheque method 'check' is accepted by validateCashboxKindMatch
 *     when paired with a cashbox of kind='check'.
 * ========================================================================== */
describe('PaymentsService — PR-FIN-PAYACCT-4B', () => {
  describe('listBalances', () => {
    it('emits a SQL that LEFT JOINs v_payment_account_balance and orders by method/sort_order/display_name', async () => {
      const { service, dsCalls } = await makeService({
        dsResults: [[]], // empty result OK; we are asserting the SQL
      });

      await service.listBalances({});
      expect(dsCalls).toHaveLength(1);
      const sql = dsCalls[0].sql;
      expect(sql).toMatch(/FROM payment_accounts pa/);
      expect(sql).toMatch(/LEFT JOIN v_payment_account_balance b/);
      expect(sql).toMatch(/LEFT JOIN chart_of_accounts coa/);
      expect(sql).toMatch(/ORDER BY pa\.method, pa\.sort_order, pa\.display_name/);
      // No filter clauses when filter is empty.
      expect(sql).not.toMatch(/WHERE/);
    });

    it('applies method + active filters when supplied', async () => {
      const { service, dsCalls } = await makeService({ dsResults: [[]] });
      await service.listBalances({ method: 'instapay', active: 'true' });
      const call = dsCalls[0];
      expect(call.sql).toMatch(/WHERE pa\.method = \$1::payment_method_code/);
      expect(call.sql).toMatch(/AND pa\.active = \$2/);
      expect(call.params).toEqual(['instapay', true]);
    });

    it('returns the row shape the FE expects (payment_account_id, net_debit, je_count, last_movement, …)', async () => {
      const fake = [
        {
          payment_account_id: 'pa-1',
          method: 'instapay',
          provider_key: 'instapay',
          display_name: 'InstaPay',
          identifier: '0100…',
          gl_account_code: '1114',
          cashbox_id: null,
          is_default: true,
          active: true,
          sort_order: 0,
          metadata: {},
          gl_name_ar: 'المحافظ الإلكترونية',
          normal_balance: 'debit',
          total_in: '1700.00',
          total_out: '0.00',
          net_debit: '1700.00',
          je_count: 6,
          last_movement: '2026-04-29',
        },
      ];
      const { service } = await makeService({ dsResults: [fake] });
      const out = await service.listBalances();
      expect(out).toHaveLength(1);
      expect(out[0].payment_account_id).toBe('pa-1');
      expect(out[0].net_debit).toBe('1700.00');
      expect(out[0].je_count).toBe(6);
      expect(out[0].last_movement).toBe('2026-04-29');
    });
  });

  describe('cheque method support', () => {
    it('accepts cashbox_id when method=check + cashbox.kind=check', async () => {
      const { service, emCalls } = await makeService({
        emResults: [
          [{ id: 'cb-check-1', kind: 'check' }], // validator SELECT
          [{ id: 'pa-check' }],                   // INSERT RETURNING id
          [{ id: 'pa-check', method: 'check' }],  // SELECT for getById
        ],
      });

      await service.create(
        {
          method: 'check',
          display_name: 'دفتر شيكات NBE',
          gl_account_code: '1115',
          cashbox_id: 'cb-check-1',
        } as any,
        'user-1',
      );

      const insert = emCalls.find((c) => /INSERT INTO payment_accounts/.test(c.sql))!;
      expect(insert.params).toContain('cb-check-1');
    });

    it('rejects mismatched kind (check method paired with non-check cashbox)', async () => {
      const { service } = await makeService({
        emResults: [[{ id: 'cb-bank-1', kind: 'bank' }]], // validator SELECT
      });

      await expect(
        service.create(
          {
            method: 'check',
            display_name: 'دفتر شيكات',
            gl_account_code: '1115',
            cashbox_id: 'cb-bank-1', // mismatched kind
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/غير متوافقة|check/);
    });
  });
});

/* ============================================================================
 * PR-FIN-PAYACCT-4D — methodMix() over v_dashboard_payment_mix_30d
 * ----------------------------------------------------------------------------
 * Pins:
 *   • methodMix issues a SELECT against v_dashboard_payment_mix_30d.
 *   • The result is ordered by total_amount DESC NULLS LAST so the FE
 *     gets dominant methods first.
 *   • The `days` parameter is accepted but does NOT mutate the SQL —
 *     today the view ships with a fixed 30-day window. Forward-compat
 *     contract: any positive `days` returns the same payload (the
 *     controller defaults non-positive to 30).
 *   • The row shape is exactly { payment_method, transactions,
 *     total_amount, pct } — what the FE's "آخر 30 يوم" card consumes.
 * ========================================================================== */
describe('PaymentsService — PR-FIN-PAYACCT-4D methodMix', () => {
  it('selects from v_dashboard_payment_mix_30d ordered by total_amount DESC', async () => {
    const { service, dsCalls } = await makeService({ dsResults: [[]] });

    await service.methodMix(30);
    expect(dsCalls).toHaveLength(1);
    const sql = dsCalls[0].sql;
    expect(sql).toMatch(/FROM v_dashboard_payment_mix_30d/);
    expect(sql).toMatch(/ORDER BY total_amount DESC NULLS LAST/);
    // Read-only: no filter parameters bound — the SQL has no $N placeholders.
    expect(sql).not.toMatch(/\$\d/);
  });

  it('returns the row shape the FE consumes (payment_method, transactions, total_amount, pct)', async () => {
    const fake = [
      { payment_method: 'cash',     transactions: 94, total_amount: '28720.01', pct: '94.41' },
      { payment_method: 'instapay', transactions: 4,  total_amount:  '1400.00', pct:  '4.60' },
      { payment_method: 'wallet',   transactions: 2,  total_amount:   '300.00', pct:  '0.99' },
    ];
    const { service } = await makeService({ dsResults: [fake] });

    const out = await service.methodMix();
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      payment_method: 'cash',
      transactions: 94,
      total_amount: '28720.01',
      pct: '94.41',
    });
    expect(out[2].payment_method).toBe('wallet');
  });

  it('does not mutate the SQL when called with non-30 days (forward-compat contract)', async () => {
    const { service, dsCalls } = await makeService({ dsResults: [[]] });
    await service.methodMix(60);
    await service.methodMix(7);
    expect(dsCalls).toHaveLength(2);
    expect(dsCalls[0].sql).toBe(dsCalls[1].sql);
    expect(dsCalls[0].sql).toMatch(/v_dashboard_payment_mix_30d/);
  });
});
