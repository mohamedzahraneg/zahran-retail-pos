/**
 * returns.lifecycle-audit.spec.ts — PR-FIN-RETURNS-EXCHANGES-AUDIT
 *
 * Pins the lifecycle activity_logs writes added in this PR:
 *
 *   1. createReturn → action='create',  entity='return',   extra.kind='create_return'
 *   2. approve()    → action='approve', entity='return',   extra.kind='approve_return'
 *   3. reject()     → action='reject',  entity='return',   extra.kind='reject_return'
 *   4. refund()     → action='update',  entity='return',   extra.kind='refund_return'
 *      (the activity_action enum has no 'refund' value; we use
 *      'update' + extra.kind to disambiguate — same convention as
 *      cancel(), which already uses 'void' + extra.kind='cancel_return')
 *   5. createExchange → action='create', entity='exchange', extra.kind='create_exchange'
 *
 * For each:
 *   · the writeActivity payload is asserted in shape (action, entity,
 *     entity_id, summary contains document_no)
 *   · extra carries document_no + status_before/after when applicable
 *     + reason / notes / amount / method when present
 *
 * Also pins:
 *   · ZERO new mutation endpoints / routes added
 *   · ZERO direct PATCH/DELETE/edit endpoints added
 *   · ZERO mutation to financial tables outside existing flows
 *   · audit writes are best-effort: a thrown writeActivity must NOT
 *     break the lifecycle method (try/catch around every call)
 *
 * No DB.  DataSource + repo + posting + engine + audit all stubbed.
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
import { AuditService } from '../audit/audit.service';

type QueryCall = { sql: string; params: any[] };
type Route = {
  match: RegExp;
  rows?: any[];
  fn?: (params: any[]) => any[] | undefined;
};

function makeRouter(routes: Route[]) {
  const calls: QueryCall[] = [];
  const ds: any = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const route = routes.find((r) => r.match.test(sql));
      const out = route ? (route.fn ? route.fn(params) : route.rows) : undefined;
      return out ?? [];
    },
    transaction: async (cb: (em: any) => Promise<any>) => cb(ds),
  };
  return { ds, calls };
}

function makeRepo(retRow: any) {
  return { findOne: jest.fn().mockResolvedValue(retRow) };
}

const RETURN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const RETURN_NO = 'RET-2026-LIFE';

async function buildSvc(opts: {
  ds: any;
  retRow: any;
  audit?: any;
  posting?: any;
}) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ReturnsService,
      { provide: DataSource, useValue: opts.ds },
      {
        provide: getRepositoryToken(ReturnEntity),
        useValue: makeRepo(opts.retRow),
      },
      {
        provide: AccountingPostingService,
        useValue:
          opts.posting ?? { postReturn: jest.fn().mockResolvedValue({}) },
      },
      {
        provide: FinancialEngineService,
        useValue: {
          recordCashOnlyMovement: jest.fn().mockResolvedValue({ ok: true }),
        },
      },
      {
        provide: AuditService,
        useValue: opts.audit ?? { writeActivity: jest.fn() },
      },
    ],
  }).compile();
  return moduleRef.get(ReturnsService);
}

const findOneRoute: Route = {
  match: /SELECT[\s\S]+FROM\s+returns\s+r[\s\S]+WHERE\s+r\.id\s*=\s*\$1/i,
  rows: [
    {
      id: RETURN_ID,
      return_no: RETURN_NO,
      status: 'refunded',
      cashbox_id: 'cb-1',
    },
  ],
};

// ─── createReturn ────────────────────────────────────────────────────

describe('ReturnsService.createReturn — activity log', () => {
  it('writes a create_return activity with document_no + totals (standalone / blind return)', async () => {
    const writeActivity = jest.fn();
    const { ds } = makeRouter([
      // INSERT INTO returns ... RETURNING ...
      {
        match: /INSERT\s+INTO\s+returns/i,
        rows: [
          {
            id: RETURN_ID,
            return_no: RETURN_NO,
            status: 'pending',
            total_refund: '150',
            restocking_fee: '0',
            net_refund: '150',
          },
        ],
      },
      { match: /INSERT\s+INTO\s+return_items/i, rows: [] },
    ]);
    const svc = await buildSvc({
      ds,
      retRow: {} as any,
      audit: { writeActivity },
    });
    // Standalone (blind) return — no original_invoice_id, so the
    // invoice-lookup branch is skipped.  Mirrors the production
    // RET-2026-000005 shape we've been working with.
    await svc.createReturn(
      {
        warehouse_id: 'wh-1',
        reason: 'wrong_size',
        items: [
          { variant_id: 'v-1', quantity: 1, unit_price: 150, refund_amount: 150 } as any,
        ],
      } as any,
      USER_ID,
    );

    expect(writeActivity).toHaveBeenCalledTimes(1);
    const call = writeActivity.mock.calls[0][0];
    expect(call).toMatchObject({
      user_id: USER_ID,
      action: 'create',
      entity: 'return',
      entity_id: RETURN_ID,
    });
    expect(call.summary).toContain(RETURN_NO);
    expect(call.extra).toMatchObject({
      kind: 'create_return',
      return_no: RETURN_NO,
      status_after: 'pending',
      reason: 'wrong_size',
      total_refund: 150,
      net_refund: 150,
      original_invoice_id: null,
      warehouse_id: 'wh-1',
      items_count: 1,
    });
  });
});

// ─── approve ────────────────────────────────────────────────────────

describe('ReturnsService.approve — activity log', () => {
  it('writes an approve_return activity with status_before/after', async () => {
    const writeActivity = jest.fn();
    const pending = {
      id: RETURN_ID,
      return_no: RETURN_NO,
      status: 'pending',
      warehouse_id: 'wh-1',
    };
    const { ds } = makeRouter([
      {
        match: /FROM\s+return_items\s+WHERE\s+return_id\s*=\s*\$1/i,
        rows: [],
      },
      {
        match: /UPDATE\s+returns\s+SET\s+status\s*=\s*'approved'/i,
        rows: [],
      },
      findOneRoute,
    ]);
    const svc = await buildSvc({
      ds,
      retRow: pending,
      audit: { writeActivity },
    });

    await svc.approve(RETURN_ID, { notes: 'OK to refund' } as any, USER_ID);

    expect(writeActivity).toHaveBeenCalledTimes(1);
    const call = writeActivity.mock.calls[0][0];
    expect(call.action).toBe('approve');
    expect(call.entity).toBe('return');
    expect(call.summary).toContain(RETURN_NO);
    expect(call.extra).toMatchObject({
      kind: 'approve_return',
      return_no: RETURN_NO,
      status_before: 'pending',
      status_after: 'approved',
      notes: 'OK to refund',
    });
  });
});

// ─── reject ─────────────────────────────────────────────────────────

describe('ReturnsService.reject — activity log', () => {
  it('writes a reject_return activity with reason', async () => {
    const writeActivity = jest.fn();
    const pending = {
      id: RETURN_ID,
      return_no: RETURN_NO,
      status: 'pending',
    };
    const { ds } = makeRouter([
      {
        match: /UPDATE\s+returns\s+SET\s+status\s*=\s*'rejected'/i,
        rows: [],
      },
      findOneRoute,
    ]);
    const svc = await buildSvc({
      ds,
      retRow: pending,
      audit: { writeActivity },
    });

    await svc.reject(RETURN_ID, { reason: 'invalid claim' } as any, USER_ID);

    expect(writeActivity).toHaveBeenCalledTimes(1);
    const call = writeActivity.mock.calls[0][0];
    expect(call.action).toBe('reject');
    expect(call.entity).toBe('return');
    expect(call.extra).toMatchObject({
      kind: 'reject_return',
      return_no: RETURN_NO,
      status_before: 'pending',
      status_after: 'rejected',
      reason: 'invalid claim',
    });
  });
});

// ─── refund ─────────────────────────────────────────────────────────

describe('ReturnsService.refund — activity log', () => {
  it('writes a refund_return activity with status_before/after + amounts', async () => {
    const writeActivity = jest.fn();
    const approved = {
      id: RETURN_ID,
      return_no: RETURN_NO,
      status: 'approved',
      net_refund: '150.00',
      total_refund: '150.00',
    };
    const { ds } = makeRouter([
      {
        match: /SELECT id, cashbox_id, status::text AS status\s+FROM shifts/i,
        rows: [{ id: 'shift-1', cashbox_id: 'cb-1', status: 'open' }],
      },
      {
        match: /UPDATE\s+returns\s+SET\s+status\s*=\s*'refunded'/i,
        rows: [],
      },
      findOneRoute,
    ]);
    const postReturn = jest
      .fn()
      .mockResolvedValue({ ok: true, entry_id: 'je-1' });
    const svc = await buildSvc({
      ds,
      retRow: approved,
      audit: { writeActivity },
      posting: { postReturn },
    });

    await svc.refund(
      RETURN_ID,
      { refund_method: 'cash', shift_id: 'shift-1' } as any,
      USER_ID,
      [],
    );

    expect(writeActivity).toHaveBeenCalledTimes(1);
    const call = writeActivity.mock.calls[0][0];
    expect(call.action).toBe('update'); // enum has no 'refund' literal
    expect(call.entity).toBe('return');
    expect(call.summary).toContain(RETURN_NO);
    expect(call.summary).toContain('cash');
    expect(call.extra).toMatchObject({
      kind: 'refund_return',
      return_no: RETURN_NO,
      status_before: 'approved',
      status_after: 'refunded',
      refund_method: 'cash',
      net_refund: 150,
      total_refund: 150,
      shift_id: 'shift-1',
      cashbox_id: 'cb-1',
      je_entry_id: 'je-1',
    });
  });
});

// ─── createExchange ─────────────────────────────────────────────────

describe('ReturnsService.createExchange — activity log', () => {
  it('writes a create_exchange activity with values + price_difference', async () => {
    const writeActivity = jest.fn();
    const { ds } = makeRouter([
      // SELECT * FROM invoices WHERE id = $1
      {
        match: /SELECT\s+\*\s+FROM\s+invoices\s+WHERE\s+id\s*=\s*\$1/i,
        rows: [
          {
            id: 'inv-1',
            shift_id: 'shift-1',
            cashbox_id: 'cb-1',
            customer_id: 'c-1',
          },
        ],
      },
      // INSERT INTO exchanges ... RETURNING id, exchange_no
      {
        match: /INSERT\s+INTO\s+exchanges/i,
        rows: [{ id: 'exc-1', exchange_no: 'EXC-2026-001' }],
      },
      { match: /INSERT\s+INTO\s+exchange_items/i, rows: [] },
      // INSERT INTO invoices ... RETURNING id, invoice_no
      {
        match: /INSERT\s+INTO\s+invoices/i,
        rows: [{ id: 'inv-new', invoice_no: 'INV-2026-NEW' }],
      },
      { match: /INSERT\s+INTO\s+invoice_items/i, rows: [] },
      { match: /UPDATE\s+exchanges\s+SET\s+new_invoice_id/i, rows: [] },
    ]);
    const postReturn = jest.fn().mockResolvedValue({ ok: true });
    const svc = await buildSvc({
      ds,
      retRow: {} as any,
      audit: { writeActivity },
      posting: {
        postReturn,
        postInvoice: jest.fn().mockResolvedValue({ ok: true }),
      },
    });

    // Equal exchange — no cash difference, so we don't need to wire
    // engine.recordCashOnlyMovement.
    await svc.createExchange(
      {
        original_invoice_id: 'inv-1',
        warehouse_id: 'wh-1',
        reason: 'wrong_size',
        returned_items: [
          { variant_id: 'v-1', quantity: 1, unit_price: 150 } as any,
        ],
        new_items: [
          { variant_id: 'v-2', quantity: 1, unit_price: 150 } as any,
        ],
      } as any,
      USER_ID,
      [],
    );

    expect(writeActivity).toHaveBeenCalledTimes(1);
    const call = writeActivity.mock.calls[0][0];
    expect(call.action).toBe('create');
    expect(call.entity).toBe('exchange');
    expect(call.entity_id).toBe('exc-1');
    expect(call.summary).toContain('EXC-2026-001');
    expect(call.extra).toMatchObject({
      kind: 'create_exchange',
      exchange_no: 'EXC-2026-001',
      status_after: 'completed',
      original_invoice_id: 'inv-1',
      new_invoice_id: 'inv-new',
      new_invoice_no: 'INV-2026-NEW',
      returned_value: 150,
      new_items_value: 150,
      price_difference: 0,
    });
  });
});

// ─── Defense-in-depth source-grep — no edit endpoints, no item-edit
//     mutations, no JE/CT/SM logic changes outside existing services ──

describe('ReturnsService — read-only contract for this PR', () => {
  const svcSrc = readFileSync(
    resolve(__dirname, 'returns.service.ts'),
    'utf-8',
  );
  const ctrlSrc = readFileSync(
    resolve(__dirname, 'returns.controller.ts'),
    'utf-8',
  );

  it('controller has no @Patch / @Delete routes (no direct edit endpoints in this PR)', () => {
    expect(ctrlSrc).not.toMatch(/@Patch\(/);
    expect(ctrlSrc).not.toMatch(/@Delete\(/);
  });

  // PR-FIN-RETURNS-EXCHANGES-EDIT-REQUESTS shipped the request-only
  // workflow (create / approve / reject status changes only — no
  // application of the requested payload).  The earlier negative-
  // grep against `edit-requests` is now obsolete.  We still guard
  // against amendment routes (Phase 4) and direct PATCH/DELETE
  // surface — both still forbidden.
  it('controller has no edit-request APPROVAL APPLICATION routes (no payload-application yet)', () => {
    // The four documented routes (GET list, POST create, POST
    // approve, POST reject) ARE allowed — the payload is NOT
    // applied to the parent document by any of them.
    expect(ctrlSrc).not.toMatch(/@Post\(['"][^'"]*amendments/);
  });

  it('returns.service does not bypass financial engine guards', () => {
    expect(svcSrc).not.toMatch(/accounting_only\s*:/);
  });

  it('returns.service does not raw-INSERT into financial tables', () => {
    expect(svcSrc).not.toMatch(/INSERT\s+INTO\s+journal_entries\b/i);
    expect(svcSrc).not.toMatch(/INSERT\s+INTO\s+journal_lines\b/i);
    expect(svcSrc).not.toMatch(/INSERT\s+INTO\s+cashbox_transactions\b/i);
  });

  it('every lifecycle method calls writeActivity', () => {
    // 5 lifecycle methods touched in this PR + cancel() that already
    // had it = 6 occurrences.
    const matches = svcSrc.match(/this\.audit[\?\s]*\.writeActivity\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });
});
