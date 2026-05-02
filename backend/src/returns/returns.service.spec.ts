/**
 * returns.service.spec.ts — PR-FIN-RETURNS-UX-1A
 *
 * Pins the read-side enrichment contract for the returns list and
 * detail endpoints:
 *
 *   • The list SQL joins users (requested/approved/refunded), cashboxes,
 *     and projects active JE id + entry_no + posted_at, refund CT id,
 *     and the computed accounting_status / inventory_status / match_status.
 *   • Filters: date_from, date_to, refund_method, accounting_status all
 *     thread into the WHERE / outer-WHERE correctly.
 *   • findOne() inherits the same enriched shape.
 *
 * Pure SQL-shape tests using a stubbed DataSource — no Postgres needed.
 *
 * Read-only contract: no DELETE / INSERT / UPDATE statements anywhere
 * in the list/findOne path (defense-in-depth source-grep).
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ReturnsService } from './returns.service';
import { ReturnEntity } from './entities/return.entity';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

type QueryCall = { sql: string; params: any[] };

function makeFakeDs(rowsByCall: any[][] = []) {
  const calls: QueryCall[] = [];
  let idx = 0;
  const ds: any = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return rowsByCall[idx++] ?? [];
    },
    transaction: async (cb: (em: any) => Promise<any>) => cb(ds),
  };
  return { ds, calls };
}

async function buildService(ds: any) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ReturnsService,
      { provide: DataSource, useValue: ds },
      { provide: getRepositoryToken(ReturnEntity), useValue: {} },
      { provide: AccountingPostingService, useValue: {} },
      { provide: FinancialEngineService, useValue: {} },
    ],
  }).compile();
  return moduleRef.get(ReturnsService);
}

// ─────────────────────────────────────────────────────────────────────
//  list() — SQL shape contract
// ─────────────────────────────────────────────────────────────────────

describe('ReturnsService.list — read enrichment SQL shape', () => {
  it('joins users for operator names + cashboxes for cashbox name', async () => {
    const { ds, calls } = makeFakeDs([[]]);
    const svc = await buildService(ds);
    await svc.list({} as any);

    expect(calls).toHaveLength(1);
    const sql = calls[0].sql;

    // user joins
    expect(sql).toMatch(/LEFT JOIN users\s+u1\s+ON u1\.id\s*=\s*r\.requested_by/);
    expect(sql).toMatch(/LEFT JOIN users\s+u2\s+ON u2\.id\s*=\s*r\.approved_by/);
    expect(sql).toMatch(/LEFT JOIN users\s+u3\s+ON u3\.id\s*=\s*r\.refunded_by/);
    expect(sql).toMatch(/u1\.full_name AS requested_by_name/);
    expect(sql).toMatch(/u2\.full_name AS approved_by_name/);
    expect(sql).toMatch(/u3\.full_name AS refunded_by_name/);

    // cashbox join
    expect(sql).toMatch(/LEFT JOIN cashboxes\s+cb\s+ON cb\.id\s*=\s*r\.cashbox_id/);
    expect(sql).toMatch(/cb\.name_ar AS cashbox_name/);
  });

  it('projects active journal entry id + entry_no + posted_at', async () => {
    const { ds, calls } = makeFakeDs([[]]);
    const svc = await buildService(ds);
    await svc.list({} as any);
    const sql = calls[0].sql;

    expect(sql).toMatch(/AS journal_entry_id/);
    expect(sql).toMatch(/AS journal_entry_no/);
    expect(sql).toMatch(/AS journal_entry_posted_at/);
    // JE subqueries scope to the active (posted, non-void) entry only.
    expect(sql).toMatch(
      /reference_type\s*=\s*'return'[\s\S]+is_posted\s*=\s*true[\s\S]+is_void\s*=\s*false/,
    );
  });

  it('projects refund cashbox_transaction id + cash-leg-unlinked diagnostic', async () => {
    const { ds, calls } = makeFakeDs([[]]);
    const svc = await buildService(ds);
    await svc.list({} as any);
    const sql = calls[0].sql;

    expect(sql).toMatch(/AS refund_cashbox_transaction_id/);
    expect(sql).toMatch(/category\s*=\s*'refund'/);
    expect(sql).toMatch(/AS has_unlinked_cash_leg/);
    expect(sql).toMatch(/coa\.code LIKE '111_'/);
  });

  it('computes accounting_status, inventory_status, match_status as derived columns', async () => {
    const { ds, calls } = makeFakeDs([[]]);
    const svc = await buildService(ds);
    await svc.list({} as any);
    const sql = calls[0].sql;

    expect(sql).toMatch(/AS accounting_status/);
    expect(sql).toMatch(/AS inventory_status/);
    expect(sql).toMatch(/AS match_status/);
    // Each must enumerate the documented buckets.
    expect(sql).toMatch(/'not_applicable'/);
    expect(sql).toMatch(/'je_missing'/);
    expect(sql).toMatch(/'cashbox_not_linked'/);
    expect(sql).toMatch(/'needs_review'/);
    expect(sql).toMatch(/'matched'/);
    expect(sql).toMatch(/'restored'/);
  });

  it('passes-through existing fields and adds created_at + updated_at', async () => {
    const { ds, calls } = makeFakeDs([[]]);
    const svc = await buildService(ds);
    await svc.list({} as any);
    const sql = calls[0].sql;
    // legacy fields still present
    for (const f of [
      'r.id',
      'r.return_no',
      'r.status',
      'r.reason',
      'r.total_refund',
      'r.refund_method',
      'r.requested_at',
      'r.approved_at',
      'r.refunded_at',
      'r.rejected_at',
      'r.original_invoice_id',
      'i.invoice_no',
      'r.customer_id',
      'c.full_name AS customer_name',
      'c.phone AS customer_phone',
      'r.cashbox_id',
    ]) {
      expect(sql).toContain(f);
    }
    // new explicit timestamps for the FE
    expect(sql).toContain('r.created_at');
    expect(sql).toContain('r.updated_at');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  list() — filter wiring
// ─────────────────────────────────────────────────────────────────────

describe('ReturnsService.list — filter wiring', () => {
  it('threads date_from / date_to into the WHERE clause as date casts', async () => {
    const { ds, calls } = makeFakeDs([[]]);
    const svc = await buildService(ds);
    await svc.list({ date_from: '2026-05-01', date_to: '2026-05-02' } as any);

    const c = calls[0];
    expect(c.sql).toMatch(/r\.requested_at\s*>=\s*\$\d+::date/);
    expect(c.sql).toMatch(
      /r\.requested_at\s*<\s*\(\$\d+::date\s*\+\s*INTERVAL\s*'1 day'\)/,
    );
    // date_from + date_to + limit + offset = 4 params
    expect(c.params).toEqual(['2026-05-01', '2026-05-02', 50, 0]);
  });

  it('threads refund_method as r.refund_method = $N', async () => {
    const { ds, calls } = makeFakeDs([[]]);
    const svc = await buildService(ds);
    await svc.list({ refund_method: 'cash' } as any);

    expect(calls[0].sql).toMatch(/r\.refund_method\s*=\s*\$\d+/);
    expect(calls[0].params).toEqual(['cash', 50, 0]);
  });

  it('threads accounting_status into the OUTER WHERE (post-CASE)', async () => {
    const { ds, calls } = makeFakeDs([[]]);
    const svc = await buildService(ds);
    await svc.list({ accounting_status: 'cashbox_not_linked' } as any);

    expect(calls[0].sql).toMatch(/FROM base b\s+WHERE accounting_status\s*=\s*\$\d+/);
    expect(calls[0].params).toEqual(['cashbox_not_linked', 50, 0]);
  });

  it('combines status + customer_id + q + date_from + refund_method correctly', async () => {
    const { ds, calls } = makeFakeDs([[]]);
    const svc = await buildService(ds);
    await svc.list({
      status: 'refunded',
      customer_id: '11111111-1111-1111-1111-111111111111',
      q: 'INV',
      date_from: '2026-05-01',
      refund_method: 'cash',
    } as any);

    expect(calls[0].params).toEqual([
      'refunded',
      '11111111-1111-1111-1111-111111111111',
      '%INV%',
      '2026-05-01',
      'cash',
      50,
      0,
    ]);
  });

  it('honors limit/offset bounds (clamp 1..200) without leaking SQL injection', async () => {
    const { ds, calls } = makeFakeDs([[]]);
    const svc = await buildService(ds);
    await svc.list({ limit: '9999', offset: '-50' } as any);
    expect(calls[0].params.slice(-2)).toEqual([200, 0]);
  });

  it('omitted optional filters → no extra WHERE clauses', async () => {
    const { ds, calls } = makeFakeDs([[]]);
    const svc = await buildService(ds);
    await svc.list({} as any);
    // No status/customer/q/date/refund_method/accounting_status filters → only LIMIT/OFFSET params.
    expect(calls[0].params).toEqual([50, 0]);
    // The base CTE has no WHERE; the outer SELECT has no accounting_status WHERE.
    expect(calls[0].sql).not.toMatch(/r\.status\s*=\s*\$/);
    expect(calls[0].sql).not.toMatch(/r\.refund_method\s*=\s*\$/);
    expect(calls[0].sql).not.toMatch(/WHERE accounting_status/);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  findOne() — inherits enriched shape
// ─────────────────────────────────────────────────────────────────────

describe('ReturnsService.findOne — read enrichment', () => {
  it('SELECTs the same enriched columns as list()', async () => {
    const headerRow = {
      id: 'ret-1',
      return_no: 'RET-2026-000001',
      status: 'refunded',
      cashbox_id: '524646d5-7bd6-4d8d-a484-b1f562b039a4',
      cashbox_name: 'الخزينة الرئيسية',
      requested_by_name: 'محمود زهران',
      approved_by_name: 'محمود زهران',
      refunded_by_name: 'محمود زهران',
      journal_entry_id: 'je-1',
      journal_entry_no: 'JE-2026-000358',
      journal_entry_posted_at: '2026-05-01T16:44:36Z',
      refund_cashbox_transaction_id: 245,
      accounting_status: 'matched',
      inventory_status: 'restored',
      match_status: 'matched',
    };
    const { ds, calls } = makeFakeDs([[headerRow], []]);
    const svc = await buildService(ds);
    const out = await svc.findOne('ret-1');

    expect(calls).toHaveLength(2); // header + items
    const sql = calls[0].sql;

    // joins
    expect(sql).toMatch(/LEFT JOIN cashboxes\s+cb\s+ON cb\.id\s*=\s*r\.cashbox_id/);
    expect(sql).toMatch(/u1\.full_name AS requested_by_name/);
    // computed fields
    expect(sql).toMatch(/AS journal_entry_id/);
    expect(sql).toMatch(/AS journal_entry_no/);
    expect(sql).toMatch(/AS journal_entry_posted_at/);
    expect(sql).toMatch(/AS refund_cashbox_transaction_id/);
    expect(sql).toMatch(/AS accounting_status/);
    expect(sql).toMatch(/AS inventory_status/);
    expect(sql).toMatch(/AS match_status/);

    // result is passed through
    expect(out.cashbox_name).toBe('الخزينة الرئيسية');
    expect(out.journal_entry_no).toBe('JE-2026-000358');
    expect(out.accounting_status).toBe('matched');
    expect(out.match_status).toBe('matched');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Defense-in-depth: read-only contract
// ─────────────────────────────────────────────────────────────────────

describe('ReturnsService — read enrichment is purely read-only', () => {
  const SRC = readFileSync(
    resolve(__dirname, './returns.service.ts'),
    'utf8',
  );
  // Strip JS comments so we only inspect executable SQL strings.
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /(^|[^:])\/\/[^\n]*/g,
    '$1',
  );

  function methodBody(name: string): string {
    const idx = CODE.indexOf(`async ${name}`);
    expect(idx).toBeGreaterThan(-1);
    // Capture up to the next `async `/`}` boundary heuristically; use a
    // generous 6000-char window that covers the longest method body.
    return CODE.substring(idx, idx + 6000);
  }

  it('list() body contains zero DELETE/INSERT/UPDATE statements', () => {
    const body = methodBody('list');
    expect(body).not.toMatch(/^\s*DELETE\s/im);
    expect(body).not.toMatch(/^\s*INSERT\s/im);
    expect(body).not.toMatch(/^\s*UPDATE\s/im);
  });

  it('findOne() body contains zero DELETE/INSERT/UPDATE statements', () => {
    const body = methodBody('findOne');
    expect(body).not.toMatch(/^\s*DELETE\s/im);
    expect(body).not.toMatch(/^\s*INSERT\s/im);
    expect(body).not.toMatch(/^\s*UPDATE\s/im);
  });
});
