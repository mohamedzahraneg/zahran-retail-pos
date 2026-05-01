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
    it('PR-4D-UX-FIX-2: emits an account-specific aggregation (no longer joins v_payment_account_balance)', async () => {
      const { service, dsCalls } = await makeService({
        dsResults: [[]],
      });

      await service.listBalances({});
      expect(dsCalls).toHaveLength(1);
      const sql = dsCalls[0].sql;
      expect(sql).toMatch(/FROM payment_accounts pa/);
      expect(sql).toMatch(/LEFT JOIN chart_of_accounts coa/);
      // PR-FIN-PAYACCT-4D-UX-FIX-8: the final ORDER BY now operates on
      // the UNION result (attached_balances ⊎ unattached_balances), so
      // the column references are unqualified — `method, sort_order,
      // display_name` rather than `pa.method`. The semantics are the
      // same; both CTEs preserve the original column names.
      expect(sql).toMatch(/ORDER BY method, sort_order, display_name/);
      // The shared-bucket view is GONE from listBalances — that was the bug.
      expect(sql).not.toMatch(/v_payment_account_balance/);
      // The new aggregation reads strictly from account-tagged source tables,
      // each filtered by `payment_account_id = pa.id`.
      expect(sql).toMatch(/LEFT JOIN LATERAL/);
      expect(sql).toMatch(/FROM invoice_payments[\s\S]+WHERE payment_account_id = pa\.id/);
      expect(sql).toMatch(/FROM customer_payments[\s\S]+WHERE payment_account_id = pa\.id/);
      expect(sql).toMatch(/FROM supplier_payments[\s\S]+WHERE payment_account_id = pa\.id/);
      // Refunds flip to amount_out so the per-account balance reflects money OUT.
      expect(sql).toMatch(/CASE WHEN kind = 'refund_out' THEN 0::numeric ELSE amount END/);
      // Voided customer/supplier rows are excluded from aggregates.
      expect(sql).toMatch(/COALESCE\(is_void, FALSE\) = FALSE/);
      // No filter clauses when filter is empty.
      expect(sql).not.toMatch(/WHERE pa\./);
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

    it('PR-4D-UX-FIX-2: each account row gets its own aggregate (the LATERAL join is per-account)', async () => {
      // The DB result is what the SQL would produce — the test simply
      // asserts the service passes it through unmodified, proving the
      // FE sees per-account values rather than the previous shared
      // bucket (when 3 accounts shared GL=1114 they all read 1690).
      const fake = [
        // InstaPay — 3 account-specific rows totaling 365.
        { payment_account_id: 'pa-instapay', display_name: 'InstaPay',     gl_account_code: '1114', total_in: '365.00', total_out: '0.00', net_debit: '365.00', je_count: 3, last_movement: '2026-04-29' },
        // WE Pay — 3 account-specific rows totaling 305 (different from InstaPay!).
        { payment_account_id: 'pa-wepay',    display_name: 'WE Pay',       gl_account_code: '1114', total_in: '305.00', total_out: '0.00', net_debit: '305.00', je_count: 3, last_movement: '2026-04-28' },
        // Vodafone Cash — INACTIVE, zero account-specific rows → 0/0/0/null.
        { payment_account_id: 'pa-vodafone', display_name: 'Vodafone Cash تجريبي', gl_account_code: '1114', total_in:   '0.00', total_out: '0.00', net_debit:   '0.00', je_count: 0, last_movement: null },
      ];
      const { service } = await makeService({ dsResults: [fake] });
      const out = await service.listBalances();
      expect(out).toHaveLength(3);
      const byName = Object.fromEntries(out.map((r: any) => [r.display_name, r]));
      // CRITICAL: each row carries DIFFERENT totals — no bucket duplication.
      expect(byName['InstaPay'].net_debit).toBe('365.00');
      expect(byName['WE Pay'].net_debit).toBe('305.00');
      expect(byName['Vodafone Cash تجريبي'].net_debit).toBe('0.00');
      expect(byName['Vodafone Cash تجريبي'].je_count).toBe(0);
      expect(byName['Vodafone Cash تجريبي'].last_movement).toBeNull();
    });
  });

  /* ════════════════════════════════════════════════════════════════════
   * PR-FIN-PAYACCT-4D-UX-FIX-2 — listMovements (per-account operations
   * feed for the DetailsPanel modal). Strictly account-tagged data;
   * never reads from gl_account_code alone.
   * ════════════════════════════════════════════════════════════════════ */
  describe('listMovements', () => {
    it('emits a SQL that filters strictly by payment_account_id (never by gl_account_code)', async () => {
      const { service, dsCalls } = await makeService({
        dsResults: [[{ rows: [], total_count: 0, sum_in: '0', sum_out: '0', sum_net: '0' }]],
      });
      await service.listMovements('pa-1', {});
      const sql = dsCalls[0].sql;
      // All three source tables filter by payment_account_id, NOT by GL code.
      expect(sql).toMatch(/FROM invoice_payments ip[\s\S]+WHERE ip\.payment_account_id = \$1::uuid/);
      expect(sql).toMatch(/FROM customer_payments cp[\s\S]+WHERE cp\.payment_account_id = \$1::uuid/);
      expect(sql).toMatch(/FROM supplier_payments sp[\s\S]+WHERE sp\.payment_account_id = \$1::uuid/);
      // Voided rows excluded from cp/sp.
      expect(sql).toMatch(/cp[\s\S]+COALESCE\(cp\.is_void, FALSE\) = FALSE/);
      expect(sql).toMatch(/sp[\s\S]+COALESCE\(sp\.is_void, FALSE\) = FALSE/);
      // gl_account_code never appears as a movement filter.
      expect(sql).not.toMatch(/gl_account_code\s*=\s*/);
      // Customer-payment refund flips to amount_out per the approved decision.
      expect(sql).toMatch(/cp\.kind = 'refund_out'[\s\S]+cp\.amount[\s\S]+0::numeric/);
      // PR-4D-UX-FIX-2-HOTFIX-2: column references must match the real DB
      // schema, NOT the FE-type aliases (`doc_no`/`name_ar` are FE shape).
      expect(sql).toMatch(/cp\.payment_no/);
      expect(sql).toMatch(/sp\.payment_no/);
      expect(sql).not.toMatch(/cp\.doc_no/);
      expect(sql).not.toMatch(/sp\.doc_no/);
      // Suppliers expose `name`, not `name_ar`.
      expect(sql).toMatch(/s\.name(?!\w)/);
      expect(sql).not.toMatch(/s\.name_ar/);
      // Pure SELECT — no INSERT/UPDATE/DELETE.
      expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
    });

    it('binds from/to/type/q and limit/offset', async () => {
      const { service, dsCalls } = await makeService({
        dsResults: [[{ rows: [], total_count: 0, sum_in: '0', sum_out: '0', sum_net: '0' }]],
      });
      await service.listMovements('pa-1', {
        from: '2026-04-01',
        to: '2026-04-30',
        type: 'invoice_payment',
        q: 'INV-2026',
        limit: 50,
        offset: 100,
      });
      const call = dsCalls[0];
      expect(call.sql).toMatch(/m\.occurred_at::date >= \$2::date/);
      expect(call.sql).toMatch(/m\.occurred_at::date <= \$3::date/);
      expect(call.sql).toMatch(/m\.operation_type = \$4/);
      expect(call.sql).toMatch(/LOWER\(COALESCE\(m\.reference_no/);
      // params: id, from, to, type, q, limit, offset
      expect(call.params[0]).toBe('pa-1');
      expect(call.params[1]).toBe('2026-04-01');
      expect(call.params[2]).toBe('2026-04-30');
      expect(call.params[3]).toBe('invoice_payment');
      expect(call.params[4]).toBe('%inv-2026%');
      expect(call.params[5]).toBe(50);
      expect(call.params[6]).toBe(100);
    });

    it('clamps limit to [1, 200] and offset to >= 0', async () => {
      const { service, dsCalls } = await makeService({
        dsResults: [[{ rows: [], total_count: 0, sum_in: '0', sum_out: '0', sum_net: '0' }]],
      });
      await service.listMovements('pa-1', { limit: 9999, offset: -50 });
      const call = dsCalls[0];
      // limit param is at the end (after the id). Value should be 200, not 9999.
      const limitParam = call.params[call.params.length - 2];
      const offsetParam = call.params[call.params.length - 1];
      expect(limitParam).toBe(200);
      expect(offsetParam).toBe(0);
    });

    it('returns { rows, total, totals } shape the FE consumes', async () => {
      const fake = [
        {
          rows: [
            { id: 'op-1', operation_type: 'invoice_payment', operation_type_ar: 'بيع',
              reference_no: 'INV-001', amount_in: '300.00', amount_out: '0.00',
              net_amount: '300.00', occurred_at: '2026-04-29T10:00:00Z' },
          ],
          total_count: 1,
          sum_in: '300.00',
          sum_out: '0.00',
          sum_net: '300.00',
        },
      ];
      const { service } = await makeService({ dsResults: [fake] });
      const out = await service.listMovements('pa-1', {});
      expect(out.rows).toHaveLength(1);
      expect(out.total).toBe(1);
      expect(out.totals.in).toBe('300.00');
      expect(out.totals.out).toBe('0.00');
      expect(out.totals.net).toBe('300.00');
      expect(out.totals.count).toBe(1);
    });

    it('returns empty rows + zero totals when the account has no movements', async () => {
      const fake = [{ rows: [], total_count: 0, sum_in: '0', sum_out: '0', sum_net: '0' }];
      const { service } = await makeService({ dsResults: [fake] });
      const out = await service.listMovements('pa-vodafone', {});
      expect(out.rows).toEqual([]);
      expect(out.total).toBe(0);
      expect(out.totals.count).toBe(0);
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

/* ============================================================================
 * PR-FIN-PAYACCT-4D-UX-FIX-8 — defensive cashbox_id sanitization
 * ----------------------------------------------------------------------------
 * Production threw `invalid input syntax for type uuid: "undefined"` again
 * on 2026-04-30 12:11:05 UTC, this time on the payment_accounts UPDATE
 * path — the operator was saving "ربط وسيلة الدفع بمحفظة" and a poisoned
 * `cashbox_id: "undefined"` reached `validateCashboxKindMatch` because
 * the previous service code did `if (dto.cashbox_id)` (truthy on the
 * string `"undefined"`) and passed it straight to a uuid SQL parameter.
 *
 * Fix: sanitize via the shared `sanitizeUuidInput` helper at the service
 * boundary in BOTH `create()` and `update()`. The helper neutralizes
 * `undefined` / `null` / `""` / `"undefined"` / `"null"` to `null`. When
 * the inbound key was provided (FE intent: change the link), we still
 * write `null` to the column — the operator's intent is "clear the pin".
 * ========================================================================== */
describe('PaymentsService.create — PR-FIN-PAYACCT-4D-UX-FIX-8 cashbox_id sanitization', () => {
  it('cashbox_id = "undefined" → never passes "undefined" to the SQL; stored as NULL', async () => {
    const { service, emCalls } = await makeService({
      emResults: [
        [{ id: 'pa-fix8-1' }],   // INSERT
        [{ id: 'pa-fix8-1', method: 'instapay', display_name: 'X' }], // getById SELECT
      ],
    });

    await service.create(
      {
        method: 'instapay',
        display_name: 'InstaPay',
        gl_account_code: '1114',
        cashbox_id: 'undefined' as any, // ← poison
      } as any,
      'user-1',
    );

    // The INSERT happened with cashbox_id slot = null, NOT "undefined".
    const insert = emCalls.find((c) => /INSERT INTO payment_accounts/.test(c.sql))!;
    expect(insert).toBeDefined();
    expect(insert.params).not.toContain('undefined');
    expect(insert.params).not.toContain('null');
    // No validateCashboxKindMatch SELECT against cashboxes fired for the poisoned value.
    const cashboxLookup = emCalls.find((c) => /FROM cashboxes WHERE id = \$1/.test(c.sql));
    expect(cashboxLookup).toBeUndefined();
  });

  it('cashbox_id = "" / "null" / whitespace → also normalized to null; no validator SELECT fires', async () => {
    for (const poison of ['', 'null', '  '] as const) {
      const { service, emCalls } = await makeService({
        emResults: [
          [{ id: 'pa-x' }],
          [{ id: 'pa-x', method: 'instapay', display_name: 'X' }],
        ],
      });
      await service.create(
        {
          method: 'instapay',
          display_name: 'InstaPay',
          gl_account_code: '1114',
          cashbox_id: poison as any,
        } as any,
        'user-1',
      );
      expect(emCalls.find((c) => /FROM cashboxes WHERE id = \$1/.test(c.sql))).toBeUndefined();
      const insert = emCalls.find((c) => /INSERT INTO payment_accounts/.test(c.sql))!;
      expect(insert.params).not.toContain(poison);
    }
  });

  it('cashbox_id = real UUID → validator runs against that UUID, not poison', async () => {
    const REAL = 'b533200b-ec23-4cb8-a539-8c78e3679f78';
    const { service, emCalls } = await makeService({
      emResults: [
        [{ id: REAL, kind: 'ewallet' }], // validator SELECT
        [{ id: 'pa-real' }],             // INSERT
        [{ id: 'pa-real', method: 'instapay', display_name: 'X' }], // getById
      ],
    });
    await service.create(
      {
        method: 'instapay',
        display_name: 'InstaPay',
        gl_account_code: '1114',
        cashbox_id: REAL,
      } as any,
      'user-1',
    );
    const validatorCall = emCalls.find((c) => /FROM cashboxes WHERE id = \$1/.test(c.sql))!;
    expect(validatorCall).toBeDefined();
    expect(validatorCall.params[0]).toBe(REAL);
  });
});

describe('PaymentsService.update — PR-FIN-PAYACCT-4D-UX-FIX-8 cashbox_id sanitization', () => {
  it('cashbox_id = "undefined" → validator skipped, UPDATE writes NULL (clears the pin)', async () => {
    const { service, emCalls } = await makeService({
      emResults: [
        [],                                                              // UPDATE (no RETURNING)
        [{ id: 'pa-up-1', method: 'instapay', display_name: 'X' }],      // getById SELECT
      ],
    });
    await service.update(
      'pa-up-1',
      { cashbox_id: 'undefined' as any } as any,
      'user-1',
    );
    // No validator SELECT against cashboxes (the poison value was
    // sanitized to null and `if (safeCashboxId)` never fires).
    expect(emCalls.find((c) => /FROM cashboxes WHERE id = \$1/.test(c.sql))).toBeUndefined();
    // UPDATE happened with cashbox_id = null in the SET clause.
    const update = emCalls.find((c) => /UPDATE payment_accounts SET/.test(c.sql))!;
    expect(update).toBeDefined();
    expect(update.sql).toMatch(/cashbox_id\s*=/);
    // params include null for cashbox_id; the literal 'undefined' must NOT appear.
    expect(update.params).not.toContain('undefined');
    expect(update.params).toContain(null);
  });

  it('cashbox_id = "" / "null" / whitespace → same as "undefined": cleared, no validator', async () => {
    for (const poison of ['', 'null', '  '] as const) {
      const { service, emCalls } = await makeService({
        emResults: [
          [],                                                                 // UPDATE
          [{ id: 'pa-up-x', method: 'instapay', display_name: 'X' }],         // getById
        ],
      });
      await service.update('pa-up-x', { cashbox_id: poison as any } as any, 'user-1');
      expect(emCalls.find((c) => /FROM cashboxes WHERE id = \$1/.test(c.sql))).toBeUndefined();
      const update = emCalls.find((c) => /UPDATE payment_accounts SET/.test(c.sql))!;
      expect(update.params).not.toContain(poison);
    }
  });

  it('cashbox_id = explicit null → validator skipped, UPDATE writes NULL (existing behavior preserved)', async () => {
    const { service, emCalls } = await makeService({
      emResults: [
        [],                                                                 // UPDATE
        [{ id: 'pa-up-2', method: 'instapay', display_name: 'X' }],         // getById
      ],
    });
    await service.update('pa-up-2', { cashbox_id: null } as any, 'user-1');
    expect(emCalls.find((c) => /FROM cashboxes WHERE id = \$1/.test(c.sql))).toBeUndefined();
    const update = emCalls.find((c) => /UPDATE payment_accounts SET/.test(c.sql))!;
    expect(update.sql).toMatch(/cashbox_id\s*=/);
    expect(update.params).toContain(null);
  });

  it('cashbox_id = real UUID → validator runs and writes the real UUID', async () => {
    const REAL = 'b533200b-ec23-4cb8-a539-8c78e3679f78';
    const { service, emCalls } = await makeService({
      emResults: [
        [{ method: 'instapay' }],                             // SELECT method for validation
        [{ id: REAL, kind: 'ewallet' }],                      // validator SELECT
        [],                                                   // UPDATE
        [{ id: 'pa-up-3', method: 'instapay', display_name: 'X' }], // getById
      ],
    });
    await service.update('pa-up-3', { cashbox_id: REAL } as any, 'user-1');
    const validatorCall = emCalls.find((c) => /FROM cashboxes WHERE id = \$1/.test(c.sql))!;
    expect(validatorCall.params[0]).toBe(REAL);
    const update = emCalls.find((c) => /UPDATE payment_accounts SET/.test(c.sql))!;
    expect(update.params).toContain(REAL);
  });

  it('cashbox_id field omitted entirely → no UPDATE on cashbox_id (preserves existing pin)', async () => {
    const { service, emCalls } = await makeService({
      emResults: [
        [],                                                                 // UPDATE
        [{ id: 'pa-up-4', method: 'instapay', display_name: 'X' }],         // getById
      ],
    });
    await service.update('pa-up-4', { display_name: 'New Name' } as any, 'user-1');
    const update = emCalls.find((c) => /UPDATE payment_accounts SET/.test(c.sql))!;
    expect(update).toBeDefined();
    expect(update.sql).not.toMatch(/cashbox_id\s*=/);
  });
});

/* ============================================================================
 * PR-FIN-PAYACCT-4D-UX-FIX-8 — listBalances surfaces unattached invoice_payments
 * ----------------------------------------------------------------------------
 * The "detailed payment-method report" shows invoice_payments grouped by
 * (payment_method, payment_account_id) including a row where
 * payment_account_id IS NULL (3 InstaPay receipts totalling 1,050 EGP in
 * production). /cashboxes used to only surface registered payment_accounts,
 * so the 1,050 was invisible. Fix: UNION ALL with synthetic rows carrying
 * a sentinel `payment_account_id = unattached:<method>`, `is_unattached =
 * TRUE`, sort_order=-1 (top of method group).
 * ========================================================================== */
describe('PaymentsService.listBalances — PR-FIN-PAYACCT-4D-UX-FIX-8 unattached rows', () => {
  it('emits a UNION ALL with a synthetic unattached_balances CTE for invoice_payments where payment_account_id IS NULL', async () => {
    const { service, dsCalls } = await makeService({ dsResults: [[]] });
    await service.listBalances();
    const sql = dsCalls[0].sql;
    expect(sql).toMatch(/WITH attached_balances AS/);
    expect(sql).toMatch(/unattached_balances AS/);
    // The unattached CTE filters strictly to invoice_payments with NULL PA.
    expect(sql).toMatch(/FROM invoice_payments ip[\s\S]+payment_account_id IS NULL/);
    // Group by payment_method only — one synthetic row per method.
    expect(sql).toMatch(/GROUP BY ip\.payment_method/);
    // Final SELECT unions both CTEs.
    expect(sql).toMatch(/SELECT \* FROM attached_balances[\s\S]+UNION ALL[\s\S]+SELECT \* FROM unattached_balances/);
    // No DML.
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it('synthetic rows carry the `is_unattached=TRUE` flag + sentinel payment_account_id', async () => {
    const { service, dsCalls } = await makeService({ dsResults: [[]] });
    await service.listBalances();
    const sql = dsCalls[0].sql;
    expect(sql).toMatch(/'unattached:' \|\| ip\.payment_method::text\s+AS payment_account_id/);
    expect(sql).toMatch(/TRUE\s+AS is_unattached/);
    expect(sql).toMatch(/FALSE\s+AS is_unattached/);
  });

  it('synthetic rows use the method-default GL bucket', async () => {
    const { service, dsCalls } = await makeService({ dsResults: [[]] });
    await service.listBalances();
    const sql = dsCalls[0].sql;
    // The CASE expression maps payment_method → method-default GL code.
    expect(sql).toMatch(/payment_method::text = 'cash'\s+THEN '1111'/);
    expect(sql).toMatch(/payment_method::text IN \('card_visa','card_mastercard','card_meeza','bank_transfer'\)\s+THEN '1113'/);
    expect(sql).toMatch(/payment_method::text IN \('instapay','wallet','vodafone_cash','orange_cash'\)\s+THEN '1114'/);
    expect(sql).toMatch(/payment_method::text = 'check'\s+THEN '1115'/);
  });

  it('method filter passes through to the unattached CTE too (no untagged leakage when filtered)', async () => {
    const { service, dsCalls } = await makeService({ dsResults: [[]] });
    await service.listBalances({ method: 'instapay' });
    const sql = dsCalls[0].sql;
    // Both the attached and unattached predicates restrict by method.
    expect(sql).toMatch(/pa\.method = \$1::payment_method_code/);
    expect(sql).toMatch(/AND ip\.payment_method = \$1::payment_method_code/);
  });

  /**
   * PR-FIN-PAYACCT-4D-UX-FIX-8-HOTFIX-1 — UNION ALL type alignment.
   *
   * Production threw `UNION types normal_balance and text cannot be
   * matched` opening /cashboxes after #210. Root cause:
   * `chart_of_accounts.normal_balance` is the `normal_balance` enum
   * (USER-DEFINED) on the attached side, but the unattached side used
   * `NULL::text`. Postgres won't auto-coerce enum ⊕ text. Same risk
   * applied to `coa.name_ar` (varchar) vs `NULL::text`. Hotfix: cast
   * both attached-side columns to `::text` so types align.
   */
  it('HOTFIX-1: casts coa.normal_balance and coa.name_ar to ::text for UNION ALL alignment', async () => {
    const { service, dsCalls } = await makeService({ dsResults: [[]] });
    await service.listBalances();
    const sql = dsCalls[0].sql;
    // Both columns must carry an explicit ::text cast on the
    // attached_balances SELECT.
    expect(sql).toMatch(/coa\.normal_balance::text\s+AS normal_balance/);
    expect(sql).toMatch(/coa\.name_ar::text\s+AS gl_name_ar/);
    // Regression guard: the bare reference (no cast) must NOT reappear.
    expect(sql).not.toMatch(/coa\.normal_balance,\s/);
    expect(sql).not.toMatch(/coa\.name_ar\s+AS gl_name_ar/);
  });
});

/* ============================================================================
 * PR-FIN-PAYACCT-4D-UX-FIX-9 — historical-payment backfill (instapay)
 * ----------------------------------------------------------------------------
 * Operator-triggered, behind admin/manage permission. Maps historical
 * `invoice_payments` rows where `payment_account_id IS NULL` onto the
 * method's single active default PA. Pure write — no JE/JL/CT side
 * effects, no posting, no engine. Strict guards: method whitelist
 * (instapay only), exactly one active default PA, idempotent.
 * ========================================================================== */
describe('PaymentsService.backfillUnattachedInvoicePayments — PR-FIN-PAYACCT-4D-UX-FIX-9', () => {
  const TARGET_PA = {
    id: '4dbe8e84-f145-4bbb-a508-4f934bf302ca',
    method: 'instapay',
    provider_key: 'instapay',
    display_name: 'InstaPay ',
    identifier: '01004888879',
    gl_account_code: '1114',
    cashbox_id: null,
    metadata: {},
  };

  it('rejects unsupported method (cash) with clean Arabic', async () => {
    const { service } = await makeService({});
    await expect(
      service.backfillUnattachedInvoicePayments({
        method: 'cash',
        dryRun: true,
        userId: 'u-1',
      }),
    ).rejects.toThrow(/الربط التلقائي غير مدعوم/);
  });

  it('rejects when no active default PA exists for the method', async () => {
    const { service } = await makeService({
      dsResults: [[]],
    });
    await expect(
      service.backfillUnattachedInvoicePayments({
        method: 'instapay',
        dryRun: true,
        userId: 'u-1',
      }),
    ).rejects.toThrow(/لا يوجد حساب دفع افتراضي مفعل/);
  });

  it('rejects when MORE than one active default PA exists for the method', async () => {
    const { service } = await makeService({
      dsResults: [
        [
          { ...TARGET_PA, id: 'pa-a' },
          { ...TARGET_PA, id: 'pa-b' },
        ],
      ],
    });
    await expect(
      service.backfillUnattachedInvoicePayments({
        method: 'instapay',
        dryRun: true,
        userId: 'u-1',
      }),
    ).rejects.toThrow(/يوجد 2 حساب افتراضي مفعل/);
  });

  it('dry-run returns counts/total without firing UPDATE', async () => {
    const { service, dsCalls, emCalls } = await makeService({
      dsResults: [
        [TARGET_PA],                                       // candidates SELECT
        [{ row_count: 3, total_amount: '1050.00' }],       // before count
      ],
    });
    const out = await service.backfillUnattachedInvoicePayments({
      method: 'instapay',
      dryRun: true,
      userId: 'u-1',
    });
    expect(out.dryRun).toBe(true);
    expect(out.before.rowCount).toBe(3);
    expect(out.before.totalAmount).toBe('1050.00');
    expect(out.after.rowCount).toBe(3);    // unchanged in dry-run
    expect(out.updatedCount).toBe(0);
    expect(out.targetAccount.id).toBe(TARGET_PA.id);
    // No UPDATE fired (no transaction + no UPDATE invoice_payments).
    expect(dsCalls.some((c) => /UPDATE invoice_payments/.test(c.sql))).toBe(false);
    expect(emCalls.some((c) => /UPDATE invoice_payments/.test(c.sql))).toBe(false);
  });

  it('execute runs UPDATE on payment_account_id + payment_account_snapshot only', async () => {
    const { service, emCalls } = await makeService({
      dsResults: [
        [TARGET_PA],                                       // candidates SELECT (initial)
        [{ row_count: 3, total_amount: '1050.00' }],       // before count
        [{ row_count: 0, total_amount: '0' }],             // after count
        [],                                                // activity_logs INSERT (PR-FIN-PAYACCT-4D-UX-FIX-12 — now on ds, post-tx)
      ],
      emResults: [
        [TARGET_PA],                                       // tx-scoped re-read FOR UPDATE
        [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],        // UPDATE RETURNING
      ],
    });
    const out = await service.backfillUnattachedInvoicePayments({
      method: 'instapay',
      dryRun: false,
      userId: 'u-1',
    });

    expect(out.dryRun).toBe(false);
    expect(out.updatedCount).toBe(3);
    expect(out.before.rowCount).toBe(3);
    expect(out.after.rowCount).toBe(0);

    // The UPDATE statement targets only the two columns we own and
    // nothing else. payment_account_id + payment_account_snapshot
    // appear in SET; amounts/dates/customer_id/invoice_id do NOT.
    const update = emCalls.find((c) => /UPDATE invoice_payments/.test(c.sql))!;
    expect(update).toBeDefined();
    expect(update.sql).toMatch(/SET payment_account_id\s*=\s*\$1::uuid/);
    expect(update.sql).toMatch(/payment_account_snapshot\s*=\s*\$2::jsonb/);
    expect(update.sql).not.toMatch(/SET[\s\S]+amount\s*=/);
    expect(update.sql).not.toMatch(/SET[\s\S]+created_at\s*=/);
    expect(update.sql).not.toMatch(/SET[\s\S]+invoice_id\s*=/);
    expect(update.sql).not.toMatch(/SET[\s\S]+customer_id\s*=/);
    expect(update.params[0]).toBe(TARGET_PA.id);
    // Snapshot contains the canonical buildSnapshot fields.
    const snap = JSON.parse(update.params[1]);
    expect(snap).toMatchObject({
      display_name: 'InstaPay ',
      provider_key: 'instapay',
      identifier: '01004888879',
      gl_account_code: '1114',
      cashbox_id: null,
    });
    expect(update.params[2]).toBe('instapay');
  });

  /**
   * PR-FIN-PAYACCT-4D-UX-FIX-11 + PR-FIN-PAYACCT-4D-UX-FIX-12 — audit INSERT
   * regression guard.
   *
   * Layered history:
   *   FIX-11: original code wrote `(... payload)` but the column is
   *           `metadata` → PG rejected the INSERT inside the tx →
   *           tx aborted → UPDATE rolled back → 3 rows stayed unattached
   *           (7 PG errors on 2026-05-01 between 09:14:48Z and 09:33:16Z).
   *   FIX-12: column rename revealed a SECOND failure inside the same
   *           INSERT — `could not determine data type of parameter $3`
   *           in `jsonb_build_object('method', $3, ...)`. Same poison
   *           effect (2 PG errors on 2026-05-01 at 11:39:08Z, 11:39:40Z).
   *
   * FIX-12 corrects both root causes:
   *   • The audit INSERT now runs on `this.ds` (separate connection)
   *     AFTER the main tx commits, so any failure here cannot affect
   *     the committed `invoice_payments` UPDATE.
   *   • Every parameter inside `jsonb_build_object` is explicitly cast
   *     so PG's type inference cannot fail (`$3::text`, `$1::text`,
   *     `$4::int`, `$5::text`).
   *
   * This single test pins the post-FIX-12 contract.
   */
  it('PR-FIN-PAYACCT-4D-UX-FIX-12: audit INSERT runs OUTSIDE the tx, on ds (not em), with `metadata` column and explicit param casts', async () => {
    const { service, dsCalls, emCalls } = await makeService({
      dsResults: [
        [TARGET_PA],
        [{ row_count: 3, total_amount: '1050.00' }],
        [{ row_count: 0, total_amount: '0' }],
        [],                                                // audit insert (now on ds)
      ],
      emResults: [
        [TARGET_PA],
        [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
      ],
    });
    await service.backfillUnattachedInvoicePayments({
      method: 'instapay',
      dryRun: false,
      userId: 'u-1',
    });
    // Audit must NOT appear inside the tx (em.query) — that was the
    // tx-poison vector.
    expect(emCalls.some((c) => /INSERT INTO activity_logs/.test(c.sql))).toBe(false);
    // Audit MUST appear on the connection-pool query path (ds.query).
    const audit = dsCalls.find((c) =>
      /INSERT INTO activity_logs/.test(c.sql),
    );
    expect(audit).toBeDefined();
    // Column list: metadata, never payload (FIX-11 regression).
    expect(audit!.sql).toMatch(/\(\s*action\s*,\s*entity\s*,\s*entity_id\s*,\s*user_id\s*,\s*metadata\s*\)/);
    expect(audit!.sql).not.toMatch(/\bpayload\b/);
    // FIX-12 explicit casts: `$3::text` for the method, plus the
    // other params we touch inside jsonb_build_object so PG's type
    // inference can't trip again.
    expect(audit!.sql).toMatch(/'method',\s*\$3::text/);
    expect(audit!.sql).toMatch(/\$1::text/);    // target_payment_account_id
    expect(audit!.sql).toMatch(/\$4::int/);     // updated_count
    expect(audit!.sql).toMatch(/\$5::text/);    // before_total_amount
    expect(audit!.sql).toMatch(/jsonb_build_object\(/);
  });

  /**
   * PR-FIN-PAYACCT-4D-UX-FIX-12 — best-effort guarantee.
   *
   * Even if the audit INSERT throws (e.g. activity_logs schema drifts
   * again, or PG hits some unrelated transient), the operator response
   * MUST be unaffected. The committed UPDATE stands; the API returns
   * the same shape with the real updatedCount.
   */
  it('PR-FIN-PAYACCT-4D-UX-FIX-12: audit INSERT failure does NOT change the committed backfill result', async () => {
    const { ds, dsCalls, emCalls } = makeFakeDataSource({
      dsResults: [
        [TARGET_PA],                                  // candidates
        [{ row_count: 3, total_amount: '1050.00' }],  // before
        [{ row_count: 0, total_amount: '0' }],        // after
      ],
      emResults: [
        [TARGET_PA],                                  // tx-scoped re-read
        [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],   // UPDATE RETURNING
      ],
    });
    // Make the audit INSERT throw. Track the call manually since the
    // override short-circuits before originalDsQuery's tracking.
    const originalDsQuery = ds.query;
    ds.query = async (sql: string, params: any[] = []) => {
      if (/INSERT INTO activity_logs/.test(sql)) {
        dsCalls.push({ sql, params });
        throw new Error('synthetic audit-insert failure');
      }
      return originalDsQuery(sql, params);
    };
    const moduleRef = await Test.createTestingModule({
      providers: [PaymentsService, { provide: DataSource, useValue: ds }],
    }).compile();
    const service = moduleRef.get(PaymentsService);

    const out = await service.backfillUnattachedInvoicePayments({
      method: 'instapay',
      dryRun: false,
      userId: 'u-1',
    });

    // Service did NOT throw. The committed backfill result stands.
    expect(out.dryRun).toBe(false);
    expect(out.updatedCount).toBe(3);
    expect(out.before.rowCount).toBe(3);
    expect(out.after.rowCount).toBe(0);
    expect(out.targetAccount.id).toBe(TARGET_PA.id);

    // Sanity: the UPDATE happened (em side), the audit was attempted (ds side)
    expect(emCalls.some((c) => /UPDATE invoice_payments/.test(c.sql))).toBe(true);
    expect(dsCalls.some((c) => /INSERT INTO activity_logs/.test(c.sql))).toBe(true);
  });

  it('does NOT touch journal_entries / journal_lines / cashbox_transactions', async () => {
    const { service, emCalls, dsCalls } = await makeService({
      dsResults: [
        [TARGET_PA],
        [{ row_count: 3, total_amount: '1050.00' }],
        [{ row_count: 0, total_amount: '0' }],
        [],                                          // audit insert
      ],
      emResults: [
        [TARGET_PA],
        [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
      ],
    });
    await service.backfillUnattachedInvoicePayments({
      method: 'instapay',
      dryRun: false,
      userId: 'u-1',
    });
    const allSql = [...dsCalls, ...emCalls].map((c) => c.sql).join(' || ');
    expect(allSql).not.toMatch(/INSERT INTO journal_entries/i);
    expect(allSql).not.toMatch(/UPDATE journal_entries/i);
    expect(allSql).not.toMatch(/INSERT INTO journal_lines/i);
    expect(allSql).not.toMatch(/UPDATE journal_lines/i);
    expect(allSql).not.toMatch(/INSERT INTO cashbox_transactions/i);
    expect(allSql).not.toMatch(/UPDATE cashbox_transactions/i);
    // FIX-12 also: no UPDATE invoices (we only touch invoice_payments).
    expect(allSql).not.toMatch(/UPDATE invoices\b/i);
  });

  /**
   * PR-FIN-PAYACCT-4D-UX-FIX-12 — dryRun must not write activity_logs.
   * The dryRun branch returns before any UPDATE or audit INSERT so the
   * post-tx audit code path is never reached.
   */
  it('PR-FIN-PAYACCT-4D-UX-FIX-12: dryRun never writes activity_logs', async () => {
    const { service, dsCalls, emCalls } = await makeService({
      dsResults: [
        [TARGET_PA],                                  // candidates
        [{ row_count: 3, total_amount: '1050.00' }],  // before count
      ],
    });
    const out = await service.backfillUnattachedInvoicePayments({
      method: 'instapay',
      dryRun: true,
      userId: 'u-1',
    });
    expect(out.dryRun).toBe(true);
    expect(out.updatedCount).toBe(0);
    // No audit INSERT on either path.
    expect(dsCalls.some((c) => /INSERT INTO activity_logs/.test(c.sql))).toBe(false);
    expect(emCalls.some((c) => /INSERT INTO activity_logs/.test(c.sql))).toBe(false);
    // No UPDATE either (dryRun).
    expect(emCalls.some((c) => /UPDATE invoice_payments/.test(c.sql))).toBe(false);
    expect(dsCalls.some((c) => /UPDATE invoice_payments/.test(c.sql))).toBe(false);
  });

  it('idempotent: second execute hits 0 rows and reports updatedCount=0', async () => {
    const { service } = await makeService({
      dsResults: [
        [TARGET_PA],                                       // candidates
        [{ row_count: 0, total_amount: '0' }],             // before (already 0)
        [{ row_count: 0, total_amount: '0' }],             // after
        [],                                                // audit insert
      ],
      emResults: [
        [TARGET_PA],                                       // tx-scoped re-read
        [],                                                // UPDATE RETURNING (no rows match)
      ],
    });
    const out = await service.backfillUnattachedInvoicePayments({
      method: 'instapay',
      dryRun: false,
      userId: 'u-1',
    });
    expect(out.updatedCount).toBe(0);
    expect(out.before.rowCount).toBe(0);
    expect(out.after.rowCount).toBe(0);
  });

  it('aborts mid-flight if the active default PA changed during the tx', async () => {
    const { service } = await makeService({
      dsResults: [
        [TARGET_PA],                                       // initial candidates
        [{ row_count: 3, total_amount: '1050.00' }],       // before
      ],
      emResults: [
        // Tx-scoped re-read returns a DIFFERENT PA — concurrent
        // change. The service must throw rather than UPDATE against
        // a target that no longer matches.
        [{ id: 'pa-different', method: 'instapay' }],
      ],
    });
    await expect(
      service.backfillUnattachedInvoicePayments({
        method: 'instapay',
        dryRun: false,
        userId: 'u-1',
      }),
    ).rejects.toThrow(/تغيّر الحساب الافتراضي/);
  });
});

/* ============================================================================
 * PR-FIN-PAYACCT-4D-UX-FIX-9 — unattached-summary endpoint
 * ----------------------------------------------------------------------------
 * Drives the operator-facing reconciliation panel. Read-only.
 * ========================================================================== */
describe('PaymentsService.unattachedSummary — PR-FIN-PAYACCT-4D-UX-FIX-9', () => {
  it('marks cash buckets as unsupported with the cashbox-driven explanation', async () => {
    const { service } = await makeService({
      dsResults: [
        // bucket query
        [
          { source_table: 'invoice_payments', payment_method: 'cash',
            row_count: 101, total_amount: '30305.01',
            earliest: '2026-04-20', latest: '2026-04-30' },
        ],
        // active default targets per method
        [],
        // active_default_count per method
        [{ method: 'cash', active_default_count: 0 }],
      ],
    });
    const out = await service.unattachedSummary();
    expect(out).toHaveLength(1);
    expect(out[0].payment_method).toBe('cash');
    expect(out[0].supported).toBe(false);
    expect(out[0].status_message).toMatch(/النقدية تُسجَّل عبر الخزنة/);
    expect(out[0].target_account).toBeNull();
  });

  it('marks instapay invoice_payments bucket as supported when exactly one active default PA exists', async () => {
    const { service } = await makeService({
      dsResults: [
        [
          { source_table: 'invoice_payments', payment_method: 'instapay',
            row_count: 3, total_amount: '1050.00',
            earliest: '2026-04-24', latest: '2026-04-25' },
        ],
        [
          {
            method: 'instapay',
            id: '4dbe8e84-f145-4bbb-a508-4f934bf302ca',
            display_name: 'InstaPay ',
            identifier: '01004888879',
            provider_key: 'instapay',
            gl_account_code: '1114',
          },
        ],
        [{ method: 'instapay', active_default_count: 1 }],
      ],
    });
    const out = await service.unattachedSummary();
    expect(out).toHaveLength(1);
    expect(out[0].payment_method).toBe('instapay');
    expect(out[0].supported).toBe(true);
    expect(out[0].status_message).toMatch(/جاهز للربط/);
    expect(out[0].target_account?.id).toBe('4dbe8e84-f145-4bbb-a508-4f934bf302ca');
  });

  it('marks customer_payments / supplier_payments rows as unsupported even for instapay', async () => {
    const { service } = await makeService({
      dsResults: [
        [
          { source_table: 'customer_payments', payment_method: 'cash',
            row_count: 1, total_amount: '10.00',
            earliest: '2026-04-29', latest: '2026-04-29' },
        ],
        [],
        [{ method: 'cash', active_default_count: 0 }],
      ],
    });
    const out = await service.unattachedSummary();
    expect(out[0].supported).toBe(false);
  });
});
