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

// ─── 13b. deleteLine (PR-PHASE2-B5) ─────────────────────────────

describe('ExpenseAllocationsService.deleteLine (PR-PHASE2-B5)', () => {
  it('deletes a single line on a draft period and recomputes total_allocated', async () => {
    const { ds, calls } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'draft' }] },
      // Ownership probe — line exists and belongs to this period.
      { match: /SELECT id FROM expense_allocation_lines WHERE id/, reply: [{ id: 'line-1' }] },
      // Targeted DELETE on the single line.
      { match: /^\s*DELETE FROM expense_allocation_lines\s+WHERE id/, reply: [] },
      // Recompute pulled from SUM(allocated_amount) of remaining lines.
      { match: /^\s*UPDATE expense_allocation_periods\s+SET total_allocated/, reply: [] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.deleteLine('p-1', 'line-1');
    expect(res).toEqual({ id: 'line-1', deleted: true });

    // Write-surface guard: confirm BOTH the targeted DELETE and the
    // period recompute fired (and no bulk DELETE …WHERE period_id).
    expect(
      calls.some((c) => /DELETE FROM expense_allocation_lines\s+WHERE id\s*=\s*\$1/.test(c.sql)),
    ).toBe(true);
    expect(
      calls.some((c) => /UPDATE expense_allocation_periods\s+SET total_allocated/.test(c.sql)),
    ).toBe(true);
    expect(
      calls.some((c) => /DELETE FROM expense_allocation_lines\s+WHERE period_id/.test(c.sql)),
    ).toBe(false);

    // Transaction boundary: every SQL call ran in a transaction.  None
    // ran on the bare DataSource.  Same pattern asserted in
    // clearLines / updateLine.
    expect(calls.every((c) => c.inTransaction)).toBe(true);
  });

  it('rejects deleteLine on an approved period', async () => {
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'approved' }] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(svc.deleteLine('p-1', 'line-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects deleteLine on a reversed period', async () => {
    const { ds } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'reversed' }] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(svc.deleteLine('p-1', 'line-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws NotFound when the line does not belong to the period (or is missing entirely)', async () => {
    const { ds, calls } = makeTxMockDs([
      { match: /FOR UPDATE/, reply: [{ id: 'p-1', status: 'draft' }] },
      // Empty reply — covers both "line doesn't exist" and "line
      // exists but belongs to a different period" without leaking
      // which one it is.
      { match: /SELECT id FROM expense_allocation_lines WHERE id/, reply: [] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(svc.deleteLine('p-1', 'ghost-line')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // The DELETE must NOT have been issued when the ownership probe
    // returned empty.
    expect(
      calls.some((c) => /DELETE FROM expense_allocation_lines/.test(c.sql)),
    ).toBe(false);
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

// ════════════════════════════════════════════════════════════════════
//  PR-PHASE2-B3 — preview / compute (read-only)
// ════════════════════════════════════════════════════════════════════
//
// B3 adds a single read-only endpoint, POST /periods/:id/preview, that
// returns proposed allocation lines without writing anything.  Tests
// below drive previewAllocation() through the route-based mock and
// assert SQL shape, rounding/residual rules, zero-basis behavior, and
// negative-GP exclusion semantics.

// Mock helper that classifies SQL by the most distinctive token we
// expect to see in each query path.  Returns the configured reply.
function previewMockDs(routes: Array<{ match: RegExp; reply: any[] | ((sql: string, params: any[] | undefined) => any[]) }>) {
  const calls: { sql: string; params?: any[] }[] = [];
  const route = (sql: string, params?: any[]) => {
    calls.push({ sql, params });
    for (const r of routes) {
      if (r.match.test(sql)) {
        return typeof r.reply === 'function' ? r.reply(sql, params) : r.reply;
      }
    }
    return [];
  };
  const ds: any = {
    query: async (sql: string, params?: any[]) => route(sql, params),
    // previewAllocation is read-only; it does NOT call ds.transaction().
    // Provide it anyway so a buggy implementation that DOES open a tx
    // fails fast instead of silently no-op-ing.
    transaction: async () => {
      throw new Error('previewAllocation must not open a transaction');
    },
  };
  return { ds, calls };
}

const PERIOD_LOOKUP = {
  id: 'p-1',
  period_start: '2026-04-01',
  period_end: '2026-04-30',
  warehouse_id: null,
  status: 'draft',
};

// ─── 18. preview — source resolution ─────────────────────────────

describe('ExpenseAllocationsService.previewAllocation — source resolution (PR-PHASE2-B3)', () => {
  it('resolves source amount from a specific approved expense', async () => {
    const { ds, calls } = previewMockDs([
      { match: /FROM expense_allocation_periods/, reply: [PERIOD_LOOKUP] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '100.00', is_approved: true }] },
      { match: /FROM invoice_items/, reply: [
        { target_id: 'prod-1', target_name: 'P1', basis_units_sold: '1', basis_revenue: '100', basis_gross_profit: '50' },
      ]},
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.previewAllocation('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'product',
      method: 'by_revenue',
    });
    expect(res.source.amount).toBe('100.00');
    expect(res.source.expense_id).toBe('e-1');
    expect(res.source.expense_category_id).toBeNull();
    // Source-side query MUST be the by-id form, NOT the SUM form.
    expect(calls.some((c) => /SELECT amount, is_approved FROM expenses WHERE id = \$1/.test(c.sql))).toBe(true);
  });

  it('rejects when expense is not approved (Arabic 400)', async () => {
    const { ds } = previewMockDs([
      { match: /FROM expense_allocation_periods/, reply: [PERIOD_LOOKUP] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '100.00', is_approved: false }] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.previewAllocation('p-1', {
        source: { expense_id: 'e-1' },
        target_kind: 'product',
        method: 'by_revenue',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws NotFound when expense_id does not exist', async () => {
    const { ds } = previewMockDs([
      { match: /FROM expense_allocation_periods/, reply: [PERIOD_LOOKUP] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.previewAllocation('p-1', {
        source: { expense_id: 'e-ghost' },
        target_kind: 'product',
        method: 'by_revenue',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('sums approved expenses in category within the period range', async () => {
    const { ds, calls } = previewMockDs([
      { match: /FROM expense_allocation_periods/, reply: [PERIOD_LOOKUP] },
      { match: /COALESCE\(SUM\(amount\),\s*0\)\s+AS total[\s\S]*FROM expenses/, reply: [{ total: '250.00' }] },
      { match: /FROM invoice_items/, reply: [
        { target_id: 'prod-1', target_name: 'P1', basis_units_sold: '1', basis_revenue: '100', basis_gross_profit: '50' },
      ]},
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.previewAllocation('p-1', {
      source: { expense_category_id: 'cat-1' },
      target_kind: 'product',
      method: 'by_revenue',
    });
    expect(res.source.amount).toBe('250.00');
    expect(res.source.expense_category_id).toBe('cat-1');
    expect(res.source.expense_id).toBeNull();
    // Sum query must scope to the period date range AND filter is_approved=TRUE.
    const sumCall = calls.find((c) => /COALESCE\(SUM\(amount\),\s*0\)\s+AS total/.test(c.sql))!;
    expect(sumCall.sql).toMatch(/is_approved\s*=\s*TRUE/);
    expect(sumCall.sql).toMatch(/expense_date\s+>=\s+\$2/);
    expect(sumCall.sql).toMatch(/expense_date\s+<=\s+\$3/);
  });

  it('rejects when both source fields are supplied', async () => {
    const { ds } = previewMockDs([
      { match: /FROM expense_allocation_periods/, reply: [PERIOD_LOOKUP] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.previewAllocation('p-1', {
        source: { expense_id: 'e-1', expense_category_id: 'cat-1' },
        target_kind: 'product',
        method: 'by_revenue',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when neither source field is supplied', async () => {
    const { ds } = previewMockDs([
      { match: /FROM expense_allocation_periods/, reply: [PERIOD_LOOKUP] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.previewAllocation('p-1', {
        source: {},
        target_kind: 'product',
        method: 'by_revenue',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws NotFound when the period does not exist', async () => {
    const { ds } = previewMockDs([
      { match: /FROM expense_allocation_periods/, reply: [] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.previewAllocation('p-ghost', {
        source: { expense_id: 'e-1' },
        target_kind: 'product',
        method: 'by_revenue',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ─── 19. preview — by_revenue / target=product ───────────────────

describe('ExpenseAllocationsService.previewAllocation — by_revenue / product (PR-PHASE2-B3)', () => {
  function setup(candidates: any[], sourceAmount = '100.00') {
    return previewMockDs([
      { match: /FROM expense_allocation_periods/, reply: [PERIOD_LOOKUP] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: sourceAmount, is_approved: true }] },
      { match: /FROM invoice_items[\s\S]*JOIN products/, reply: candidates },
    ]);
  }

  it('happy path: 3 candidates, exact split, zero residual', async () => {
    const { ds } = setup([
      { target_id: 'A', target_name: 'A', basis_units_sold: '1', basis_revenue: '100', basis_gross_profit: '10' },
      { target_id: 'B', target_name: 'B', basis_units_sold: '1', basis_revenue: '200', basis_gross_profit: '20' },
      { target_id: 'C', target_name: 'C', basis_units_sold: '1', basis_revenue: '700', basis_gross_profit: '70' },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.previewAllocation('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'product',
      method: 'by_revenue',
    });
    expect(res.candidates_total).toBe(3);
    expect(res.candidates_excluded).toBe(0);
    expect(res.proposed_lines).toHaveLength(3);
    const byId = (id: string) => res.proposed_lines.find((l: any) => l.target_id === id)!;
    expect(byId('A').proposed_amount).toBe('10.00');
    expect(byId('B').proposed_amount).toBe('20.00');
    expect(byId('C').proposed_amount).toBe('70.00');
    expect(res.rounding_residual).toBe('0.00');
    expect(res.rounding_residual_absorbed_into_target_id).toBeNull();
    expect(res.zero_basis_warning).toBeNull();
  });

  it('rounding residual is absorbed into the largest-basis line', async () => {
    // source=1.00, three candidates with revenues 1/1/1 → each raw share is 0.333…,
    // each rounds to 0.33, sum = 0.99, residual = 0.01.  All three tie on basis,
    // so deterministic tie-break by lexicographically-smallest target_id picks 'A'.
    const { ds } = setup([
      { target_id: 'A', target_name: 'A', basis_units_sold: '1', basis_revenue: '1', basis_gross_profit: '0' },
      { target_id: 'B', target_name: 'B', basis_units_sold: '1', basis_revenue: '1', basis_gross_profit: '0' },
      { target_id: 'C', target_name: 'C', basis_units_sold: '1', basis_revenue: '1', basis_gross_profit: '0' },
    ], '1.00');
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.previewAllocation('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'product',
      method: 'by_revenue',
    });
    const amounts = res.proposed_lines.map((l: any) => l.proposed_amount).sort();
    expect(amounts).toEqual(['0.33', '0.33', '0.34']);
    expect(res.rounding_residual).toBe('0.01');
    expect(res.rounding_residual_absorbed_into_target_id).toBe('A');
    // SUM(proposed_amount) must equal source exactly
    const sum = res.proposed_lines.reduce(
      (s: number, l: any) => s + Number(l.proposed_amount), 0,
    );
    expect(Math.round(sum * 100) / 100).toBe(1);
  });

  it('zero source amount returns an empty preview with Arabic warning', async () => {
    const { ds } = setup([
      { target_id: 'A', target_name: 'A', basis_units_sold: '1', basis_revenue: '100', basis_gross_profit: '10' },
    ], '0.00');
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.previewAllocation('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'product',
      method: 'by_revenue',
    });
    expect(res.proposed_lines).toEqual([]);
    expect(res.zero_basis_warning).toBe('مبلغ المصدر صفر.');
  });

  it('empty candidate set returns empty preview with Arabic warning', async () => {
    const { ds } = setup([], '100.00');
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.previewAllocation('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'product',
      method: 'by_revenue',
    });
    expect(res.proposed_lines).toEqual([]);
    expect(res.zero_basis_warning).toBe('لا توجد مبيعات معتمدة في هذه الفترة.');
  });

  it('embeds weight_pct and weight_basis_total for provenance', async () => {
    const { ds } = setup([
      { target_id: 'A', target_name: 'A', basis_units_sold: '1', basis_revenue: '100', basis_gross_profit: '10' },
      { target_id: 'B', target_name: 'B', basis_units_sold: '1', basis_revenue: '300', basis_gross_profit: '30' },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.previewAllocation('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'product',
      method: 'by_revenue',
    });
    expect(res.total_basis).toBe('400.000000');
    const byId = (id: string) => res.proposed_lines.find((l: any) => l.target_id === id)!;
    expect(byId('A').weight_pct).toBe('25.0000');
    expect(byId('B').weight_pct).toBe('75.0000');
    expect(byId('A').weight_basis_total).toBe('400.000000');
  });
});

// ─── 20. preview — by_units_sold ─────────────────────────────────

describe('ExpenseAllocationsService.previewAllocation — by_units_sold (PR-PHASE2-B3)', () => {
  it('uses units_sold (not revenue) as the basis', async () => {
    const { ds } = previewMockDs([
      { match: /FROM expense_allocation_periods/, reply: [PERIOD_LOOKUP] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '100.00', is_approved: true }] },
      { match: /FROM invoice_items[\s\S]*JOIN products/, reply: [
        { target_id: 'A', target_name: 'A', basis_units_sold: '1',  basis_revenue: '999', basis_gross_profit: '0' },
        { target_id: 'B', target_name: 'B', basis_units_sold: '4',  basis_revenue: '1',   basis_gross_profit: '0' },
      ]},
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.previewAllocation('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'product',
      method: 'by_units_sold',
    });
    const byId = (id: string) => res.proposed_lines.find((l: any) => l.target_id === id)!;
    // Total units = 5; A has 1/5 = 20.00, B has 4/5 = 80.00.
    expect(byId('A').proposed_amount).toBe('20.00');
    expect(byId('B').proposed_amount).toBe('80.00');
    expect(byId('A').basis_value).toBe('1.000000');
    expect(byId('B').basis_value).toBe('4.000000');
  });
});

// ─── 21. preview — by_gross_profit ───────────────────────────────

describe('ExpenseAllocationsService.previewAllocation — by_gross_profit (PR-PHASE2-B3)', () => {
  it('all positive GPs: all counted, allocates proportionally', async () => {
    const { ds } = previewMockDs([
      { match: /FROM expense_allocation_periods/, reply: [PERIOD_LOOKUP] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '100.00', is_approved: true }] },
      { match: /FROM invoice_items[\s\S]*JOIN products/, reply: [
        { target_id: 'A', target_name: 'A', basis_units_sold: '1', basis_revenue: '999', basis_gross_profit: '40' },
        { target_id: 'B', target_name: 'B', basis_units_sold: '1', basis_revenue: '999', basis_gross_profit: '60' },
      ]},
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.previewAllocation('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'product',
      method: 'by_gross_profit',
    });
    expect(res.candidates_total).toBe(2);
    expect(res.candidates_excluded).toBe(0);
    const byId = (id: string) => res.proposed_lines.find((l: any) => l.target_id === id)!;
    expect(byId('A').proposed_amount).toBe('40.00');
    expect(byId('B').proposed_amount).toBe('60.00');
  });

  it('excludes a target with negative GP and reports candidates_excluded=1', async () => {
    const { ds } = previewMockDs([
      { match: /FROM expense_allocation_periods/, reply: [PERIOD_LOOKUP] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '100.00', is_approved: true }] },
      { match: /FROM invoice_items[\s\S]*JOIN products/, reply: [
        { target_id: 'A', target_name: 'A', basis_units_sold: '1', basis_revenue: '1', basis_gross_profit: '60' },
        { target_id: 'B', target_name: 'B', basis_units_sold: '1', basis_revenue: '1', basis_gross_profit: '-20' },
        { target_id: 'C', target_name: 'C', basis_units_sold: '1', basis_revenue: '1', basis_gross_profit: '40' },
      ]},
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.previewAllocation('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'product',
      method: 'by_gross_profit',
    });
    expect(res.candidates_total).toBe(3);
    expect(res.candidates_excluded).toBe(1);
    // A=60/(60+40)=60.00, C=40.00; B is dropped from proposed_lines.
    expect(res.proposed_lines.map((l: any) => l.target_id).sort()).toEqual(['A', 'C']);
    const byId = (id: string) => res.proposed_lines.find((l: any) => l.target_id === id)!;
    expect(byId('A').proposed_amount).toBe('60.00');
    expect(byId('C').proposed_amount).toBe('40.00');
  });

  it('all GPs non-positive → empty preview + specific Arabic warning', async () => {
    const { ds } = previewMockDs([
      { match: /FROM expense_allocation_periods/, reply: [PERIOD_LOOKUP] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '100.00', is_approved: true }] },
      { match: /FROM invoice_items[\s\S]*JOIN products/, reply: [
        { target_id: 'A', target_name: 'A', basis_units_sold: '1', basis_revenue: '1', basis_gross_profit: '-5' },
        { target_id: 'B', target_name: 'B', basis_units_sold: '1', basis_revenue: '1', basis_gross_profit: '0' },
      ]},
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.previewAllocation('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'product',
      method: 'by_gross_profit',
    });
    expect(res.proposed_lines).toEqual([]);
    expect(res.candidates_excluded).toBe(2);
    expect(res.zero_basis_warning).toBe('لا توجد أهداف ذات ربح موجب في هذه الفترة.');
  });
});

// ─── 22. preview — target kind = category ────────────────────────

describe('ExpenseAllocationsService.previewAllocation — target=category (PR-PHASE2-B3)', () => {
  it('joins categories and groups by category_id', async () => {
    const { ds, calls } = previewMockDs([
      { match: /FROM expense_allocation_periods/, reply: [PERIOD_LOOKUP] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '100.00', is_approved: true }] },
      { match: /FROM invoice_items[\s\S]*JOIN categories/, reply: [
        { target_id: 'cat-A', target_name: 'فئة أ', basis_units_sold: '2', basis_revenue: '200', basis_gross_profit: '0' },
      ]},
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.previewAllocation('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'category',
      method: 'by_revenue',
    });
    expect(res.target_kind).toBe('category');
    const aggregate = calls.find((c) => /FROM invoice_items[\s\S]*JOIN categories/.test(c.sql))!;
    expect(aggregate.sql).toMatch(/JOIN categories c\s+ON c\.id\s+=\s+p\.category_id/);
    expect(aggregate.sql).toMatch(/GROUP BY c\.id, c\.name_ar/);
    expect(res.proposed_lines[0].target_id).toBe('cat-A');
  });
});

// ─── 23. preview — target kind = warehouse ───────────────────────

describe('ExpenseAllocationsService.previewAllocation — target=warehouse (PR-PHASE2-B3)', () => {
  it('joins warehouses (no product_variants/products join needed)', async () => {
    const { ds, calls } = previewMockDs([
      { match: /FROM expense_allocation_periods/, reply: [PERIOD_LOOKUP] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '100.00', is_approved: true }] },
      { match: /FROM invoice_items[\s\S]*JOIN warehouses/, reply: [
        { target_id: 'wh-A', target_name: 'الفرع الرئيسي', basis_units_sold: '5', basis_revenue: '500', basis_gross_profit: '0' },
      ]},
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.previewAllocation('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'warehouse',
      method: 'by_revenue',
    });
    const aggregate = calls.find((c) => /FROM invoice_items[\s\S]*JOIN warehouses/.test(c.sql))!;
    expect(aggregate.sql).toMatch(/JOIN warehouses w\s+ON w\.id\s+=\s+i\.warehouse_id/);
    expect(aggregate.sql).not.toMatch(/JOIN products\s+p\s+ON/);
    expect(aggregate.sql).not.toMatch(/JOIN product_variants\s+pv\s+ON/);
    expect(res.proposed_lines[0].target_id).toBe('wh-A');
  });
});

// ─── 24. preview — SQL invariants ────────────────────────────────

describe('ExpenseAllocationsService.previewAllocation — SQL invariants (PR-PHASE2-B3)', () => {
  function captureAggregate(target_kind: 'product' | 'category' | 'warehouse', method: 'by_revenue') {
    const { ds, calls } = previewMockDs([
      { match: /FROM expense_allocation_periods/, reply: [{ id: 'p-1', period_start: '2026-04-01', period_end: '2026-04-30', warehouse_id: null }] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '100.00', is_approved: true }] },
      { match: /FROM invoice_items/, reply: [] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    return svc.previewAllocation('p-1', {
      source: { expense_id: 'e-1' },
      target_kind,
      method,
    }).then(() => calls);
  }

  it('uses canonical sales status filter (completed/paid/partially_paid)', async () => {
    const calls = await captureAggregate('product', 'by_revenue');
    const agg = calls.find((c) => /FROM invoice_items/.test(c.sql))!;
    expect(agg.sql).toMatch(/i\.status\s+IN\s*\(\s*'completed'\s*,\s*'paid'\s*,\s*'partially_paid'\s*\)/);
  });

  it('filters out returns with NOT i.is_return', async () => {
    const calls = await captureAggregate('product', 'by_revenue');
    const agg = calls.find((c) => /FROM invoice_items/.test(c.sql))!;
    expect(agg.sql).toMatch(/NOT\s+i\.is_return/);
  });

  it('uses end-exclusive date upper bound (< period_end + INTERVAL 1 day)', async () => {
    const calls = await captureAggregate('product', 'by_revenue');
    const agg = calls.find((c) => /FROM invoice_items/.test(c.sql))!;
    expect(agg.sql).toMatch(/i\.completed_at\s+>=\s+\$1::date/);
    expect(agg.sql).toMatch(/i\.completed_at\s+<\s+\(\$2::date\s+\+\s+INTERVAL\s+'1\s+day'\)/);
  });

  it('respects period.warehouse_id when set (conditional filter)', async () => {
    const calls = await captureAggregate('product', 'by_revenue');
    const agg = calls.find((c) => /FROM invoice_items/.test(c.sql))!;
    expect(agg.sql).toMatch(/\$3::uuid\s+IS\s+NULL\s+OR\s+i\.warehouse_id\s*=\s*\$3::uuid/);
  });

  it('product target uses invoice_items→product_variants→products join chain', async () => {
    const calls = await captureAggregate('product', 'by_revenue');
    const agg = calls.find((c) => /FROM invoice_items/.test(c.sql))!;
    expect(agg.sql).toMatch(/JOIN product_variants pv\s+ON pv\.id\s*=\s*ii\.variant_id/);
    expect(agg.sql).toMatch(/JOIN products p\s+ON p\.id\s*=\s*pv\.product_id/);
  });

  it('revenue formula matches v_product_profit (qty * unit_price - discount_amount)', async () => {
    const calls = await captureAggregate('product', 'by_revenue');
    const agg = calls.find((c) => /FROM invoice_items/.test(c.sql))!;
    expect(agg.sql).toMatch(/SUM\(ii\.quantity::numeric\s*\*\s*ii\.unit_price\s*-\s*ii\.discount_amount\)/);
    // and crucially does NOT use the nullable ii.line_total column
    expect(agg.sql).not.toMatch(/SUM\(ii\.line_total\)/);
  });
});

// ─── 25. preview — period status agnostic ────────────────────────

describe('ExpenseAllocationsService.previewAllocation — works on any period status (PR-PHASE2-B3)', () => {
  it.each(['draft', 'approved', 'reversed'])(
    'allows preview on a %s period (read-only)',
    async (status) => {
      const { ds } = previewMockDs([
        { match: /FROM expense_allocation_periods/, reply: [{ ...PERIOD_LOOKUP, status }] },
        { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '100.00', is_approved: true }] },
        { match: /FROM invoice_items/, reply: [
          { target_id: 'A', target_name: 'A', basis_units_sold: '1', basis_revenue: '100', basis_gross_profit: '0' },
        ]},
      ]);
      const svc = new ExpenseAllocationsService(ds as any);
      const res = await svc.previewAllocation('p-1', {
        source: { expense_id: 'e-1' },
        target_kind: 'product',
        method: 'by_revenue',
      });
      expect(res.period_id).toBe('p-1');
      expect(res.proposed_lines).toHaveLength(1);
    },
  );
});

// ─── 26. preview — source-grep guards (B3-specific) ──────────────

describe('expense-allocations.service.ts — B3 source-grep guards', () => {
  const SRC_RAW = readFileSync(
    resolve(__dirname, './expense-allocations.service.ts'),
    'utf-8',
  );
  const SRC = SRC_RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('previewAllocation method is implemented and exported', () => {
    expect(SRC).toMatch(/async previewAllocation\(/);
  });

  it('previewAllocation does NOT call ds.transaction (read-only path)', () => {
    // Slice the source between "async previewAllocation(" and the next top-level
    // method or class close to scope the check to the preview path only.
    const m = SRC.match(/async previewAllocation\([\s\S]*?\n  (?:private|async|\/\/)/);
    const slice = m ? m[0] : SRC;
    expect(slice).not.toMatch(/this\.ds\.transaction\b/);
    expect(slice).not.toMatch(/em\.query/); // no transactional .query either
  });

  it('preview helpers only run SELECTs (no INSERT/UPDATE/DELETE keywords in their scope)', () => {
    const helpersStart = SRC.indexOf('private async resolveSourceAmount');
    const helpersEnd = SRC.indexOf('private async lockPeriod');
    expect(helpersStart).toBeGreaterThan(0);
    expect(helpersEnd).toBeGreaterThan(helpersStart);
    const slice = SRC.slice(helpersStart, helpersEnd);
    for (const verb of ['INSERT INTO', 'UPDATE', 'DELETE FROM']) {
      expect(slice).not.toMatch(new RegExp(`${verb}\\s+[a-z_]+`, 'i'));
    }
  });

  it('preview uses canonical sales-status filter as a literal SQL string', () => {
    expect(SRC).toMatch(/'completed','paid','partially_paid'/);
  });

  it('still has zero FinancialEngine / financial-engine references in code', () => {
    expect(SRC).not.toMatch(/FinancialEngine/);
    expect(SRC).not.toMatch(/financial-engine/);
  });
});

// ─── 27. controller wiring — preview route + view permission ────

describe('ExpenseAllocationsController — preview wiring (PR-PHASE2-B3)', () => {
  const CTRL_RAW = readFileSync(
    resolve(__dirname, './expense-allocations.controller.ts'),
    'utf-8',
  );
  const CTRL = CTRL_RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('declares POST periods/:id/preview', () => {
    expect(CTRL).toMatch(/@Post\('periods\/:id\/preview'\)[\s\S]+preview\s*\(/);
  });

  it('preview route is guarded by expense_allocation.view (NOT .manage)', () => {
    expect(CTRL).toMatch(
      /@Post\('periods\/:id\/preview'\)\s*@Permissions\(\s*'expense_allocation\.view'\s*\)/,
    );
  });

  it('PreviewDtoIn validates nested source via @ValidateNested + @Type', () => {
    expect(CTRL).toMatch(/class PreviewSourceDtoIn[\s\S]+@IsUUID\(\)\s+expense_id/);
    expect(CTRL).toMatch(/class PreviewDtoIn[\s\S]+@ValidateNested\(\)[\s\S]+@Type\(\(\)\s*=>\s*PreviewSourceDtoIn\)/);
  });

  it('still has zero FinancialEngine references', () => {
    expect(CTRL).not.toMatch(/FinancialEngine/);
  });
});

// ════════════════════════════════════════════════════════════════════
//  PR-PHASE2-TZ-FIX — DATE columns serialise as YYYY-MM-DD
// ════════════════════════════════════════════════════════════════════
//
// After applying the global pg DATE parser override (see
// src/database/pg-date-parser.ts), DATE columns flow into responses as
// plain `YYYY-MM-DD` strings.  The previewAllocation response embeds
// period_scope.from / .to derived from `period.period_start` and
// `period.period_end`.  Mock-DataSource tests below pin both shapes.

describe('PR-PHASE2-TZ-FIX — DATE serialisation in expense-allocations responses', () => {
  it('previewAllocation period_scope.from/to are YYYY-MM-DD with no T time component', async () => {
    // The mock DataSource here returns the raw string form the pg
    // override would produce in production.  Asserts the service does
    // not introduce a Date round-trip that would re-add the T-time.
    const ds: any = {
      query: async (sql: string) => {
        if (/FROM expense_allocation_periods/.test(sql)) {
          return [{
            id: 'p-1',
            period_start: '2026-04-01',
            period_end:   '2026-04-30',
            warehouse_id: null,
            status: 'draft',
          }];
        }
        if (/SELECT amount, is_approved FROM expenses/.test(sql)) {
          return [{ amount: '100.00', is_approved: true }];
        }
        if (/FROM invoice_items/.test(sql)) {
          return [{
            target_id: 'prod-1', target_name: 'P',
            basis_units_sold: '1', basis_revenue: '100', basis_gross_profit: '0',
          }];
        }
        return [];
      },
      transaction: async () => { throw new Error('preview must not open a transaction'); },
    };
    const svc = new ExpenseAllocationsService(ds);
    const res = await svc.previewAllocation('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'product',
      method: 'by_revenue',
    });
    expect(res.period_scope.from).toBe('2026-04-01');
    expect(res.period_scope.to).toBe('2026-04-30');
    expect(res.period_scope.from).not.toMatch(/T\d{2}:/);
    expect(res.period_scope.to).not.toMatch(/T\d{2}:/);
    expect(res.period_scope.from).not.toMatch(/Z$/);
    expect(res.period_scope.to).not.toMatch(/Z$/);
  });
});

// ════════════════════════════════════════════════════════════════════
//  PR-PHASE2-B4 v2 — saveAllocationPreview (batch save inside a txn)
// ════════════════════════════════════════════════════════════════════
//
// v2 drops the IdempotencyInterceptor that caused the v1 bootstrap
// crash; idempotency is provided by the "reject if lines exist" guard
// (replace_existing=false default).  All other invariants preserved.

function saveMockDs(routes: Array<{ match: RegExp; reply: any[] | ((c: { sql: string; params?: any[]; inTx: boolean }) => any[]) }>) {
  const calls: { sql: string; params?: any[]; inTx: boolean }[] = [];
  const dispatch = (sql: string, params: any[] | undefined, inTx: boolean) => {
    const call = { sql, params, inTx };
    calls.push(call);
    for (const r of routes) {
      if (r.match.test(sql)) {
        return typeof r.reply === 'function' ? r.reply(call) : r.reply;
      }
    }
    return [];
  };
  const ds: any = {
    query: async (sql: string, params?: any[]) => dispatch(sql, params, false),
    transaction: async (fn: (em: any) => any) => {
      const em = {
        query: async (sql: string, params?: any[]) => dispatch(sql, params, true),
      };
      return fn(em);
    },
  };
  return { ds, calls };
}

const DRAFT_PERIOD = {
  id: 'p-1',
  period_start: '2026-04-01',
  period_end: '2026-04-30',
  warehouse_id: null,
  status: 'draft',
};
const SOURCE = { expense_id: 'e-1' } as const;

// ─── 28. saveAllocationPreview — happy path / by_revenue × product ───

describe('ExpenseAllocationsService.saveAllocationPreview — by_revenue × product (PR-PHASE2-B4 v2)', () => {
  function defaultMock(opts?: { existingLines?: number; insertedIds?: string[] }) {
    const existing = opts?.existingLines ?? 0;
    const inserted = (opts?.insertedIds ?? ['line-A', 'line-B', 'line-C']).map(
      (id, i) => ({
        id,
        product_id: ['prod-A', 'prod-B', 'prod-C'][i],
        product_category_id: null,
        warehouse_id: null,
        allocated_amount: '0',
        weight_basis_value: '0',
        weight_basis_total: '0',
      }),
    );
    return saveMockDs([
      { match: /FOR UPDATE/, reply: [DRAFT_PERIOD] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '100.00', is_approved: true }] },
      { match: /FROM invoice_items[\s\S]*JOIN products/, reply: [
        { target_id: 'prod-A', target_name: 'A', basis_units_sold: '1', basis_revenue: '100', basis_gross_profit: '10' },
        { target_id: 'prod-B', target_name: 'B', basis_units_sold: '1', basis_revenue: '200', basis_gross_profit: '20' },
        { target_id: 'prod-C', target_name: 'C', basis_units_sold: '1', basis_revenue: '700', basis_gross_profit: '70' },
      ] },
      { match: /SELECT COUNT\(\*\)::int AS count FROM expense_allocation_lines/, reply: [{ count: existing }] },
      { match: /^\s*DELETE FROM expense_allocation_lines/, reply: [] },
      { match: /^\s*INSERT INTO expense_allocation_lines/, reply: inserted },
      { match: /^\s*UPDATE expense_allocation_periods\s+SET total_allocated/, reply: [] },
    ]);
  }

  it('saves N lines, returns saved_count + total_allocated, recomputes period total', async () => {
    const { ds, calls } = defaultMock();
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.saveAllocationPreview('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'product',
      method: 'by_revenue',
    });
    expect(res.saved_count).toBe(3);
    expect(res.total_allocated).toBe('100.00');
    expect(res.method).toBe('by_revenue');
    expect(res.target_kind).toBe('product');
    expect(res.candidates_excluded).toBe(0);
    expect(res.candidates_total).toBe(3);
    expect(res.replace_existing).toBe(false);
    expect(res.existing_lines_deleted).toBe(0);
    expect(res.lines).toHaveLength(3);
    const insertCall = calls.find((c) => /INSERT INTO expense_allocation_lines/.test(c.sql))!;
    expect(insertCall.inTx).toBe(true);
    expect(insertCall.sql).toMatch(/VALUES /);
    expect(insertCall.sql).toMatch(/RETURNING/);
    const recomputeCall = calls.find((c) => /UPDATE expense_allocation_periods\s+SET total_allocated/.test(c.sql))!;
    expect(recomputeCall.inTx).toBe(true);
  });

  it('attributes basis + weight provenance into every line', async () => {
    const { ds } = defaultMock();
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.saveAllocationPreview('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'product',
      method: 'by_revenue',
    });
    expect(res.total_basis).toBe('1000.000000');
    for (const l of res.lines) {
      expect(l.weight_basis_total).toBe('1000.000000');
      expect(l.weight_pct).toMatch(/^\d+\.\d{4}$/);
      expect(l.basis_value).toMatch(/^\d+\.\d{6}$/);
      expect(l.allocated_amount).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it('SUM(proposed_amount) === source_amount exactly (residual rule)', async () => {
    const inserted = ['ins-A', 'ins-B', 'ins-C'].map((id, i) => ({
      id,
      product_id: ['A', 'B', 'C'][i],
      product_category_id: null,
      warehouse_id: null,
    }));
    const { ds } = saveMockDs([
      { match: /FOR UPDATE/, reply: [DRAFT_PERIOD] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '1.00', is_approved: true }] },
      { match: /FROM invoice_items[\s\S]*JOIN products/, reply: [
        { target_id: 'A', target_name: 'A', basis_units_sold: '1', basis_revenue: '1', basis_gross_profit: '0' },
        { target_id: 'B', target_name: 'B', basis_units_sold: '1', basis_revenue: '1', basis_gross_profit: '0' },
        { target_id: 'C', target_name: 'C', basis_units_sold: '1', basis_revenue: '1', basis_gross_profit: '0' },
      ] },
      { match: /SELECT COUNT\(\*\)::int AS count FROM expense_allocation_lines/, reply: [{ count: 0 }] },
      { match: /^\s*INSERT INTO expense_allocation_lines/, reply: inserted },
      { match: /^\s*UPDATE expense_allocation_periods\s+SET total_allocated/, reply: [] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.saveAllocationPreview('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'product',
      method: 'by_revenue',
    });
    expect(res.rounding_residual).toBe('0.01');
    expect(res.rounding_residual_absorbed_into_target_id).toBe('A');
    expect(res.rounding_residual_absorbed_into_line_id).toBe('ins-A');
    const amounts = res.lines.map((l: any) => Number(l.allocated_amount)).sort();
    expect(amounts).toEqual([0.33, 0.33, 0.34]);
    const sum = res.lines.reduce((s: number, l: any) => s + Number(l.allocated_amount), 0);
    expect(Math.round(sum * 100) / 100).toBe(1);
  });
});

// ─── 29. period status guards (draft-only) ────────────────────────

describe('saveAllocationPreview — FSM guards (PR-PHASE2-B4 v2)', () => {
  function statusMock(status: 'approved' | 'reversed') {
    return saveMockDs([
      { match: /FOR UPDATE/, reply: [{ ...DRAFT_PERIOD, status }] },
    ]);
  }
  it('rejects approved periods with Arabic 400', async () => {
    const { ds } = statusMock('approved');
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.saveAllocationPreview('p-1', { source: SOURCE, target_kind: 'product', method: 'by_revenue' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects reversed periods with Arabic 400', async () => {
    const { ds } = statusMock('reversed');
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.saveAllocationPreview('p-1', { source: SOURCE, target_kind: 'product', method: 'by_revenue' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('throws NotFound when the period does not exist', async () => {
    const { ds } = saveMockDs([{ match: /FOR UPDATE/, reply: [] }]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.saveAllocationPreview('p-ghost', { source: SOURCE, target_kind: 'product', method: 'by_revenue' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ─── 30. pre-existing lines policy (the v2 idempotency model) ─────

describe('saveAllocationPreview — pre-existing lines policy (PR-PHASE2-B4 v2)', () => {
  function reuseBasisMock(existing: number) {
    const inserted = ['ins-1'].map((id) => ({ id, product_id: 'prod-1', product_category_id: null, warehouse_id: null }));
    return saveMockDs([
      { match: /FOR UPDATE/, reply: [DRAFT_PERIOD] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '50.00', is_approved: true }] },
      { match: /FROM invoice_items[\s\S]*JOIN products/, reply: [
        { target_id: 'prod-1', target_name: 'X', basis_units_sold: '1', basis_revenue: '50', basis_gross_profit: '0' },
      ] },
      { match: /SELECT COUNT\(\*\)::int AS count FROM expense_allocation_lines/, reply: [{ count: existing }] },
      { match: /^\s*DELETE FROM expense_allocation_lines/, reply: [] },
      { match: /^\s*INSERT INTO expense_allocation_lines/, reply: inserted },
      { match: /^\s*UPDATE expense_allocation_periods\s+SET total_allocated/, reply: [] },
    ]);
  }

  it('rejects (400 Arabic) when lines exist and replace_existing is false', async () => {
    const { ds, calls } = reuseBasisMock(2);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.saveAllocationPreview('p-1', {
        source: { expense_id: 'e-1' },
        target_kind: 'product',
        method: 'by_revenue',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(calls.some((c) => /^\s*DELETE FROM expense_allocation_lines/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /^\s*INSERT INTO expense_allocation_lines/.test(c.sql))).toBe(false);
  });

  it('rejects also when replace_existing is omitted (defaults to false)', async () => {
    const { ds } = reuseBasisMock(1);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.saveAllocationPreview('p-1', {
        source: { expense_id: 'e-1' },
        target_kind: 'product',
        method: 'by_revenue',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('with replace_existing=true: DELETE existing then INSERT new — all inside the same txn', async () => {
    const { ds, calls } = reuseBasisMock(2);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.saveAllocationPreview('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'product',
      method: 'by_revenue',
      replace_existing: true,
    });
    expect(res.replace_existing).toBe(true);
    expect(res.existing_lines_deleted).toBe(2);
    const delCall = calls.find((c) => /^\s*DELETE FROM expense_allocation_lines/.test(c.sql))!;
    const insCall = calls.find((c) => /^\s*INSERT INTO expense_allocation_lines/.test(c.sql))!;
    expect(delCall.inTx).toBe(true);
    expect(insCall.inTx).toBe(true);
    expect(calls.indexOf(delCall)).toBeLessThan(calls.indexOf(insCall));
  });

  it('with replace_existing=true and NO existing lines: no DELETE issued, INSERT proceeds', async () => {
    const { ds, calls } = reuseBasisMock(0);
    const svc = new ExpenseAllocationsService(ds as any);
    const res = await svc.saveAllocationPreview('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'product',
      method: 'by_revenue',
      replace_existing: true,
    });
    expect(res.existing_lines_deleted).toBe(0);
    expect(calls.some((c) => /^\s*DELETE FROM expense_allocation_lines/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /^\s*INSERT INTO expense_allocation_lines/.test(c.sql))).toBe(true);
  });
});

// ─── 31. zero-basis rejects (no empty save allowed) ────────────────

describe('saveAllocationPreview — zero-basis rejects (PR-PHASE2-B4 v2)', () => {
  it('rejects when sourceAmount = 0', async () => {
    const { ds } = saveMockDs([
      { match: /FOR UPDATE/, reply: [DRAFT_PERIOD] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '0', is_approved: true }] },
      { match: /FROM invoice_items[\s\S]*JOIN products/, reply: [
        { target_id: 'A', target_name: 'A', basis_units_sold: '1', basis_revenue: '100', basis_gross_profit: '50' },
      ] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.saveAllocationPreview('p-1', { source: { expense_id: 'e-1' }, target_kind: 'product', method: 'by_revenue' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when no candidates returned by the basis query', async () => {
    const { ds } = saveMockDs([
      { match: /FOR UPDATE/, reply: [DRAFT_PERIOD] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '100', is_approved: true }] },
      { match: /FROM invoice_items[\s\S]*JOIN products/, reply: [] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.saveAllocationPreview('p-1', { source: { expense_id: 'e-1' }, target_kind: 'product', method: 'by_revenue' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when by_gross_profit excludes ALL candidates', async () => {
    const { ds } = saveMockDs([
      { match: /FOR UPDATE/, reply: [DRAFT_PERIOD] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '100', is_approved: true }] },
      { match: /FROM invoice_items[\s\S]*JOIN products/, reply: [
        { target_id: 'A', target_name: 'A', basis_units_sold: '1', basis_revenue: '100', basis_gross_profit: '-10' },
        { target_id: 'B', target_name: 'B', basis_units_sold: '1', basis_revenue: '100', basis_gross_profit: '0' },
      ] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.saveAllocationPreview('p-1', { source: { expense_id: 'e-1' }, target_kind: 'product', method: 'by_gross_profit' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── 32. DTO validation (same gates as preview) ────────────────────

describe('saveAllocationPreview — DTO validation (PR-PHASE2-B4 v2)', () => {
  function emptyMock() {
    return saveMockDs([{ match: /FOR UPDATE/, reply: [DRAFT_PERIOD] }]);
  }
  it('rejects when source is missing', async () => {
    const { ds } = emptyMock();
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.saveAllocationPreview('p-1', { target_kind: 'product', method: 'by_revenue' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects when both source fields supplied', async () => {
    const { ds } = emptyMock();
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.saveAllocationPreview('p-1', {
        source: { expense_id: 'e', expense_category_id: 'c' },
        target_kind: 'product', method: 'by_revenue',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects when neither source field supplied', async () => {
    const { ds } = emptyMock();
    const svc = new ExpenseAllocationsService(ds as any);
    await expect(
      svc.saveAllocationPreview('p-1', { source: {}, target_kind: 'product', method: 'by_revenue' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── 33. target_kind matrix — category + warehouse paths ───────────

describe('saveAllocationPreview — target_kind matrix (PR-PHASE2-B4 v2)', () => {
  it('target_kind=category populates product_category_id on each row', async () => {
    const { ds, calls } = saveMockDs([
      { match: /FOR UPDATE/, reply: [DRAFT_PERIOD] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '100', is_approved: true }] },
      { match: /FROM invoice_items[\s\S]*JOIN categories/, reply: [
        { target_id: 'cat-A', target_name: 'فئة', basis_units_sold: '2', basis_revenue: '200', basis_gross_profit: '0' },
      ] },
      { match: /SELECT COUNT\(\*\)::int AS count FROM expense_allocation_lines/, reply: [{ count: 0 }] },
      { match: /^\s*INSERT INTO expense_allocation_lines/, reply: [
        { id: 'ins', product_id: null, product_category_id: 'cat-A', warehouse_id: null },
      ] },
      { match: /^\s*UPDATE expense_allocation_periods\s+SET total_allocated/, reply: [] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await svc.saveAllocationPreview('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'category',
      method: 'by_units_sold',
    });
    const insertCall = calls.find((c) => /INSERT INTO expense_allocation_lines/.test(c.sql))!;
    const params = insertCall.params!;
    expect(params[4]).toBeNull();              // product_id
    expect(params[5]).toBe('cat-A');           // product_category_id
    expect(params[6]).toBeNull();              // warehouse_id
    expect(params[7]).toBe('by_units_sold');
  });

  it('target_kind=warehouse populates warehouse_id on each row', async () => {
    const { ds, calls } = saveMockDs([
      { match: /FOR UPDATE/, reply: [DRAFT_PERIOD] },
      { match: /SELECT amount, is_approved FROM expenses/, reply: [{ amount: '100', is_approved: true }] },
      { match: /FROM invoice_items[\s\S]*JOIN warehouses/, reply: [
        { target_id: 'wh-A', target_name: 'الفرع', basis_units_sold: '5', basis_revenue: '500', basis_gross_profit: '300' },
      ] },
      { match: /SELECT COUNT\(\*\)::int AS count FROM expense_allocation_lines/, reply: [{ count: 0 }] },
      { match: /^\s*INSERT INTO expense_allocation_lines/, reply: [
        { id: 'ins', product_id: null, product_category_id: null, warehouse_id: 'wh-A' },
      ] },
      { match: /^\s*UPDATE expense_allocation_periods\s+SET total_allocated/, reply: [] },
    ]);
    const svc = new ExpenseAllocationsService(ds as any);
    await svc.saveAllocationPreview('p-1', {
      source: { expense_id: 'e-1' },
      target_kind: 'warehouse',
      method: 'by_gross_profit',
    });
    const insertCall = calls.find((c) => /INSERT INTO expense_allocation_lines/.test(c.sql))!;
    const params = insertCall.params!;
    expect(params[4]).toBeNull();              // product_id
    expect(params[5]).toBeNull();              // product_category_id
    expect(params[6]).toBe('wh-A');            // warehouse_id
    expect(params[7]).toBe('by_gross_profit');
  });
});

// ─── 34. source-grep guards (B4 v2 specific) ───────────────────────

describe('expense-allocations.service.ts — B4 v2 source-grep guards', () => {
  const SRC_RAW = readFileSync(
    resolve(__dirname, './expense-allocations.service.ts'),
    'utf-8',
  );
  const SRC = SRC_RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('saveAllocationPreview is implemented and exported', () => {
    expect(SRC).toMatch(/async saveAllocationPreview\(/);
  });

  it('saveAllocationPreview opens a single transaction (ds.transaction wrapper)', () => {
    const m = SRC.match(/async saveAllocationPreview\([\s\S]*?\n  (?:async|private|\/\/)/);
    expect(m).not.toBeNull();
    const slice = m![0];
    expect(slice).toMatch(/this\.ds\.transaction\(async\s*\(\s*em\s*\)\s*=>/);
  });

  it('saveAllocationPreview locks the parent period with FOR UPDATE (via lockPeriod)', () => {
    const m = SRC.match(/async saveAllocationPreview\([\s\S]*?\n  (?:async|private|\/\/)/);
    const slice = m![0];
    expect(slice).toMatch(/this\.lockPeriod\(em,\s*periodId\)/);
  });

  it('B4 v2 writes are confined to expense_allocation_lines + expense_allocation_periods', () => {
    const writeTokenRe = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi;
    const allowed = new Set(['expense_allocation_periods', 'expense_allocation_lines']);
    const targets = new Set<string>();
    let mm: RegExpExecArray | null;
    while ((mm = writeTokenRe.exec(SRC)) !== null) {
      targets.add(mm[1].toLowerCase());
    }
    for (const t of targets) {
      expect(allowed.has(t)).toBe(true);
    }
    expect(SRC).toMatch(/INSERT\s+INTO\s+expense_allocation_lines/i);
    expect(SRC).toMatch(/DELETE\s+FROM\s+expense_allocation_lines/i);
  });

  it('B4 v2 path never references forbidden tables / FinancialEngine / accounting_only', () => {
    expect(SRC).not.toMatch(/FinancialEngine/);
    for (const t of [
      'journal_entries',
      'journal_lines',
      'cashbox_transactions',
      'stock_movements',
      'product_variants',
      'invoice_items',
      'invoices',
    ]) {
      expect(SRC).not.toMatch(new RegExp(`INSERT\\s+INTO\\s+${t}\\b`, 'i'));
      expect(SRC).not.toMatch(new RegExp(`UPDATE\\s+${t}\\b`, 'i'));
      expect(SRC).not.toMatch(new RegExp(`DELETE\\s+FROM\\s+${t}\\b`, 'i'));
    }
    expect(SRC).not.toMatch(/\baccounting_only\b/);
    expect(SRC).not.toMatch(/provisioning/);
  });
});

// ─── 35. controller wiring — route + permission + NO interceptor ───

describe('ExpenseAllocationsController — save-preview wiring (PR-PHASE2-B4 v2)', () => {
  const CTRL_RAW = readFileSync(
    resolve(__dirname, './expense-allocations.controller.ts'),
    'utf-8',
  );
  const CTRL = CTRL_RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('declares POST periods/:id/save-preview', () => {
    expect(CTRL).toMatch(/@Post\('periods\/:id\/save-preview'\)[\s\S]+savePreview\s*\(/);
  });

  it('save-preview route is guarded by expense_allocation.manage', () => {
    expect(CTRL).toMatch(
      /@Post\('periods\/:id\/save-preview'\)\s*@Permissions\(\s*'expense_allocation\.manage'\s*\)/,
    );
  });

  it('save-preview route does NOT wire IdempotencyInterceptor (v1 crash regression guard)', () => {
    // The route block (the next ~6 lines after @Post('save-preview')) must NOT
    // contain @UseInterceptors.  And the controller file must not import
    // IdempotencyInterceptor at all.
    const routeBlock = CTRL.match(/@Post\('periods\/:id\/save-preview'\)[\s\S]{0,400}?savePreview\s*\(/);
    expect(routeBlock).not.toBeNull();
    expect(routeBlock![0]).not.toMatch(/@UseInterceptors/);
    expect(CTRL).not.toMatch(/IdempotencyInterceptor/);
    expect(CTRL).not.toMatch(/idempotency\.interceptor/);
  });

  it('SavePreviewDtoIn declares optional replace_existing flag', () => {
    expect(CTRL).toMatch(/class SavePreviewDtoIn[\s\S]+@IsOptional\(\)\s+replace_existing/);
  });
});
