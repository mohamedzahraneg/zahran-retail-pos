/**
 * expense-allocations.spec.ts — PR-PHASE2-B1
 *
 * Foundation tests for the read-only expense-allocation surface:
 *
 *   Behavioural — drive ExpenseAllocationsService against a mock
 *   DataSource and assert:
 *     a. listPeriods returns empty array cleanly when no rows
 *     b. listPeriods composes WHERE clauses from filters
 *     c. getPeriod throws NotFound when id is absent
 *     d. getPeriod returns period + lines when present
 *     e. profitWithOverhead returns rows with overhead_allocated=0
 *        when no allocations exist (regression invariant)
 *     f. profitWithOverhead applies date filter when from/to set
 *     g. unallocatedExpenses returns the view rows
 *
 *   Source-grep — pin the hard constraints in place forever:
 *     - no FinancialEngine import / call
 *     - no INSERT/UPDATE/DELETE on journal_entries / journal_lines /
 *       cashbox_transactions / stock_movements / product_variants /
 *       invoice_items / invoices / expenses
 *     - no `accounting_only` escape
 *
 *   Migration source-grep — verify the migration file structure:
 *     - creates exactly the two tables + the enum + the two views
 *     - reuses touch_updated_at()
 *     - no mention of forbidden tables in any non-SELECT context
 *
 *   Module wiring — confirm both controllers are registered, the
 *   service is the only provider, and no FinancialEngineService
 *   anywhere in the module's dependency graph.
 */

import { NotFoundException, BadRequestException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExpenseAllocationsService } from './expense-allocations.service';

// ─── Mock DataSource (mirrors the pattern in recurring-expenses.v2.spec.ts) ──

interface MockCall {
  sql: string;
  params?: any[];
}

type Handler = (call: MockCall) => any[] | Promise<any[]>;

function makeMockDs(handler: Handler) {
  const calls: MockCall[] = [];
  const ds: any = {
    query: async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      return await handler({ sql, params });
    },
  };
  return { ds, calls };
}

function findCall(calls: MockCall[], re: RegExp): MockCall | undefined {
  return calls.find((c) => re.test(c.sql));
}

// ─── 1. listPeriods ───────────────────────────────────────────────

