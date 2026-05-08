/**
 * returns-audit.service.spec.ts — PR-FIN-RETURNS-EXCHANGES-AUDIT
 *
 * Pins the read-only audit composition for returns + exchanges:
 *   1. Document-level audit_logs rows surface in `document_changes`.
 *   2. Item-level audit_logs rows surface in `item_changes`.
 *   3. activity_logs rows surface in `activity`.
 *   4. `amendments` is an empty array (Phase 4 placeholder).
 *   5. The service issues SELECT-only SQL — no INSERT/UPDATE/DELETE.
 *   6. Both `getReturnAudit` and `getExchangeAudit` resolve to the
 *      same shape so the FE can reuse one renderer.
 *
 * No DB.  DataSource is stubbed with a SQL-router fake.
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ReturnsAuditService } from './returns-audit.service';

type QueryCall = { sql: string; params: any[] };
type Route = { match: RegExp; rows: any[] };

function makeRouter(routes: Route[]) {
  const calls: QueryCall[] = [];
  const ds: any = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const route = routes.find((r) => r.match.test(sql));
      return route ? route.rows : [];
    },
  };
  return { ds, calls };
}

async function buildSvc(ds: any) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ReturnsAuditService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  return moduleRef.get(ReturnsAuditService);
}

const RETURN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EXCHANGE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('ReturnsAuditService — read-only composition', () => {
  it('getReturnAudit composes document_changes + item_changes + activity', async () => {
    // The items query is more specific (it contains the
    // `IN (SELECT id::text FROM <items_table> ...)` subselect).  Order
    // the routes so the SQL-router resolves it before the broader
    // document-changes pattern.
    const { ds, calls } = makeRouter([
      // Item changes (table_name='return_items')
      {
        match:
          /FROM\s+audit_logs[\s\S]+IN\s+\(SELECT id::text FROM return_items WHERE return_id\s*=\s*\$2\)/i,
        rows: [
          {
            id: 'ad-2',
            table_name: 'return_items',
            record_id: 'ri-1',
            operation: 'I',
            changed_by: 'u-1',
            changed_by_username: 'admin',
            changed_by_name: 'مدير النظام',
            old_data: null,
            new_data: { id: 'ri-1', return_id: RETURN_ID, quantity: 1 },
            changed_at: '2026-05-08T09:55:00Z',
          },
        ],
      },
      // Document changes (table_name='returns') — broader regex; lives
      // AFTER the items route so SQL-router resolves items first.
      {
        match: /FROM\s+audit_logs[\s\S]+ad\.table_name\s*=\s*\$1/i,
        rows: [
          {
            id: 'ad-1',
            table_name: 'returns',
            record_id: RETURN_ID,
            operation: 'U',
            changed_by: 'u-1',
            changed_by_username: 'admin',
            changed_by_name: 'مدير النظام',
            old_data: { status: 'pending' },
            new_data: { status: 'approved' },
            changed_at: '2026-05-08T10:00:00Z',
          },
        ],
      },
      // Activity log rows (entity='return')
      {
        match:
          /FROM\s+activity_logs[\s\S]+a\.entity\s*=\s*\$1::entity_type/i,
        rows: [
          {
            id: 'act-1',
            user_id: 'u-1',
            username: 'admin',
            full_name: 'مدير النظام',
            action: 'void',
            entity: 'return',
            entity_id: RETURN_ID,
            summary: 'تم إلغاء المرتجع',
            metadata: { reason: 'test' },
            ip_address: '10.0.0.1',
            created_at: '2026-05-08T11:00:00Z',
          },
        ],
      },
    ]);
    const svc = await buildSvc(ds);

    const out = await svc.getReturnAudit(RETURN_ID);

    expect(out.document_type).toBe('return');
    expect(out.document_id).toBe(RETURN_ID);
    expect(out.document_changes).toHaveLength(1);
    expect(out.document_changes[0].operation).toBe('U');
    expect(out.item_changes).toHaveLength(1);
    expect(out.item_changes[0].record_id).toBe('ri-1');
    expect(out.activity).toHaveLength(1);
    expect(out.activity[0].action).toBe('void');
    expect(out.amendments).toEqual([]); // Phase 4 placeholder

    // Three SELECTs were issued (document, items, activity).
    expect(calls.length).toBe(3);
  });

  it('getExchangeAudit uses exchanges + exchange_items tables', async () => {
    const { ds, calls } = makeRouter([
      // Items first (more specific).
      {
        match:
          /FROM\s+audit_logs[\s\S]+IN\s+\(SELECT id::text FROM exchange_items WHERE exchange_id\s*=\s*\$2\)/i,
        rows: [],
      },
      // Document next.
      {
        match: /FROM\s+audit_logs[\s\S]+ad\.table_name\s*=\s*\$1/i,
        rows: [],
      },
      // Activity last.
      {
        match:
          /FROM\s+activity_logs[\s\S]+a\.entity\s*=\s*\$1::entity_type/i,
        rows: [],
      },
    ]);
    const svc = await buildSvc(ds);

    const out = await svc.getExchangeAudit(EXCHANGE_ID);

    expect(out.document_type).toBe('exchange');
    expect(out.document_id).toBe(EXCHANGE_ID);
    expect(out.amendments).toEqual([]);

    // Service issues queries in code order: document, items, activity.
    // Document-changes call → table_name='exchanges'.
    expect(calls[0].params[0]).toBe('exchanges');
    expect(calls[0].params[1]).toBe(EXCHANGE_ID);
    // Item-changes call → table_name='exchange_items' + FK + key name.
    expect(calls[1].params[0]).toBe('exchange_items');
    expect(calls[1].params[1]).toBe(EXCHANGE_ID);
    expect(calls[1].params[2]).toBe('exchange_id');
    // Activity call → entity='exchange'.
    expect(calls[2].params[0]).toBe('exchange');
    expect(calls[2].params[1]).toBe(EXCHANGE_ID);
  });

  it('returns the placeholder shape even when audit_logs has no rows yet (pre-trigger)', async () => {
    const { ds } = makeRouter([
      { match: /FROM\s+audit_logs/i, rows: [] },
      { match: /FROM\s+activity_logs/i, rows: [] },
    ]);
    const svc = await buildSvc(ds);

    const out = await svc.getReturnAudit(RETURN_ID);
    expect(out.document_changes).toEqual([]);
    expect(out.item_changes).toEqual([]);
    expect(out.activity).toEqual([]);
    expect(out.amendments).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Defense-in-depth source-grep — Phase 1 is read-only.
// ─────────────────────────────────────────────────────────────────────

describe('ReturnsAuditService — read-only contract', () => {
  const src = readFileSync(
    resolve(__dirname, 'returns-audit.service.ts'),
    'utf-8',
  );
  // Strip block-comments + line-comments so the negative-grep doesn't
  // false-positive on the file's own header-level prose.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('contains zero INSERT / UPDATE / DELETE / TRUNCATE / DROP / ALTER statements', () => {
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(code).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bDROP\b/i);
    expect(code).not.toMatch(/\bALTER\b/i);
  });

  it('does not invoke any posting / engine / mutation services', () => {
    expect(code).not.toMatch(/\bAccountingPostingService\b/);
    expect(code).not.toMatch(/\bFinancialEngineService\b/);
    expect(code).not.toMatch(/\bpostReturn\b/);
    expect(code).not.toMatch(/\brecordTransaction\b/);
    expect(code).not.toMatch(/\brecordCashOnlyMovement\b/);
    expect(code).not.toMatch(/\baccounting_only\b/);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Controller wiring — only TWO new GET endpoints, both read-only.
// ─────────────────────────────────────────────────────────────────────

describe('ReturnsController — Phase 1 endpoints', () => {
  const src = readFileSync(
    resolve(__dirname, 'returns.controller.ts'),
    'utf-8',
  );

  it('exposes GET /returns/:id/audit and GET /exchanges/:id/audit', () => {
    expect(src).toMatch(/@Get\('returns\/:id\/audit'\)/);
    expect(src).toMatch(/@Get\('exchanges\/:id\/audit'\)/);
  });

  it('does NOT expose any new PATCH/DELETE endpoints in this PR', () => {
    expect(src).not.toMatch(/@Patch\(/);
    expect(src).not.toMatch(/@Delete\(/);
  });

  it('keeps the class-level @Permissions(\'returns.view\') gate', () => {
    expect(src).toMatch(/@Permissions\(['"]returns\.view['"]\)/);
  });
});
