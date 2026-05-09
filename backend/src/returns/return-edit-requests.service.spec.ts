/**
 * return-edit-requests.service.spec.ts — PR-FIN-RETURNS-EXCHANGES-EDIT-REQUESTS
 *
 * Pins Phase-1 contract: request + review status changes only.
 * Approval / rejection do NOT apply the requested payload.
 *
 * What's covered:
 *   1. create() inserts into return_edit_requests with status=pending
 *      + captures before_snapshot from the live document/items.
 *   2. create() validates requested_action (allowlist), reason length
 *      (≥ 5), payload shape (object, non-array, non-null).
 *   3. create() throws NotFound when the parent document is missing.
 *   4. approve() / reject() update only the request row's status +
 *      reviewer fields.  No mutation of returns / return_items /
 *      exchanges / exchange_items / journal_entries / journal_lines /
 *      cashbox_transactions / stock_movements.
 *   5. reject() requires review_notes ≥ 5 chars.
 *   6. Reviewing a non-pending request throws Conflict.
 *   7. Activity log written with correct kind + status_before/after
 *      for create / approve / reject.
 *   8. Source-grep: no AccountingPostingService / FinancialEngineService
 *      / postReturn / recordTransaction / recordCashOnlyMovement /
 *      reverseByReference / accounting_only / raw INSERT into financial
 *      tables in the service source.
 *
 * No DB.  DataSource is stubbed via SQL-router fake.
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ReturnEditRequestsService } from './return-edit-requests.service';
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

async function buildSvc(ds: any, audit?: any) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ReturnEditRequestsService,
      { provide: DataSource, useValue: ds },
      {
        provide: AuditService,
        useValue: audit ?? { writeActivity: jest.fn() },
      },
    ],
  }).compile();
  return moduleRef.get(ReturnEditRequestsService);
}

const RET_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const REQ_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// ─── create ────────────────────────────────────────────────────────

describe('ReturnEditRequestsService.create — request only, no application', () => {
  it('inserts a pending request with before_snapshot from the live document', async () => {
    const writeActivity = jest.fn();
    const { ds, calls } = makeRouter([
      // Parent document SELECT
      {
        match: /SELECT\s+\*\s+FROM\s+returns\s+WHERE\s+id\s*=\s*\$1/i,
        rows: [
          { id: RET_ID, return_no: 'RET-2026-EDIT-1', status: 'approved' },
        ],
      },
      // Items SELECT
      {
        match: /SELECT\s+\*\s+FROM\s+return_items\s+WHERE\s+return_id\s*=\s*\$1/i,
        rows: [{ id: 'ri-1', return_id: RET_ID, unit_price: '150' }],
      },
      // INSERT INTO return_edit_requests
      {
        match: /INSERT\s+INTO\s+return_edit_requests/i,
        rows: [
          {
            id: REQ_ID,
            return_id: RET_ID,
            return_no: 'RET-2026-EDIT-1',
            requested_action: 'price_change',
            requested_payload: { item_id: 'ri-1', new_unit_price: 120 },
            before_snapshot: {
              document: { id: RET_ID, return_no: 'RET-2026-EDIT-1' },
              items: [{ id: 'ri-1' }],
            },
            after_preview: null,
            reason_text: 'العميل وجد سعرًا أقل',
            status: 'pending',
            requested_by: USER_ID,
            requested_at: '2026-05-09T12:00:00Z',
            reviewed_by: null,
            reviewed_at: null,
            review_notes: null,
            idempotency_key: null,
            created_at: '2026-05-09T12:00:00Z',
            updated_at: '2026-05-09T12:00:00Z',
          },
        ],
      },
    ]);
    const svc = await buildSvc(ds, { writeActivity });

    const out = await svc.create({
      entity: 'return',
      parent_id: RET_ID,
      requested_action: 'price_change',
      requested_payload: { item_id: 'ri-1', new_unit_price: 120 },
      reason_text: 'العميل وجد سعرًا أقل',
      user_id: USER_ID,
    });

    expect(out.status).toBe('pending');
    expect(out.id).toBe(REQ_ID);
    expect(out.parent_id).toBe(RET_ID);
    expect(out.before_snapshot).toBeDefined();

    // No mutation of the parent document or items.
    const wroteDocOrItems = calls.some(
      (c) =>
        /UPDATE\s+returns\b/i.test(c.sql) ||
        /UPDATE\s+return_items\b/i.test(c.sql) ||
        /DELETE\s+FROM\s+(returns|return_items)\b/i.test(c.sql),
    );
    expect(wroteDocOrItems).toBe(false);

    // Activity logged with edit_request_create.
    expect(writeActivity).toHaveBeenCalledTimes(1);
    const log = writeActivity.mock.calls[0][0];
    expect(log.action).toBe('create');
    expect(log.entity).toBe('return');
    expect(log.entity_id).toBe(RET_ID);
    expect(log.extra).toMatchObject({
      kind: 'edit_request_create',
      edit_request_id: REQ_ID,
      requested_action: 'price_change',
      status_after: 'pending',
    });
  });

  it('rejects an unknown requested_action', async () => {
    const { ds } = makeRouter([]);
    const svc = await buildSvc(ds);
    await expect(
      svc.create({
        entity: 'return',
        parent_id: RET_ID,
        requested_action: 'totally_invalid_action',
        requested_payload: { x: 1 },
        reason_text: 'reason text long enough',
        user_id: USER_ID,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a reason shorter than 5 chars', async () => {
    const { ds } = makeRouter([]);
    const svc = await buildSvc(ds);
    await expect(
      svc.create({
        entity: 'return',
        parent_id: RET_ID,
        requested_action: 'price_change',
        requested_payload: { x: 1 },
        reason_text: 'abc',
        user_id: USER_ID,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-object requested_payload', async () => {
    const { ds } = makeRouter([]);
    const svc = await buildSvc(ds);
    await expect(
      svc.create({
        entity: 'return',
        parent_id: RET_ID,
        requested_action: 'price_change',
        requested_payload: [1, 2, 3] as any,
        reason_text: 'a valid reason',
        user_id: USER_ID,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws NotFound when the parent return does not exist', async () => {
    const { ds } = makeRouter([
      {
        match: /SELECT\s+\*\s+FROM\s+returns\s+WHERE\s+id\s*=\s*\$1/i,
        rows: [],
      },
    ]);
    const svc = await buildSvc(ds);
    await expect(
      svc.create({
        entity: 'return',
        parent_id: RET_ID,
        requested_action: 'price_change',
        requested_payload: { x: 1 },
        reason_text: 'a valid reason',
        user_id: USER_ID,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ─── approve ───────────────────────────────────────────────────────

describe('ReturnEditRequestsService.approve — status change only', () => {
  it('updates only the request row + writes edit_request_approve activity', async () => {
    const writeActivity = jest.fn();
    const { ds, calls } = makeRouter([
      // SELECT FOR UPDATE
      {
        match: /SELECT\s+\*\s+FROM\s+return_edit_requests\s+WHERE\s+id\s*=\s*\$1\s+FOR UPDATE/i,
        rows: [
          {
            id: REQ_ID,
            return_id: RET_ID,
            status: 'pending',
            requested_by: USER_ID,
          },
        ],
      },
      // UPDATE
      {
        match: /UPDATE\s+return_edit_requests/i,
        rows: [
          {
            id: REQ_ID,
            return_id: RET_ID,
            status: 'approved',
            reviewed_by: USER_ID,
            reviewed_at: '2026-05-09T13:00:00Z',
            review_notes: 'OK',
          },
        ],
      },
    ]);
    const svc = await buildSvc(ds, { writeActivity });

    const out = await svc.approve({
      entity: 'return',
      request_id: REQ_ID,
      user_id: USER_ID,
      review_notes: 'OK',
    });

    expect(out.status).toBe('approved');

    // No writes to parent document / items / financial tables.
    const wroteForbidden = calls.some(
      (c) =>
        /UPDATE\s+(returns|return_items|exchanges|exchange_items|journal_entries|journal_lines|cashbox_transactions|stock_movements)\b/i.test(c.sql) ||
        /INSERT\s+INTO\s+(returns|return_items|exchanges|exchange_items|journal_entries|journal_lines|cashbox_transactions|stock_movements)\b/i.test(c.sql) ||
        /DELETE\s+FROM\s+(returns|return_items|exchanges|exchange_items|journal_entries|journal_lines|cashbox_transactions|stock_movements)\b/i.test(c.sql),
    );
    expect(wroteForbidden).toBe(false);

    expect(writeActivity).toHaveBeenCalledTimes(1);
    const log = writeActivity.mock.calls[0][0];
    expect(log.action).toBe('approve');
    expect(log.extra).toMatchObject({
      kind: 'edit_request_approve',
      status_before: 'pending',
      status_after: 'approved',
    });
  });

  it('throws Conflict when reviewing a non-pending request', async () => {
    const { ds } = makeRouter([
      {
        match: /SELECT\s+\*\s+FROM\s+return_edit_requests/i,
        rows: [{ id: REQ_ID, return_id: RET_ID, status: 'approved' }],
      },
    ]);
    const svc = await buildSvc(ds);
    await expect(
      svc.approve({
        entity: 'return',
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

// ─── reject ────────────────────────────────────────────────────────

describe('ReturnEditRequestsService.reject — status change only', () => {
  it('rejects without review_notes', async () => {
    const { ds } = makeRouter([]);
    const svc = await buildSvc(ds);
    await expect(
      svc.reject({
        entity: 'return',
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sets status=rejected and writes edit_request_reject activity', async () => {
    const writeActivity = jest.fn();
    const { ds } = makeRouter([
      {
        match: /SELECT\s+\*\s+FROM\s+return_edit_requests\s+WHERE\s+id\s*=\s*\$1\s+FOR UPDATE/i,
        rows: [{ id: REQ_ID, return_id: RET_ID, status: 'pending' }],
      },
      {
        match: /UPDATE\s+return_edit_requests/i,
        rows: [
          {
            id: REQ_ID,
            return_id: RET_ID,
            status: 'rejected',
            reviewed_by: USER_ID,
            review_notes: 'لا يمكن قبول هذا التعديل',
          },
        ],
      },
    ]);
    const svc = await buildSvc(ds, { writeActivity });

    const out = await svc.reject({
      entity: 'return',
      request_id: REQ_ID,
      user_id: USER_ID,
      review_notes: 'لا يمكن قبول هذا التعديل',
    });

    expect(out.status).toBe('rejected');
    expect(writeActivity).toHaveBeenCalledTimes(1);
    const log = writeActivity.mock.calls[0][0];
    expect(log.action).toBe('reject');
    expect(log.extra).toMatchObject({
      kind: 'edit_request_reject',
      status_before: 'pending',
      status_after: 'rejected',
    });
  });
});

// ─── exchange parity (smoke) ───────────────────────────────────────

describe('ReturnEditRequestsService — exchange parity', () => {
  it('uses exchange_edit_requests + exchange_id when entity="exchange"', async () => {
    const { ds, calls } = makeRouter([
      {
        match: /SELECT\s+\*\s+FROM\s+exchanges\s+WHERE\s+id\s*=\s*\$1/i,
        rows: [{ id: 'exc-1', exchange_no: 'EXC-EDIT-1' }],
      },
      {
        match:
          /SELECT\s+\*\s+FROM\s+exchange_items\s+WHERE\s+exchange_id\s*=\s*\$1/i,
        rows: [],
      },
      {
        match: /INSERT\s+INTO\s+exchange_edit_requests/i,
        rows: [
          {
            id: 'req-x',
            exchange_id: 'exc-1',
            exchange_no: 'EXC-EDIT-1',
            requested_action: 'reason_change',
            status: 'pending',
            requested_payload: { reason: 'updated' },
            before_snapshot: { document: {}, items: [] },
            reason_text: 'تصحيح السبب',
          },
        ],
      },
    ]);
    const svc = await buildSvc(ds);
    const out = await svc.create({
      entity: 'exchange',
      parent_id: 'exc-1',
      requested_action: 'reason_change',
      requested_payload: { reason: 'updated' },
      reason_text: 'تصحيح السبب',
      user_id: USER_ID,
    });
    expect(out.parent_id).toBe('exc-1');

    // Confirm we hit the exchange tables, not the return tables.
    const sqls = calls.map((c) => c.sql).join('\n');
    expect(sqls).toMatch(/exchange_edit_requests/);
    expect(sqls).toMatch(/exchange_items/);
    expect(sqls).not.toMatch(/return_edit_requests/);
  });
});

// ─── Defense-in-depth source-grep ─────────────────────────────────

describe('ReturnEditRequestsService — read-only contract for parent docs', () => {
  const src = readFileSync(
    resolve(__dirname, 'return-edit-requests.service.ts'),
    'utf-8',
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('does not import or call any posting / engine / mutation services', () => {
    expect(code).not.toMatch(/\bAccountingPostingService\b/);
    expect(code).not.toMatch(/\bFinancialEngineService\b/);
    expect(code).not.toMatch(/\bpostReturn\b/);
    expect(code).not.toMatch(/\brecordTransaction\b/);
    expect(code).not.toMatch(/\brecordCashOnlyMovement\b/);
    expect(code).not.toMatch(/\breverseByReference\b/);
    expect(code).not.toMatch(/\baccounting_only\b/);
  });

  it('does not write to financial tables or the parent document tables', () => {
    expect(code).not.toMatch(/INSERT\s+INTO\s+journal_entries\b/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+journal_lines\b/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+cashbox_transactions\b/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+stock_movements\b/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+returns\b/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+return_items\b/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+exchanges\b/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+exchange_items\b/i);
    expect(code).not.toMatch(/UPDATE\s+returns\b/i);
    expect(code).not.toMatch(/UPDATE\s+return_items\b/i);
    expect(code).not.toMatch(/UPDATE\s+exchanges\b/i);
    expect(code).not.toMatch(/UPDATE\s+exchange_items\b/i);
    expect(code).not.toMatch(/UPDATE\s+journal_entries\b/i);
    expect(code).not.toMatch(/UPDATE\s+cashbox_transactions\b/i);
    expect(code).not.toMatch(/UPDATE\s+stock_movements\b/i);
    expect(code).not.toMatch(/DELETE\s+FROM\s+(returns|return_items|exchanges|exchange_items|journal_entries|journal_lines|cashbox_transactions|stock_movements)\b/i);
  });

  it('writes only to return_edit_requests / exchange_edit_requests', () => {
    // Whitelist the only tables touched by INSERT/UPDATE in the
    // service body.
    expect(code).toMatch(/INSERT\s+INTO\s+\$\{table\}/i); // template-literal INSERT (return_edit_requests OR exchange_edit_requests)
    expect(code).toMatch(/UPDATE\s+\$\{table\}/i); // same for review()
  });
});

// ─── Controller: only the documented routes added ────────────────

describe('ReturnsController — Phase 1 edit-request routes only', () => {
  const ctrl = readFileSync(
    resolve(__dirname, 'returns.controller.ts'),
    'utf-8',
  );

  it('exposes the four edit-request routes for returns', () => {
    expect(ctrl).toMatch(/@Get\(['"]returns\/:id\/edit-requests['"]\)/);
    expect(ctrl).toMatch(/@Post\(['"]returns\/:id\/edit-requests['"]\)/);
    expect(ctrl).toMatch(
      /@Post\(['"]returns\/:id\/edit-requests\/:requestId\/approve['"]\)/,
    );
    expect(ctrl).toMatch(
      /@Post\(['"]returns\/:id\/edit-requests\/:requestId\/reject['"]\)/,
    );
  });

  it('exposes the four edit-request routes for exchanges', () => {
    expect(ctrl).toMatch(/@Get\(['"]exchanges\/:id\/edit-requests['"]\)/);
    expect(ctrl).toMatch(/@Post\(['"]exchanges\/:id\/edit-requests['"]\)/);
    expect(ctrl).toMatch(
      /@Post\(['"]exchanges\/:id\/edit-requests\/:requestId\/approve['"]\)/,
    );
    expect(ctrl).toMatch(
      /@Post\(['"]exchanges\/:id\/edit-requests\/:requestId\/reject['"]\)/,
    );
  });

  it('still has zero @Patch / @Delete routes', () => {
    expect(ctrl).not.toMatch(/@Patch\(/);
    expect(ctrl).not.toMatch(/@Delete\(/);
  });
});