describe('ExpenseAllocationsService.listPeriods (PR-PHASE2-B1)', () => {
  it('returns empty array cleanly when no rows match', async () => {
    const { ds } = makeMockDs(() => []);
    const svc = new ExpenseAllocationsService(ds as any);
    const rows = await svc.listPeriods();
    expect(rows).toEqual([]);
  });

  it('returns rows with audit names + lines_count when periods exist', async () => {
    const { ds } = makeMockDs(() => [
      {
        id: 'p-1',
        period_start: '2026-05-01',
        period_end: '2026-05-31',
        warehouse_id: 'wh-1',
        warehouse_name: 'الفرع الرئيسي',
        status: 'draft',
        total_allocated: '0',
        notes: null,
        created_by: 'u-1',
        created_by_name: 'محرر',
        approved_by: null,
        approved_by_name: null,
        approved_at: null,
        reversed_by: null,
        reversed_by_name: null,
        reversed_at: null,
        reversed_reason: null,
        created_at: '2026-05-11T10:00:00Z',
        updated_at: '2026-05-11T10:00:00Z',
        lines_count: '0',
      },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const rows = await svc.listPeriods();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'p-1',
      status: 'draft',
      warehouse_name: 'الفرع الرئيسي',
      lines_count: '0',
    });
  });

  it('composes WHERE from filters: from/to/status/warehouse_id', async () => {
    const { ds, calls } = makeMockDs(() => []);
    const svc = new ExpenseAllocationsService(ds as any);
    await svc.listPeriods({
      from: '2026-05-01',
      to: '2026-05-31',
      status: 'approved',
      warehouse_id: 'wh-1',
    });
    const c = calls[0]!;
    expect(c.sql).toMatch(/p\.period_end\s+>=\s+\$1/);
    expect(c.sql).toMatch(/p\.period_start\s+<=\s+\$2/);
    expect(c.sql).toMatch(/p\.status\s*=\s*\$3/);
    expect(c.sql).toMatch(/p\.warehouse_id\s*=\s*\$4/);
    expect(c.params).toEqual([
      '2026-05-01',
      '2026-05-31',
      'approved',
      'wh-1',
    ]);
  });

  it('rejects an invalid status filter with BadRequest', async () => {
    const { ds } = makeMockDs(() => []);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.listPeriods({ status: 'bogus' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('order is by period_start DESC then created_at DESC', async () => {
    const { ds, calls } = makeMockDs(() => []);
    const svc = new ExpenseAllocationsService(ds as any);
    await svc.listPeriods();
    expect(calls[0]?.sql).toMatch(
      /ORDER BY p\.period_start DESC, p\.created_at DESC/,
    );
  });
});

// ─── 2. getPeriod ────────────────────────────────────────────────

describe('ExpenseAllocationsService.getPeriod (PR-PHASE2-B1)', () => {
  it('throws NotFoundException with Arabic message when id is absent', async () => {
    const { ds } = makeMockDs(({ sql }) => {
      if (/FROM expense_allocation_periods/i.test(sql)) return [];
      return [];
    });
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(svc.getPeriod('missing-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.getPeriod('missing-id')).rejects.toMatchObject({
      message: 'فترة التوزيع غير موجودة.',
    });
  });

  it('returns the period merged with its lines array', async () => {
    const period = {
      id: 'p-2',
      period_start: '2026-04-01',
      period_end: '2026-04-30',
      status: 'approved',
      total_allocated: '5000',
    };
    const line = {
      id: 'l-1',
      period_id: 'p-2',
      expense_id: 'e-1',
      expense_no: 'EXP-2026-00001',
      source_amount: '5000',
      product_id: 'pr-1',
      product_name: 'منتج اختبار',
      allocation_method: 'by_revenue',
      allocated_amount: '500',
    };
    const { ds } = makeMockDs(({ sql }) => {
      if (/FROM expense_allocation_periods p/i.test(sql)) return [period];
      if (/FROM expense_allocation_lines l/i.test(sql)) return [line];
      return [];
    });
    const svc = new ExpenseAllocationsService(ds as any);
    const out = await svc.getPeriod('p-2');
    expect(out.id).toBe('p-2');
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatchObject({
      id: 'l-1',
      allocation_method: 'by_revenue',
      product_name: 'منتج اختبار',
    });
  });

  it('returns lines: [] when the period has no lines', async () => {
    const { ds } = makeMockDs(({ sql }) => {
      if (/FROM expense_allocation_periods p/i.test(sql)) return [{ id: 'p-3' }];
      if (/FROM expense_allocation_lines l/i.test(sql)) return [];
      return [];
    });
    const svc = new ExpenseAllocationsService(ds as any);
    const out = await svc.getPeriod('p-3');
    expect(out.lines).toEqual([]);
  });
});

// ─── 3. profitWithOverhead ───────────────────────────────────────

describe('ExpenseAllocationsService.profitWithOverhead (PR-PHASE2-B1)', () => {
  it('returns rows with overhead_allocated=0 when no allocations exist (regression invariant vs base view)', async () => {
    const productRow = {
      product_id: 'pr-1',
      product_name: 'منتج',
      product_type: 'fast_moving',
      units_sold: '10',
      revenue: '1000',
      cogs: '600',
      gross_profit: '400',
      roi_pct: '66.67',
      overhead_allocated: '0',
      net_profit_after_overhead: '400',
    };
    const { ds } = makeMockDs(() => [productRow]);
    const svc = new ExpenseAllocationsService(ds as any);
    const rows = await svc.profitWithOverhead();
    expect(rows[0]).toMatchObject({
      overhead_allocated: '0',
      net_profit_after_overhead: '400',
    });
  });

  it('returns empty array cleanly when no products have sold', async () => {
    const { ds } = makeMockDs(() => []);
    const svc = new ExpenseAllocationsService(ds as any);
    expect(await svc.profitWithOverhead()).toEqual([]);
  });

  it('applies a date-scoped overhead subquery when from + to are supplied', async () => {
    const { ds, calls } = makeMockDs(() => []);
    const svc = new ExpenseAllocationsService(ds as any);
    await svc.profitWithOverhead({ from: '2026-01-01', to: '2026-12-31' });
    const c = calls[0]!;
    expect(c.sql).toMatch(/p\.period_end\s+>=\s+\$1::date/);
    expect(c.sql).toMatch(/p\.period_start\s+<=\s+\$2::date/);
    expect(c.params).toEqual(['2026-01-01', '2026-12-31']);
  });

  it('uses an all-time overhead subquery when no date filter is supplied', async () => {
    const { ds, calls } = makeMockDs(() => []);
    const svc = new ExpenseAllocationsService(ds as any);
    await svc.profitWithOverhead();
    const c = calls[0]!;
    // No date-bound predicates appear when filters omitted.
    expect(c.sql).not.toMatch(/\$1::date/);
    expect(c.params).toEqual([]);
  });

  it('always restricts to approved periods', async () => {
    const { ds, calls } = makeMockDs(() => []);
    const svc = new ExpenseAllocationsService(ds as any);
    await svc.profitWithOverhead();
    expect(calls[0]?.sql).toMatch(/p\.status\s*=\s*'approved'/);
  });
});

// ─── 4. unallocatedExpenses ──────────────────────────────────────

describe('ExpenseAllocationsService.unallocatedExpenses (PR-PHASE2-B1)', () => {
  it('returns rows from v_unallocated_expenses verbatim', async () => {
    const { ds } = makeMockDs(() => [
      {
        id: 'e-1',
        expense_no: 'EXP-2026-00001',
        amount: '1000',
        expense_date: '2026-05-10',
        category_id: 'c-1',
        category_code: 'rent',
        category_name: 'إيجار',
      },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const rows = await svc.unallocatedExpenses();
    expect(rows).toHaveLength(1);
    expect(rows[0].expense_no).toBe('EXP-2026-00001');
  });

  it('returns empty array cleanly when no rows', async () => {
    const { ds } = makeMockDs(() => []);
    const svc = new ExpenseAllocationsService(ds as any);
    expect(await svc.unallocatedExpenses()).toEqual([]);
  });

  it('applies date + warehouse filters', async () => {
    const { ds, calls } = makeMockDs(() => []);
    const svc = new ExpenseAllocationsService(ds as any);
    await svc.unallocatedExpenses({
      from: '2026-05-01',
      to: '2026-05-31',
      warehouse_id: 'wh-1',
    });
    const c = calls[0]!;
    expect(c.sql).toMatch(/u\.expense_date\s+>=\s+\$1/);
    expect(c.sql).toMatch(/u\.expense_date\s+<=\s+\$2/);
    expect(c.sql).toMatch(/u\.warehouse_id\s*=\s*\$3/);
    expect(c.params).toEqual(['2026-05-01', '2026-05-31', 'wh-1']);
  });
});

// ─── 5. Source-grep invariants — service file ────────────────────

describe('expense-allocations.service.ts — source-grep guards (PR-PHASE2-B1)', () => {
  const SRC = readFileSync(
    resolve(__dirname, './expense-allocations.service.ts'),
    'utf-8',
  );
  // Strip comments before grepping for forbidden patterns so docstrings
  // can describe what we DON'T do without tripping the negative grep.
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('does NOT import FinancialEngine in any form', () => {
    expect(CODE).not.toMatch(/FinancialEngine/);
    expect(CODE).not.toMatch(/financial-engine/);
  });

  it('does NOT INSERT / UPDATE / DELETE on journal_entries / journal_lines', () => {
    for (const verb of ['INSERT INTO', 'UPDATE', 'DELETE FROM']) {
      expect(CODE).not.toMatch(new RegExp(`${verb}\\s+journal_entries\\b`, 'i'));
      expect(CODE).not.toMatch(new RegExp(`${verb}\\s+journal_lines\\b`, 'i'));
    }
  });

  it('does NOT INSERT / UPDATE / DELETE on cashbox_transactions / stock_movements', () => {
    for (const verb of ['INSERT INTO', 'UPDATE', 'DELETE FROM']) {
      expect(CODE).not.toMatch(
        new RegExp(`${verb}\\s+cashbox_transactions\\b`, 'i'),
      );
      expect(CODE).not.toMatch(
        new RegExp(`${verb}\\s+stock_movements\\b`, 'i'),
      );
    }
  });

  it('does NOT INSERT / UPDATE / DELETE on product_variants / invoice_items / invoices', () => {
    for (const verb of ['INSERT INTO', 'UPDATE', 'DELETE FROM']) {
      expect(CODE).not.toMatch(
        new RegExp(`${verb}\\s+product_variants\\b`, 'i'),
      );
      expect(CODE).not.toMatch(
        new RegExp(`${verb}\\s+invoice_items\\b`, 'i'),
      );
      expect(CODE).not.toMatch(new RegExp(`${verb}\\s+invoices\\b`, 'i'));
    }
  });

  it('does NOT INSERT / UPDATE / DELETE on expenses', () => {
    // PR-PHASE2-B1 is read-only over expenses too — the allocation
    // layer references but never mutates them.
    for (const verb of ['INSERT INTO', 'UPDATE', 'DELETE FROM']) {
      expect(CODE).not.toMatch(new RegExp(`${verb}\\s+expenses\\b`, 'i'));
    }
  });

  it('confines all writes to expense_allocation_periods and expense_allocation_lines only (B2 scope)', () => {
    // PR-PHASE2-B2 adds INSERT/UPDATE/DELETE on the two allocation tables.
    // That is expected.  This test pins the WRITE SCOPE: collect every
    // INSERT / UPDATE / DELETE token in the service, then confirm each
    // one names ONLY one of the two allocation tables — never any other.
    const writeTokenRe =
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi;
    const allowed = new Set([
      'expense_allocation_periods',
      'expense_allocation_lines',
    ]);
    const targets = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = writeTokenRe.exec(CODE)) !== null) {
      targets.add(m[1].toLowerCase());
    }
    for (const t of targets) {
      expect(allowed.has(t)).toBe(true);
    }
    // And — separately — confirm the two allocation tables ARE actually
    // written to (B2 mutations land in this PR, so they must appear).
    expect(targets.has('expense_allocation_periods')).toBe(true);
    expect(targets.has('expense_allocation_lines')).toBe(true);
  });

  it('does NOT use the accounting_only escape hatch', () => {
    expect(CODE).not.toMatch(/\baccounting_only\b/);
  });

  it('does NOT touch backend/src/provisioning', () => {
    expect(CODE).not.toMatch(/provisioning/);
  });
});

// ─── 6. Source-grep — migration file ─────────────────────────────

describe('132_expense_allocation.sql — migration source guards (PR-PHASE2-B1)', () => {
  const MIG = readFileSync(
    resolve(__dirname, '../../../database/migrations/132_expense_allocation.sql'),
    'utf-8',
  );

  it('creates the status enum', () => {
    expect(MIG).toMatch(
      /CREATE TYPE expense_allocation_period_status AS ENUM[^;]+'draft'[^;]+'approved'[^;]+'reversed'/s,
    );
  });

  it('creates expense_allocation_periods + expense_allocation_lines tables', () => {
    expect(MIG).toMatch(/CREATE TABLE IF NOT EXISTS expense_allocation_periods/);
    expect(MIG).toMatch(/CREATE TABLE IF NOT EXISTS expense_allocation_lines/);
  });

  it('reuses the existing touch_updated_at() helper (does NOT redefine it)', () => {
    expect(MIG).toMatch(/EXECUTE FUNCTION touch_updated_at\(\)/);
    expect(MIG).not.toMatch(/CREATE OR REPLACE FUNCTION touch_updated_at/);
    expect(MIG).not.toMatch(/CREATE FUNCTION touch_updated_at/);
  });

  it('creates v_product_profit_with_overhead view based on v_product_profit', () => {
    expect(MIG).toMatch(
      /CREATE OR REPLACE VIEW v_product_profit_with_overhead\s+AS[\s\S]+FROM v_product_profit pp/,
    );
    // The view restricts to approved periods only.
    expect(MIG).toMatch(/p\.status\s*=\s*'approved'/);
  });

  it('creates v_unallocated_expenses view', () => {
    expect(MIG).toMatch(/CREATE OR REPLACE VIEW v_unallocated_expenses/);
  });

  it('migration body contains NO direct writes to forbidden tables', () => {
    const body = MIG.replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\n]*/g, '');
    for (const t of [
      'journal_entries',
      'journal_lines',
      'cashbox_transactions',
      'stock_movements',
      'product_variants',
      'invoice_items',
    ]) {
      expect(body).not.toMatch(new RegExp(`INSERT\\s+INTO\\s+${t}\\b`, 'i'));
      expect(body).not.toMatch(new RegExp(`UPDATE\\s+${t}\\b`, 'i'));
      expect(body).not.toMatch(new RegExp(`DELETE\\s+FROM\\s+${t}\\b`, 'i'));
      expect(body).not.toMatch(new RegExp(`ALTER\\s+TABLE\\s+${t}\\b`, 'i'));
      expect(body).not.toMatch(new RegExp(`DROP\\s+TABLE\\s+${t}\\b`, 'i'));
    }
    // No engine_context bypass, no accounting_only.
    expect(body).not.toMatch(/accounting_only/i);
  });

  it('does NOT drop or alter existing views v_product_profit / v_daily_profit', () => {
    expect(MIG).not.toMatch(/DROP\s+VIEW\s+v_product_profit\b/i);
    expect(MIG).not.toMatch(/CREATE\s+OR\s+REPLACE\s+VIEW\s+v_product_profit\s+AS/i);
    expect(MIG).not.toMatch(/DROP\s+VIEW\s+v_daily_profit/i);
    expect(MIG).not.toMatch(/CREATE\s+OR\s+REPLACE\s+VIEW\s+v_daily_profit/i);
  });

  it('uses IF NOT EXISTS guards so re-running the migration is safe', () => {
    expect(MIG).toMatch(/CREATE TABLE IF NOT EXISTS expense_allocation_periods/);
    expect(MIG).toMatch(/CREATE TABLE IF NOT EXISTS expense_allocation_lines/);
    expect(MIG).toMatch(
      /IF NOT EXISTS[\s\S]+typname = 'expense_allocation_period_status'/,
    );
  });
});

// ─── 7. Module wiring ────────────────────────────────────────────

describe('ExpenseAllocationsModule — wiring (PR-PHASE2-B1)', () => {
  const MODULE_SRC_RAW = readFileSync(
    resolve(__dirname, './expense-allocations.module.ts'),
    'utf-8',
  );
  // Strip /* … */ block comments and // line comments so docstring mentions of
  // "FinancialEngine" (intentional: "No FinancialEngine dependency") don't
  // trip the guard.  We only care about actual code references.
  const MODULE_SRC = MODULE_SRC_RAW
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  it('registers both the periods controller and the reports controller', () => {
    expect(MODULE_SRC).toMatch(/ExpenseAllocationsController/);
    expect(MODULE_SRC).toMatch(/ExpenseAllocationsReportsController/);
  });

  it('does NOT import FinancialEngineService or any chart-of-accounts internals', () => {
    expect(MODULE_SRC).not.toMatch(/FinancialEngine/);
    expect(MODULE_SRC).not.toMatch(/chart-of-accounts/);
  });

  it('only provides ExpenseAllocationsService (read-only foundation)', () => {
    expect(MODULE_SRC).toMatch(/providers:\s*\[\s*ExpenseAllocationsService\s*\]/);
  });
});

// ════════════════════════════════════════════════════════════════════
//  PR-PHASE2-B2 — mutation surface
// ════════════════════════════════════════════════════════════════════
//
// B2 adds draft-period CRUD, manual-line CRUD, and the approve/reverse
// FSM.  The behavior tests below drive the service against a mock
// DataSource that supports `ds.transaction(async em => …)` and route
// queries by SQL shape — keeping the spec independent of any real DB.

interface TxMockCall {
  sql: string;
  params?: any[];
  inTransaction: boolean;
}

function makeTxMockDs(routes: Array<{ match: RegExp; reply: any[] | ((c: TxMockCall) => any[]) }>) {
  const calls: TxMockCall[] = [];
  const route = (sql: string, params?: any[], inTx = false) => {
    const call: TxMockCall = { sql, params, inTransaction: inTx };
    calls.push(call);
    for (const r of routes) {
      if (r.match.test(sql)) {
        return typeof r.reply === 'function' ? r.reply(call) : r.reply;
      }
    }
    return [];
  };
  const ds: any = {
    query: async (sql: string, params?: any[]) => route(sql, params, false),
    transaction: async (fn: (em: any) => any) => {
      const em = {
        query: async (sql: string, params?: any[]) => route(sql, params, true),
      };
      return fn(em);
    },
  };
  return { ds, calls };
}

const PERIOD_ROW_FULL = {
  id: 'p-1',
  period_start: '2026-05-01',
  period_end: '2026-05-31',
  warehouse_id: null,
  warehouse_name: null,
  status: 'draft',
  total_allocated: '0',
  notes: null,
  created_by: 'u-1',
  created_by_name: 'محرر',
  approved_by: null,
  approved_by_name: null,
  approved_at: null,
  reversed_by: null,
  reversed_by_name: null,
  reversed_at: null,
  reversed_reason: null,
  created_at: '2026-05-11T10:00:00Z',
  updated_at: '2026-05-11T10:00:00Z',
};

// ─── 8. createPeriod ─────────────────────────────────────────────

describe('ExpenseAllocationsService.createPeriod (PR-PHASE2-B2)', () => {
  it('inserts a draft period with the supplied user as created_by, then returns it via getPeriod', async () => {
    const { ds, calls } = makeTxMockDs([
      { match: /^\s*INSERT INTO expense_allocation_periods/, reply: [{ id: 'p-1' }] },
      { match: /FROM expense_allocation_periods\s+p\s+LEFT JOIN warehouses/, reply: [PERIOD_ROW_FULL] },
      { match: /FROM expense_allocation_lines/, reply: [] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.createPeriod(
      { period_start: '2026-05-01', period_end: '2026-05-31' },
      'user-99',
    );
    expect(res).toMatchObject({ id: 'p-1', status: 'draft' });
    const ins = calls.find((c) => /INSERT INTO expense_allocation_periods/.test(c.sql))!;
    expect(ins.sql).toMatch(/status,\s*created_by/);
    expect(ins.params).toEqual([
      '2026-05-01',
      '2026-05-31',
      null,
      null,
      'user-99',
    ]);
  });

  it('rejects when period_end < period_start (BadRequest, Arabic)', async () => {
    const { ds } = makeTxMockDs([]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.createPeriod(
        { period_start: '2026-05-10', period_end: '2026-05-01' },
        'u-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when either date is missing', async () => {
    const { ds } = makeTxMockDs([]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.createPeriod({ period_start: '', period_end: '2026-05-31' } as any, 'u-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── 9. updatePeriod ─────────────────────────────────────────────

describe('ExpenseAllocationsService.updatePeriod (PR-PHASE2-B2)', () => {
  it('updates a draft period and returns the refreshed row', async () => {
    const { ds, calls } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'draft', period_start: '2026-05-01', period_end: '2026-05-31' }] },
      { match: /^\s*UPDATE expense_allocation_periods/, reply: [] },
      { match: /FROM expense_allocation_periods\s+p\s+LEFT JOIN warehouses/, reply: [{ ...PERIOD_ROW_FULL, notes: 'تم التحديث' }] },
      { match: /FROM expense_allocation_lines/, reply: [] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.updatePeriod('p-1', { notes: 'تم التحديث' });
    expect(res).toMatchObject({ notes: 'تم التحديث' });
    const upd = calls.find((c) => /^\s*UPDATE expense_allocation_periods/.test(c.sql))!;
    expect(upd.sql).toMatch(/SET notes = \$1/);
  });

  it('rejects update on an approved period with BadRequest', async () => {
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'approved', period_start: '2026-05-01', period_end: '2026-05-31' }] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.updatePeriod('p-1', { notes: 'too late' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects update on a reversed period', async () => {
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'reversed', period_start: '2026-05-01', period_end: '2026-05-31' }] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.updatePeriod('p-1', { notes: 'no' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when the merged date range becomes invalid', async () => {
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'draft', period_start: '2026-05-01', period_end: '2026-05-31' }] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.updatePeriod('p-1', { period_end: '2026-04-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── 10. deletePeriod ────────────────────────────────────────────

describe('ExpenseAllocationsService.deletePeriod (PR-PHASE2-B2)', () => {
  it('deletes a draft period; CASCADE handles lines', async () => {
    const { ds, calls } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'draft' }] },
      { match: /^\s*DELETE FROM expense_allocation_periods/, reply: [] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.deletePeriod('p-1');
    expect(res).toEqual({ success: true });
    expect(calls.some((c) => /DELETE FROM expense_allocation_periods/.test(c.sql))).toBe(true);
  });

  it('rejects delete on approved period', async () => {
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'approved' }] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(svc.deletePeriod('p-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects delete on reversed period', async () => {
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'reversed' }] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(svc.deletePeriod('p-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── 11. addLine ─────────────────────────────────────────────────

describe('ExpenseAllocationsService.addLine (PR-PHASE2-B2)', () => {
  function draftAddLineMock() {
    return makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'draft' }] },
      { match: /^\s*INSERT INTO expense_allocation_lines/, reply: [{ id: 'line-1' }] },
      { match: /^\s*UPDATE expense_allocation_periods\s+SET total_allocated/, reply: [] },
    ]);
  }

  it('appends a manual product-target line and recomputes total_allocated', async () => {
    const { ds, calls } = draftAddLineMock();
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.addLine('p-1', {
      expense_id: 'e-1',
      source_amount: 100,
      product_id: 'prod-1',
      allocated_amount: 25,
    });
    expect(res).toEqual({ id: 'line-1' });
    const ins = calls.find((c) => /INSERT INTO expense_allocation_lines/.test(c.sql))!;
    expect(ins.sql).toMatch(/'manual'/);
    expect(calls.some((c) => /UPDATE expense_allocation_periods\s+SET total_allocated/.test(c.sql))).toBe(true);
  });

  it('rejects a line with ZERO targets', async () => {
    const { ds } = draftAddLineMock();
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.addLine('p-1', {
        expense_id: 'e-1',
        source_amount: 100,
        allocated_amount: 10,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a line with MULTIPLE targets', async () => {
    const { ds } = draftAddLineMock();
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.addLine('p-1', {
        expense_id: 'e-1',
        source_amount: 100,
        product_id: 'p-1',
        product_category_id: 'cat-1',
        allocated_amount: 10,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a line with no source (no expense_id and no expense_category_id)', async () => {
    const { ds } = draftAddLineMock();
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.addLine('p-1', {
        source_amount: 100,
        product_id: 'prod-1',
        allocated_amount: 10,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when allocated_amount is negative', async () => {
    const { ds } = draftAddLineMock();
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.addLine('p-1', {
        expense_id: 'e-1',
        source_amount: 100,
        product_id: 'prod-1',
        allocated_amount: -5,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-manual allocation_method (B2 only accepts manual)', async () => {
    const { ds } = draftAddLineMock();
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.addLine('p-1', {
        expense_id: 'e-1',
        source_amount: 100,
        product_id: 'prod-1',
        allocated_amount: 25,
        allocation_method: 'by_revenue' as any,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects adding a line to an approved period', async () => {
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'approved' }] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.addLine('p-1', {
        expense_id: 'e-1',
        source_amount: 100,
        product_id: 'prod-1',
        allocated_amount: 25,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── 12. clearLines ──────────────────────────────────────────────

describe('ExpenseAllocationsService.clearLines (PR-PHASE2-B2)', () => {
  it('clears all lines on a draft period and resets total_allocated', async () => {
    const { ds, calls } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'draft' }] },
      { match: /^\s*DELETE FROM expense_allocation_lines/, reply: [] },
      { match: /^\s*UPDATE expense_allocation_periods\s+SET total_allocated/, reply: [] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.clearLines('p-1');
    expect(res).toEqual({ success: true });
    expect(calls.some((c) => /DELETE FROM expense_allocation_lines\s+WHERE period_id/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /UPDATE expense_allocation_periods\s+SET total_allocated/.test(c.sql))).toBe(true);
  });

  it('rejects clearLines on a non-draft period', async () => {
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'approved' }] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(svc.clearLines('p-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── 13. updateLine ──────────────────────────────────────────────

describe('ExpenseAllocationsService.updateLine (PR-PHASE2-B2)', () => {
  it('updates an existing manual line and triggers recompute', async () => {
    const existing = {
      id: 'line-1',
      period_id: 'p-1',
      allocation_method: 'manual',
      expense_id: 'e-1',
      expense_category_id: null,
      product_id: 'prod-1',
      product_category_id: null,
      warehouse_id: null,
      source_amount: '100',
      allocated_amount: '25',
    };
    const { ds, calls } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'draft' }] },
      { match: /FROM expense_allocation_lines WHERE id/, reply: [existing] },
      { match: /^\s*UPDATE expense_allocation_lines\s+SET/, reply: [] },
      { match: /^\s*UPDATE expense_allocation_periods\s+SET total_allocated/, reply: [] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.updateLine('p-1', 'line-1', { allocated_amount: 30 });
    expect(res).toEqual({ id: 'line-1' });
    expect(calls.some((c) => /UPDATE expense_allocation_lines\s+SET allocated_amount/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /UPDATE expense_allocation_periods\s+SET total_allocated/.test(c.sql))).toBe(true);
  });

  it('rejects update on an approved period', async () => {
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'approved' }] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.updateLine('p-1', 'line-1', { allocated_amount: 10 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws NotFound when the line does not belong to the period', async () => {
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'draft' }] },
      { match: /FROM expense_allocation_lines WHERE id/, reply: [] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.updateLine('p-1', 'ghost-line', { allocated_amount: 10 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('re-validates target invariants on the patched row', async () => {
    const existing = {
      id: 'line-1',
      period_id: 'p-1',
      allocation_method: 'manual',
      expense_id: 'e-1',
      expense_category_id: null,
      product_id: 'prod-1',
      product_category_id: null,
      warehouse_id: null,
      source_amount: '100',
      allocated_amount: '25',
    };
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'draft' }] },
      { match: /FROM expense_allocation_lines WHERE id/, reply: [existing] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    // Clearing the only target leaves zero targets — must reject.
    await expect(
      svc.updateLine('p-1', 'line-1', { product_id: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── 14. approvePeriod ──────────────────────────────────────────

describe('ExpenseAllocationsService.approvePeriod (PR-PHASE2-B2)', () => {
  it('flips draft → approved when at least one line exists; sets approved_by/at + total_allocated', async () => {
    const { ds, calls } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'draft' }] },
      { match: /SELECT COUNT\(\*\)::int AS count FROM expense_allocation_lines/, reply: [{ count: 2 }] },
      { match: /^\s*UPDATE expense_allocation_periods\s+SET status\s*=\s*'approved'/, reply: [] },
      { match: /FROM expense_allocation_periods\s+p\s+LEFT JOIN warehouses/, reply: [{ ...PERIOD_ROW_FULL, status: 'approved', approved_by: 'u-99' }] },
      { match: /FROM expense_allocation_lines/, reply: [] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.approvePeriod('p-1', 'u-99');
    expect(res).toMatchObject({ status: 'approved', approved_by: 'u-99' });
    const upd = calls.find((c) =>
      /UPDATE expense_allocation_periods\s+SET status\s*=\s*'approved'/.test(c.sql),
    )!;
    expect(upd.sql).toMatch(/approved_by\s*=\s*\$1/);
    expect(upd.sql).toMatch(/approved_at\s*=\s*NOW\(\)/);
    expect(upd.sql).toMatch(/total_allocated\s*=\s*\(\s*SELECT COALESCE/);
    expect(upd.params).toEqual(['u-99', 'p-1']);
  });

  it('rejects approve when the period has no lines', async () => {
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'draft' }] },
      { match: /SELECT COUNT\(\*\)::int AS count FROM expense_allocation_lines/, reply: [{ count: 0 }] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(svc.approvePeriod('p-1', 'u-99')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects approve on a non-draft period', async () => {
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'approved' }] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(svc.approvePeriod('p-1', 'u-99')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects approve on a reversed (terminal) period', async () => {
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'reversed' }] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(svc.approvePeriod('p-1', 'u-99')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('after approve, subsequent addLine on the same period rejects (status guard)', async () => {
    // Approve gate happens first; we simulate the next mutation seeing status='approved'.
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'approved' }] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.addLine('p-1', {
        expense_id: 'e-1',
        source_amount: 100,
        product_id: 'prod-1',
        allocated_amount: 25,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── 15. reversePeriod ──────────────────────────────────────────

describe('ExpenseAllocationsService.reversePeriod (PR-PHASE2-B2)', () => {
  it('flips approved → reversed with reason + reversed_by/at', async () => {
    const { ds, calls } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'approved' }] },
      { match: /^\s*UPDATE expense_allocation_periods\s+SET status\s*=\s*'reversed'/, reply: [] },
      { match: /FROM expense_allocation_periods\s+p\s+LEFT JOIN warehouses/, reply: [{ ...PERIOD_ROW_FULL, status: 'reversed', reversed_reason: 'خطأ في التوزيع' }] },
      { match: /FROM expense_allocation_lines/, reply: [] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.reversePeriod('p-1', 'u-99', 'خطأ في التوزيع');
    expect(res).toMatchObject({ status: 'reversed', reversed_reason: 'خطأ في التوزيع' });
    const upd = calls.find((c) =>
      /UPDATE expense_allocation_periods\s+SET status\s*=\s*'reversed'/.test(c.sql),
    )!;
    expect(upd.sql).toMatch(/reversed_by\s*=\s*\$1/);
    expect(upd.sql).toMatch(/reversed_at\s*=\s*NOW\(\)/);
    expect(upd.sql).toMatch(/reversed_reason\s*=\s*\$2/);
    expect(upd.params).toEqual(['u-99', 'خطأ في التوزيع', 'p-1']);
  });

  it('rejects reverse on a draft period', async () => {
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'draft' }] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.reversePeriod('p-1', 'u-99', 'سبب'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects reverse on a reversed period (terminal)', async () => {
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'reversed' }] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.reversePeriod('p-1', 'u-99', 'سبب'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires a non-empty reason (whitespace only does NOT count)', async () => {
    const { ds } = makeTxMockDs([]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.reversePeriod('p-1', 'u-99', ''),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.reversePeriod('p-1', 'u-99', '   '),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── 16. Reports react to FSM state (source-level invariants) ────

describe('Reports — FSM-aware overhead aggregation (PR-PHASE2-B2 invariants)', () => {
  const SRC = readFileSync(
    resolve(__dirname, './expense-allocations.service.ts'),
    'utf-8',
  );
  const MIG = readFileSync(
    resolve(__dirname, '../../../database/migrations/132_expense_allocation.sql'),
    'utf-8',
  );

  it('profitWithOverhead service overhead subquery is restricted to status = approved', () => {
    // The service has two overhead branches (date-scoped vs all-time).
    // BOTH must filter approved-only.
    const matches = SRC.match(/p\.status\s*=\s*'approved'/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('migration view v_product_profit_with_overhead also filters approved-only', () => {
    expect(MIG).toMatch(
      /CREATE OR REPLACE VIEW v_product_profit_with_overhead[\s\S]+WHERE p\.status\s*=\s*'approved'/,
    );
  });

  it('migration view v_unallocated_expenses correlates against approved periods only', () => {
    expect(MIG).toMatch(
      /CREATE OR REPLACE VIEW v_unallocated_expenses[\s\S]+p\.status\s*=\s*'approved'/,
    );
  });

  it('draft and reversed status are NEVER selected as approved by the overhead joins', () => {
    // Negative invariant: no path treats draft/reversed as contributing.
    expect(SRC).not.toMatch(/p\.status\s*=\s*'draft'\s*OR\s*p\.status\s*=\s*'approved'/);
    expect(SRC).not.toMatch(/p\.status\s*IN\s*\([^)]*'draft'[^)]*'approved'/i);
    expect(SRC).not.toMatch(/p\.status\s*IN\s*\([^)]*'reversed'[^)]*'approved'/i);
  });
});

// ─── 17. Controller wiring — B2 routes + manage permission ───────

describe('ExpenseAllocationsController — B2 wiring + permissions', () => {
  const CTRL_RAW = readFileSync(
    resolve(__dirname, './expense-allocations.controller.ts'),
    'utf-8',
  );
  // Strip comments so docstring mentions of forbidden patterns don't
  // trip the negative grep.
  const CTRL = CTRL_RAW
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  it('declares the 8 mutation routes from the B2 spec', () => {
    // Route declarations: HTTP-verb decorator on the line above the handler.
    expect(CTRL).toMatch(/@Post\('periods'\)[\s\S]+createPeriod\s*\(/);
    expect(CTRL).toMatch(/@Patch\('periods\/:id'\)[\s\S]+updatePeriod\s*\(/);
    expect(CTRL).toMatch(/@Delete\('periods\/:id'\)[\s\S]+deletePeriod\s*\(/);
    expect(CTRL).toMatch(/@Post\('periods\/:id\/lines'\)[\s\S]+addLine\s*\(/);
    expect(CTRL).toMatch(/@Delete\('periods\/:id\/lines'\)[\s\S]+clearLines\s*\(/);
    expect(CTRL).toMatch(/@Patch\('periods\/:id\/lines\/:line_id'\)[\s\S]+updateLine\s*\(/);
    expect(CTRL).toMatch(/@Post\('periods\/:id\/approve'\)[\s\S]+approvePeriod\s*\(/);
    expect(CTRL).toMatch(/@Post\('periods\/:id\/reverse'\)[\s\S]+reversePeriod\s*\(/);
  });

  it('every mutation route has @Permissions("expense_allocation.manage")', () => {
    // Count: 8 mutation routes → at least 8 manage-permission decorators.
    const manageHits = CTRL.match(/@Permissions\(\s*'expense_allocation\.manage'\s*\)/g) || [];
    expect(manageHits.length).toBeGreaterThanOrEqual(8);
  });

  it('class-level keeps expense_allocation.view for the GET routes', () => {
    expect(CTRL).toMatch(/@Permissions\(\s*'expense_allocation\.view'\s*\)\s*@Controller/);
  });

  it('reverse route requires a body DTO with a reason field', () => {
    expect(CTRL).toMatch(/class ReverseDtoIn[\s\S]+@IsString\(\)\s+@MinLength\(1\)\s+reason/);
  });

  it('does NOT import FinancialEngine or chart-of-accounts internals', () => {
    expect(CTRL).not.toMatch(/FinancialEngine/);
    expect(CTRL).not.toMatch(/chart-of-accounts/);
  });
});
