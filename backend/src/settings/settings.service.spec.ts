/**
 * settings.service.spec.ts — PR-FIN-PAYACCT-4D-UX-FIX-6
 *
 * Pins the second cashbox CRUD entry point (POST/PATCH
 * `/api/v1/settings/cashboxes`) against the same UUID-sentinel poison
 * that PR #208 fixes on the cash-desk path. The Settings page's
 * legacy `CashboxModal` calls `settingsApi.{create,update}Cashbox` →
 * this service. Without the sanitization a poisoned `"undefined"` /
 * `"null"` would reach the SQL and produce
 * `invalid input syntax for type uuid: "undefined"`.
 *
 * The DataSource is stubbed so we can assert SQL strings + parameter
 * tuples without touching Postgres.
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SettingsService } from './settings.service';

type QueryCall = { sql: string; params: any[] };

function makeFakeDataSource(
  responder: (sql: string, params: any[]) => any[] | Promise<any[]>,
) {
  const dsCalls: QueryCall[] = [];
  const ds: any = {
    query: async (sql: string, params: any[] = []) => {
      dsCalls.push({ sql, params });
      return responder(sql, params);
    },
    transaction: async (cb: (em: any) => Promise<any>) => cb(ds),
  };
  return { ds, dsCalls };
}

async function makeService(
  responder: (sql: string, params: any[]) => any[] | Promise<any[]>,
) {
  const { ds, dsCalls } = makeFakeDataSource(responder);
  const moduleRef = await Test.createTestingModule({
    providers: [
      SettingsService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  const service = moduleRef.get(SettingsService);
  return { service, ds, dsCalls };
}

describe('SettingsService.createCashbox — PR-FIN-PAYACCT-4D-UX-FIX-6 uuid sanitization', () => {
  const REAL_WAREHOUSE = '00000000-aaaa-bbbb-cccc-111111111111';
  const FALLBACK_WAREHOUSE = '00000000-ffff-eeee-dddd-222222222222';
  const newCashboxRow = (warehouse_id: string) => ({
    id: 'cb-new',
    name_ar: 'خزنة',
    name_en: null,
    warehouse_id,
    is_active: true,
  });

  it('1) warehouse_id = "undefined" → never passed as a uuid; warehouse fallback fires', async () => {
    let inserted: any = null;
    const { service, dsCalls } = await makeService(async (sql) => {
      if (/FROM warehouses/.test(sql)) return [{ id: FALLBACK_WAREHOUSE }];
      if (/INSERT INTO cashboxes/.test(sql)) return [newCashboxRow(FALLBACK_WAREHOUSE)];
      return [];
    });

    await service.createCashbox({
      name_ar: 'خزنة',
      warehouse_id: 'undefined',
    } as any);

    const insert = dsCalls.find((c) => /INSERT INTO cashboxes/.test(c.sql))!;
    expect(insert).toBeDefined();
    // params = [name_ar, name_en, warehouse_id, is_active]
    expect(insert.params).not.toContain('undefined');
    expect(insert.params).not.toContain('null');
    expect(insert.params[2]).toBe(FALLBACK_WAREHOUSE);
    // The warehouse-fallback SELECT must have fired.
    expect(dsCalls.some((c) => /FROM warehouses WHERE is_active = TRUE/.test(c.sql))).toBe(true);
  });

  it('2) warehouse_id = "" / "null" / whitespace → fallback fires; sentinel never in params', async () => {
    for (const poison of ['', 'null', '   '] as const) {
      const { service, dsCalls } = await makeService(async (sql) => {
        if (/FROM warehouses/.test(sql)) return [{ id: FALLBACK_WAREHOUSE }];
        if (/INSERT INTO cashboxes/.test(sql)) return [newCashboxRow(FALLBACK_WAREHOUSE)];
        return [];
      });

      await service.createCashbox({
        name_ar: 'خزنة',
        warehouse_id: poison,
      } as any);

      const insert = dsCalls.find((c) => /INSERT INTO cashboxes/.test(c.sql))!;
      expect(insert.params[2]).toBe(FALLBACK_WAREHOUSE);
      expect(insert.params).not.toContain(poison);
    }
  });

  it('3) warehouse_id omitted entirely → fallback fires (parity with cash-desk path)', async () => {
    const { service, dsCalls } = await makeService(async (sql) => {
      if (/FROM warehouses/.test(sql)) return [{ id: FALLBACK_WAREHOUSE }];
      if (/INSERT INTO cashboxes/.test(sql)) return [newCashboxRow(FALLBACK_WAREHOUSE)];
      return [];
    });

    await service.createCashbox({ name_ar: 'خزنة' } as any);

    const insert = dsCalls.find((c) => /INSERT INTO cashboxes/.test(c.sql))!;
    expect(insert.params[2]).toBe(FALLBACK_WAREHOUSE);
    expect(dsCalls.some((c) => /FROM warehouses WHERE is_active = TRUE/.test(c.sql))).toBe(true);
  });

  it('4) valid uuid passes through untouched; no fallback SELECT fires', async () => {
    const { service, dsCalls } = await makeService(async (sql) => {
      if (/INSERT INTO cashboxes/.test(sql)) return [newCashboxRow(REAL_WAREHOUSE)];
      // The fallback SELECT should NEVER be called when a real uuid arrives.
      if (/FROM warehouses/.test(sql)) {
        throw new Error('fallback SELECT should not run when warehouse_id is a real uuid');
      }
      return [];
    });

    await service.createCashbox({
      name_ar: 'خزنة',
      warehouse_id: REAL_WAREHOUSE,
    } as any);

    const insert = dsCalls.find((c) => /INSERT INTO cashboxes/.test(c.sql))!;
    expect(insert.params[2]).toBe(REAL_WAREHOUSE);
    expect(dsCalls.some((c) => /FROM warehouses WHERE is_active = TRUE/.test(c.sql))).toBe(false);
  });

  it('5) no warehouses + sentinel input → throws clean Arabic BadRequest, no INSERT fires', async () => {
    const { service, dsCalls } = await makeService(async (sql) => {
      if (/FROM warehouses/.test(sql)) return []; // no active warehouses
      return [];
    });

    await expect(
      service.createCashbox({
        name_ar: 'خزنة',
        warehouse_id: 'undefined',
      } as any),
    ).rejects.toThrow(BadRequestException);
    // Confirm no cashbox row landed.
    expect(dsCalls.some((c) => /INSERT INTO cashboxes/.test(c.sql))).toBe(false);
  });
});

describe('SettingsService.updateCashbox — PR-FIN-PAYACCT-4D-UX-FIX-6 uuid sanitization', () => {
  it('1) warehouse_id = "undefined" → field OMITTED from UPDATE (column is NOT NULL)', async () => {
    let updateCall: QueryCall | undefined;
    const { service, dsCalls } = await makeService(async (sql, params) => {
      if (/UPDATE cashboxes/.test(sql)) {
        updateCall = { sql, params };
        return [{ id: 'cb-1' }];
      }
      return [];
    });

    await service.updateCashbox('cb-1', {
      name_ar: 'اسم جديد',
      warehouse_id: 'undefined',
    } as any);

    expect(updateCall).toBeDefined();
    // The UPDATE SET clause must NOT include warehouse_id.
    expect(updateCall!.sql).not.toMatch(/warehouse_id\s*=/);
    expect(updateCall!.params).not.toContain('undefined');
    // It MUST include name_ar (the unaffected field).
    expect(updateCall!.sql).toMatch(/name_ar\s*=/);
    expect(updateCall!.params).toContain('اسم جديد');
    // Sanity: only DSCalls captured the UPDATE we expected.
    expect(dsCalls.filter((c) => /UPDATE cashboxes/.test(c.sql))).toHaveLength(1);
  });

  it('2) warehouse_id = "" / "null" / whitespace → field OMITTED, never in params', async () => {
    for (const poison of ['', 'null', '   '] as const) {
      let updateCall: QueryCall | undefined;
      const { service } = await makeService(async (sql, params) => {
        if (/UPDATE cashboxes/.test(sql)) {
          updateCall = { sql, params };
          return [{ id: 'cb-1' }];
        }
        return [];
      });

      await service.updateCashbox('cb-1', {
        name_ar: 'اسم',
        warehouse_id: poison,
      } as any);

      expect(updateCall).toBeDefined();
      expect(updateCall!.sql).not.toMatch(/warehouse_id\s*=/);
      expect(updateCall!.params).not.toContain(poison);
    }
  });

  it('3) valid uuid passes through into UPDATE', async () => {
    let updateCall: QueryCall | undefined;
    const REAL = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const { service } = await makeService(async (sql, params) => {
      if (/UPDATE cashboxes/.test(sql)) {
        updateCall = { sql, params };
        return [{ id: 'cb-1' }];
      }
      return [];
    });

    await service.updateCashbox('cb-1', { warehouse_id: REAL } as any);

    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toMatch(/warehouse_id\s*=/);
    expect(updateCall!.params).toContain(REAL);
  });

  it('4) only warehouse_id="undefined" supplied → no fields to update → throws NotFound', async () => {
    const { service, dsCalls } = await makeService(async () => []);
    await expect(
      service.updateCashbox('cb-1', { warehouse_id: 'undefined' } as any),
    ).rejects.toThrow(NotFoundException);
    // No UPDATE fired.
    expect(dsCalls.some((c) => /UPDATE cashboxes/.test(c.sql))).toBe(false);
  });
});

describe('UpsertCashboxDto — PR-FIN-PAYACCT-4D-UX-FIX-6 validator tightening', () => {
  // The DTO change tightens warehouse_id from `@IsString()` to
  // `@IsOptional() @IsUUID()`. Independent unit-level validation —
  // proves the controller boundary now rejects sentinel strings before
  // they ever reach the service.
  const { validateSync } = require('class-validator');
  const { plainToInstance } = require('class-transformer');
  const { UpsertCashboxDto } = require('./dto/settings.dto');

  function validate(input: any) {
    const dto = plainToInstance(UpsertCashboxDto, input);
    return validateSync(dto, { whitelist: false, forbidNonWhitelisted: false });
  }

  it('rejects warehouse_id = "undefined"', () => {
    const errors = validate({ name_ar: 'خزنة', warehouse_id: 'undefined' });
    const wErr = errors.find((e: any) => e.property === 'warehouse_id');
    expect(wErr).toBeDefined();
    expect(JSON.stringify(wErr!.constraints)).toMatch(/UUID/i);
  });

  it('rejects warehouse_id = "null"', () => {
    const errors = validate({ name_ar: 'خزنة', warehouse_id: 'null' });
    expect(errors.find((e: any) => e.property === 'warehouse_id')).toBeDefined();
  });

  it('rejects warehouse_id that is not a uuid', () => {
    const errors = validate({ name_ar: 'خزنة', warehouse_id: 'not-a-uuid' });
    expect(errors.find((e: any) => e.property === 'warehouse_id')).toBeDefined();
  });

  it('accepts valid uuid', () => {
    const errors = validate({
      name_ar: 'خزنة',
      warehouse_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    });
    expect(errors.find((e: any) => e.property === 'warehouse_id')).toBeUndefined();
  });

  it('accepts missing warehouse_id (now optional, falls through to service fallback)', () => {
    const errors = validate({ name_ar: 'خزنة' });
    expect(errors.find((e: any) => e.property === 'warehouse_id')).toBeUndefined();
  });
});

// ─── PR-FIN-PAYMENTS-WALLET-DISPLAY-BALANCE ──────────────────────────
// Pins the listCashboxes() shape that surfaces a GL-derived
// `accounting_balance` for non-cash kinds (ewallet/bank/check) so the
// FE can stop showing the misleading stored `current_balance` (which
// stays at 0 forever on those kinds because non-cash payments don't
// write CTs — see posting.service.ts for the rule).
//
// We assert SQL structure + parameters, not Postgres semantics —
// behaviour over GL data is verified live in production via
// supabase.execute_sql before merge.
describe('SettingsService.listCashboxes — accounting_balance derivation', () => {
  it('SQL shape: pure SELECT — no INSERT/UPDATE/DELETE on the cashboxes path', async () => {
    const { service, dsCalls } = await makeService(async () => []);
    await service.listCashboxes();
    expect(dsCalls).toHaveLength(1);
    const sql = dsCalls[0].sql;
    expect(sql).toMatch(/^\s*SELECT/i);
    expect(sql).not.toMatch(/\bINSERT\b/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
  });

  it('SQL shape: derives accounting_gl_code via the canonical kind→code map', async () => {
    const { service, dsCalls } = await makeService(async () => []);
    await service.listCashboxes();
    const sql = dsCalls[0].sql;
    expect(sql).toMatch(/accounting_gl_code/);
    // ewallet → 1114, bank → 1113, check → 1115. cash maps to NULL
    // (the FE keeps showing the stored current_balance for cash).
    expect(sql).toMatch(/'ewallet'[\s\S]*?'1114'/);
    expect(sql).toMatch(/'bank'[\s\S]*?'1113'/);
    expect(sql).toMatch(/'check'[\s\S]*?'1115'/);
  });

  it('SQL shape: derives accounting_balance via Σ(jl.debit − jl.credit) on the matching account_code', async () => {
    const { service, dsCalls } = await makeService(async () => []);
    await service.listCashboxes();
    const sql = dsCalls[0].sql;
    expect(sql).toMatch(/accounting_balance/);
    expect(sql).toMatch(/journal_lines/);
    expect(sql).toMatch(/SUM\(jl\.debit\s*-\s*jl\.credit\)/);
    expect(sql).toMatch(/chart_of_accounts/);
  });

  it('SQL shape: only counts posted, non-void journal entries (matches GL net rules)', async () => {
    const { service, dsCalls } = await makeService(async () => []);
    await service.listCashboxes();
    const sql = dsCalls[0].sql;
    expect(sql).toMatch(/je\.is_posted\s*=\s*TRUE/);
    expect(sql).toMatch(/je\.is_void\s*=\s*FALSE/);
  });

  it('SQL shape: cash kind is excluded from the GL aggregation (stays NULL → FE keeps current_balance)', async () => {
    const { service, dsCalls } = await makeService(async () => []);
    await service.listCashboxes();
    const sql = dsCalls[0].sql;
    // The IN-list inside the accounting_balance CASE must not name 'cash'.
    expect(sql).toMatch(/IN\s*\(\s*'ewallet'\s*,\s*'bank'\s*,\s*'check'\s*\)/);
    expect(sql).not.toMatch(/IN\s*\(\s*'cash'\s*,/);
  });

  it('SQL shape: filters to active cashboxes by default', async () => {
    const { service, dsCalls } = await makeService(async () => []);
    await service.listCashboxes();
    expect(dsCalls[0].sql).toMatch(/cb\.is_active\s*=\s*TRUE/);
  });

  it('warehouse_id filter: propagates to params and adds the warehouse_id condition', async () => {
    const WAREHOUSE = '00000000-aaaa-bbbb-cccc-111111111111';
    const { service, dsCalls } = await makeService(async () => []);
    await service.listCashboxes(WAREHOUSE);
    expect(dsCalls[0].params).toContain(WAREHOUSE);
    expect(dsCalls[0].sql).toMatch(/cb\.warehouse_id\s*=\s*\$1/);
  });

  it('no warehouse_id: empty params and no warehouse_id predicate', async () => {
    const { service, dsCalls } = await makeService(async () => []);
    await service.listCashboxes();
    expect(dsCalls[0].params).toEqual([]);
    expect(dsCalls[0].sql).not.toMatch(/cb\.warehouse_id\s*=/);
  });

  it('passes returned rows through verbatim (cash row: accounting_balance = NULL)', async () => {
    const cashRow = {
      id: 'cb-cash',
      kind: 'cash',
      name_ar: 'الخزينة الرئيسية',
      current_balance: '1500.00',
      accounting_gl_code: null,
      accounting_balance: null,
      is_active: true,
    };
    const { service } = await makeService(async () => [cashRow]);
    const out = await service.listCashboxes();
    expect(out).toEqual([cashRow]);
    expect(out[0].accounting_balance).toBeNull();
    expect(out[0].accounting_gl_code).toBeNull();
  });

  it('passes returned rows through verbatim (ewallet row: accounting_balance = derived GL net)', async () => {
    // Production fixture-shape: GL 1114 net = +2,190.00 EGP from
    // wallet/instapay invoice payments, while the stored
    // current_balance on خزنة التحويلات is still 0 (non-cash payments
    // never write CTs).
    const ewalletRow = {
      id: 'cb-ewallet',
      kind: 'ewallet',
      name_ar: 'خزنة التحويلات',
      current_balance: '0',
      accounting_gl_code: '1114',
      accounting_balance: '2190.00',
      is_active: true,
    };
    const { service } = await makeService(async () => [ewalletRow]);
    const out = await service.listCashboxes();
    expect(out[0].accounting_gl_code).toBe('1114');
    expect(out[0].accounting_balance).toBe('2190.00');
    // The stored current_balance is still 0 — the FE picks the right
    // figure via displayCashboxBalance based on kind.
    expect(out[0].current_balance).toBe('0');
  });

  it('bank kind row: accounting_gl_code = 1113 (canonical map)', async () => {
    const bankRow = {
      id: 'cb-bank',
      kind: 'bank',
      name_ar: 'حساب POS Visa',
      current_balance: '0',
      accounting_gl_code: '1113',
      accounting_balance: '0.00',
      is_active: true,
    };
    const { service } = await makeService(async () => [bankRow]);
    const out = await service.listCashboxes();
    expect(out[0].accounting_gl_code).toBe('1113');
  });

  it('check kind row: accounting_gl_code = 1115 (canonical map)', async () => {
    const checkRow = {
      id: 'cb-check',
      kind: 'check',
      name_ar: 'الشيكات الواردة',
      current_balance: '0',
      accounting_gl_code: '1115',
      accounting_balance: '0.00',
      is_active: true,
    };
    const { service } = await makeService(async () => [checkRow]);
    const out = await service.listCashboxes();
    expect(out[0].accounting_gl_code).toBe('1115');
  });
});
